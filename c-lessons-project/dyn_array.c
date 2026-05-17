#include "dyn_array.h"
#include <stdlib.h>
#include <string.h>

/*
 * Why 8? Small enough not to waste memory on tiny arrays; large enough
 * that very short arrays don't trigger a realloc on every push.
 * V8 (Chrome's JS engine) uses similar heuristics with more complexity
 * around "holey" vs "packed" representations.
 */
#define INITIAL_CAP 8

void da_init(DynArray *a) {
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
}

void da_free(DynArray *a) {
    /* free(NULL) is defined and safe -- which is why we can call this
     * on a zero-initialized DynArray without any special-casing. */
    free(a->data);
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
}

/*
 * Internal helper: grow the buffer to at least new_cap.
 *
 * realloc(NULL, n) is equivalent to malloc(n), so this works for
 * both first-time allocation and subsequent growth. realloc also
 * handles the copy-from-old-to-new if it can't extend in place.
 */
static bool da_grow(DynArray *a, size_t new_cap) {
    int *new_data = realloc(a->data, new_cap * sizeof(int));
    if (new_data == NULL) {
        /* realloc failed. Critically: the ORIGINAL buffer is still
         * valid -- we haven't lost any data. We just couldn't grow.
         * Returning false lets the caller decide what to do. */
        return false;
    }
    a->data = new_data;
    a->cap  = new_cap;
    return true;
}

bool da_push(DynArray *a, int value) {
    if (a->len == a->cap) {
        /* Out of space. Time to grow.
         *
         * THE crucial choice: DOUBLE capacity, not add a constant.
         * This is what makes push amortized O(1).
         *
         * If we added a constant K each time, pushing N items would do
         * N/K growths, each copying up to N items -- total O(N^2 / K).
         *
         * Doubling means log2(N) growths. The copying work across all
         * of them sums to N + N/2 + N/4 + ... < 2N -- linear total,
         * so O(1) per push on average. */
        size_t new_cap = (a->cap == 0) ? INITIAL_CAP : a->cap * 2;
        if (!da_grow(a, new_cap)) return false;
    }
    a->data[a->len++] = value;
    return true;
}

bool da_pop(DynArray *a, int *out) {
    if (a->len == 0) return false;
    a->len--;
    if (out) *out = a->data[a->len];
    /* Deliberate: we do NOT shrink the buffer on pop. Shrinking would
     * defeat the amortized guarantee on subsequent pushes. Most real
     * implementations only shrink on explicit request. */
    return true;
}

bool da_get(const DynArray *a, size_t i, int *out) {
    if (i >= a->len) return false;
    *out = a->data[i];
    return true;
}

bool da_set(DynArray *a, size_t i, int value) {
    if (i >= a->len) return false;
    a->data[i] = value;
    return true;
}

bool da_reserve(DynArray *a, size_t min_cap) {
    if (a->cap >= min_cap) return true;
    return da_grow(a, min_cap);
}
