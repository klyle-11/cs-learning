#!/bin/bash
# The server's memory on a folder of 20,000 files, on each profile, against a
# ceiling per profile: memory efficiency is kept on every platform, and the
# boards' limits are the tighter ones. Fails if any request or the server at
# rest goes over. Linux with glibc only (the heap is counted by test/heapcount.c,
# loaded ahead of the C library); elsewhere it says so and stops.
#   ./test/memory.sh        (from server-cpp/, after `make`; `make memory`)
#   KEEP=1 ./test/memory.sh keep the folder made for it, and print where
#
# Each line: the profile, the step, KB in use after it, the most there was
# during it, and the ceiling for that profile. The ceilings are about a third
# above what was measured on 11 October 2026; a change that holds what these
# profiles were built not to hold (the list in memory, a folder's names all at
# once, a cached file copied for each answer) goes well past them.
set -u
cd "$(dirname "$0")/.."
case "$(uname -s)" in Linux) ;; *) echo "memory: not measured here (needs Linux with glibc)"; exit 0 ;; esac
command -v python3 >/dev/null || { echo "memory: needs python3"; exit 1; }
WORK="$(mktemp -d)"
PORT=4414
B=http://127.0.0.1:$PORT
SRV=
trap '[ -n "$SRV" ] && kill $SRV 2>/dev/null; wait 2>/dev/null; [ -n "${KEEP:-}" ] && echo "kept: $WORK" || rm -rf "$WORK"' EXIT
mkdir -p build
cc -shared -fPIC -O2 -o build/heapcount.so test/heapcount.c -ldl || { echo "memory: could not build test/heapcount.c"; exit 1; }

# The folder: a camera roll of 15,000 pictures in one folder, 50 courses of 100
# documents, 20 books of 30 pages, 30 files of links and 30 text files without.
python3 - "$WORK/ws" <<'PYEOF'
import os, sys, zipfile
d = sys.argv[1]
os.makedirs(d + '/notes'); open(d + '/notes/notes.json', 'w').write('[]')
open(d + '/FRONTPAGE.md', 'w').write('# Memory test\n')
os.makedirs(d + '/photos/camera-roll')
for i in range(15000): open(f'{d}/photos/camera-roll/IMG_{i:05d}_holiday_picture.jpg', 'wb').write(b'x')
for c in range(50):
    os.makedirs(f'{d}/course-{c:02d}-something-long-enough')
    for k in range(100): open(f'{d}/course-{c:02d}-something-long-enough/{k:03d}-lesson.md', 'w').write(f'# Lesson {k} of course {c}\n\nfindme words ' * 3)
os.makedirs(d + '/books'); os.makedirs(d + '/links')
page = '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>%s</title></head><body><h1>%s</h1><p>%s</p></body></html>\n'
for b in range(20):
    with zipfile.ZipFile(f'{d}/books/book-{b:02d}.epub', 'w') as z:
        z.writestr('mimetype', 'application/epub+zip', zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>', zipfile.ZIP_DEFLATED)
        items = ''.join(f'<item id="c{i}" href="text/ch{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(30))
        spine = ''.join(f'<itemref idref="c{i}"/>' for i in range(30))
        z.writestr('OEBPS/content.opf', f'<package><metadata><dc:title>Book {b}</dc:title></metadata><manifest>{items}</manifest><spine>{spine}</spine></package>', zipfile.ZIP_DEFLATED)
        for i in range(30): z.writestr(f'OEBPS/text/ch{i}.xhtml', page % (f'Chapter {i}', f'Chapter {i}', 'words ' * 2000), zipfile.ZIP_DEFLATED)
for i in range(30):
    open(f'{d}/links/saved-{i:02d}.json', 'w').write('[' + ','.join('{"mediaUrl":"https://i.example/%d.jpg","title":"t%d"}' % (k, k) for k in range(50)) + ']')
    open(f'{d}/links/plain-{i:02d}.txt', 'w').write('no addresses here\n' * 100)
PYEOF

# Ceilings, in KB: the most during any step, and what is in use at rest.
declare -A PEAK=( [desktop]=6144 [small]=6144 [esp32]=256 [esp32-psram]=1408 )
declare -A RESTKB=( [desktop]=2048 [small]=2048 [esp32]=128 [esp32-psram]=256 )
# The page files a profile may keep in memory (its most_held), in KB: the cache may grow by this much, no more.
declare -A CACHEKB=( [desktop]=16384 [small]=4096 [esp32]=0 [esp32-psram]=1024 )
FAIL=0
for PROFILE in desktop small esp32 esp32-psram; do
  OUT="$WORK/heap-$PROFILE.txt"; rm -f "$OUT"; rm -rf "$WORK/ws/.hub-cache" "$WORK/ws/up"
  HEAPCOUNT_OUT="$OUT" LD_PRELOAD="$PWD/build/heapcount.so" "${HUBD:-./hubd}" "$WORK/ws" --port $PORT --www ../hub --state "$WORK/state-$PROFILE" --profile $PROFILE > "$WORK/log-$PROFILE.txt" 2>&1 &
  SRV=$!
  for _ in $(seq 1 100); do curl -s -o /dev/null -m 1 $B/ && break; sleep 0.1; done
  step() {   # step <name>: the heap now and the most since the last step, against the ceilings
    kill -USR1 $SRV; sleep 0.3
    read -r now most < <(tail -1 "$OUT")
    local now_kb=$((now / 1024)) most_kb=$((most / 1024)) mark=ok
    [ $most_kb -gt ${PEAK[$PROFILE]} ] && { mark=OVER; FAIL=1; }
    printf '  %-12s %-28s in use %6d KB, at most %6d KB  (ceiling %d KB)  %s\n' "$PROFILE" "$1" $now_kb $most_kb ${PEAK[$PROFILE]} $mark
  }
  step "start-up"
  curl -s -o /dev/null $B/api/docs; step "the list, first"
  curl -s -o /dev/null $B/api/docs; step "the list, again"
  curl -s -o /dev/null -X POST --data-binary '# x' "$B/api/upload?path=up/a.md"; step "an upload"
  curl -s -N $B/api/events > /dev/null & EV=$!
  sleep 3; step "3 s with a page open"
  curl -s -o /dev/null $B/api/docs; step "the list after the upload"
  curl -s -o /dev/null "$B/api/search?q=findme"; step "a search"
  curl -s -o /dev/null "$B/api/files?path=photos"; step "a folder's files"
  kill $EV 2>/dev/null
  sleep 0.5; step "at rest"
  read -r rest _ < <(tail -1 "$OUT")
  if [ $((rest / 1024)) -gt ${RESTKB[$PROFILE]} ]; then echo "  $PROFILE: $((rest / 1024)) KB in use at rest, over its ceiling of ${RESTKB[$PROFILE]} KB"; FAIL=1; fi
  # The engine's WebAssembly (2.6 MB), twice: kept in memory only within the profile's bound, and never copied for an answer.
  curl -s -o /dev/null "$B/vendor/marginalia/wasm/marginalia_wasm_bg.wasm"; curl -s -o /dev/null "$B/vendor/marginalia/wasm/marginalia_wasm_bg.wasm"; step "a large page file, twice"
  read -r now most < <(tail -1 "$OUT")
  # (64 KB of slack: a connection's own bookkeeping)
  if [ $(((now - rest) / 1024)) -gt $((CACHEKB[$PROFILE] + 64)) ]; then echo "  $PROFILE: the page-file cache grew by $(((now - rest) / 1024)) KB, past its bound of ${CACHEKB[$PROFILE]} KB"; FAIL=1; fi
  if [ $(((most - now) / 1024)) -gt 512 ]; then echo "  $PROFILE: sending a kept page file took $(((most - now) / 1024)) KB more for a while: a copy for the answer?"; FAIL=1; fi
  kill $SRV; wait $SRV 2>/dev/null; SRV=
done
[ $FAIL = 0 ] && echo "PASS: memory within every profile's ceilings" || { echo "FAIL: over a ceiling (above)"; exit 1; }
