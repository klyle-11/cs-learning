// Counts the heap a program uses, for test/memory.sh: loaded ahead of the C
// library (LD_PRELOAD), it keeps the bytes in use and the most there has been.
// On SIGUSR1 it appends "in-use peak" (bytes) to the file $HEAPCOUNT_OUT and
// starts the peak again from what is in use. Linux with glibc only
// (malloc_usable_size); memory.sh skips the test elsewhere.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <malloc.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *(*real_malloc)(size_t);
static void (*real_free)(void *);
static void *(*real_realloc)(void *, size_t);
static void *(*real_calloc)(size_t, size_t);
static atomic_long cur, peak;
// dlsym itself allocates before the real functions are known: served from here.
static char boot[1 << 16];
static size_t boot_used;

static void bump(long d) {
  long c = atomic_fetch_add(&cur, d) + d, p = atomic_load(&peak);
  while (c > p && !atomic_compare_exchange_weak(&peak, &p, c)) {}
}
static void dump(int sig) {
  (void)sig;
  const char *o = getenv("HEAPCOUNT_OUT");
  FILE *f = fopen(o ? o : "/dev/stderr", "a");
  if (f) { fprintf(f, "%ld %ld\n", atomic_load(&cur), atomic_load(&peak)); fclose(f); }
  atomic_store(&peak, atomic_load(&cur));
}
static int in_boot(void *p) { return (char *)p >= boot && (char *)p < boot + sizeof boot; }
static void *from_boot(size_t n) { void *p = boot + boot_used; boot_used += (n + 15) & ~(size_t)15; return p; }
static void init(void) {
  static int busy;
  if (real_malloc || busy) return;
  busy = 1;
  real_calloc = dlsym(RTLD_NEXT, "calloc");
  real_malloc = dlsym(RTLD_NEXT, "malloc");
  real_free = dlsym(RTLD_NEXT, "free");
  real_realloc = dlsym(RTLD_NEXT, "realloc");
  signal(SIGUSR1, dump);
}
void *malloc(size_t n) {
  if (!real_malloc) init();
  if (!real_malloc) return from_boot(n);
  void *p = real_malloc(n);
  if (p) bump((long)malloc_usable_size(p));
  return p;
}
void free(void *p) {
  if (!p || in_boot(p)) return;
  bump(-(long)malloc_usable_size(p));
  real_free(p);
}
void *calloc(size_t a, size_t b) {
  if (!real_calloc) { void *p = from_boot(a * b); memset(p, 0, a * b); return p; }
  void *p = real_calloc(a, b);
  if (p) bump((long)malloc_usable_size(p));
  return p;
}
void *realloc(void *p, size_t n) {
  if (!real_realloc) init();
  if (p && in_boot(p)) { void *q = malloc(n); if (q) memcpy(q, p, n); return q; }
  long before = p ? (long)malloc_usable_size(p) : 0;
  void *q = real_realloc(p, n);
  if (q) bump((long)malloc_usable_size(q) - before);
  else if (!n) bump(-before);
  return q;
}
