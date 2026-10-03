#!/bin/bash
# Runs the same requests against the Node server and the C++ server, each on its
# own copy of a small fixture folder, and compares the answers.
#   ./test/contract.sh        (from server-cpp/, after `make`)
set -u
cd "$(dirname "$0")/.."
REPO="$(cd .. && pwd)"
WORK="$(mktemp -d)"
NODE_PORT=4411
CPP_PORT=4412
trap 'kill $NODE_PID $CPP_PID 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"' EXIT

fixture() {
  mkdir -p "$1/a" "$1/b" "$1/notes"
  printf '# Fixture Title\n\nDescription.\n' > "$1/FRONTPAGE.md"
  printf '# First\n\nBody one.\n' > "$1/a/1-doc.md"
  printf '# Tenth\n' > "$1/a/10-doc.md"
  printf 'no heading here\n' > "$1/a/2-doc.md"
  printf '<html><head><title> A Page </title></head><body><h1>Hi</h1></body></html>\n' > "$1/b/page.html"
  printf 'int main(void) { return 0; }\n' > "$1/code.c"
  printf '# ignored\n' > "$1/CLAUDE.md"
  printf '# Refs\n' > "$1/references.md"
  printf 'secret\n' > "$1/.hidden.md"
  printf '{\n  "title": "From hub.json",\n  "side": ["references.md"],\n  "ignore": ["CLAUDE.md"]\n}\n' > "$1/hub.json"
  echo '[]' > "$1/notes/notes.json"
  printf '0123456789abcdefghij' > "$1/b/clip.mp4"
  printf 'not really a png' > "$1/b/pic.png"
}
fixture "$WORK/node/ws"
fixture "$WORK/cpp/ws"

PORT=$NODE_PORT node "$REPO/hub/server.js" "$WORK/node/ws" > "$WORK/node.log" 2>&1 &
NODE_PID=$!
./hubd "$WORK/cpp/ws" --port $CPP_PORT --www "$REPO/hub" > "$WORK/cpp.log" 2>&1 &
CPP_PID=$!
# wait until both answer (the memory-checked build starts slowly)
for port in $NODE_PORT $CPP_PORT; do
  for _ in $(seq 1 50); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$port/api/config" && break; sleep 0.2; done
done

# Print "status body" with the parts that legitimately differ (folder path,
# ids, timestamps) replaced, and JSON keys sorted.
norm() {
  python3 -c '
import sys, json, re
status, root = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
def scrub(v):
    if isinstance(v, dict):
        return {k: ("<id>" if k == "id" else "<ts>" if k == "ts" else scrub(x)) for k, x in v.items()}
    if isinstance(v, list): return [scrub(x) for x in v]
    if isinstance(v, str): return v.replace(root, "<root>")
    return v
try: out = json.dumps(scrub(json.loads(raw)), sort_keys=True)
except Exception: out = raw.replace(root, "<root>")
if sys.argv[3] == "status-only": out = ""
print(status, out)' "$1" "$2" "$3"
}

run() { # run <port> <root>: the request script
  local B="http://127.0.0.1:$1" R="$2" ID
  req() { # req <label> <mode> curl-args...
    local label="$1" mode="$2"; shift 2
    local out; out="$(curl -s -m 5 -w '\n%{http_code}' "$@")"
    echo "## $label"; printf '%s' "${out%$'\n'*}" | norm "${out##*$'\n'}" "$R" "$mode"
  }
  hreq() { # like req, but also shows the headers that matter for partial downloads
    local label="$1"; shift
    echo "## $label"
    curl -s -m 5 -D - -o "$WORK/body" "$@" | tr -d '\r' | grep -iE '^(HTTP/|content-range|accept-ranges|content-type|content-length)' | sed 's/^HTTP\/1.1 \([0-9]*\).*/\1/' | tr 'A-Z' 'a-z' | sort
    echo "body: $(cat "$WORK/body")"
  }
  J=(-H 'Content-Type: application/json')
  req "config"                body "$B/api/config"
  req "docs"                  body "$B/api/docs"
  req "doc"                   body "$B/api/doc?path=a/1-doc.md"
  req "doc missing"           body "$B/api/doc?path=a/nope.md"
  req "doc traversal"         body "$B/api/doc?path=../../etc/passwd"
  req "doc not readable type" body "$B/api/doc?path=hub.json"
  req "raw html"              body "$B/raw/b/page.html"
  req "raw traversal"         body --path-as-is "$B/raw/../../../etc/passwd"
  req "raw encoded traversal" body "$B/raw/%2e%2e/%2e%2e/etc/passwd"
  hreq "media whole"            "$B/raw/b/clip.mp4"
  hreq "media range middle"     -H 'Range: bytes=2-5' "$B/raw/b/clip.mp4"
  hreq "media range open end"   -H 'Range: bytes=15-' "$B/raw/b/clip.mp4"
  hreq "media range last n"     -H 'Range: bytes=-4' "$B/raw/b/clip.mp4"
  hreq "media range past end"   -H 'Range: bytes=10-999' "$B/raw/b/clip.mp4"
  hreq "media range unsatisfiable" -H 'Range: bytes=50-60' "$B/raw/b/clip.mp4"
  hreq "media range nonsense"   -H 'Range: bytes=abc' "$B/raw/b/clip.mp4"
  hreq "text file range"        -H 'Range: bytes=0-6' "$B/raw/a/1-doc.md"
  req "index page"            status-only "$B/"
  req "vendor marked"         status-only "$B/vendor/marked.js"
  req "vendor highlight"      status-only "$B/vendor/highlight.js"
  req "unknown route"         body "$B/api/nope"
  req "notes empty"           body "$B/api/notes"
  req "note create"           body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md","text":"why \"this\"?\nline two","quote":"Body one.","type":"question","heading":"first","headingText":"First"}' "$B/api/notes"
  req "highlight create"      body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md","quote":"Body","type":"important"}' "$B/api/notes"
  req "note with own id"      body -X POST "${J[@]}" -d '{"id":"made-on-phone-1","ts":"2026-01-02T03:04:05.678Z","doc":"a/1-doc.md","text":"written offline"}' "$B/api/notes"
  req "same note again"       body -X POST "${J[@]}" -d '{"id":"made-on-phone-1","doc":"a/1-doc.md","text":"sent twice"}' "$B/api/notes"
  req "own id is usable"      body -X PUT "${J[@]}" -d '{"text":"edited by its own id"}' "$B/api/notes/made-on-phone-1"
  req "note with bad id"      body -X POST "${J[@]}" -d '{"id":"../x","ts":"yesterday","doc":"a/1-doc.md","text":"bad id and time"}' "$B/api/notes"
  req "note bad"              body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md"}' "$B/api/notes"
  ID="$(curl -s "$B/api/notes" | python3 -c 'import sys,json; print([n for n in json.load(sys.stdin) if n["status"] == "highlight"][0]["id"])')"
  req "highlight gets text"   body -X PUT "${J[@]}" -d '{"text":"now annotated ünïcode"}' "$B/api/notes/$ID"
  req "note retype"           body -X PUT "${J[@]}" -d '{"type":"unclear","ignored":"x"}' "$B/api/notes/$ID"
  req "notes list"            body "$B/api/notes"
  req "note delete"           body -X DELETE "$B/api/notes/$ID"
  req "note delete missing"   body -X DELETE "$B/api/notes/$ID"
  req "note put missing"      body -X PUT "${J[@]}" -d '{"text":"x"}' "$B/api/notes/nope"
  req "rename title"          body -X PUT "${J[@]}" -d '{"title":"  Renamed   Title "}' "$B/api/config"
  req "front after rename"    body "$B/api/doc?path=FRONTPAGE.md"
  req "set highlights"        body -X PUT "${J[@]}" -d '{"highlights":[{"id":"a","name":" Alpha ","color":"#AABBCC"},{"id":"b","name":"","color":"#112233"},{"id":"c","name":"bad colour","color":"red"},{"name":"no id","color":"#000000"}]}' "$B/api/config"
  req "edit front"            body -X PUT "${J[@]}" -d '{"markdown":"# Edited\n\nNew text."}' "$B/api/front"
  req "front after edit"      body "$B/api/doc?path=FRONTPAGE.md"
  req "edit front bad"        body -X PUT "${J[@]}" -d '{"nope":1}' "$B/api/front"
  req "upload new"            body -X POST --data-binary '# Uploaded' "$B/api/upload?path=up/new%20file.md"
  req "upload again"          body -X POST --data-binary '# Changed' "$B/api/upload?path=up/new%20file.md"
  req "uploaded content"      body "$B/api/doc?path=up/new%20file.md"
  req "upload traversal"      body -X POST --data-binary 'x' "$B/api/upload?path=../evil.md"
  req "upload hidden"         body -X POST --data-binary 'x' "$B/api/upload?path=up/.secret"
  req "other site posts a note" body -X POST "${J[@]}" -H 'Origin: http://evil.example' -d '{"doc":"a/1-doc.md","text":"planted"}' "$B/api/notes"
  req "other site uploads"      body -X POST -H 'Origin: https://evil.example' --data-binary 'x' "$B/api/upload?path=planted.md"
  req "sandboxed page posts"    body -X POST "${J[@]}" -H 'Origin: null' -d '{"doc":"a/1-doc.md","text":"planted"}' "$B/api/notes"
  req "own page posts"          body -X POST "${J[@]}" -H "Origin: $B" -d '{"doc":"a/1-doc.md","text":"from the page itself"}' "$B/api/notes"
  req "other site may read"     status-only -H 'Origin: http://evil.example' "$B/api/config"
  req "docs after changes"    body "$B/api/docs"
  req "workspaces"            body "$B/api/workspaces"
}

run $NODE_PORT "$WORK/node/ws" > "$WORK/node.out"
run $CPP_PORT "$(cd "$WORK/cpp/ws" && pwd -P)" > "$WORK/cpp.out"
# macOS temp folders are reached through a symlink; the servers report the real path.
sed -i '' "s|$(cd "$WORK/node/ws" && pwd -P)|<root>|g; s|$(cd "$WORK/cpp/ws" && pwd -P)|<root>|g" "$WORK/node.out" "$WORK/cpp.out"

TOTAL=$(grep -c '^## ' "$WORK/node.out")
if diff "$WORK/node.out" "$WORK/cpp.out" > "$WORK/diff.txt"; then
  echo "PASS: $TOTAL requests, identical answers from both servers"
else
  echo "DIFFERENCES (< node, > c++):"
  cat "$WORK/diff.txt"
  echo "--- of $TOTAL requests"
  exit 1
fi
