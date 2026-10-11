#!/bin/bash
# Make videos small enough for the card and easy for the board to stream.
#
#   tools/shrink-video.sh lecture.mov                 -> lecture.small.mp4, 720 lines high
#   tools/shrink-video.sh 480 a.mov b.mkv c.mp4       -> a.small.mp4, b.small.mp4, c.small.mp4, 480 lines
#   tools/shrink-video.sh *.mov 480                   the height may come first or last
#
# Any number of videos; a bare number among them (240 to 2160) is the height, 720
# if none is given. Each result is named after its video, "<name>.small.mp4"
# beside it; one that is there already is left alone (FORCE=1 makes it again).
# A video that fails does not stop the rest: they are listed at the end.
#
# Run it on a computer (needs ffmpeg: brew install ffmpeg / apt install ffmpeg),
# then copy the results to the card. The board cannot do this itself: re-encoding
# video takes a desktop processor minutes, and the ESP32 has neither the speed
# nor the memory.
#
# What it makes: H.264 video and AAC sound in an MP4, which every browser plays;
# quality-led rather than size-led (CRF 26: lectures and screen recordings come
# out at a quarter to a tenth of their size); and "faststart", the file's index
# moved to the front, so a browser can begin playing and seek with a few small
# range requests instead of first fetching the end of a large file over the
# board's Wi-Fi. FAT32 holds files up to 4 GB; the board serves files of any
# size up to that, so this is about speed and room, not a limit.
set -uo pipefail
HEIGHT=720
VIDEOS=()
for a in "$@"; do
  # A number that is not the name of a file here is the height.
  if [[ "$a" =~ ^[0-9]+$ && ! -e "$a" ]]; then
    [ "$a" -ge 240 ] && [ "$a" -le 2160 ] || { echo "height $a: give one from 240 to 2160 (720, 480)"; exit 1; }
    HEIGHT="$a"
  else
    VIDEOS+=("$a")
  fi
done
[ ${#VIDEOS[@]} -gt 0 ] || { echo "usage: shrink-video.sh [height] video [video ...]      height: 720 (default), 480, ..."; exit 1; }
command -v ffmpeg > /dev/null || { echo "needs ffmpeg"; exit 1; }
FAILED=()
for IN in "${VIDEOS[@]}"; do
  [ -f "$IN" ] || { echo "$IN: no such file"; FAILED+=("$IN"); continue; }
  case "$IN" in *.small.mp4) echo "$IN: already a small one, left alone"; continue ;; esac
  OUT="${IN%.*}.small.mp4"
  if [ -e "$OUT" ] && [ -z "${FORCE:-}" ]; then echo "$OUT: there already, left alone (FORCE=1 to make it again)"; continue; fi
  # -nostdin: ffmpeg would otherwise read the keyboard, and take the rest of a list piped in.
  if ! ffmpeg -nostdin -hide_banner -loglevel error -stats -y -i "$IN" \
      -vf "scale=-2:'min($HEIGHT,ih)'" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
      -c:a aac -b:a 96k -ac 2 -movflags +faststart "$OUT"; then
    echo "$IN: could not be converted"
    rm -f "$OUT"
    FAILED+=("$IN")
    continue
  fi
  SIZE=$(wc -c < "$OUT" | tr -d ' ')
  echo "$OUT: $((SIZE / 1048576)) MB (was $(( $(wc -c < "$IN" | tr -d ' ') / 1048576 )) MB)"
  [ "$SIZE" -lt 4294967295 ] || echo "  still over 4 GB, which FAT32 cannot hold: try a smaller height (480) or split it"
done
if [ ${#FAILED[@]} -gt 0 ]; then printf 'not converted: %s\n' "${FAILED[@]}"; exit 1; fi
