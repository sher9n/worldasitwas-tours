#!/usr/bin/env bash
# Publishes the socials pack, and survives the volume endpoint.
#
# Two things learned the hard way:
#   - A single timeout aborts a whole folder transfer, so this checks what is
#     already correct and only sends the rest. Run it again after a failure and
#     it picks up where it stopped.
#   - Uploading one file to a directory that does not exist yet creates a FILE
#     with that directory's name, and every later folder upload then fails with
#     "not a directory". The pack is therefore flat, with no subfolder.
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${RAILWAY_TOKEN:?set RAILWAY_TOKEN to the tour project token}"
V="${VOLUME:-worldasitwas-tours-volume}"
SRC=content/tours/_socials
BASE=https://tours.worldasitwas.com/media/_socials

pass=1
while [ $pass -le 6 ]; do
  missing=""
  for f in $(ls "$SRC"); do
    L=$(stat -f%z "$SRC/$f")
    R=$(curl -s -o /dev/null -w "%{size_download}" "$BASE/$f?cb=$RANDOM")
    [ "$L" = "$R" ] || missing="$missing $f"
  done
  [ -z "$missing" ] && { echo "all files live"; exit 0; }
  set -- $missing
  echo "pass $pass: $# file(s) still to send"
  for f in $missing; do
    railway volume files --volume "$V" upload "$SRC/$f" /tours/_socials --overwrite >/dev/null 2>&1 \
      && echo "  sent $f" || echo "  missed $f"
    sleep 1
  done
  pass=$((pass + 1))
done
echo "gave up with files still missing" >&2
exit 1
