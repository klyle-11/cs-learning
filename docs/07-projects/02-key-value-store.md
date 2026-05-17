# Persistent Key-Value Store

> **What this teaches**: What "durable" actually costs. The log-structured architecture behind Bitcask, LevelDB, RocksDB, and Kafka. How a hash map in RAM plus an append-only file on disk gets you 80% of a real database — and what the remaining 20% (compaction, crash recovery, concurrency) really involves.

**Language**: C
**Effort**: 2–3 days for the basic log + in-memory index. A week for compaction and crash recovery.
**Companion reads**: 2.2 hash map (the in-memory index is exactly this), 7.6 redis-like server (KV with a network protocol), 7.7 SQLite clone (the *opposite* design — B-tree on disk instead of log + index in RAM).

---

## 1. Why this matters

Every persistent system in the world is some answer to the same question: *"I need to store data such that it survives a crash, and I need to read it back in less than disk-seek time."* The two dominant architectures are:

- **Update-in-place** (SQLite, classic RDBMSes): a B-tree on disk, modified in place, with write-ahead logging for crash safety.
- **Log-structured** (Bitcask, LevelDB, RocksDB, Kafka, modern SSDs *inside the controller*): write only to the end of a log, keep an index in RAM, periodically compact.

The log-structured design wins on writes (sequential-only I/O is much faster than seek-bound I/O on both spinning disks and SSDs), and it's much simpler to implement correctly. It also exposes the costs of durability — `fsync`, write amplification, compaction overhead — directly, where the B-tree design hides them.

After building this you understand:

1. Why "the database is just a sorted file" jokes have a kernel of truth.
2. Why your laptop SSD has internal garbage collection.
3. Why Redis snapshots are append-only files (the AOF mode).
4. What it actually means when someone says "we got 100k writes/sec on a single node."

---

## 2. The mental model

```
              ┌─────────────────────────────────────────┐
   PUT k v ──▶│        in-memory hash map               │
              │  k → (file_id, offset, length)          │
              └─────────────────────────────────────────┘
                         │
                         │ (insert)
                         ▼
              ┌─────────────────────────────────────────┐
              │      append-only log file               │
              │  ...┌──────┬──────┬──────┐              │
              │     │ k₁v₁ │ k₂v₂ │ k₃v₃ │ ◀── append   │
              │  ...└──────┴──────┴──────┘              │
              └─────────────────────────────────────────┘

   GET k:
     idx = map[k]            # O(1)
     pread(idx.file, idx.offset, idx.length)  # one disk read
```

That's it. The entire architecture. Writes go to the end of a file (sequential, fast); the in-memory index remembers where each key landed; reads are one hash lookup plus one `pread`.

The non-obvious parts:

- **Updates and deletes are also appends.** PUT of an existing key appends a new record and updates the in-memory index to point to the new offset. The old record is now "dead" — still on disk, but the index doesn't reference it. DELETE appends a tombstone record.
- **The log grows forever** until you compact. Compaction = read records in order, write only the live ones to a new file, swap.
- **The index is rebuilt on startup** by replaying the log. This is the "crash recovery" — there is no separate recovery protocol because the log *is* the database.

---

## 3. The record format

Every record on disk is the same shape:

```
+-----------+----------+----------+--------+--------+
| crc32 (4) | ksize(4) | vsize(4) | key... | val... |
+-----------+----------+----------+--------+--------+
```

`vsize == -1` (or any sentinel like `0xFFFFFFFF`) means **tombstone**: the record is a deletion marker, no value follows.

```c
// kv.h
#include <stdint.h>

#define KV_TOMBSTONE_VSIZE 0xFFFFFFFFu

typedef struct {
    uint32_t crc;
    uint32_t ksize;
    uint32_t vsize;
    // key follows
    // value follows
} __attribute__((packed)) RecordHeader;
```

**The CRC is not optional.** Power loss during a write can leave a partial record at the tail; on recovery you must be able to detect "this last record was truncated" and stop there. Without the CRC you can't distinguish a truncated record from a real one.

---

## 4. The writer

```c
// kv.h
typedef struct {
    int   fd;                 // append-only fd for the active log file
    off_t pos;                // current write position
    HashMap *index;           // key → (offset, length)
} KVStore;

int kv_put(KVStore *s, const void *k, uint32_t kn, const void *v, uint32_t vn);
int kv_get(KVStore *s, const void *k, uint32_t kn, void **out_v, uint32_t *out_vn);
int kv_del(KVStore *s, const void *k, uint32_t kn);
```

```c
// kv.c (write path)
#include <unistd.h>
#include <string.h>
#include "kv.h"
#include "crc32.h"

static int write_record(KVStore *s, const void *k, uint32_t kn,
                        const void *v, uint32_t vn,
                        off_t *out_value_offset) {
    RecordHeader h = { .ksize = kn, .vsize = vn };
    uint32_t crc = crc32(0, &h.ksize, sizeof h.ksize);
    crc = crc32(crc, &h.vsize, sizeof h.vsize);
    crc = crc32(crc, k, kn);
    if (vn != KV_TOMBSTONE_VSIZE) crc = crc32(crc, v, vn);
    h.crc = crc;

    struct iovec iov[4] = {
        { &h,         sizeof h },
        { (void*)k,   kn },
        { (void*)v,   vn == KV_TOMBSTONE_VSIZE ? 0 : vn },
        { 0, 0 }
    };
    ssize_t n = writev(s->fd, iov, 3);
    if (n < 0) return -1;
    *out_value_offset = s->pos + sizeof h + kn;
    s->pos += n;
    return 0;
}

int kv_put(KVStore *s, const void *k, uint32_t kn,
           const void *v, uint32_t vn) {
    off_t voff;
    if (write_record(s, k, kn, v, vn, &voff) < 0) return -1;
    IndexEntry e = { .offset = voff, .length = vn };
    hashmap_set(s->index, k, kn, &e);
    return 0;
}
```

**`writev`, not `write` + `write` + `write`.** Scatter-gather I/O writes the header, key, and value in one syscall — atomic with respect to other `writev`s, so if you ever want concurrent writers you can rely on it.

The `crc32` should cover *everything except the crc field itself*. Don't get cute with including the crc bytes in the crc input — you'll fight your own tail.

---

## 5. The reader

```c
int kv_get(KVStore *s, const void *k, uint32_t kn,
           void **out_v, uint32_t *out_vn) {
    IndexEntry e;
    if (hashmap_get(s->index, k, kn, &e) < 0) return -1;     // not found
    if (e.length == KV_TOMBSTONE_VSIZE) return -1;            // tombstone
    void *buf = malloc(e.length);
    ssize_t n = pread(s->fd, buf, e.length, e.offset);
    if (n != (ssize_t)e.length) { free(buf); return -1; }
    *out_v = buf;
    *out_vn = e.length;
    return 0;
}
```

`pread` is the move: it doesn't change the file offset, so the same fd can serve concurrent readers and writers. You will never use `lseek`+`read` in a real KV store.

Notice we don't reverify the CRC on read. Two schools:

- **Trust the disk.** Skip the CRC on hot paths. Re-verify on a periodic scrub.
- **Verify always.** Roughly halves read throughput in `memcpy`-bound workloads. Correct, but a real cost.

LevelDB defaults to verify-always, Bitcask to trust. Decide based on what you're trying to teach yourself this round.

---

## 6. Recovery on startup

Open the log, scan from offset 0, rebuild the index. Stop at the first record whose CRC doesn't match — that's the torn-write boundary.

```c
int kv_recover(KVStore *s, const char *path) {
    s->fd = open(path, O_RDWR | O_CREAT | O_APPEND, 0644);
    if (s->fd < 0) return -1;
    s->index = hashmap_new();

    off_t pos = 0;
    RecordHeader h;
    while (pread(s->fd, &h, sizeof h, pos) == (ssize_t)sizeof h) {
        size_t total = sizeof h + h.ksize + (h.vsize == KV_TOMBSTONE_VSIZE ? 0 : h.vsize);
        void *body = malloc(h.ksize + (h.vsize == KV_TOMBSTONE_VSIZE ? 0 : h.vsize));
        if (pread(s->fd, body, total - sizeof h, pos + sizeof h) != (ssize_t)(total - sizeof h)) {
            free(body); break;                       // truncated tail
        }
        uint32_t crc = crc32(0, &h.ksize, sizeof h.ksize);
        crc = crc32(crc, &h.vsize, sizeof h.vsize);
        crc = crc32(crc, body, total - sizeof h);
        if (crc != h.crc) { free(body); break; }     // torn write — stop here

        void *k = body;
        if (h.vsize == KV_TOMBSTONE_VSIZE) hashmap_del(s->index, k, h.ksize);
        else {
            IndexEntry e = { .offset = pos + sizeof h + h.ksize, .length = h.vsize };
            hashmap_set(s->index, k, h.ksize, &e);
        }
        free(body);
        pos += total;
    }
    // truncate trailing garbage so the next append starts clean
    ftruncate(s->fd, pos);
    s->pos = pos;
    return 0;
}
```

Truncating to the last good record is the rule. The torn tail is *gone forever* — that write is lost, but everything before it is intact. The caller (your application) should have its own retry logic for in-flight writes that haven't been acknowledged yet; that is *not* the KV store's responsibility.

---

## 7. `fsync`: the cost of "durable"

Here is the punchline of this whole project. After `write()`, your data is *in the kernel page cache*, not on disk. A kernel panic or power loss in the next few seconds (default writeback interval on Linux: 30 seconds) loses it.

```c
fsync(s->fd);   // wait for data to hit the platter / NAND
```

`fsync` on a single SSD takes 1–10 ms. On spinning disk: 10–50 ms. So:

- **Without fsync**: ~1M ops/sec on a modern machine. Data loss on crash.
- **With fsync per write**: ~100–1000 ops/sec. No data loss.
- **With fsync every N writes (group commit)**: ~10k–100k ops/sec, lose up to N writes on crash.

This is **the** durability tradeoff in every database. Postgres' `synchronous_commit`, MySQL's `innodb_flush_log_at_trx_commit`, Redis' `appendfsync` settings — they are all this same knob.

Build a configuration: `fsync_mode` ∈ `{always, every_N_ms, never}`. The "every N ms" mode runs a background thread that wakes up and calls `fsync`. This is what real systems do.

---

## 8. Compaction

The log file grows forever; dead records accumulate. Compaction reclaims that space.

Simple algorithm:

```
1. Stop accepting writes briefly OR start a new active log and let writers move to it.
2. Read the old log front-to-back.
3. For each record, check the in-memory index:
     - If the index still points to this exact offset, write it to a new file.
     - Otherwise, skip (it's a dead version or a tombstone).
4. Update the index to point to the new file's offsets.
5. Delete the old file.
```

Two designs in the wild:

- **Bitcask**: one "active" file (appended to) plus N "immutable" files. Compaction merges multiple immutable files into one.
- **LevelDB / RocksDB**: tiered ("L0" through "Ln"), each level is a sorted set of immutable files. Compaction promotes data through levels. This is the LSM-tree, and it's about 10× more complex than Bitcask.

Build the Bitcask version. You'll learn the lesson without drowning in level-management code.

---

## 9. What we left out (deliberately)

- **Range scans.** A hash-map index can't iterate in key order. To support `RANGE(a, b)`, swap the hash map for a sorted structure (B-tree, skiplist) — at which point you're 30% of the way to an LSM tree.
- **Transactions.** Atomic multi-key writes require either a transaction log on top of the value log, or a serializable write protocol. Real databases have both.
- **Concurrency.** Multiple writers need either external locking or an MVCC layer with versioned records. Bitcask is single-writer for a reason.
- **Network protocol.** That is project 7.6 (Redis-like server). You can bolt this KV onto it directly.

---

## 10. Common pitfalls

1. **Forgetting `fsync` and claiming durability.** Common, embarrassing, present in production code I have personally shipped. Power-loss test before you claim correctness.
2. **CRC over wrong bytes.** Easy to mismatch what the writer hashed vs what the reader hashes. Centralize the helper.
3. **Index out of sync with disk.** If you crash *between* the disk append and the index update, on recovery the replay re-inserts it correctly. But if you crash *between* the index update and the disk append — wait, that order is wrong. Always append to disk first, then update the index. The disk is the source of truth.
4. **Treating tombstones as missing during compaction.** Compaction must keep tombstones until *all* files containing the dead value have been compacted, otherwise the deletion can "come back." LevelDB tracks this with sequence numbers.
5. **`O_APPEND` and `pwrite`.** They don't compose — `O_APPEND` overrides the offset on every write. If you want to use `pwrite`, drop `O_APPEND` and manage the position yourself.
6. **Treating short reads as errors only.** A short `pread` near EOF is the truncation signal during recovery; treat it as the end of the log, not as an I/O failure.

---

## 11. Variations you'll encounter in the wild

- **Bitcask** (Riak) — the design above, nearly verbatim. ~1500 lines of Erlang in production.
- **LevelDB / RocksDB** — LSM-tree on disk. Sorted, levels, bloom filters, much more code (~50k LOC for RocksDB).
- **LMDB** — the opposite extreme: copy-on-write B-tree, memory-mapped, no compaction. Reads are pointer arithmetic, writes are slow.
- **WiredTiger** (MongoDB's storage engine) — both modes available; LSM for write-heavy, B-tree for read-heavy.
- **Pebble** (CockroachDB) — Go LSM, designed for cloud storage.
- **The SSD inside your laptop** — runs an LSM-shaped garbage collector in firmware because flash erases are slow.

---

## 12. Where this shows up in the real world

- **Kafka**: literally a log-structured KV store with a network API; the "key" is the partition+offset.
- **Redis** AOF mode: persistence via an append-only log of commands; replay on restart.
- **Git's object store**: content-addressed, append-only, *also* periodically compacted (`git gc` repacks loose objects into packfiles).
- **etcd, Consul**: WAL + bbolt (a Go LMDB clone). Different design, same problem.
- **Cassandra, ScyllaDB**: LSM trees, multi-node, hinted handoff.

---

## 13. Going deeper

1. **Add a sorted on-disk format (an "SSTable").** Sort the keys in compaction output. You now have the basis of an LSM tree.
2. **Add bloom filters per SSTable.** Avoid disk hits for keys that don't exist. ~10 bits per key, ~1% false positive. Beautiful 50-line addition.
3. **Add a memtable + WAL split.** Writes go to a sorted in-memory structure *plus* the WAL; periodic flush writes the memtable to a new SSTable. This is the standard LSM write path.
4. **Implement range scans.** Requires the SSTables to be sorted and a heap-merge across active memtable + SSTables.
5. **Read the Bitcask paper.** It's 6 pages. *Bitcask: A Log-Structured Hash Table for Fast Key/Value Data*.
6. **Read the LevelDB source `db/version_set.cc` and `db/db_impl.cc`.** ~5000 lines combined. Production LSM code, very readable.

---

## 14. Industry context

> Log-structured storage went from "academic curiosity" (Mendel Rosenblum's 1991 LFS paper) to "the dominant write-heavy storage architecture" over about 20 years. The cause was SSDs: random-write penalty stopped being unique to spinning disks, sequential writes stopped being slower than random writes, and the firmware *inside* the SSD started doing LSM-shaped GC anyway.

- **Active debate**: B-tree vs. LSM for *read-heavy* workloads. LMDB partisans (Howard Chu) argue B-tree wins on reads by a wide margin; LSM partisans (Facebook RocksDB team) argue compaction tuning closes most of the gap and you keep the write wins. The honest answer is workload-dependent.
- **Historical context**: Bitcask (Riak, 2010) popularized the "all keys in RAM" log-structured design. LevelDB (Google, 2011, by Sanjay Ghemawat and Jeff Dean) introduced the modern LSM as widely used. RocksDB (Facebook, 2013) was a fork optimized for SSDs at scale.
- **What a tech lead would ask**: "What's your write amplification?" (How many bytes do you write to disk per byte from the client? LSM trees in the worst case: 10×+.) "What's your read amplification?" (How many disk reads per logical read? LSM: ~1 in the best case if the index is in RAM and the value is in the most-recent SSTable.) "How do you handle a dirty crash mid-compaction?" (The new file isn't visible until atomically renamed; if you crash before the rename, recover from the originals.)
- **Forward-looking**: Tiered storage (hot data on NVMe, warm on SSD, cold on S3) is reshaping all of these designs. Disaggregated storage (S3-as-WAL, e.g., Neon, WarpStream) is the most active research front.
- **Names worth knowing**: Mendel Rosenblum (LFS paper), Patrick O'Neil (LSM paper), Sanjay Ghemawat (LevelDB), Howard Chu (LMDB), Mark Callaghan (RocksDB performance, blog at smalldatum.blogspot.com).

---

## 15. Self-check questions

1. Why does the CRC have to come *before* the variable-length parts in the record header?
2. What happens during recovery if you crash mid-write of a 4 KB value?
3. Why is `pread` better than `lseek` + `read` for KV reads?
4. What does Bitcask sacrifice to keep all keys in RAM?
5. Why don't you `fsync` after every write in a high-throughput system?
6. Why must tombstones survive compaction until *all* dead versions are gone?
7. What's the structural difference between Bitcask and LevelDB?

If you can answer these, you have absorbed roughly the first three years of "how databases work" without reading a single SIGMOD paper.
