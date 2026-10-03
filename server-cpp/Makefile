CXX      ?= c++
CC       ?= cc
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -Wshadow -Wconversion -fstack-protector-strong
CFLAGS   ?= -O2 -Wall
LDFLAGS  ?= -pthread

hubd: build/hub.o build/cJSON.o
	$(CXX) $(LDFLAGS) -o $@ $^

build/hub.o: src/hub.cpp src/http.hpp vendor/cJSON.h | build
	$(CXX) $(CXXFLAGS) -c -o $@ src/hub.cpp

build/cJSON.o: vendor/cJSON.c vendor/cJSON.h | build
	$(CC) $(CFLAGS) -c -o $@ vendor/cJSON.c

build:
	mkdir -p build

# A build that reports memory errors and undefined behaviour as they happen.
check: CXXFLAGS += -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer
check: CFLAGS += -g -O1 -fsanitize=address,undefined
check: LDFLAGS += -fsanitize=address,undefined
check: clean hubd

# Compare this server with the Node one on the same folder.
test: hubd
	./test/contract.sh

clean:
	rm -rf build hubd

.PHONY: check test clean
