#!/bin/bash
# Publish a firmware update that boards pick up by themselves (README.md, "Updates").
#
#   tools/release.sh keys        once: make the signing key and put its public half in main/update_key.h
#   tools/release.sh [hub.bin]   each release: sign the built image and write build/release/
#
# The private key stays on this computer, in ~/.config/hub/update-signing-key.pem
# (HUB_SIGNING_KEY to put it elsewhere). Never commit it, never give it to CI:
# whoever has it can make every board install anything. Keep a copy somewhere
# safe; without it, boards accept no more updates until reflashed by USB.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="${HUB_SIGNING_KEY:-$HOME/.config/hub/update-signing-key.pem}"

if [ "${1:-}" = keys ]; then
  if [ -e "$KEY" ]; then echo "$KEY already exists; using it"; else
    mkdir -p "$(dirname "$KEY")"; (umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$KEY")
    echo "made $KEY (keep it safe, keep it out of git)"
  fi
  {
    echo '// The public half of the key that signs firmware releases (tools/release.sh'
    echo '// writes it). Empty: this build installs no updates.'
    echo '#pragma once'
    printf 'static const char UPDATE_KEY_PEM[] =\n'
    openssl ec -in "$KEY" -pubout 2>/dev/null | sed 's/.*/    "&\\n"/'
    echo '    ;'
  } > main/update_key.h
  echo "wrote main/update_key.h: commit it, build, and flash once by USB; boards then trust releases signed with this key"
  exit 0
fi

BIN="${1:-build/hub.bin}"
[ -f "$BIN" ] || { echo "no $BIN: build first (idf.py build), or give the .bin to sign"; exit 1; }
[ -f "$KEY" ] || { echo "no signing key: run tools/release.sh keys first"; exit 1; }
grep -q 'BEGIN PUBLIC KEY' main/update_key.h || { echo "main/update_key.h has no key: run tools/release.sh keys, rebuild, then release"; exit 1; }
VERSION=$(sed -n 's/^#define HUB_VERSION \([0-9]*\).*/\1/p' main/version.h)
SHA=$(openssl dgst -sha256 -r "$BIN" | cut -d' ' -f1)
SIZE=$(wc -c < "$BIN" | tr -d ' ')
# The sentence the board checks (update.cpp): the version and the image's hash, signed together.
SIG=$(printf 'hub-firmware %s %s' "$VERSION" "$SHA" | openssl dgst -sha256 -sign "$KEY" | openssl base64 -A)
OUT=build/release
mkdir -p "$OUT"
cp "$BIN" "$OUT/hub.bin"
cat > "$OUT/hub-firmware.json" <<JSON
{ "version": $VERSION, "file": "hub.bin", "size": $SIZE, "sha256": "$SHA", "signature": "$SIG" }
JSON
echo "release v$VERSION signed: $OUT/hub.bin ($SIZE bytes), $OUT/hub-firmware.json"
echo "publish it as the latest release, tagged v$VERSION, with both files attached:"
echo "  gh release create v$VERSION $OUT/hub.bin $OUT/hub-firmware.json --title \"Board firmware v$VERSION\" --latest"
echo "(then raise HUB_VERSION in main/version.h for the next one)"
