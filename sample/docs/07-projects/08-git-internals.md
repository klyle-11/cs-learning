# Git Internals From Scratch

> **What this teaches**: How a content-addressed object store + a handful of pointer files becomes a distributed version control system. Blobs, trees, commits, refs, the index, and zlib compression. After this, every `git` command stops being magic and starts being a predictable manipulation of files under `.git/`.

**Language**: C (with `zlib` and `openssl`/`sha1.h`)
**Effort**: 4–6 days for a working `init`, `add`, `commit`, `log`, `cat-file`. Two weeks for `checkout`, `merge`, `diff`.
**Companion reads**: 6.5 Merkle tree (the data structure underneath the whole thing), 7.2 KV store (the loose-object store is structurally one), 4.2 TLV parser (the packfile format uses TLV-shaped encoding).

---

## 1. Why this matters

Linus Torvalds wrote the first version of git in two weeks in April 2005. The core data model has not changed since. It is one of the most influential pieces of software ever written, and the entire architecture is *radically* simpler than people imagine:

- A **content-addressed object store**: files in `.git/objects/` named by SHA-1 of their (zlib-compressed) contents. Identical content always has identical name. Deduplication is free.
- **Four object types**: `blob` (file contents), `tree` (directory listing), `commit` (a tree pointer plus metadata), `tag` (annotated tag).
- **Refs**: tiny files in `.git/refs/` that hold a commit SHA. A branch is just a file with `40 bytes of hex`. Switching branches is editing one file.
- **The index**: a single binary file `.git/index` listing every staged file's path, mode, mtime, and SHA. The "staging area" *is* this file.

Git is a Merkle tree (project 6.5) plus a file-backed key-value store (project 7.2) plus a thin command line. That is the entire system. After building a subset, "merge conflict" and "detached HEAD" stop being mysteries and start being literal consequences of the data model.

---

## 2. The mental model

```
   working tree (your files on disk)
        │  git add
        ▼
   index (.git/index)               ← list of (path, mode, sha) entries
        │  git commit
        ▼
   ┌──────────────────────────────────────────────┐
   │      objects/  (content-addressed store)     │
   │                                              │
   │    commit b3a1...   (points to a tree)       │
   │       │                                      │
   │       ▼                                      │
   │    tree 4f02...     (lists blobs + subtrees) │
   │       │                                      │
   │       ▼                                      │
   │    blob f5d9...     (file contents)          │
   │                                              │
   └──────────────────────────────────────────────┘
        ▲
        │
   refs/heads/main  ← a file containing "b3a1..."

   HEAD ← a file containing "ref: refs/heads/main"
```

Three things to commit to memory:

1. **A blob is *just* a file's contents.** No filename, no permissions — that metadata lives in the parent tree.
2. **A tree is a directory listing.** Each entry: `<mode> <name>\0<20-byte sha>`. No subdirs are flattened; subdirectories are sub-tree entries pointing at another tree.
3. **A commit is a tree pointer plus metadata.** Author, committer, parent commit(s), message. That's it. History is the linked list of commits via `parent` pointers.

Branches and tags are *not* objects. They're files containing SHAs. This is why "branches are cheap" — making one is `echo <sha> > .git/refs/heads/foo`.

---

## 3. The object format

Every object on disk is:

```
   <type> <size>\0<content>
```

Then **zlib-compressed**, and stored at `.git/objects/<first 2 sha hex>/<remaining 38 sha hex>`. The SHA-1 is taken over the *uncompressed* representation including the header.

```c
// object.h
typedef enum { OBJ_BLOB = 1, OBJ_TREE = 2, OBJ_COMMIT = 3, OBJ_TAG = 4 } ObjType;

int  object_write(ObjType type, const void *data, size_t n, uint8_t sha[20]);
int  object_read(const uint8_t sha[20], ObjType *type, void **data, size_t *n);
```

### Writing an object

```c
#include <openssl/sha.h>
#include <zlib.h>

int object_write(ObjType type, const void *data, size_t n, uint8_t sha[20]) {
    const char *type_str = type_name(type);          // "blob", "tree", ...

    char header[64];
    int hn = snprintf(header, sizeof header, "%s %zu", type_str, n);
    size_t framed_n = hn + 1 + n;
    uint8_t *framed = malloc(framed_n);
    memcpy(framed, header, hn);
    framed[hn] = 0;
    memcpy(framed + hn + 1, data, n);

    SHA1(framed, framed_n, sha);

    // compress
    uLongf zbound = compressBound(framed_n);
    uint8_t *zbuf = malloc(zbound);
    compress(zbuf, &zbound, framed, framed_n);

    // path: .git/objects/ab/cdef...
    char path[80];
    sprintf(path, ".git/objects/%02x", sha[0]);
    mkdir(path, 0755);
    sprintf(path, ".git/objects/%02x/", sha[0]);
    for (int i = 1; i < 20; i++) sprintf(path + strlen(path), "%02x", sha[i]);

    FILE *f = fopen(path, "wb");
    if (f) { fwrite(zbuf, 1, zbound, f); fclose(f); }

    free(framed); free(zbuf);
    return 0;
}
```

(In production, use `fdopen` + `O_EXCL` + atomic rename so concurrent writers don't corrupt the file. Educational version skips it.)

**Reading is the reverse**: open the file, `uncompress`, parse the header, return the body.

**Why the `<type> <size>\0` prefix?** So the SHA-1 of a blob is different from the SHA-1 of a tree even if their raw bytes are identical. Type is part of the identity.

---

## 4. `git hash-object` and `git cat-file`

These two commands give you a complete object store API at the shell level:

```c
// git_hash_object.c — store a file as a blob, print its SHA
int main(int argc, char **argv) {
    void *data; size_t n;
    read_file(argv[1], &data, &n);
    uint8_t sha[20];
    object_write(OBJ_BLOB, data, n, sha);
    for (int i = 0; i < 20; i++) printf("%02x", sha[i]);
    putchar('\n');
}
```

```c
// git_cat_file.c — read an object back
int main(int argc, char **argv) {
    uint8_t sha[20];
    hex_to_sha(argv[1], sha);
    ObjType t; void *data; size_t n;
    object_read(sha, &t, &data, &n);
    fwrite(data, 1, n, stdout);
}
```

You now have the core of git: an immutable content-addressed store. Every command above this layer is just a clever combination of these two.

---

## 5. Tree objects

A tree's body is a packed list:

```
<mode> <name>\0<20-byte sha><mode> <name>\0<20-byte sha>...
```

`mode` is ASCII octal: `100644` for a regular file, `100755` for an executable, `40000` for a subdirectory (note: leading zero stripped), `120000` for a symlink. Entries must be sorted by name.

```c
typedef struct TreeEntry {
    uint32_t mode;
    char     name[256];
    uint8_t  sha[20];
} TreeEntry;

int tree_write(TreeEntry *entries, size_t n, uint8_t sha[20]) {
    Buffer buf = {0};
    for (size_t i = 0; i < n; i++) {
        char header[300];
        int hn = snprintf(header, sizeof header, "%o %s", entries[i].mode, entries[i].name);
        buffer_append(&buf, header, hn + 1);
        buffer_append(&buf, entries[i].sha, 20);
    }
    return object_write(OBJ_TREE, buf.data, buf.len, sha);
}
```

**Entries must be sorted by name.** Otherwise the SHA changes and your tree is "different" from an identical tree elsewhere — defeats the deduplication.

---

## 6. Commit objects

A commit's body is plain text:

```
tree 4f02ab...
parent b3a1cd...
parent c7d2ef...                  ← second parent, only on merges
author Alice <a@x> 1716000000 +0000
committer Alice <a@x> 1716000000 +0000

commit message goes here
```

```c
int commit_write(uint8_t tree_sha[20], uint8_t *parent_shas, size_t n_parents,
                 const char *author, const char *msg, uint8_t out_sha[20]) {
    Buffer buf = {0};
    char line[300];
    int n = snprintf(line, sizeof line, "tree %s\n", sha_to_hex(tree_sha));
    buffer_append(&buf, line, n);
    for (size_t i = 0; i < n_parents; i++) {
        n = snprintf(line, sizeof line, "parent %s\n", sha_to_hex(parent_shas + i*20));
        buffer_append(&buf, line, n);
    }
    time_t now = time(NULL);
    n = snprintf(line, sizeof line, "author %s %ld +0000\n", author, now);
    buffer_append(&buf, line, n);
    n = snprintf(line, sizeof line, "committer %s %ld +0000\n", author, now);
    buffer_append(&buf, line, n);
    buffer_append(&buf, "\n", 1);
    buffer_append(&buf, msg, strlen(msg));

    return object_write(OBJ_COMMIT, buf.data, buf.len, out_sha);
}
```

History is the parent-pointer linked list. `git log` walks it from `HEAD` backward. Merge commits have multiple parents.

---

## 7. Refs

A ref is a tiny file:

```
.git/HEAD              ← "ref: refs/heads/main"
.git/refs/heads/main   ← "b3a1cdef...\n"
.git/refs/heads/foo    ← "c7d2ef98...\n"
.git/refs/tags/v1.0    ← "e4f5a6b7...\n"
```

Branch creation:

```c
void branch_create(const char *name, uint8_t sha[20]) {
    char path[256];
    snprintf(path, sizeof path, ".git/refs/heads/%s", name);
    FILE *f = fopen(path, "w");
    fprintf(f, "%s\n", sha_to_hex(sha));
    fclose(f);
}
```

That is the entire branch implementation. Switching branches is editing `.git/HEAD`. Tagging is writing a file under `refs/tags/`. **This is why git operations on refs are essentially instantaneous regardless of repo size.**

---

## 8. The index

`.git/index` is a packed binary file listing every path currently staged for commit. The format is documented but fiddly: header (`DIRC` magic, version, count), then variable-length entries with mode, mtime, sha, name; ends with a SHA over the whole thing.

For a teaching implementation, **use a simpler text format** for v1:

```
100644 b3a1cdef... src/main.c
100644 c7d2ef98... README.md
```

Then `git add` appends/updates entries; `git commit` builds a tree from the index entries, creates a commit pointing at that tree, updates `refs/heads/<current>` to the new commit, and (optionally) clears the index.

The transformation **index → tree** is non-trivial because the index is flat (full paths) and trees are nested. You group entries by directory and recursively build subtrees bottom-up.

---

## 9. `git add` and `git commit` in 60 lines

```c
int cmd_add(const char *path) {
    void *data; size_t n;
    read_file(path, &data, &n);
    uint8_t sha[20];
    object_write(OBJ_BLOB, data, n, sha);
    index_set(path, 0100644, sha);
    return 0;
}

int cmd_commit(const char *msg) {
    uint8_t tree_sha[20];
    build_tree_from_index(tree_sha);

    uint8_t head_sha[20];
    int has_parent = ref_resolve("HEAD", head_sha);

    uint8_t commit_sha[20];
    commit_write(tree_sha, has_parent ? head_sha : NULL, has_parent ? 1 : 0,
                 author, msg, commit_sha);

    // update HEAD's ref
    ref_update_via_head(commit_sha);
    printf("[main %s] %s\n", sha_to_hex_short(commit_sha), msg);
    return 0;
}
```

Run this, look at `.git/objects/` — your blobs, trees, commits are all there. Run `git log` (the real one) inside your fake repo and it works. This is when the lesson lands.

---

## 10. `git log`

```c
int cmd_log(void) {
    uint8_t sha[20];
    if (ref_resolve("HEAD", sha) < 0) return -1;

    while (1) {
        ObjType t; void *data; size_t n;
        object_read(sha, &t, &data, &n);
        if (t != OBJ_COMMIT) break;

        Commit c;
        commit_parse(data, n, &c);

        printf("commit %s\n", sha_to_hex(sha));
        printf("Author: %s\n\n", c.author);
        printf("    %s\n\n", c.message);

        if (c.n_parents == 0) { free(data); break; }
        memcpy(sha, c.parents, 20);
        free(data);
    }
    return 0;
}
```

This is *literally* `git log` for the linear-history case. For merge commits with multiple parents, you'd use a priority queue keyed by commit time. Reading `git log` source (`builtin/log.c` in the real repo) after writing this is a revelation — it's the same loop with 10 years of features bolted on.

---

## 11. Packfiles (briefly)

`.git/objects/<2>/<38>` is the "loose object" format. Real git also has **packfiles**: thousands of objects in one file with delta compression (object N stored as a delta against object M when they share most of their content). `git gc` periodically repacks loose objects.

Packfiles are out of scope for a v1. They're a binary format (TLV-shaped — project 4.2 — with a custom integer encoding) plus delta compression (a custom byte-code-like format). Writing a packfile reader is a weekend; a writer is a week. Skip for now.

---

## 12. Common pitfalls

1. **Forgetting the `<type> <size>\0` prefix in the SHA input.** Your SHAs won't match `git`'s; you can't interoperate.
2. **Not sorting tree entries.** SHAs change; objects deduplicate incorrectly.
3. **Storing absolute paths in trees.** Tree entries are *names* (single path component). Subdirs are subtree entries.
4. **Compressing before SHA.** SHA is over the *uncompressed* framed data; compression is independent.
5. **Writing the working tree on `add` instead of just hashing.** `add` only updates the index + writes the blob. Working tree is untouched.
6. **Not handling the initial commit** (no parent). Branch on `has_parent`; first commit has zero parent lines.
7. **Treating refs as ledgers, not as files.** "Recording a commit" is editing one file. Doing more is wrong.
8. **Mishandling line endings.** Git has CRLF normalization (`core.autocrlf`). Skip it for v1; document the gap.

---

## 13. Variations you'll encounter in the wild

- **git** itself — `~250k LOC` in C. `builtin/` is the per-command source; `sha1-file.c`, `object.c`, `tree.c`, `commit.c` are the data-model core. Highly readable.
- **libgit2** — embeddable C library reimplementing git's core. Cleaner API, used by many tools.
- **jgit** — Eclipse's Java port. Different perspective on the same model.
- **gitoxide** — modern Rust reimplementation. Fast, ergonomic, evolving.
- **Mercurial** — different VCS, same overall idea (DAG of commits, content addressing). Different on-disk format.
- **Fossil** — Richard Hipp's (SQLite author) VCS. Single SQLite database as the entire repo. Beautiful alt-design.
- **Pijul** — patch-based VCS with category theory underneath. Genuinely different ideas.

---

## 14. Where this shows up in the real world

- Every git server (GitHub, GitLab, Bitbucket, Gitea) implements exactly this storage layer + the smart HTTP transfer protocol on top.
- **Docker image layers** are a Merkle DAG, structurally identical to git trees.
- **IPFS** (the InterPlanetary File System) is a content-addressed object store directly modeled on git.
- **Nix store** uses content addressing for build outputs.
- **OCI image format** uses the same blob-and-manifest pattern.
- **Blockchain block storage** is the same idea minus the human-friendly UX.

---

## 15. Going deeper

1. **Implement `checkout <branch>`.** Walk the tree of the target commit; write each blob to the working tree; update the index; update HEAD.
2. **Implement `diff`.** Compare two trees; for each changed blob pair, run an LCS-based line-diff algorithm. Real git uses Myers' algorithm.
3. **Implement `merge` (fast-forward only first).** Then three-way merge.
4. **Implement packfile reading** so you can clone real repos.
5. **Implement the smart HTTP protocol** so you can `git push` and `git pull` to your own server.
6. **Read `Documentation/technical/` in the git source.** Especially `pack-format.txt`, `index-format.txt`, `protocol-v2.txt`. The most underrated documentation in open source.
7. **Read Aditya Mukerjee's "Build Your Own Git" series** and Wyag (Write Yourself a Git) by Thibault Polge — both are excellent walkthroughs that complement this guide.

---

## 16. Industry context

> Git won the VCS wars in part because its model is *simpler* than the previous generation's (CVS, Subversion). The data model is small enough to fit in your head; everything else is policy. That conceptual minimality is why every replacement-attempt is judged by "is the model simpler" and almost never is.

- **Active debate**: "Should we use a `git`-shaped model for very large monorepos?" — Google (Piper), Facebook (Mercurial → Sapling), and Microsoft (VFS for Git, Scalar) have all built infrastructure to scale git-shaped operations to TB-scale repos. The answer is "yes, with major server-side work."
- **Historical context**: Linus wrote git in April 2005 in roughly two weeks after the BitKeeper license was revoked. The design choices (content addressing, single-pass operations, minimal locking) were optimized for the kernel workflow specifically.
- **What a tech lead would ask**: "How do you handle large binary files?" (You don't, well. Git LFS is the workaround.) "What's the cost of cloning a 10 GB repo?" (Bandwidth + delta resolution; packfiles + multi-pack help.) "How does merge handle the same file edited by both branches?" (Three-way merge using the common ancestor; conflicts when the same lines diverge.)
- **Forward-looking**: SHA-256 transition (slow, ongoing). Partial clone and sparse checkout for huge repos. `jj` (jujutsu) is a recent reimagining of the UX without touching the data model.
- **Names worth knowing**: Linus Torvalds, Junio Hamano (current git maintainer since ~2005), Scott Chacon (Pro Git, GitHub), Edward Thomson (libgit2), Sébastien Pierre (early git tooling), Martin von Zweigbergk (jj / Google).

---

## 17. Self-check questions

1. Why does the object header include the type and size before the content?
2. What's the difference between a tree object and a directory listing?
3. Why are branches "cheap" in git?
4. What does HEAD point to in detached HEAD state, vs. normal?
5. How does git deduplicate identical files across commits "for free"?
6. What is the index, and why does it exist separately from the working tree and the latest commit?
7. Why does a SHA-1 collision in git's object store matter (and why did it almost not, for a long time)?

If you can answer these, you understand the data model under every code review you've ever done, every PR you've ever opened, every commit you've ever made.
