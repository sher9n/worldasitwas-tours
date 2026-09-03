#!/bin/sh
#
# One picture of every picture in a walk, so a person can look at the whole
# thing at once.
#
# Built for the Colombo 1999 walk, where the failure mode is not a wrong fact
# but a wrong image: a rendered Sinhala sign that reads as nonsense, a vehicle
# from the wrong decade, a skyline with a tower that was not built yet. Those
# are invisible in a log and obvious in a grid.
#
#   tools/contact-sheet.sh tour_colombo_1999_three_wheeler [columns]
#
# Writes content/work/<tour>/contact-sheet.jpg
set -eu

TOUR="${1:?usage: tools/contact-sheet.sh <tour_id> [columns]}"
COLS="${2:-4}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="$ROOT/content/tours/$TOUR"
OUT="$ROOT/content/work/$TOUR/contact-sheet.jpg"

[ -d "$DIR" ] || { echo "no such walk: $DIR" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"

# Stills only, and in a stable order so the sheet reads stop by stop.
list=$(find "$DIR" -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' \) | sort)
n=$(printf '%s\n' "$list" | grep -c . || true)
[ "$n" -gt 0 ] || { echo "no images in $DIR" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
i=0
printf '%s\n' "$list" | while read -r f; do
  [ -n "$f" ] || continue
  i=$((i + 1))
  # Uniform cells: letterbox rather than crop, so nothing is hidden by the grid.
  ffmpeg -v error -y -i "$f" -vf "scale=420:560:force_original_aspect_ratio=decrease,pad=420:560:(ow-iw)/2:(oh-ih)/2:color=0x14171d" \
    "$tmp/$(printf '%03d' "$i").jpg"
done

rows=$(( (n + COLS - 1) / COLS ))
ffmpeg -v error -y -pattern_type glob -i "$tmp/*.jpg" -filter_complex "tile=${COLS}x${rows}:padding=8:color=0x0d0f13" -frames:v 1 "$OUT"
echo "$n images -> $OUT"
