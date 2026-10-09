#!/bin/bash
# Sends a fixed list of requests to the server, on a small fixture folder, and
# compares the answers with the ones recorded in test/expected.txt. Those were
# recorded when the C++ server and the Node server it replaced gave identical
# answers, so this holds the server to the contract in API.md.
#   ./test/contract.sh            (from server-cpp/, after `make`)
#   UPDATE=1 ./test/contract.sh   record the answers as the new expected ones,
#                                 after reading the differences and meaning them
#   HUBD=build/hubd-own ./test/contract.sh   test another copy of the server
#                                 than ./hubd ("make test-own" builds and tests that one)
set -u
cd "$(dirname "$0")/.."
REPO="$(cd .. && pwd)"
# On Windows the scratch folder is made here, under build/, and not in /tmp: "diff" may be the one that came with Git
# (MSYS2 has none unless diffutils is installed), and that one has a /tmp of its own, so it would not find the answers.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) mkdir -p build; WORK="$(mktemp -d "$PWD/build/test.XXXXXX")" ;;
  *) WORK="$(mktemp -d)" ;;
esac
CPP_PORT=4412
# The folder's real path as the server reports it. On Windows that is the
# Windows form (C:/...), not the shell's own (/tmp/...).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXE=.exe; real() { cygpath -m "$(cd "$1" && pwd -P)"; } ;;
  *) EXE=; real() { (cd "$1" && pwd -P); } ;;
esac
# Python: on Windows "python3" can be the Store's placeholder, which runs nothing.
PY=python3; "$PY" -c '' 2>/dev/null || PY=python
export PYTHONUTF8=1   # Windows Python would otherwise read the answers in the system's code page
trap 'kill $CPP_PID 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"' EXIT

fixture() {
  mkdir -p "$1/a" "$1/b" "$1/notes"
  printf '# Fixture Title\n\nDescription.\n' > "$1/FRONTPAGE.md"
  printf '# First\n\nBody one.\n' > "$1/a/1-doc.md"
  printf '# Tenth\n' > "$1/a/10-doc.md"
  printf '# Same  Words\n\nA *first* paragraph, with a [link](http://example.com/x) &amp; more.\n\n- item one\n- item one\n\n```c\nint x = 1;\n```\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |\n' > "$1/a/blocks.md"
  printf '<html><head><title>T</title><style>p { color: red }</style></head><body><h1>Same Words</h1><p>A <em>first</em> paragraph, with a <a href="http://example.com/x">link</a> &amp; more.</p><ul><li>item one</li><li>item one</li></ul><pre><code>int x = 1;\n</code></pre><table><tr><th>h1</th><th>h2</th></tr><tr><td>c1</td><td>c2</td></tr></table><script>var hidden = 1;</script><!-- hidden too --></body></html>\n' > "$1/b/blocks.html"
  printf 'no heading here\n' > "$1/a/2-doc.md"
  printf '<html><head><title> A Page </title></head><body><h1>Hi</h1></body></html>\n' > "$1/b/page.html"
  printf 'int main(void) { return 0; }\n' > "$1/code.c"
  # A small book: two pages in reading order, a contents that names them, a picture. One page is written twice over so that it packs.
  "$PY" - "$1/b/book.epub" <<'PYEOF'
import sys, zipfile
page = '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>%s</title></head><body><h1>%s</h1>%s</body></html>\n'
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('mimetype', 'application/epub+zip', zipfile.ZIP_STORED)
    z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/content.opf', '<package><metadata><dc:title>A Small Book</dc:title></metadata><manifest>'
               '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="two" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>'
               '<item id="one" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="dot" href="img/dot.png" media-type="image/png"/>'
               '</manifest><spine toc="ncx"><itemref idref="one"/><itemref idref="two"/><itemref idref="missing"/></spine></package>', zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/toc.ncx', '<ncx><docTitle><text>A Small Book</text></docTitle><navMap>'
               '<navPoint><navLabel><text>The  First &amp; Best</text></navLabel><content src="text/ch1.xhtml#top"/></navPoint>'
               '</navMap><pageList><pageTarget><navLabel><text>ii</text></navLabel><content src="text/ch2.xhtml"/></pageTarget></pageList></ncx>', zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/text/ch1.xhtml', page % ('One', 'Same Words', '<p>A <em>first</em> paragraph, with a <a href="ch2.xhtml">link</a> &amp; more.</p>' + '<p>item one</p>' * 2 + '<p><img src="../img/dot.png" alt=""/></p>'), zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/text/ch2.xhtml', page % ('Two', 'Second', '<p>Not packed.</p>'), zipfile.ZIP_STORED)
    z.writestr('OEBPS/img/dot.png', b'not really a png either', zipfile.ZIP_STORED)
PYEOF
  printf '# ignored\n' > "$1/CLAUDE.md"
  printf '# Refs\n' > "$1/references.md"
  printf 'secret\n' > "$1/.hidden.md"
  printf '<html><body><script>document.title = "ran"</script></body></html>\n' > "$1/b/app.html"
  printf '{"items":[{"src":"https:\\/\\/img.example\\/a%%20b.JPG?x=1\\u0026y=2","page":"https://site.example/post/1"},{"src":"https://img.example/a%%20b.JPG?x=1&y=2"}]}\nSee https://v.example/clip.mp4, and (https://pbs.example/media/abc?format=png). Not http://plain.example/x.jpg\n<b>"https://x.example/a"b</b>\n' > "$1/b/saved.json"
  printf 'No addresses in this one.\n' > "$1/b/plain.txt"
  printf '[{"mediaUrl":"https://i.example/thumb.jpg?x=1","postUrl":"https://site.example/search","linkUrl":"https://site.example/watch?v=1&t=2","title":"A <Saved> Video","isVideo":false,"directUrls":["https://cdn.example/videoplayback?itag=401&mime=video%%2Fmp4","https://cdn.example/videoplayback?itag=251&mime=audio%%2Fwebm"]},{"nested":{"mediaUrl":"https://i.example/pic.png","ytDlpUrls":[]}},{"directUrls":["https://c.example/loop.webm"]},{"mediaUrl":"https://t.example/small.webm","isVideo":true,"title":"Clip as thumbnail","linkUrl":"https://site.example/item","directUrls":["https://d.example/full.mp4"]},{"mediaUrl":"https://t.example/only.webm","isVideo":true},{"thumbnailUrl":"https://t.example/new.jpg","sourcePage":"https://site.example/found","mediaPage":"https://site.example/leads","title":"New names","directMedia":["https://d.example/new.mp4"]},{"ThumbnailURL":"https://t.example/case.jpg","directMedia":"https://d.example/one.mp4"},{"postUrl":"https://site.example/untitled"}]\n' > "$1/b/items.json"
  printf '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<DL><p>\n<DT><A HREF="https://v.example/a.mp4" ADD_DATE="1">A clip &amp; more</A>\n<DT><A HREF="https://site.example/page">A page</A>\n<DT><A HREF="http://plain.example/">Not kept</A>\n</DL>\n' > "$1/b/marks.html"
  printf '{\n  "title": "From hub.json",\n  "side": ["references.md"],\n  "ignore": ["CLAUDE.md"],\n  "scripts": ["b/app.html", "page.html"]\n}\n' > "$1/hub.json"
  echo '[]' > "$1/notes/notes.json"
  printf '0123456789abcdefghij' > "$1/b/clip.mp4"
  printf 'not really a png' > "$1/b/pic.png"
  printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$1/b/drawing.svg"
}
fixture "$WORK/cpp/ws"

# It is told to ask even this machine to pair, so the requests below prove
# that nothing is answered without a paired device's token.
mkdir -p "$WORK/cpp/workspaces"
"${HUBD:-./hubd$EXE}" "$WORK/cpp/ws" --port $CPP_PORT --www "$REPO/hub" --state "$WORK/cpp/state" --workspaces "$WORK/cpp/workspaces" --pair-local > "$WORK/cpp.log" 2>&1 &
CPP_PID=$!
# wait until it answers (the memory-checked build starts slowly)
for port in $CPP_PORT; do
  for _ in $(seq 1 50); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$port/" && break; sleep 0.2; done
done
code_in() { grep -o 'pairing code: [A-Z0-9-]*' "$1" | tail -1 | awk '{print $3}'; }

# Print "status body" with the parts that legitimately differ (folder path,
# ids, timestamps) replaced, and JSON keys sorted.
norm() {
  "$PY" -c '
import sys, json, re
sys.stdout.reconfigure(newline="\n")   # Windows Python would end lines with CR LF
status, root = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
def scrub(v):
    if isinstance(v, dict):
        return {k: ("<" + k + ">" if k in ("id", "ts", "code", "created", "seen", "used", "free", "changed", "workspace", "undo", "at") else scrub(x)) for k, x in v.items()}
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
  hreq "page allowed its scripts" "$B/raw/b/app.html"
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
  echo "## vendor pdf, and its worker"; for f in pdf.mjs pdf.worker.mjs; do curl -s -o /dev/null -D - "$B/vendor/$f" | tr -d '\r' | grep -iE '^(HTTP/|content-type|content-security-policy)' | sed 's/^HTTP\/1.1 \([0-9]*\).*/\1/'; done
  echo "## vendor document engine: a module, its worker, its WebAssembly, and what is not served"; for f in index.js worker.js recolor-worker.js ui.css wasm/marginalia_wasm_bg.wasm wasm-ocr/marginalia_wasm.js ../package.json Index.js .js ocr-worker.js node.js direct.js; do curl -s -o /dev/null --path-as-is -D - "$B/vendor/marginalia/$f" | tr -d '' | grep -iE '^(HTTP/|content-type|content-security-policy)' | sed 's/^HTTP\/1.1 \([0-9]*\).*/\1/'; done
  echo "## the engine worker of the reader itself, and the policy it runs under"; curl -s -o /dev/null -D - "$B/js/engine-worker.js" | tr -d '\r' | grep -iE '^(HTTP/|content-type|content-security-policy)' | sed 's/^HTTP\/1.1 \([0-9]*\).*/\1/'
  req "sha256 of a file"      body "$B/api/sha256?path=a/1-doc.md"
  req "sha256 again, kept"    body "$B/api/sha256?path=a/1-doc.md"
  req "sha256 of media"       body "$B/api/sha256?path=b/clip.mp4"
  req "sha256 of a book"      body "$B/api/sha256?path=b/book.epub" | sed -E 's/[0-9a-f]{64}/<sha256>/'
  req "sha256 inside a book"  body "$B/api/sha256?path=b/book.epub/OEBPS/text/ch1.xhtml"
  req "sha256 of a folder"    body "$B/api/sha256?path=a"
  req "sha256 no such file"   body "$B/api/sha256?path=a/nope.md"
  req "sha256 hidden"         body "$B/api/sha256?path=.hidden.md"
  req "sha256 escape"         body "$B/api/sha256?path=../x"
  req "sha256 no path"        body "$B/api/sha256"
  req "unknown route"         body "$B/api/nope"
  req "notes empty"           body "$B/api/notes"
  req "note create"           body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md","text":"why \"this\"?\nline two","quote":"Body one.","type":"question","heading":"first","headingText":"First"}' "$B/api/notes"
  req "highlight create"      body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md","quote":"Body","type":"important"}' "$B/api/notes"
  req "note with own id"      body -X POST "${J[@]}" -d '{"id":"made-on-phone-1","ts":"2026-01-02T03:04:05.678Z","doc":"a/1-doc.md","text":"written offline"}' "$B/api/notes"
  req "same note again"       body -X POST "${J[@]}" -d '{"id":"made-on-phone-1","doc":"a/1-doc.md","text":"sent twice"}' "$B/api/notes"
  req "own id is usable"      body -X PUT "${J[@]}" -d '{"text":"edited by its own id"}' "$B/api/notes/made-on-phone-1"
  req "note with bad id"      body -X POST "${J[@]}" -d '{"id":"../x","ts":"yesterday","doc":"a/1-doc.md","text":"bad id and time"}' "$B/api/notes"
  req "note bad"              body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md"}' "$B/api/notes"
  req "highlight with anchor" body -X POST "${J[@]}" -d '{"id":"anchored-1","ts":"2026-01-02T03:04:05.678Z","doc":"a/1-doc.md","quote":"one","anchor":{"block":"00ff00ff00ff00ff","nth":1,"start":4,"before":"Body","after":".","extra":"dropped"}}' "$B/api/notes"
  req "anchor not hex"        body -X POST "${J[@]}" -d '{"id":"anchored-2","ts":"2026-01-02T03:04:05.678Z","doc":"a/1-doc.md","quote":"one","anchor":{"block":"../x","start":-3}}' "$B/api/notes"
  req "anchor replaced"       body -X PUT "${J[@]}" -d '{"quote":"Body","anchor":{"block":"abc","start":0}}' "$B/api/notes/anchored-1"
  req "quote without anchor"  body -X PUT "${J[@]}" -d '{"quote":"Body one"}' "$B/api/notes/anchored-1"
  req "anchored note gone"    body -X DELETE "$B/api/notes/anchored-1"
  req "anchored note 2 gone"  body -X DELETE "$B/api/notes/anchored-2"
  req "note with a stamp"     body -X POST "${J[@]}" -d '{"id":"stamped-1","ts":"2026-01-02T03:04:05.678Z","doc":"a/1-doc.md","text":"first","quote":"Body","type":"question","at":"0001760000000000-0000-aaa"}' "$B/api/notes"
  req "an older edit is not applied" body -X PUT "${J[@]}" -d '{"text":"older","at":"0001759999999999-0000-bbb"}' "$B/api/notes/stamped-1"
  req "a newer edit is applied" body -X PUT "${J[@]}" -d '{"text":"newer","at":"0001760000000001-0000-bbb"}' "$B/api/notes/stamped-1"
  req "each part goes by its own stamp" body -X PUT "${J[@]}" -d '{"type":"","at":"0001760000000000-0001-ccc"}' "$B/api/notes/stamped-1"
  req "an old edit to the text still loses" body -X PUT "${J[@]}" -d '{"text":"late","at":"0001760000000000-0002-ccc"}' "$B/api/notes/stamped-1"
  req "no stamp: applied as before" body -X PUT "${J[@]}" -d '{"text":"no stamp","at":"yesterday"}' "$B/api/notes/stamped-1"
  req "a reply"                 body -X POST "${J[@]}" -d '{"id":"reply-1","ts":"2026-01-02T03:04:05.678Z","doc":"a/1-doc.md","text":"and also","replyTo":"stamped-1"}' "$B/api/notes"
  req "a reply to no id"        body -X POST "${J[@]}" -d '{"doc":"a/1-doc.md","text":"x","replyTo":"../x"}' "$B/api/notes"
  req "stamped note gone"       body -X DELETE "$B/api/notes/stamped-1"
  req "reply gone"              body -X DELETE "$B/api/notes/reply-1"
  echo "## pdf.js character maps and typefaces, and what is not served"; for f in cmaps/78-EUC-H.bcmap standard_fonts/FoxitSerif.pfb standard_fonts/LiberationSans-Regular.ttf standard_fonts/LICENSE_FOXIT cmaps/../../package.json cmaps/x.js; do echo "$f"; curl -s -o /dev/null --path-as-is -D - "$B/vendor/pdfjs/$f" | tr -d '\r' | grep -iE '^(HTTP/|content-type)' | sed 's/^HTTP\/1.1 \([0-9]*\).*/\1/'; done
  req "highlight on a pdf page" body -X POST "${J[@]}" -d '{"id":"engine-1","ts":"2026-01-02T03:04:05.678Z","doc":"b/paper.pdf","quote":"risks","headingText":"page 1","mg":{"doc":"b34531a9d344f4405422a9f1edb6b33fdc50c69fb28f4c723e8deed368a43674","anchor":{"unit":"p1","unitIndex":0,"quote":{"exact":"risks","prefix":"are ","suffix":" associated"},"position":{"start":10,"end":15},"rects":[{"x0":1.5,"x1":2,"y0":3,"y1":4},{"x0":"no"}],"other":1},"other":2}}' "$B/api/notes"
  req "engine anchor not usable" body -X POST "${J[@]}" -d '{"id":"engine-2","ts":"2026-01-02T03:04:05.678Z","doc":"b/paper.pdf","quote":"risks","mg":{"doc":"../x","anchor":{"unit":"p1","quote":{"exact":"risks"}}}}' "$B/api/notes"
  req "engine anchor kept on edit" body -X PUT "${J[@]}" -d '{"type":"question"}' "$B/api/notes/engine-1"
  req "quote without engine anchor" body -X PUT "${J[@]}" -d '{"quote":"risk"}' "$B/api/notes/engine-1"
  req "engine note gone"      body -X DELETE "$B/api/notes/engine-1"
  req "engine note 2 gone"    body -X DELETE "$B/api/notes/engine-2"
  req "blocks of markdown"    body "$B/api/blocks?path=a/blocks.md"
  req "blocks of a page"      body "$B/api/blocks?path=b/blocks.html"
  req "blocks of code"        body "$B/api/blocks?path=code.c"
  req "blocks, no such doc"   body "$B/api/blocks?path=a/none.md"
  req "blocks, not a doc"     body "$B/api/blocks?path=b/pic.png"
  req "blocks, traversal"     body "$B/api/blocks?path=../x.md"
  req "links in a file"       body "$B/api/links?path=b/saved.json"
  # The nonce is new each time: it is left out of what is compared.
  hreq "links as a gallery"            "$B/cards/b/saved.json" | sed -E 's/nonce-[0-9a-f]+/nonce-N/; s/nonce="[0-9a-f]+"/nonce="N"/'
  hreq "saved items as a gallery"      "$B/cards/b/items.json?paper=101010&ink=eeeeee&accent=zzzzzz&rule=abc&size=999" | sed -E 's/nonce-[0-9a-f]+/nonce-N/; s/nonce="[0-9a-f]+"/nonce="N"/'
  echo "## cards at an item";         for i in 5 7 99 x; do curl -s -m 5 -b "$JAR" "$B/cards/b/items.json?item=$i" | grep -o '<body[^>]*>'; done; curl -s -m 5 -b "$JAR" "$B/cards/b/marks.html?item=1" | grep -o '<body[^>]*>'
  req "saved items in a file" body "$B/api/links?path=b/items.json"
  req "bookmarks"             body "$B/api/links?path=b/marks.html"
  req "links, none in it"     body "$B/api/links?path=b/plain.txt"
  req "links, not that kind"  body "$B/api/links?path=a/1-doc.md"
  req "links, no such file"   body "$B/api/links?path=b/none.txt"
  req "cards, hidden"         body "$B/cards/.hidden.txt"
  req "book page"             body "$B/api/doc?path=b/book.epub/OEBPS/text/ch1.xhtml"
  hreq "book page, raw"                "$B/raw/b/book.epub/OEBPS/text/ch1.xhtml"
  req "book page, not packed" body "$B/raw/b/book.epub/OEBPS/text/ch2.xhtml"
  hreq "book picture"                  "$B/raw/b/book.epub/OEBPS/img/dot.png"
  req "book page blocks"      body "$B/api/blocks?path=b/book.epub/OEBPS/text/ch1.xhtml"
  req "book, no such page"    body "$B/api/doc?path=b/book.epub/OEBPS/text/none.xhtml"
  req "book, not a page"      body "$B/api/doc?path=b/book.epub/OEBPS/content.opf"
  req "book, no such file"    body "$B/raw/b/book.epub/OEBPS/none.png"
  req "book, hidden name"     body "$B/raw/b/book.epub/.secret"
  req "not a book"            body "$B/raw/a/1-doc.md/x.xhtml"
  ID="$(curl -s -b "$JAR" "$B/api/notes" | "$PY" -c 'import sys,json; print([n for n in json.load(sys.stdin) if n["status"] == "highlight"][0]["id"])' | tr -d '\r')"
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
  # A removed folder is kept aside, hidden, and can be put back with its locks; or let go for good.
  req "removed, listed"         body "$B/api/removed"
  UNDO="$(curl -s -b "$JAR" "$B/api/removed" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)[0]["undo"])' | tr -d '\r')"
  echo "## removed folder kept aside"
  (cd "$2" && find .removed -type f | sed "s|$UNDO|<undo>|" | sort)
  req "kept aside, not served"  body "$B/raw/.removed/$UNDO/gone/FRONTPAGE.md"
  mkdir -p "$2/gone"
  req "put back, name taken"    body -X POST "${J[@]}" -d "{\"undo\":\"$UNDO\"}" "$B/api/folder/restore"
  rmdir "$2/gone"
  req "put back, bad name"      body -X POST "${J[@]}" -d '{"undo":"../../x"}' "$B/api/folder/restore"
  req "put back"                body -X POST "${J[@]}" -d "{\"undo\":\"$UNDO\"}" "$B/api/folder/restore"
  req "put back again"          body -X POST "${J[@]}" -d "{\"undo\":\"$UNDO\"}" "$B/api/folder/restore"
  req "locks put back"          body "$B/api/config"
  req "its file is back"        body "$B/api/doc?path=gone/deep/x.md"
  req "remove it again"         body -X DELETE "$B/api/folder?path=gone"
  UNDO="$(curl -s -b "$JAR" "$B/api/removed" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)[0]["undo"])' | tr -d '\r')"
  req "let go now"              body -X DELETE "$B/api/removed?undo=$UNDO"
  req "let go again"            body -X DELETE "$B/api/removed?undo=$UNDO"
  req "nothing removed now"     body "$B/api/removed"
  echo "## nothing kept aside"
  ls -A "$2/.removed" | wc -l | tr -d ' '
  req "upload new"            body -X POST --data-binary '# Uploaded' "$B/api/upload?path=up/new%20file.md"
  req "upload again"          body -X POST --data-binary '# Changed' "$B/api/upload?path=up/new%20file.md"
  req "uploaded content"      body "$B/api/doc?path=up/new%20file.md"
  req "upload traversal"      body -X POST --data-binary 'x' "$B/api/upload?path=../evil.md"
  req "upload hidden"         body -X POST --data-binary 'x' "$B/api/upload?path=up/.secret"
  req "look saved"            body -X PUT "${J[@]}" -d '{"look":{"theme":"lime-dark","fs":20,"roomy":true,"font":"sans","bad key!":"x","script":"<b>","themeSide":""}}' "$B/api/config"
  req "upload replaces"       body -X POST --data-binary '# Newer, and longer' "$B/api/upload?path=up/new%20file.md&replace=1"
  req "replaced content"      body "$B/api/doc?path=up/new%20file.md"
  req "replace, nothing there" body -X POST --data-binary '# Fresh' "$B/api/upload?path=up/fresh.md&replace=1"
  req "files of a folder"     body "$B/api/files?path=up"
  req "files, no such folder" body "$B/api/files?path=nope"
  req "files, a file"         body "$B/api/files?path=code.c"
  req "files, escape"         body "$B/api/files?path=../.."
  req "module, none such"     status-only "$B/js/nope.js"
  req "module, odd name"      status-only "$B/js/..%2Fapp.js"
  req "other site posts a note" body -X POST "${J[@]}" -H 'Origin: http://evil.example' -d '{"doc":"a/1-doc.md","text":"planted"}' "$B/api/notes"
  req "other site uploads"      body -X POST -H 'Origin: https://evil.example' --data-binary 'x' "$B/api/upload?path=planted.md"
  req "sandboxed page posts"    body -X POST "${J[@]}" -H 'Origin: null' -d '{"doc":"a/1-doc.md","text":"planted"}' "$B/api/notes"
  req "own page posts"          body -X POST "${J[@]}" -H "Origin: $B" -d '{"doc":"a/1-doc.md","text":"from the page itself"}' "$B/api/notes"
  req "other site reads"        body -H 'Origin: http://evil.example' "$B/api/config"
  # A reader loaded from another hub: it must send its token itself.
  TOKEN=$(awk '$6 ~ /^hub_device/{print $7}' "$JAR" | tail -1)
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
  # Pairing from another site: only from a page on a home network (as another hub is), and its wrong tries are its own.
  echo "## other hub, pair from a website"; curl -s -w ' %{http_code}\n' "${X[@]}" -X POST "${J[@]}" -d "{\"code\":\"$CODE\",\"name\":\"x\"}" "$B/api/pair"
  H=(-H 'Origin: https://desk.local:4321')
  T2=$(curl -s "${H[@]}" -X POST "${J[@]}" -d "{\"code\":\"$CODE\",\"name\":\"other reader\"}" "$B/api/pair" | grep -o '"token": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
  echo "## other hub, pair with code"; [ -n "$T2" ] && echo "given a token"
  for o in http://192.168.1.20:4321 'http://[fd00::5]:4321' http://localhost:4321 https://hub.example.com http://8.8.8.8; do echo "## pairing from $o"; curl -s -w ' %{http_code}\n' -H "Origin: $o" -X POST "${J[@]}" -d '{"code":"AAAA-AAAA"}' "$B/api/pair"; done
  CODE=$(curl -s -b "$JAR" -X POST "$B/api/pair/code" | grep -o '[A-Z0-9]\{4\}-[A-Z0-9]\{4\}')
  echo "## five wrong codes from another hub's page"; for _ in 1 2 3 4 5; do curl -s -o /dev/null -w '%{http_code} ' "${H[@]}" -X POST "${J[@]}" -d '{"code":"AAAA-AAAA"}' "$B/api/pair"; done; echo
  echo "## then the right one from there"; curl -s -w ' %{http_code}\n' "${H[@]}" -X POST "${J[@]}" -d "{\"code\":\"$CODE\"}" "$B/api/pair"
  echo "## the code still works for this hub's own page"; curl -s -o /dev/null -w '%{http_code}\n' -X POST "${J[@]}" -d "{\"code\":\"$CODE\",\"name\":\"own page\"}" "$B/api/pair"
  OWN=$(curl -s -b "$JAR" "$B/api/devices" | "$PY" -c 'import sys,json; print([d["id"] for d in json.load(sys.stdin) if d["name"]=="own page"][0])' | tr -d '\r')
  curl -s -o /dev/null -b "$JAR" -X DELETE "$B/api/devices/$OWN"
  echo "## other hub, new token";     curl -s -o /dev/null -w '%{http_code}\n' "${X[@]}" -H "Authorization: Bearer $T2" "$B/api/session"
  req "set hubs"              body -X PUT "${J[@]}" -d '{"hubs":[{"name":"  Desk   top ","url":"https://Desk.local:4321/some/path"},{"name":"dup","url":"https://desk.local:4321"},{"name":"usual port","url":"https://pi.local:443"},{"name":"","url":"https://x.local"},{"name":"bad","url":"ftp://x.local"},{"name":"bad2","url":"not a url"}]}' "$B/api/hubs"
  req "hubs"                  body "$B/api/hubs"
  echo "## page policy";              curl -s -o /dev/null -D - -b "$JAR" "$B/" | tr -d '\r' | grep -i '^content-security-policy' | grep -o "connect-src[^;]*"
  # Search, hidden files, and the page's files when the browser already has them.
  req "search"                  body "$B/api/search?q=BODY%20one"
  req "search, nothing found"   body "$B/api/search?q=zzzznothing"
  req "search, too short"       body "$B/api/search?q=a"
  req "search skips ignored"    body "$B/api/search?q=ignored"
  req "search, a saved link"    body "$B/api/search?q=D.example/NEW"
  req "search, a saved name"    body "$B/api/search?q=clip%20as"
  req "search, a bookmark"      body "$B/api/search?q=site.example/page"
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
  # What notes.json and hub.json held before each write is kept beside them, hidden: the version before, and one a day.
  cp "$R/notes/notes.json" "$WORK/notes.before"
  req "a note, to be kept before"  status-only -X POST "${J[@]}" -d '{"doc":"a/1-doc.md","text":"kept before"}' "$B/api/notes"
  echo "## the copy before is the version before"
  if cmp -s "$WORK/notes.before" "$R/notes/.notes.prev.json"; then echo same; else echo different; fi
  echo "## earlier copies kept"
  (cd "$R" && ls -a notes . | grep -E '^\.(notes|hub)\.' | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}/<day>/' | sort)
  req "an earlier copy is not served" body "$B/raw/notes/.notes.prev.json"
  req "nor listed"                body "$B/api/files?path=notes"
  # Workspaces: an upload that becomes a workspace of its own, switching to it and back.
  req "upload to own workspace"   body -X POST --data-binary $'# In Own\n\nBody.\n' "$B/api/upload?path=doc.md&workspace=My%20Space"
  req "own workspace, odd name"   body -X POST --data-binary 'x' "$B/api/upload?path=a/b.md&workspace=..%2F..%2Fescape%3F"
  req "own workspace, no name"    body -X POST --data-binary 'x' "$B/api/upload?path=a.md&workspace=..."
  req "own workspace, bad path"   body -X POST --data-binary 'x' "$B/api/upload?path=../x.md&workspace=My%20Space"
  req "own workspace, again"      body -X POST --data-binary 'x' "$B/api/upload?path=doc.md&workspace=My%20Space"
  req "workspaces listed"         body "$B/api/workspaces"
  req "switch to missing"         body -X POST "${J[@]}" -d '{"root":"/nowhere"}' "$B/api/workspace"
  req "switch with no root"       body -X POST "${J[@]}" -d '{}' "$B/api/workspace"
  WSROOT="$(curl -s -b "$JAR" "$B/api/workspaces" | "$PY" -c 'import sys,json; print([w["root"] for w in json.load(sys.stdin) if w["name"]=="My Space"][0])' | tr -d '\r')"
  HOMEWS="$(curl -s -b "$JAR" "$B/api/config" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["workspace"])' | tr -d '\r')"
  req "switch to own"             body -X POST "${J[@]}" -d "{\"root\":\"$WSROOT\"}" "$B/api/workspace"
  OWNWS="$(curl -s -b "$JAR" "$B/api/config" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["workspace"])' | tr -d '\r')"
  # A page left showing home, after own was opened: refused, and told which is open. Reading included.
  req "stale page: a note"        body -X POST "${J[@]}" -H "X-Hub-Workspace: $HOMEWS" -d '{"doc":"doc.md","text":"meant for home"}' "$B/api/notes"
  req "stale page: the config"    body -H "X-Hub-Workspace: $HOMEWS" "$B/api/config"
  req "stale page: a file"        body -H "X-Hub-Workspace: $HOMEWS" "$B/raw/doc.md"
  echo "## stale page: told the open one"
  curl -s -m 5 -b "$JAR" -D - -o /dev/null -H "X-Hub-Workspace: $HOMEWS" "$B/api/notes" | tr -d '\r' | grep -i '^x-hub-workspace:' | awk -v own="$OWNWS" '{print ($2 == own) ? "the open one" : "another: " $2}'
  req "stale page: workspaces"    status-only -H "X-Hub-Workspace: $HOMEWS" "$B/api/workspaces"
  req "current page: a note"      body -X POST "${J[@]}" -H "X-Hub-Workspace: $OWNWS" -d '{"doc":"doc.md","text":"meant for own"}' "$B/api/notes"
  req "config in own"             body "$B/api/config"
  req "docs in own"               body "$B/api/docs"
  req "note in own"               body -X POST "${J[@]}" -d '{"doc":"doc.md","text":"in the other workspace"}' "$B/api/notes"
  req "notes in own"              body "$B/api/notes"
  req "switch home"               body -X POST "${J[@]}" -H "X-Hub-Workspace: $HOMEWS" -d "{\"root\":\"$R\"}" "$B/api/workspace"   # from a stale page too
  req "notes at home"             status-only "$B/api/notes"
  req "config at home"            body "$B/api/config"
  ID="$(curl -s -b "$JAR" "$B/api/devices" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])' | tr -d '\r')"
  req "unpair"                  body -X DELETE "$B/api/devices/$ID"
  req "after unpairing"         body "$B/api/config"
  req "docs after changes"    body "$B/api/docs"
  req "workspaces"            body "$B/api/workspaces"
}

run $CPP_PORT "$(real "$WORK/cpp/ws")" "$WORK/cpp.log" > "$WORK/cpp.out"
# macOS temp folders are reached through a symlink; the server reports the real path.
# (written to a second file: "sed -i" takes different arguments on macOS and elsewhere)
sed "s|$(real "$WORK/cpp/ws")|<root>|g; s|$(real "$WORK/cpp/workspaces")|<workspaces>|g" "$WORK/cpp.out" > "$WORK/cpp.norm" && mv "$WORK/cpp.norm" "$WORK/cpp.out"

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
