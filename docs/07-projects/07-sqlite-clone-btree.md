# SQLite-Style Database with B-Tree

> **What this teaches**: The other half of "how databases work" (the half project 7.2 didn't cover): **update-in-place on a paged B-tree**. The pager, the page cache, B-tree splits and merges, a tiny SQL subset, and a REPL. This is the hardest project on the list by pure code complexity — and the most satisfying when the first `SELECT * FROM users` returns a row from disk.

**Language**: C
**Effort**: 1–2 weeks. The pager and B-tree take most of it; the SQL parser is small if you keep the dialect tiny.
**Companion reads**: 7.2 KV store (the log-structured opposite of this design), 2.2 hash map (the in-memory index analog of the B-tree), 1.1 arena (used heavily for per-statement allocations).

---

## 1. Why this matters

SQLite is the most-deployed database in the world (billions of installations — every Android phone, every browser, every airplane). It is also a single C file (~150k lines of amalgamated source) that runs on everything from microcontrollers to mainframes. The architecture has three layers, each interesting on its own and each illustrating a fundamental database concept:

1. **The pager**: turns a file on disk into a stream of fixed-size pages, with a cache, dirty-page tracking, and (eventually) a journal for crash recovery.
2. **The B-tree**: a sorted, balanced structure of pages, where each page is one node, with split-on-insert and merge-on-delete.
3. **The VM / SQL layer**: a tokenizer → parser → planner → bytecode VM that translates SQL into B-tree operations.

After building this you understand, viscerally:

- Why every "real" database picks a page size (4 KB or 8 KB or 16 KB) and lives inside it.
- Why B-trees beat hash tables for *range scans* and *ordered iteration* even though hash tables beat them for point lookups.
- Why "ACID" is mostly the journal — durability and atomicity are the journal; consistency and isolation are the locking/MVCC layer.
- Why SQL ended up the way it is. (Hint: writing a tiny SQL parser is unreasonably illuminating about SQL's quirks.)

---

## 2. The mental model

```
   SQL text ──▶ tokenizer ──▶ parser ──▶ planner ──▶ bytecode VM
                                                          │
                                                          ▼
   ┌────────────────────────────────────────────────────────────┐
   │                        B-tree                              │
   │                                                            │
   │            ┌────────┐                                      │
   │            │ root   │                                      │
   │            │ keys:  │  (internal node = sorted keys + child ptrs)
   │            └─┬─┬─┬──┘                                      │
   │              │ │ │                                         │
   │       ┌──────┘ │ └──────┐                                  │
   │       ▼        ▼        ▼                                  │
   │   ┌──────┐ ┌──────┐ ┌──────┐                               │
   │   │ leaf │ │ leaf │ │ leaf │  (leaf = sorted [key, value])  │
   │   └──────┘ └──────┘ └──────┘                               │
   │                                                            │
   └────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌────────────────────────────────────────────────────────────┐
   │                       Pager                                │
   │  page cache (in-memory) ───── file (on disk, 4 KB pages)   │
   └────────────────────────────────────────────────────────────┘
```

The shape to internalize: **every node in the B-tree is one disk page**. The B-tree's job is to keep the tree shallow (typically 3–4 levels for billions of rows), so any lookup is 3–4 disk reads — and the top levels are cached, so it's actually 1 read for almost all lookups.

A 4 KB page can hold roughly 200 (key, child) pairs in an internal node. So a 3-level tree holds 200³ ≈ 8 million entries; 4 levels holds 1.6 billion. **This is the whole reason B-trees won the database wars** in the 1970s.

---

## 3. The pager

The pager is a thin abstraction over a file: "give me page N." It maintains a small LRU cache (project 2.3 — go build it if you haven't), reads on miss, writes back on eviction.

```c
// pager.h
#define PAGE_SIZE 4096
#define CACHE_SIZE 128

typedef struct Pager {
    int     fd;
    size_t  file_size;
    void   *cache_pages[CACHE_SIZE];
    int     cache_page_ids[CACHE_SIZE];   // -1 = empty slot
    int     dirty[CACHE_SIZE];
    // ... LRU bookkeeping ...
} Pager;

Pager *pager_open(const char *path);
void  *pager_get(Pager *p, int page_id);   // returns a pointer to the cached page
void   pager_mark_dirty(Pager *p, int page_id);
int    pager_flush(Pager *p);              // write all dirty pages
void   pager_close(Pager *p);
int    pager_new_page(Pager *p);           // allocate a new page at end of file
```

The implementation is ~150 lines. Tricks worth flagging:

- **Pin/unpin**. When you hand out a page pointer to a B-tree operation, that page must not be evicted while in use. Production pagers track "pinned" pages explicitly; for a teaching version you can skip this if your operations are short.
- **`pread`/`pwrite` only**. Same reason as the KV store — no `lseek`, so concurrent ops (if you ever add them) don't fight over the file offset.
- **Flush before close**. Dirty pages in the cache that haven't been flushed are lost on close. Worse, lost on crash. The journal/WAL exists to make this safe; for a v1, just `fsync` on close and accept the data loss on crash.

---

## 4. The B-tree node layout

Each page is one node. Two kinds: internal and leaf.

```c
// btree_node.h
typedef enum { NODE_LEAF = 1, NODE_INTERNAL = 2 } NodeType;

// shared header (every page starts with this)
typedef struct {
    uint8_t  type;        // NODE_LEAF or NODE_INTERNAL
    uint8_t  is_root;
    uint16_t num_cells;   // number of (key, value) or (key, child) pairs
    uint32_t parent;      // page id of parent (0 = root)
} NodeHeader;

// leaf page layout:
//   [NodeHeader][next_leaf:4][cells...]
//   each cell: [key:4][value:VALUE_SIZE]
//
// internal page layout:
//   [NodeHeader][right_child:4][cells...]
//   each cell: [key:4][child:4]
```

A leaf cell stores the value inline; an internal cell stores a "go left if key < this" pointer. The **rightmost child** of an internal node is stored separately (since there are `n` keys and `n+1` children).

Constants you'll derive once and remember:

```c
#define LEAF_HEADER_SIZE     (sizeof(NodeHeader) + 4)
#define LEAF_CELL_SIZE       (4 + VALUE_SIZE)
#define LEAF_MAX_CELLS       ((PAGE_SIZE - LEAF_HEADER_SIZE) / LEAF_CELL_SIZE)

#define INTERNAL_HEADER_SIZE (sizeof(NodeHeader) + 4)
#define INTERNAL_CELL_SIZE   (8)
#define INTERNAL_MAX_CELLS   ((PAGE_SIZE - INTERNAL_HEADER_SIZE) / INTERNAL_CELL_SIZE)
```

Fix the row layout — for an educational version, each row is e.g. `(id int, username char[32], email char[255])` = 291 bytes. That gives ~14 rows per leaf page.

---

## 5. B-tree operations

### Search

```c
// returns leaf page id where `key` would live (whether it exists or not)
int btree_find_leaf(BTree *bt, int root_pid, int key) {
    int pid = root_pid;
    for (;;) {
        NodeHeader *h = pager_get(bt->pager, pid);
        if (h->type == NODE_LEAF) return pid;
        // binary search the internal node's keys
        int lo = 0, hi = h->num_cells;
        while (lo < hi) {
            int m = (lo + hi) / 2;
            int mk = internal_key(h, m);
            if (key <= mk) hi = m;
            else lo = m + 1;
        }
        pid = (lo == h->num_cells) ? internal_right_child(h) : internal_child(h, lo);
    }
}
```

Three pages for a billion rows. That is the algorithmic miracle of the B-tree, and it falls out of the layout.

### Insert (with split)

```c
void btree_insert(BTree *bt, int root_pid, int key, const void *value) {
    int leaf_pid = btree_find_leaf(bt, root_pid, key);
    NodeHeader *leaf = pager_get(bt->pager, leaf_pid);
    if (leaf->num_cells < LEAF_MAX_CELLS) {
        leaf_insert_inplace(leaf, key, value);
        pager_mark_dirty(bt->pager, leaf_pid);
    } else {
        leaf_split_and_insert(bt, leaf_pid, key, value);
    }
}
```

The split is where it gets interesting. When a leaf overflows:

1. Allocate a new sibling page.
2. Move the right half of cells to the new sibling.
3. Insert the new key into whichever half it belongs in.
4. Promote the median key (the first key of the new right sibling) to the parent.
5. If the parent overflows, recurse upward.
6. If the root itself splits, allocate a new root with two children.

```c
static void leaf_split_and_insert(BTree *bt, int leaf_pid, int key, const void *value) {
    int new_pid = pager_new_page(bt->pager);
    NodeHeader *old_leaf = pager_get(bt->pager, leaf_pid);
    NodeHeader *new_leaf = pager_get(bt->pager, new_pid);
    leaf_init(new_leaf);

    // collect all cells (existing + new) sorted by key
    Cell tmp[LEAF_MAX_CELLS + 1];
    collect_with_insert(old_leaf, key, value, tmp);

    int split = (LEAF_MAX_CELLS + 1) / 2;
    leaf_write_cells(old_leaf, tmp, 0, split);
    leaf_write_cells(new_leaf, tmp, split, LEAF_MAX_CELLS + 1 - split);
    leaf_set_next(new_leaf, leaf_next(old_leaf));
    leaf_set_next(old_leaf, new_pid);

    int promoted_key = cell_key(&tmp[split]);
    parent_insert(bt, old_leaf->parent, promoted_key, new_pid);

    pager_mark_dirty(bt->pager, leaf_pid);
    pager_mark_dirty(bt->pager, new_pid);
}
```

The "leaf linked list" (`next_leaf` pointer) is what makes range scans efficient — after `WHERE id BETWEEN 5 AND 100`, you find leaf 5, then traverse leaf-by-leaf without going back up the tree.

### Delete (with merge)

Symmetric, but harder. Underflowing leaves either borrow from a sibling or merge with one. Most teaching implementations skip delete-with-merge in v1 and leave it as "TODO: rebalance after delete" — the database still works, you just leak space until VACUUM.

---

## 6. Tying in SQL

The SQL layer is bounded by your ambition. The minimal subset:

```
INSERT INTO t VALUES (id, name, email);
SELECT * FROM t;
SELECT * FROM t WHERE id = ?;
DELETE FROM t WHERE id = ?;
```

A tokenizer (50 lines), a recursive-descent parser (150 lines), and a tiny "executor" that calls the B-tree operations. Skip query planning, skip indexes other than the primary key, skip joins, skip aggregates. You can ship this in a day after the B-tree works.

Real SQLite has a *bytecode VM* in between — the planner emits opcodes (`OpenRead`, `Rewind`, `Next`, `Column`, `ResultRow`) that the VM executes. That's beautiful but takes weeks. The straight-execution approach is enough for the lessons here.

The REPL is `readline` + dispatch on `.` for meta-commands:

```
sqlite> CREATE TABLE users (id int, name char(32));
sqlite> INSERT INTO users VALUES (1, 'alice');
sqlite> SELECT * FROM users;
1 | alice
sqlite> .exit
```

---

## 7. Crash safety (the part you skip the first time)

So far the database is *not crash-safe*. A power loss mid-write can leave a page partially updated. The fix is one of:

- **Rollback journal** (classic SQLite): before modifying a page, write its original contents to a journal file. If the database crashes, recovery replays the journal in reverse to undo the in-progress transaction. On commit, delete the journal.
- **WAL** (write-ahead log, modern SQLite): all writes go to a sequential log first. The main file is updated lazily by a checkpoint operation. Readers can see the old version while writers append; concurrency improves dramatically.

Both are sophisticated; both can be skipped in v1 with a giant warning ("do not put data you care about in this thing"). Building either teaches you exactly how Postgres, MySQL, and SQLite achieve durability.

---

## 8. Operation walkthroughs

### Insert into a 1M-row table

- Find leaf: 3 page reads (root + 1 internal + 1 leaf). Root is in cache → effectively 2 reads.
- Insert in-place: 0 reads, 1 write on next flush.
- Total: ~2 reads, eventual 1 write. Negligible cost; ~10 µs.

### Range scan `SELECT * WHERE id BETWEEN 1000 AND 2000`

- Find first leaf: 3 reads.
- Walk leaf linked list: ~1 page read per ~14 rows.
- For 1000 rows: ~72 page reads. With OS page cache hot, microseconds.

### Worst case: insert into a full B-tree forcing root split

- Find leaf: 3 reads.
- Split leaf: 1 allocation, 2 writes.
- Split parent: another allocation, 2 writes.
- Split root: another allocation, 3 writes (new root + 2 children).
- Total: ~8 writes. Still fast, but variable — this is why benchmarks distinguish `p50` and `p99` latency.

---

## 9. Common pitfalls

1. **Returning pointers into pages that get evicted.** Pin/unpin or copy out.
2. **Forgetting `pager_mark_dirty` after a write.** Dirty bit stays clean; eviction silently drops the change; data corruption.
3. **Recursive splits that update the parent without re-fetching it.** A split can cause the parent's page pointer to be invalidated by the cache; always look up afresh.
4. **Hard-coding row size without alignment.** Misaligned `int` loads on ARM crash; on x86 they're slow.
5. **Off-by-one in internal node child arithmetic.** N keys, N+1 children. Most B-tree bugs are here. Draw the picture before coding.
6. **No `fsync` on commit.** Same lesson as the KV store. Without `fsync`, "committed" data evaporates on power loss.
7. **Concurrent access without locking.** A v1 should be single-process; pretending otherwise breaks everything.

---

## 10. Variations you'll encounter in the wild

- **SQLite** — `~150k LOC` amalgamation, the canonical reference. `src/btree.c` (~10k lines) is the gold standard.
- **LMDB** — copy-on-write B-tree, memory-mapped, no journal. Brilliantly simple, very fast reads.
- **bbolt** (Go fork of BoltDB, used by etcd) — LMDB-style, ~5k LOC, very readable.
- **WiredTiger** (MongoDB) — both B-tree and LSM modes; B-tree is the default.
- **InnoDB** (MySQL) — clustered B-tree (the table *is* a B-tree on primary key). Different design from SQLite.
- **Postgres** — heap files + separate B-tree indexes; the heap is *not* a B-tree, which is unusual.
- **CMU's `cub-db`** and Bob Nystrom's `craftinginterpreters` SQLite-clone walkthrough — explicitly pedagogical, worth reading after your own.

---

## 11. Where this shows up in the real world

- **Every smartphone, browser, and embedded device** runs SQLite somewhere.
- **MySQL/MariaDB InnoDB**: clustered B-tree on primary key, secondary B-tree indexes.
- **Postgres**: B-tree as the default index type; the heap table is separate.
- **Filesystems** — ext4's HTree, XFS's B+ tree directories, btrfs (the whole filesystem), ZFS metadata. All B-trees.
- **etcd, Consul**: bbolt (LMDB-style B-tree) for the data store.
- **Most key-value caches that support range scans** (TiKV, FoundationDB) use B-tree-shaped indexes on top of LSM storage.

---

## 12. Going deeper

1. **Implement delete with merge/borrow.** The hard half of B-tree maintenance.
2. **Add a secondary index** — a second B-tree keyed by a different column, pointing to row IDs in the primary.
3. **Add a rollback journal.** ~300 lines; teaches durability protocols better than reading a paper.
4. **Add a bytecode VM** for SQL execution. Now you have a compiler and an interpreter. Read SQLite's `src/vdbe.c` for inspiration.
5. **Add a query planner** that picks indexes. Cost-based or rule-based — both are interesting.
6. **Read the SQLite "Architecture" doc** on sqlite.org. ~30 pages, fantastically written.
7. **Read the LMDB design doc.** Howard Chu's "MDB: A Memory-Mapped Database and Backend for OpenLDAP."

---

## 13. Industry context

> SQLite is arguably the most successful piece of software written by a single person (Richard Hipp) in history. Its design is also one of the few in databases where reading the source teaches you more than reading the papers.

- **Active debate**: B-tree vs. LSM-tree as the default storage shape for new databases. The B-tree camp (Postgres, SQLite, LMDB) argues read efficiency and predictability; the LSM camp (RocksDB, Cassandra, TiKV) argues write throughput and operational simplicity. Hybrid systems (Spanner, CockroachDB) increasingly use both.
- **Historical context**: Bayer & McCreight invented B-trees in 1972. Their B+ tree variant (leaves linked, all data in leaves) is what every modern database actually uses. SQLite was created in 2000 to replace a fragile in-process database in a US Navy missile cruiser.
- **What a tech lead would ask**: "What's your fan-out?" (Number of children per internal node — larger is better for shallow trees but worse for cache.) "What's your fill factor?" (Pages average ~70% full after random inserts, ~100% full after sequential inserts. Affects total disk usage 30%.) "How do you handle concurrent readers and writers?" (SQLite WAL: many readers + one writer; Postgres: MVCC with snapshot isolation.)
- **Forward-looking**: Cloud-native storage (S3 as the disk) is forcing rethinks. Aurora, Neon, and PlanetScale all decompose the page-cache + write-log layers differently from on-prem databases.
- **Names worth knowing**: Rudolf Bayer (B-tree inventor), Richard Hipp (SQLite), Howard Chu (LMDB), Andy Pavlo (CMU databases, the YouTube lectures are excellent), Jim Gray (transaction processing pioneer).

---

## 14. Self-check questions

1. Why is the B-tree fan-out so important to lookup latency?
2. Why does the leaf linked-list pointer matter for SQL semantics?
3. What does the pager's pin/unpin protocol protect against?
4. Why must a split promote the median key, not the smallest or largest?
5. What's the failure mode if you crash mid-split without a journal?
6. Why is SQLite's bytecode VM a smart engineering choice for portability?
7. What does "clustered index" mean (InnoDB) vs "secondary index" (SQLite)?

If you can answer these, you have built (and now understand) the architecture under most databases in production today.
