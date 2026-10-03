CC      = gcc
CFLAGS  = -Wall -Wextra -std=c11 -g -O0

all: test

test: test.c dyn_array.c dyn_array.h
	$(CC) $(CFLAGS) -o test test.c dyn_array.c

run: test
	./test

clean:
	rm -f test

.PHONY: all run clean
