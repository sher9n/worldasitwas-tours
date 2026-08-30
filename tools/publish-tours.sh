#!/bin/sh
#
# Put published walks on the tour service.
#
# Walks are generated on a laptop and are far too heavy for git — about 55 MB
# of stills, narration and lip-synced clips each, against a 100 KB manifest.
# They live on a Railway volume instead, and this is how they get there.
#
# The service reads the volume on every request, so a walk uploaded here is
# live immediately: no redeploy, no restart, no app release.
#
#   RAILWAY_TOKEN=<project token> tools/publish-tours.sh              # all walks
#   RAILWAY_TOKEN=<project token> tools/publish-tours.sh tour_x tour_y  # some
#
# Re-running replaces what is there, which is what you want after a walk has
# been rewritten. Uploads run one walk at a time so a failure costs one walk
# rather than the batch, and the SFTP session Railway opens occasionally times
# out on the first try, so each walk gets three attempts.
set -u

VOLUME="${VOLUME:-worldasitwas-tours-volume}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOURS_DIR="$ROOT/content/tours"

if [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "RAILWAY_TOKEN is not set. Use the tour project's token." >&2
  exit 1
fi

if [ $# -gt 0 ]; then
  TOURS="$*"
else
  TOURS=$(cd "$TOURS_DIR" && ls -d tour_* 2>/dev/null)
fi

[ -n "$TOURS" ] || { echo "no walks found in $TOURS_DIR" >&2; exit 1; }

ok=0; failed=""
for t in $TOURS; do
  src="$TOURS_DIR/$t"
  if [ ! -f "$src/manifest.json" ]; then
    echo "  skip $t (no manifest.json — not published yet)"
    continue
  fi
  size=$(du -sh "$src" | cut -f1 | tr -d ' ')
  files=$(find "$src" -type f | wc -l | tr -d ' ')
  printf "  %-42s %6s  %3s files ... " "$t" "$size" "$files"

  n=0
  while [ $n -lt 3 ]; do
    n=$((n + 1))
    if out=$(railway volume files --volume "$VOLUME" upload "$src" "/tours/$t" --overwrite 2>&1); then
      echo "ok"
      ok=$((ok + 1))
      break
    fi
    if [ $n -eq 3 ]; then
      echo "FAILED"
      echo "$out" | sed 's/^/        /' >&2
      failed="$failed $t"
    else
      printf "retry %s ... " "$n"
      sleep 3
    fi
  done
done

echo
echo "$ok walk(s) published to the volume."
[ -n "$failed" ] && { echo "failed:$failed" >&2; exit 1; }

# The service lists the volume per request, so this reflects reality straight away.
BASE="${PUBLIC_BASE_URL:-https://tours.worldasitwas.com}"
echo "service now reports: $(curl -s "$BASE/health")"
