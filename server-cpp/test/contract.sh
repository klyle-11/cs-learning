#!/bin/bash
# Sends a fixed list of requests to the server, on a small fixture folder, and
# compares the answers with the ones recorded in test/expected.txt. Those were
# recorded when the C++ server and the Node server it replaced gave identical
# answers, so this holds the server to the contract in API.md.
#   ./test/contract.sh            (from server-cpp/, after `make`)
#   UPDATE=1 ./test/contract.sh   record the answers as the new expected ones,
#                                 after reading the differences and meaning them
set -u
cd "$(dirname "$0")/.."
REPO="$(cd .. && pwd)"
WORK="$(mktemp -d)"
CPP_PORT=4412
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=.exe ;; *) EXE= ;; esac
trap 'kill $CPP_PID 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"' EXIT

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
  printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$1/b/drawing.svg"
}
fixture "$WORK/cpp/ws"

# It is told to ask even this machine to pair, so the requests below prove
# that nothing is answered without a paired device's token.
mkdir -p "$WORK/cpp/workspaces"
./hubd$EXE "$WORK/cpp/ws" --port $CPP_PORT --www "$REPO/hub" --state "$WORK/cpp/state" --workspaces "$WORK/cpp/workspaces" --pair-local > "$WORK/cpp.log" 2>&1 &
CPP_PID=$!
# wait until it answers (the memory-checked build starts slowly)
for port in $CPP_PORT; do
  for _ in $(seq 1 50); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$port/" && break; sleep 0.2; done
done
code_in() { grep -o 'pairing code: [A-Z0-9-]*' "$1" | tail -1 | awk '{print $3}'; }

# Print "status body" with the parts that legitimately differ (folder path,
# ids, timestamps) replaced, and JSON keys sorted.
norm() {
  python3 -c '
import sys, json, re
status, root = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
def scrub(v):
    if isinstance(v, dict):
        return {k: ("<" + k + ">" if k in ("id", "ts", "code", "created", "seen", "used", "free") else scrub(x)) for k, x in v.items()}
    if isinstance(v, list): return [scrub(x) for x in v]
    if isinstance(v, str): return v.replace(root, "<root>")
    return v
try: out = json.dumps(scrub(json.loads(raw)), sort_keys=True)
except Exception: out = raw.replace(root, "<root>")
if sys.argv[3] == "status-only": out = ""
print(status, out)' "$1" "$2" "$3"
}

run() { # run <port> <root> <log>: the request script
  local B="http://127.0.0.1:$1" R="$2" LOG="$3" ID JAR="$WORK/jar.$1"
  anon() { # like req, with no token
    local label="$1" mode="$2"; shift 2
    local out; out="$(curl -s -m 5 -w '\n%{http_code}' "$@")"
    echo "## $label"; printf '%s' "${out%$'\n'*}" | norm "${out##*$'\n'}" "$R" "$mode"
  }
  req() { # req <label> <mode> curl-args...
    local label="$1" mode="$2"; shift 2
    local out; out="$(curl -s -m 5 -b "$JAR" -w '\n%{http_code}' "$@")"
    echo "## $label"; printf '%s' "${out%$'\n'*}" | norm "${out##*$'\n'}" "$R" "$mode"
  }
  hreq() { # like req, but also shows the headers that matter for partial downloads
    local label="$1"; shift
    echo "## $label"
    curl -s -m 5 -b "$JAR" -D - -o "$WORK/body" "$@" | tr -d '\r' | grep -iE '^(HTTP/|content-range|accept-ranges|content-type|content-length|content-security-policy|x-content-type-options|x-frame-options|referrer-policy|cross-origin-)' | sed 's/^HTTP\/1.1 \([0-9]*\).*/\1/' | tr 'A-Z' 'a-z' | sort | { if [ "$label" = "page headers" ]; then grep -v '^content-length'; else cat; fi; }
    # The page itself changes whenever the reader does: its headers are the contract, not its text.
    if [ "$label" = "page headers" ]; then echo "body: (the page)"; else echo "body: $(cat "$WORK/body")"; fi
  }
  J=(-H 'Content-Type: application/json')
  # Before pairing: the page itself is public, nothing else is.
  anon "page without pairing"     status-only "$B/"
  anon "script without pairing"   status-only "$B/app.js"
  anon "config without pairing"   body "$B/api/config"
  anon "file without pairing"     body "$B/raw/a/1-doc.md"
  anon "note without pairing"     body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md","text":"planted"}' "$B/api/notes"
  anon "upload without pairing"   body -X POST --data-binary 'x' "$B/api/upload?path=planted.md"
  anon "session without pairing"  body "$B/api/session"
  anon "made-up token"            body -b 'hub_device=0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' "$B/api/config"
  anon "pair with no code"        body -X POST "${J[@]}" -d '{}' "$B/api/pair"
  anon "pair with a wrong code"   body -X POST "${J[@]}" -d '{"code":"AAAA-AAAA","name":"intruder"}' "$B/api/pair"
  anon "pair"                     body -c "$JAR" -X POST "${J[@]}" -d "{\"code\":\"$(code_in "$LOG")\",\"name\":\"  test   device \"}" "$B/api/pair"
  anon "code works once"          body -X POST "${J[@]}" -d "{\"code\":\"$(code_in "$LOG")\"}" "$B/api/pair"
  req "session"               body "$B/api/session"
  req "devices"               body "$B/api/devices"
  req "new pairing code"      body -X POST "$B/api/pair/code"
  req "storage"               body "$B/api/storage"
  req "unknown device"        body -X DELETE "$B/api/devices/nope"
  # A name that is not this machine's: what a DNS-rebinding page would send.
  req "foreign host name"       body -H 'Host: evil.example' "$B/api/config"
  req "foreign host and origin" body -X POST "${J[@]}" -H 'Host: evil.example' -H 'Origin: http://evil.example' -d '{"doc":"a/1-doc.md","text":"planted"}' "$B/api/notes"
  req "other site fetches"      body -H 'Sec-Fetch-Site: cross-site' "$B/api/notes"
  req "other port fetches"      body -H 'Sec-Fetch-Site: same-site' "$B/raw/a/1-doc.md"
  req "own page fetches"        status-only -H 'Sec-Fetch-Site: same-origin' "$B/api/notes"
  hreq "page headers"           "$B/"
  hreq "html file headers"      "$B/raw/b/page.html"
  hreq "svg file headers"       "$B/raw/b/drawing.svg"
  hreq "api headers"            "$B/api/doc?path=a/1-doc.md"
  head -c 1100000 /dev/zero | tr '\0' 'a' > "$WORK/big"
  req "oversized json"          body -X POST "${J[@]}" --data-binary "@$WORK/big" "$B/api/notes"
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
  ID="$(curl -s -b "$JAR" "$B/api/notes" | python3 -c 'import sys,json; print([n for n in json.load(sys.stdin) if n["status"] == "highlight"][0]["id"])')"
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
  req "folder front page"     body -X PUT "${J[@]}" -d '{"folder":"a","markdown":"# Folder A\n\nAbout this folder."}' "$B/api/front"
  req "folder front content"  body "$B/api/doc?path=a/FRONTPAGE.md"
  req "folder front missing"  body -X PUT "${J[@]}" -d '{"folder":"nope","markdown":"# X"}' "$B/api/front"
  req "folder front escape"   body -X PUT "${J[@]}" -d '{"folder":"../..","markdown":"# X"}' "$B/api/front"
  req "edit front bad"        body -X PUT "${J[@]}" -d '{"nope":1}' "$B/api/front"
  mkdir -p "$2/gone/deep" && printf '# Gone\n' > "$2/gone/FRONTPAGE.md" && printf 'x\n' > "$2/gone/deep/x.md"
  req "set locks"             body -X PUT "${J[@]}" -d '{"locks":{"gone":{"salt":"c2FsdA==","hash":"aGFzaA=="},"a":{},"b":{"salt":"<bad>","hash":"x"},"../up":{"salt":"c2FsdA==","hash":"aGFzaA=="},"gone/deep":{}}}' "$B/api/config"
  req "remove folder"         body -X DELETE "$B/api/folder?path=gone"
  req "locks after removal"   body "$B/api/config"
  req "removed folder docs"   body "$B/api/docs"
  req "remove folder again"   body -X DELETE "$B/api/folder?path=gone"
  req "remove folder escape"  body -X DELETE "$B/api/folder?path=../.."
  req "remove notes folder"   body -X DELETE "$B/api/folder?path=notes"
  req "remove notes folder, other case" body -X DELETE "$B/api/folder?path=Notes"
  req "remove a file"         body -X DELETE "$B/api/folder?path=code.c"
  req "upload new"            body -X POST --data-binary '# Uploaded' "$B/api/upload?path=up/new%20file.md"
  req "upload again"          body -X POST --data-binary '# Changed' "$B/api/upload?path=up/new%20file.md"
  req "uploaded content"      body "$B/api/doc?path=up/new%20file.md"
  req "upload traversal"      body -X POST --data-binary 'x' "$B/api/upload?path=../evil.md"
  req "upload hidden"         body -X POST --data-binary 'x' "$B/api/upload?path=up/.secret"
  req "other site posts a note" body -X POST "${J[@]}" -H 'Origin: http://evil.example' -d '{"doc":"a/1-doc.md","text":"planted"}' "$B/api/notes"
  req "other site uploads"      body -X POST -H 'Origin: https://evil.example' --data-binary 'x' "$B/api/upload?path=planted.md"
  req "sandboxed page posts"    body -X POST "${J[@]}" -H 'Origin: null' -d '{"doc":"a/1-doc.md","text":"planted"}' "$B/api/notes"
  req "own page posts"          body -X POST "${J[@]}" -H "Origin: $B" -d '{"doc":"a/1-doc.md","text":"from the page itself"}' "$B/api/notes"
  req "other site reads"        body -H 'Origin: http://evil.example' "$B/api/config"
  # A reader loaded from another hub: it must send its token itself.
  TOKEN=$(awk '$6=="hub_device"{print $7}' "$JAR" | tail -1)
  X=(-H 'Origin: https://other.example:4321')
  cors() { curl -s -o /dev/null -D - "$@" | tr -d '\r' | grep -i -E '^(HTTP|access-control|vary)' | sort; }
  echo "## other hub, cookie only";   curl -s -o /dev/null -w '%{http_code}\n' -b "$JAR" "${X[@]}" "$B/api/hubs"
  echo "## other hub, no token";      curl -s -o /dev/null -w '%{http_code}\n' "${X[@]}" "$B/api/hubs"
  echo "## other hub, bad token";     curl -s -o /dev/null -w '%{http_code}\n' "${X[@]}" -H 'Authorization: Bearer 0123456789abcdef.AAAA' "$B/api/hubs"
  echo "## other hub, token";         curl -s -o /dev/null -w '%{http_code}\n' "${X[@]}" -H "Authorization: Bearer $TOKEN" "$B/api/hubs"
  echo "## other hub, headers";       cors "${X[@]}" -H "Authorization: Bearer $TOKEN" "$B/api/hubs"
  echo "## other hub, preflight";     cors -X OPTIONS "${X[@]}" -H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: authorization,content-type' "$B/api/config"
  echo "## other hub, odd origin";    curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: null' -H "Authorization: Bearer $TOKEN" "$B/api/hubs"
  echo "## other hub, pair no code";  curl -s -o /dev/null -w '%{http_code}\n' "${X[@]}" -X POST "${J[@]}" -d '{"code":"AAAA-AAAA","name":"x"}' "$B/api/pair"
  CODE=$(curl -s -b "$JAR" -X POST "$B/api/pair/code" | grep -o '[A-Z0-9]\{4\}-[A-Z0-9]\{4\}')
  T2=$(curl -s "${X[@]}" -X POST "${J[@]}" -d "{\"code\":\"$CODE\",\"name\":\"other reader\"}" "$B/api/pair" | grep -o '"token": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
  echo "## other hub, pair with code"; [ -n "$T2" ] && echo "given a token"
  echo "## other hub, new token";     curl -s -o /dev/null -w '%{http_code}\n' "${X[@]}" -H "Authorization: Bearer $T2" "$B/api/session"
  req "set hubs"              body -X PUT "${J[@]}" -d '{"hubs":[{"name":"  Desk   top ","url":"https://Desk.local:4321/some/path"},{"name":"dup","url":"https://desk.local:4321"},{"name":"usual port","url":"https://pi.local:443"},{"name":"","url":"https://x.local"},{"name":"bad","url":"ftp://x.local"},{"name":"bad2","url":"not a url"}]}' "$B/api/hubs"
  req "hubs"                  body "$B/api/hubs"
  echo "## page policy";              curl -s -o /dev/null -D - -b "$JAR" "$B/" | tr -d '\r' | grep -i '^content-security-policy' | grep -o "connect-src[^;]*"
  # Search, hidden files, and the page's files when the browser already has them.
  req "search"                  body "$B/api/search?q=BODY%20one"
  req "search, nothing found"   body "$B/api/search?q=zzzznothing"
  req "search, too short"       body "$B/api/search?q=a"
  req "search skips ignored"    body "$B/api/search?q=ignored"
  req "search skips hidden"     body "$B/api/search?q=secret"
  req "raw hidden file"         body "$B/raw/.hidden.md"
  req "doc hidden file"         body "$B/api/doc?path=.hidden.md"
  TAG="$(curl -s -o /dev/null -D - "$B/app.js" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')"
  echo "## page file has a tag";       [ -n "$TAG" ] && echo yes; curl -s -o /dev/null -D - "$B/app.js" | tr -d '\r' | grep -i '^cache-control'
  echo "## page file, already held";   curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H "If-None-Match: $TAG" "$B/app.js"
  PTAG="$(curl -s -o /dev/null -D - "$B/" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')"
  echo "## page, already held, keeps its policy"; curl -s -o /dev/null -D - -H "If-None-Match: $PTAG" "$B/" | tr -d '\r' | grep -i -E '^HTTP|^content-security-policy' | cut -c1-70
  echo "## page file, other tag";      curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: "0"' "$B/app.js"
  echo "## data is never kept";        curl -s -o /dev/null -D - -b "$JAR" "$B/api/config" | tr -d '\r' | grep -i '^cache-control\|^etag'
  req "hub address, odd characters" body -X PUT "${J[@]}" -d '{"hubs":[{"name":"x","url":"https://x;sandbox"},{"name":"y","url":"https://x,script-src"},{"name":"ok","url":"https://[fe80::1]:4321"}]}' "$B/api/hubs"
  req "hubs emptied"            body -X PUT "${J[@]}" -d '{"hubs":[]}' "$B/api/hubs"
  # A damaged notes file is left alone, and says so.
  cp "$R/notes/notes.json" "$WORK/notes.keep"; printf '[{"id":"broken' > "$R/notes/notes.json"
  req "note onto a damaged file" body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md","text":"must not wipe"}' "$B/api/notes"
  req "notes from a damaged file" body "$B/api/notes"
  req "edit on a damaged file"   body -X PUT "${J[@]}" -d '{"text":"x"}' "$B/api/notes/anything"
  echo "## damaged file untouched";    cat "$R/notes/notes.json"; echo
  cp "$WORK/notes.keep" "$R/notes/notes.json"
  cp "$R/hub.json" "$WORK/hub.keep"; printf '{"title": "brok' > "$R/hub.json"
  req "settings from a damaged file" body "$B/api/config"
  req "settings onto a damaged file" body -X PUT "${J[@]}" -d '{"locks":{}}' "$B/api/config"
  cp "$WORK/hub.keep" "$R/hub.json"
  # Workspaces: an upload that becomes a workspace of its own, switching to it and back.
  req "upload to own workspace"   body -X POST --data-binary $'# In Own\n\nBody.\n' "$B/api/upload?path=doc.md&workspace=My%20Space"
  req "own workspace, odd name"   body -X POST --data-binary 'x' "$B/api/upload?path=a/b.md&workspace=..%2F..%2Fescape%3F"
  req "own workspace, no name"    body -X POST --data-binary 'x' "$B/api/upload?path=a.md&workspace=..."
  req "own workspace, bad path"   body -X POST --data-binary 'x' "$B/api/upload?path=../x.md&workspace=My%20Space"
  req "own workspace, again"      body -X POST --data-binary 'x' "$B/api/upload?path=doc.md&workspace=My%20Space"
  req "workspaces listed"         body "$B/api/workspaces"
  req "switch to missing"         body -X POST "${J[@]}" -d '{"root":"/nowhere"}' "$B/api/workspace"
  req "switch with no root"       body -X POST "${J[@]}" -d '{}' "$B/api/workspace"
  WSROOT="$(curl -s -b "$JAR" "$B/api/workspaces" | python3 -c 'import sys,json; print([w["root"] for w in json.load(sys.stdin) if w["name"]=="My Space"][0])')"
  req "switch to own"             body -X POST "${J[@]}" -d "{\"root\":\"$WSROOT\"}" "$B/api/workspace"
  req "config in own"             body "$B/api/config"
  req "docs in own"               body "$B/api/docs"
  req "note in own"               body -X POST "${J[@]}" -d '{"doc":"doc.md","text":"in the other workspace"}' "$B/api/notes"
  req "notes in own"              body "$B/api/notes"
  req "switch home"               body -X POST "${J[@]}" -d "{\"root\":\"$R\"}" "$B/api/workspace"
  req "notes at home"             status-only "$B/api/notes"
  req "config at home"            body "$B/api/config"
  ID="$(curl -s -b "$JAR" "$B/api/devices" | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')"
  req "unpair"                  body -X DELETE "$B/api/devices/$ID"
  req "after unpairing"         body "$B/api/config"
  req "docs after changes"    body "$B/api/docs"
  req "workspaces"            body "$B/api/workspaces"
}

run $CPP_PORT "$(cd "$WORK/cpp/ws" && pwd -P)" "$WORK/cpp.log" > "$WORK/cpp.out"
# macOS temp folders are reached through a symlink; the server reports the real path.
# (written to a second file: "sed -i" takes different arguments on macOS and elsewhere)
sed "s|$(cd "$WORK/cpp/ws" && pwd -P)|<root>|g; s|$(cd "$WORK/cpp/workspaces" && pwd -P)|<workspaces>|g" "$WORK/cpp.out" > "$WORK/cpp.norm" && mv "$WORK/cpp.norm" "$WORK/cpp.out"

EXPECTED="test/expected.txt"
TOTAL=$(grep -c '^## ' "$WORK/cpp.out")
if [ -n "${UPDATE:-}" ]; then
  cp "$WORK/cpp.out" "$EXPECTED"
  echo "recorded: $TOTAL requests written to $EXPECTED"
elif diff "$EXPECTED" "$WORK/cpp.out" > "$WORK/diff.txt"; then
  echo "PASS: $TOTAL requests, answers as recorded"
else
  echo "DIFFERENCES (< recorded, > now):"
  cat "$WORK/diff.txt"
  echo "--- of $TOTAL requests"
  [ -n "${KEEP:-}" ] && cp "$WORK/cpp.out" "$WORK/cpp.log" "$KEEP/"
  exit 1
fi
