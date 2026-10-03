#ifndef DYN_ARRAY_H
#define DYN_ARRAY_H

#include <stddef.h>
#include <stdbool.h>

/*
 * A dynamic array of int.
 *
 * Three fields tell the whole story:
 *   data: pointer to a heap buffer holding the elements
 *   len:  how many elements are actually in use
 *   cap:  how many elements the buffer can hold before we must grow
 *
 * Invariant: 0 <= len <= cap, and `data` points to a buffer of
 * cap * sizeof(int) bytes (or is NULL when cap == 0).
 *
 * Every dynamic-array implementation in every language --
 * JS arrays, Python lists, Rust Vec, Go slices, C++ std::vector --
 * is some elaboration on this triple.
 */
typedef struct {
    int    *data;
    size_t  len;
    size_t  cap;
} DynArray;

/* Initialize an empty array. No heap allocation yet -- we wait until first push. */
void da_init(DynArray *a);

/* Free the underlying buffer. Safe to call on an empty array, and safe twice. */
void da_free(DynArray *a);

/* Push value to the end. Grows the buffer if needed.
 * Returns true on success, false if memory allocation failed. */
bool da_push(DynArray *a, int value);

/* Pop the last element into *out. Returns false if the array is empty.
 * `out` may be NULL if you don't need the value. */
bool da_pop(DynArray *a, int *out);

/* Get element at index i into *out. Returns false if i is out of bounds. */
bool da_get(const DynArray *a, size_t i, int *out);

/* Set element at index i to value. Returns false if i is out of bounds. */
bool da_set(DynArray *a, size_t i, int value);

/* Reserve capacity for at least min_cap elements.
 * Useful when you know roughly how many you'll push and want to avoid reallocs. */
bool da_reserve(DynArray *a, size_t min_cap);

#endif /* DYN_ARRAY_H */
