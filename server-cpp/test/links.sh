#!/bin/bash
# Symbolic links put into the workspace by hand (review, finding 14). One that leads out of the workspace is not
# listed, searched or served, and nothing is written or removed through it; one that leads elsewhere in the workspace
# still works. Windows needs extra rights to make links, so there this says so and stops.
#   ./test/links.sh     (from server-cpp/, after `make`; `make test` runs it after contract.sh)
set -u
cd "$(dirname "$0")/.."
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) echo "links: not tried here (no symbolic links without extra rights)"; exit 0 ;; esac
WORK="$(mktemp -d)"
PORT=4413
trap 'kill $PID 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/ws/notes" "$WORK/ws/real" "$WORK/outside/deep"
echo '[]' > "$WORK/ws/notes/notes.json"
printf '# Inside\n\nfindme inside\n' > "$WORK/ws/real/in.md"
printf '# Secret\n\nfindme secret\n' > "$WORK/outside/secret.md"
printf '# Deep\n' > "$WORK/outside/deep/d.md"
ln -s "$WORK/outside" "$WORK/ws/out"                  # a folder outside
ln -s "$WORK/outside/secret.md" "$WORK/ws/secret.md"  # a file outside
ln -s real "$WORK/ws/alias"                           # a folder inside
"${HUBD:-./hubd}" "$WORK/ws" --port $PORT --state "$WORK/state" > "$WORK/log" 2>&1 &
PID=$!
B="http://127.0.0.1:$PORT"
for _ in $(seq 1 50); do curl -s -o /dev/null -m 1 "$B/" && break; sleep 0.2; done
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: expected $2, got $3"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
has() { if curl -s "$1" | grep -q "$2"; then echo yes; else echo no; fi; }
check "a file outside, as itself"            404 "$(code "$B/raw/secret.md")"
check "a file outside, as a document"        404 "$(code "$B/api/doc?path=secret.md")"
check "through a folder outside"             404 "$(code "$B/raw/out/secret.md")"
check "through it, as a document"            404 "$(code "$B/api/doc?path=out/secret.md")"
check "through it, its blocks"               404 "$(code "$B/api/blocks?path=out/secret.md")"
check "through it, its SHA-256"              404 "$(code "$B/api/sha256?path=out/secret.md")"
check "through it, its files"                404 "$(code "$B/api/files?path=out")"
check "listed"                               no  "$(has "$B/api/docs" 'secret\|"out/')"
check "found"                                no  "$(has "$B/api/search?q=findme" 'secret')"
check "an upload through it"                 400 "$(code -X POST --data-binary x "$B/api/upload?path=out/planted.md")"
check "nothing written outside"              no  "$(test -e "$WORK/outside/planted.md" && echo yes || echo no)"
check "removing a folder through it"         400 "$(code -X DELETE "$B/api/folder?path=out/deep")"
check "nothing removed outside"              yes "$(test -e "$WORK/outside/deep/d.md" && echo yes || echo no)"
check "a front page through it"              400 "$(code -X PUT -H 'Content-Type: application/json' -d '{"folder":"out","markdown":"# X"}' "$B/api/front")"
check "a link inside the workspace, served"  200 "$(code "$B/raw/alias/in.md")"
check "and listed"                           yes "$(has "$B/api/docs" 'alias/in.md')"
[ $fail = 0 ] && echo "PASS: links" || echo "FAIL: links"
exit $fail
