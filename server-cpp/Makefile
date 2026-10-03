CXX      ?= c++
CC       ?= cc
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -Wshadow -Wconversion -fstack-protector-strong
CFLAGS   ?= -O2 -Wall
LDFLAGS  ?= -pthread
# mbedTLS 3.x: TLS, certificates, hashes and random numbers (the library ESP-IDF ships).
#   macOS: brew install mbedtls      Debian/Ubuntu: apt install libmbedtls-dev
MBEDTLS  ?= $(firstword $(wildcard /opt/homebrew/opt/mbedtls /usr/local/opt/mbedtls))
ifneq ($(MBEDTLS),)
CXXFLAGS += -I$(MBEDTLS)/include
LDFLAGS  += -L$(MBEDTLS)/lib
endif
LDLIBS   ?= -lmbedtls -lmbedx509 -lmbedcrypto

hubd: build/hub.o build/cJSON.o
	$(CXX) $(LDFLAGS) -o $@ $^ $(LDLIBS)

build/hub.o: src/hub.cpp src/http.hpp src/secure.hpp vendor/cJSON.h | build
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

# Put the page on the board's SD card:  make card CARD=/Volumes/NAME
# Everything lives in CARD/hub: the page in hub/www, your documents beside it.
card:
	@test -d "$(CARD)" || { echo "usage: make card CARD=/Volumes/<the card>"; exit 1; }
	mkdir -p "$(CARD)/hub/www/vendor"
	cp ../hub/index.html ../hub/app.js ../hub/local.js ../hub/vault.js ../hub/trust.html ../hub/trust.js "$(CARD)/hub/www/"
	cp ../hub/node_modules/marked/lib/marked.umd.js "$(CARD)/hub/www/vendor/marked.js"
	cp ../hub/node_modules/@highlightjs/cdn-assets/highlight.min.js "$(CARD)/hub/www/vendor/highlight.js"
	cp ../hub/node_modules/dompurify/dist/purify.min.js "$(CARD)/hub/www/vendor/purify.js"

clean:
	rm -rf build hubd

.PHONY: check test clean card
