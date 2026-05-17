#include "dyn_array.h"
#include <stdio.h>
#include <assert.h>

/* Each test runs an assertion-protected scenario.
 * If any assert() fails, the program crashes with a useful message. */

static void test_init_and_free(void) {
    DynArray a;
    da_init(&a);
    assert(a.data == NULL);
    assert(a.len == 0);
    assert(a.cap == 0);
    da_free(&a);  /* free on empty array is safe */
}

static void test_push_and_get(void) {
    DynArray a;
    da_init(&a);

    for (int i = 0; i < 100; i++) {
        assert(da_push(&a, i * 10));
    }
    assert(a.len == 100);

    int out;
    assert(da_get(&a, 0, &out)  && out == 0);
    assert(da_get(&a, 50, &out) && out == 500);
    assert(da_get(&a, 99, &out) && out == 990);
    assert(!da_get(&a, 100, &out));  /* out of bounds -- crucial that this fails */

    da_free(&a);
}

static void test_set(void) {
    DynArray a;
    da_init(&a);
    da_push(&a, 1); da_push(&a, 2); da_push(&a, 3);

    assert(da_set(&a, 1, 99));
    int out;
    assert(da_get(&a, 1, &out) && out == 99);
    assert(!da_set(&a, 10, 0));  /* out of bounds */

    da_free(&a);
}

static void test_pop(void) {
    DynArray a;
    da_init(&a);
    da_push(&a, 1); da_push(&a, 2); da_push(&a, 3);

    int out;
    assert(da_pop(&a, &out) && out == 3);
    assert(da_pop(&a, &out) && out == 2);
    assert(da_pop(&a, &out) && out == 1);
    assert(!da_pop(&a, &out));  /* empty */

    da_free(&a);
}

static void test_capacity_doubling(void) {
    /* This is the test that makes the lesson concrete.
     * We print every capacity change. Watch how few there are. */
    DynArray a;
    da_init(&a);

    size_t prev_cap = 0;
    int growths = 0;
    for (int i = 0; i < 1000; i++) {
        da_push(&a, i);
        if (a.cap != prev_cap) {
            printf("    push #%4d: cap grew %4zu -> %4zu\n", i, prev_cap, a.cap);
            prev_cap = a.cap;
            growths++;
        }
    }
    printf("    -> 1000 pushes triggered only %d grow operations.\n", growths);
    printf("    -> This is why arr.push() feels free in JavaScript.\n");
    /* 1000 elements with doubling from 8 grows ~7-8 times, not 1000. */
    assert(growths < 15);

    da_free(&a);
}

static void test_reserve(void) {
    DynArray a;
    da_init(&a);

    assert(da_reserve(&a, 1000));
    assert(a.cap >= 1000);
    assert(a.len == 0);  /* reserve doesn't add elements */

    /* Now we can push 1000 items with zero growths. */
    size_t cap_before = a.cap;
    for (int i = 0; i < 1000; i++) da_push(&a, i);
    assert(a.cap == cap_before);

    da_free(&a);
}

int main(void) {
    printf("test_init_and_free... ");        test_init_and_free();        printf("ok\n");
    printf("test_push_and_get... ");         test_push_and_get();         printf("ok\n");
    printf("test_set... ");                  test_set();                  printf("ok\n");
    printf("test_pop... ");                  test_pop();                  printf("ok\n");
    printf("test_reserve... ");              test_reserve();              printf("ok\n");
    printf("test_capacity_doubling:\n");     test_capacity_doubling();    printf("  ok\n");

    printf("\nAll tests passed.\n");
    return 0;
}
