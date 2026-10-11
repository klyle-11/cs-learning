#!/bin/bash
# Exercise the complete store API on a scratch workspace.  The store is the
# ESP32 program built for a computer, so these checks do not touch data/.
set -eu
cd "$(dirname "$0")/.."
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) mkdir -p build; WORK="$(mktemp -d "$PWD/build/store-test.XXXXXX")"; EXE=.exe ;;
  *) WORK="$(mktemp -d)"; EXE= ;;
esac
PORT=${STORE_PORT:-4415}
BASE="http://127.0.0.1:$PORT"
STORE=${STORE:-./store$EXE}
PID=
CURL_TLS=
trap '[ -n "$PID" ] && kill "$PID" 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"' EXIT

mkdir -p "$WORK/ws/folder/not-empty" "$WORK/ws/empty" "$WORK/ws/.removed" "$WORK/www/js"
printf '<!doctype html><title>Store test</title>\n' > "$WORK/www/index.html"
printf 'export const works = true;\n' > "$WORK/www/app.js"
printf '<!doctype html><p>self-signed certificate</p>\n' > "$WORK/www/store-trust.html"
printf 'const storeTrust = true;\n' > "$WORK/www/store-trust.js"
printf '0123456789abcdefghij' > "$WORK/ws/media.mp4"
printf 'inside\n' > "$WORK/ws/folder/not-empty/file.txt"
printf 'hidden\n' > "$WORK/ws/.hidden"

start() {
  HUB_SETUP_CODE=123456 "$STORE" "$WORK/ws" --www "$WORK/www" --host 127.0.0.1 --port "$PORT" "$@" > "$WORK/store.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 100); do
    curl $CURL_TLS -sS -o /dev/null -m 1 "$BASE/" 2>/dev/null && return
    sleep 0.05
  done
  echo "store did not start"; cat "$WORK/store.log"; exit 1
}
stop() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=; }

BODY="$WORK/body"; HEAD="$WORK/head"; CODE=
request() {
  CODE=$(curl $CURL_TLS -sS -m 8 -D "$HEAD" -o "$BODY" -w '%{http_code}' "$@") || { echo "curl failed: $*"; cat "$WORK/store.log"; exit 1; }
}
status() {
  local want=$1; shift
  request "$@"
  if [ "$CODE" != "$want" ]; then echo "wanted $want, got $CODE: $*"; cat "$BODY"; exit 1; fi
}
json_assert() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert eval(sys.argv[2], {"d":d})' "$BODY" "$1"
}
auth() { printf '%s' 'Authorization: Bearer first-password'; }

start

# Public page and device description; everything else needs the password.
status 200 "$BASE/"
grep -qi '^ETag:' "$HEAD"
status 200 "$BASE/app.js"
status 200 "$BASE/trust"
grep -q 'self-signed certificate' "$BODY"
status 200 "$BASE/trust.js"
status 200 "$BASE/api/device"
json_assert 'd["store"] is True and d["profile"] == "store-t3s3" and d["passwordSet"] is False and d["maxUpload"] == 4294967295'
status 401 "$BASE/raw/media.mp4"
json_assert 'd["error"] == "password required"'

# First setup is code-gated; the password is 8..128 characters.
status 400 -X POST -H 'Content-Type: application/json' --data '{"code":"123456","password":"short"}' "$BASE/api/password"
status 403 -X POST -H 'Content-Type: application/json' --data '{"code":"000000","password":"first-password"}' "$BASE/api/password"
status 204 -X POST -H 'Content-Type: application/json' --data '{"code":"123456","password":"first-password"}' "$BASE/api/password"
status 200 "$BASE/api/device"; json_assert 'd["passwordSet"] is True'
status 401 -H 'Authorization: Bearer wrong' "$BASE/api/list?path="

# Origin is checked before authorization; this server's own origin is accepted.
status 403 -H "$(auth)" -H 'Origin: https://evil.example' "$BASE/api/list?path="
status 403 -H "$(auth)" -H 'Sec-Fetch-Site: cross-site' "$BASE/api/list?path="
status 200 -H "$(auth)" -H "Origin: $BASE" "$BASE/api/list?path="

# A listing is valid JSON in directory order, includes metadata, and hides dot names.
status 200 -H "$(auth)" "$BASE/api/list?path="
json_assert 'set(x["name"] for x in d) == {"folder", "empty", "media.mp4"} and all(set(x) == {"name","dir","size","mtime"} for x in d)'
status 200 -H "$(auth)" "$BASE/api/list?path=&hidden=1"
json_assert '".removed" in [x["name"] for x in d] and ".hidden" in [x["name"] for x in d] and ".hub-cache" not in [x["name"] for x in d]'
status 404 -H "$(auth)" "$BASE/api/list?path=missing"

# Whole and ranged reads, ETags, content types, and sandboxing.
status 200 -H "$(auth)" "$BASE/raw/media.mp4"
[ "$(cat "$BODY")" = '0123456789abcdefghij' ]
ETAG=$(tr -d '\r' < "$HEAD" | awk -F': ' 'tolower($1)=="etag" {print $2}')
grep -qi '^Accept-Ranges: bytes' "$HEAD"
status 304 -H "$(auth)" -H "If-None-Match: $ETAG" "$BASE/raw/media.mp4"
status 206 -H "$(auth)" -H 'Range: bytes=2-5' "$BASE/raw/media.mp4"; [ "$(cat "$BODY")" = '2345' ]; grep -qi '^Content-Range: bytes 2-5/20' "$HEAD"
status 206 -H "$(auth)" -H 'Range: bytes=15-' "$BASE/raw/media.mp4"; [ "$(cat "$BODY")" = 'fghij' ]
status 206 -H "$(auth)" -H 'Range: bytes=-4' "$BASE/raw/media.mp4"; [ "$(cat "$BODY")" = 'ghij' ]
status 416 -H "$(auth)" -H 'Range: bytes=50-60' "$BASE/raw/media.mp4"; grep -qi '^Content-Range: bytes \*/20' "$HEAD"
printf '<script>bad()</script>\n' > "$WORK/ws/page.html"
status 200 -H "$(auth)" "$BASE/raw/page.html"; grep -qi '^Content-Security-Policy: sandbox' "$HEAD"

# PUT is streamed through .hub-cache, makes destination folders only after the
# body arrives, and honours both forms of optimistic concurrency.
status 201 -X PUT -H "$(auth)" -H 'If-None-Match: *' --data-binary 'one' "$BASE/raw/new/deep.txt"
json_assert 'd["size"] == 3 and d["etag"].startswith(chr(34))'
NEW_ETAG=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["etag"])' "$BODY")
status 412 -X PUT -H "$(auth)" -H 'If-None-Match: *' --data-binary 'two' "$BASE/raw/new/deep.txt"
status 412 -X PUT -H "$(auth)" -H 'If-Match: "wrong"' --data-binary 'two' "$BASE/raw/new/deep.txt"
status 200 -X PUT -H "$(auth)" -H "If-Match: $NEW_ETAG" --data-binary 'replacement' "$BASE/raw/new/deep.txt"
status 413 -X PUT -H "$(auth)" -H 'Content-Length: 4294967296' "$BASE/raw/too-big.bin"
status 200 -H "$(auth)" "$BASE/raw/new/deep.txt"; [ "$(cat "$BODY")" = replacement ]

# Move, delete a file or empty folder, and reject a non-empty folder.
status 200 -X POST -H "$(auth)" -H 'Content-Type: application/json' --data '{"from":"new/deep.txt","to":"moved/deep.txt"}' "$BASE/api/move"
status 409 -X POST -H "$(auth)" -H 'Content-Type: application/json' --data '{"from":"media.mp4","to":"moved/deep.txt"}' "$BASE/api/move"
status 404 -X POST -H "$(auth)" -H 'Content-Type: application/json' --data '{"from":"missing","to":"x"}' "$BASE/api/move"
status 200 -X DELETE -H "$(auth)" "$BASE/raw/moved/deep.txt"
status 200 -X DELETE -H "$(auth)" "$BASE/raw/empty"
status 409 -X DELETE -H "$(auth)" "$BASE/raw/folder"
status 404 -X DELETE -H "$(auth)" "$BASE/raw/missing"

# The counter reports exact changed paths while retained, then falls back to all.
status 200 -H "$(auth)" "$BASE/api/changes?since=0"; json_assert 'd.get("all") is True'
status 200 "$BASE/api/device"; BASELINE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["changes"])' "$BODY")
status 201 -X PUT -H "$(auth)" --data-binary x "$BASE/raw/change-one"
status 200 -H "$(auth)" "$BASE/api/changes?since=$BASELINE"; json_assert 'd["paths"] == ["change-one"]'
for i in $(seq 1 65); do status 201 -X PUT -H "$(auth)" --data-binary x "$BASE/raw/many-$i"; done
status 200 -H "$(auth)" "$BASE/api/changes?since=$BASELINE"; json_assert 'd.get("all") is True'
NOW=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["changes"])' "$BODY")
status 200 -H "$(auth)" "$BASE/api/changes?since=$NOW"; json_assert 'd["paths"] == []'

# Every route rejects traversal, empty components, hidden internals, and links.
status 400 -H "$(auth)" --path-as-is "$BASE/raw/../outside"
status 400 -H "$(auth)" --path-as-is "$BASE/raw/a//b"
status 400 -H "$(auth)" "$BASE/raw/.hub-cache/x"
status 400 -H "$(auth)" "$BASE/api/list?path=../outside"
status 400 -X POST -H "$(auth)" -H 'Content-Type: application/json' --data '{"from":"media.mp4","to":"../outside"}' "$BASE/api/move"
if command -v ln >/dev/null 2>&1; then
  ln -s "$(dirname "$WORK")" "$WORK/ws/link" 2>/dev/null || true
  [ ! -L "$WORK/ws/link" ] || status 400 -H "$(auth)" "$BASE/raw/link/outside"
fi

# Changing the password needs both bearer authorization and the current value.
status 403 -X POST -H "$(auth)" -H 'Content-Type: application/json' --data '{"old":"wrong","password":"second-password"}' "$BASE/api/password"
status 204 -X POST -H "$(auth)" -H 'Content-Type: application/json' --data '{"old":"first-password","password":"second-password"}' "$BASE/api/password"
status 401 -H "$(auth)" "$BASE/api/list?path="
status 200 -H 'Authorization: Bearer second-password' "$BASE/api/list?path="

# A completed cache upload left by a power cut is recovered when no old target
# exists; the rest of the private cache is emptied before serving.
stop
mkdir -p "$WORK/ws/.hub-cache/uploads/recovered"
printf 'after power cut\n' > "$WORK/ws/.hub-cache/uploads/recovered/file.txt.tmp"
printf 'discard me\n' > "$WORK/ws/.hub-cache/junk"
start --password second-password
status 200 -H 'Authorization: Bearer second-password' "$BASE/raw/recovered/file.txt"
[ "$(cat "$BODY")" = 'after power cut' ]
[ ! -e "$WORK/ws/.hub-cache/junk" ]

# Over TLS, the board-specific trust page exposes the exact self-signed
# certificate and its fingerprint. A plain request to that listener is sent
# to HTTPS rather than serving the reader unencrypted.
if command -v openssl >/dev/null 2>&1; then
  stop
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=127.0.0.1' \
    -addext 'subjectAltName=IP:127.0.0.1' -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1
  BASE="https://127.0.0.1:$PORT"; CURL_TLS=-k
  start --tls --cert "$WORK/cert.pem" --key "$WORK/key.pem" --password second-password
  status 200 "$BASE/trust"
  status 200 "$BASE/api/trust"; json_assert 'len(d["fingerprint"].split(":")) == 32 and d["encrypted"] is True'
  status 200 "$BASE/hub-store.crt"
  cmp "$BODY" "$WORK/cert.pem"
  BASE="http://127.0.0.1:$PORT"; CURL_TLS=
  status 308 "$BASE/"
  grep -qi '^Location: https://127.0.0.1:' "$HEAD"
fi

echo "PASS: store API"
