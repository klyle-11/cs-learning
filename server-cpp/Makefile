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

# Windows, built in the MSYS2 "UCRT64" shell (see ../WINDOWS.md).
#   - the network and adapter libraries Windows keeps separate
#   - 64-bit file sizes; one .exe with nothing else to install beside it
#   - a manifest that makes file names UTF-8, so names outside ASCII work
ifeq ($(OS),Windows_NT)
EXE      := .exe
CXXFLAGS += -D_FILE_OFFSET_BITS=64
LDFLAGS  += -static
LDLIBS   += -lws2_32 -liphlpapi -lbcrypt
EXTRA    := build/hubd-res.o
build/hubd-res.o: windows/hubd.rc windows/hubd.manifest | build
	windres windows/hubd.rc -O coff -o $@
hubd: hubd.exe
endif

# build/hubd-own is a second copy of the server, for building and testing a
# change while the hub itself is running (Windows will not replace a program
# that is running, so "make hubd" fails then):  make test-own
hubd$(EXE) build/hubd-own$(EXE): build/hub.o build/cJSON.o $(EXTRA)
	$(CXX) $(LDFLAGS) -o $@ $^ $(LDLIBS)

build/hub.o: src/hub.cpp src/http.hpp src/fs.hpp src/status.hpp src/secure.hpp src/platform.hpp src/anchor.hpp src/zip.hpp src/epub.hpp src/links.hpp vendor/cJSON.h | build
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

# Send the recorded requests and compare the answers with test/expected.txt.
test: hubd
	./test/contract.sh
	./test/links.sh
# The server's memory on 20,000 files, on every profile, against a ceiling for each (Linux only).
memory: hubd
	./test/memory.sh
test-own: build/hubd-own$(EXE)
	HUBD=build/hubd-own$(EXE) ./test/contract.sh
	HUBD=build/hubd-own$(EXE) ./test/links.sh

# Put the page on the board's SD card:  make card CARD=/Volumes/NAME
# Everything lives in CARD/hub: the page in hub/www, your documents beside it.
card:
	@test -d "$(CARD)" || { echo "usage: make card CARD=/Volumes/<the card>"; exit 1; }
	mkdir -p "$(CARD)/hub/www/vendor"
	cp ../hub/index.html ../hub/app.js ../hub/local.js ../hub/vault.js ../hub/trust.html ../hub/trust.js ../hub/sw.js ../hub/manifest.webmanifest ../hub/icon-192.png ../hub/icon-512.png ../hub/apple-touch-icon.png "$(CARD)/hub/www/"
	cp ../hub/node_modules/marked/lib/marked.umd.js "$(CARD)/hub/www/vendor/marked.js"
	cp ../hub/node_modules/@highlightjs/cdn-assets/highlight.min.js "$(CARD)/hub/www/vendor/highlight.js"
	cp ../hub/node_modules/dompurify/dist/purify.min.js "$(CARD)/hub/www/vendor/purify.js"
	cp ../hub/node_modules/pdfjs-dist/legacy/build/pdf.min.mjs "$(CARD)/hub/www/vendor/pdf.mjs"
	cp ../hub/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs "$(CARD)/hub/www/vendor/pdf.worker.mjs"
	mkdir -p "$(CARD)/hub/www/vendor/marginalia/wasm"
	cd ../hub/node_modules/marginalia-engine/dist && cp index.js client.js worker.js selection.js selection-engine.js frame.js geometry.js overlay.js surfaces.js caret.js dom.js themes.js recolor.js recolor-worker.js ui.css "$(CARD)/hub/www/vendor/marginalia/"
	cp ../hub/node_modules/marginalia-engine/dist/wasm/marginalia_wasm.js ../hub/node_modules/marginalia-engine/dist/wasm/marginalia_wasm_bg.wasm "$(CARD)/hub/www/vendor/marginalia/wasm/"
	if ls ../hub/js/*.js >/dev/null 2>&1; then mkdir -p "$(CARD)/hub/www/js" && cp ../hub/js/*.js "$(CARD)/hub/www/js/"; fi
	mkdir -p "$(CARD)/hub/www/vendor/pdfjs" && cp -R ../hub/node_modules/pdfjs-dist/cmaps ../hub/node_modules/pdfjs-dist/standard_fonts "$(CARD)/hub/www/vendor/pdfjs/"
	mkdir -p "$(CARD)/hub/www/vendor/fonts" && cp ../hub/node_modules/@fontsource/atkinson-hyperlegible/files/*-latin-*.woff2 ../hub/node_modules/@fontsource/opendyslexic/files/*-latin-*.woff2 "$(CARD)/hub/www/vendor/fonts/"

clean:
	rm -rf build hubd hubd.exe

.PHONY: check test test-own memory clean card
