#!/bin/bash
# Publish a firmware update that boards pick up by themselves (README.md, "Updates").
#
#   tools/release.sh keys          once: make the signing key and put its public half in main/update_key.h
#   tools/release.sh [build-dir]   each release, for each board: sign the build's image and add it to build/release/
#
# A release holds one image per kind of chip (esp32: the T3 V1.6.1; esp32s3: the
# T3-S3), each with its own hub-firmware-CHIP.json; a board fetches only its own.
# For both: build each in its own folder with its own configuration
# (idf.py -B build-esp32s3 -D SDKCONFIG=build-esp32s3/sdkconfig set-target esp32s3 build), run this
# for each build folder, then publish build/release/ as one release.
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

BUILD="${1:-build}"
BIN="$BUILD/hub.bin"
[ -f "$BIN" ] || { echo "no $BIN: build first (idf.py build), or give the build folder"; exit 1; }
CHIP=$(sed -n 's/^#define CONFIG_IDF_TARGET "\(.*\)"$/\1/p' "$BUILD/config/sdkconfig.h" 2>/dev/null)
[ -n "$CHIP" ] || { echo "cannot tell which chip $BUILD is for (no $BUILD/config/sdkconfig.h)"; exit 1; }
[ -f "$KEY" ] || { echo "no signing key: run tools/release.sh keys first"; exit 1; }
grep -q 'BEGIN PUBLIC KEY' main/update_key.h || { echo "main/update_key.h has no key: run tools/release.sh keys, rebuild, then release"; exit 1; }
VERSION=$(sed -n 's/^#define HUB_VERSION \([0-9]*\).*/\1/p' main/version.h)
SHA=$(openssl dgst -sha256 -r "$BIN" | cut -d' ' -f1)
SIZE=$(wc -c < "$BIN" | tr -d ' ')
# The sentence the board checks (update.cpp): the chip, the version and the image's hash, signed together.
SIG=$(printf 'hub-firmware %s %s %s' "$CHIP" "$VERSION" "$SHA" | openssl dgst -sha256 -sign "$KEY" | openssl base64 -A)
OUT=build/release
mkdir -p "$OUT"
cp "$BIN" "$OUT/hub-$CHIP.bin"
cat > "$OUT/hub-firmware-$CHIP.json" <<JSON
{ "chip": "$CHIP", "version": $VERSION, "file": "hub-$CHIP.bin", "size": $SIZE, "sha256": "$SHA", "signature": "$SIG" }
JSON
echo "v$VERSION for $CHIP signed: $OUT/hub-$CHIP.bin ($SIZE bytes), $OUT/hub-firmware-$CHIP.json"
echo "when every board's image is in $OUT, publish it as the latest release, tagged v$VERSION:"
echo "  gh release create v$VERSION $OUT/* --title \"Board firmware v$VERSION\" --latest"
echo "(then raise HUB_VERSION in main/version.h for the next one)"
