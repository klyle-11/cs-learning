#!/bin/bash
# Make a video small enough for the card and easy for the board to stream.
#
#   tools/shrink-video.sh lecture.mov                 -> lecture.small.mp4, 720 lines high
#   tools/shrink-video.sh lecture.mov out.mp4 480     -> 480 lines (smaller still)
#
# Run it on a computer (needs ffmpeg: brew install ffmpeg / apt install ffmpeg),
# then copy the result to the card. The board cannot do this itself: re-encoding
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
set -euo pipefail
IN="${1:?usage: shrink-video.sh input [output.mp4] [height]}"
OUT="${2:-${IN%.*}.small.mp4}"
HEIGHT="${3:-720}"
command -v ffmpeg > /dev/null || { echo "needs ffmpeg"; exit 1; }
ffmpeg -hide_banner -i "$IN" \
  -vf "scale=-2:'min($HEIGHT,ih)'" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -ac 2 -movflags +faststart "$OUT"
SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "$OUT: $((SIZE / 1048576)) MB (was $(( $(wc -c < "$IN" | tr -d ' ') / 1048576 )) MB)"
[ "$SIZE" -lt 4294967295 ] || echo "still over 4 GB, which FAT32 cannot hold: try a smaller height (480) or split it"
