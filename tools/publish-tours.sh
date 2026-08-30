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
#   RAILWAY_TOKEN=<project token> tools/publish-tours.sh --check     # what is up there
#   RAILWAY_TOKEN=<project token> tools/publish-tours.sh             # send what is missing
#   RAILWAY_TOKEN=<project token> tools/publish-tours.sh tour_x      # send one, always
#
# TWO THINGS WILL WASTE YOUR AFTERNOON IF YOU DO NOT KNOW THEM.
#
# Do not deploy while this runs. Upload goes over SFTP into the running
# container, so a redeploy — including the automatic one a push to main
# triggers — restarts it and cuts the transfer off mid-walk. A run of "Failed
# to initialize SFTP session / Timeout" across every remaining walk is what
# that looks like.
#
# Do not run several of these at once, and leave the pauses in. Railway's SFTP
# endpoint starts refusing sessions when they are opened back to back, and the
# failure is again a timeout rather than anything that names the real cause.
set -u

VOLUME="${VOLUME:-worldasitwas-tours-volume}"
PAUSE="${PAUSE:-5}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOURS_DIR="$ROOT/content/tours"

[ -n "${RAILWAY_TOKEN:-}" ] || { echo "RAILWAY_TOKEN is not set. Use the tour project's token." >&2; exit 1; }

local_tours() { (cd "$TOURS_DIR" && ls -d tour_* 2>/dev/null); }
local_count() { find "$TOURS_DIR/$1" -type f | wc -l | tr -d ' '; }

# One listing of the whole /tours directory, then one per walk. Counting files
# per walk any other way means an SFTP session per walk, which is the thing
# the endpoint dislikes.
remote_count() {
  n=$(railway volume files --volume "$VOLUME" list "/tours/$1" 2>/dev/null | tr ' ' '\n' | grep -c '[^[:space:]]') || n=0
  echo "${n:-0}"
}

reconcile() {
  short=""
  for t in $(local_tours); do
    [ -f "$TOURS_DIR/$t/manifest.json" ] || continue
    l=$(local_count "$t"); r=$(remote_count "$t")
    if [ "$l" = "$r" ]; then
      printf "  %-42s %3s files  complete\n" "$t" "$l"
    else
      printf "  %-42s %3s files  ON VOLUME: %s  SHORT\n" "$t" "$l" "$r"
      short="$short $t"
    fi
    sleep 1
  done
}

if [ "${1:-}" = "--check" ]; then
  echo "Comparing $TOURS_DIR with the volume:"
  reconcile
  echo
  [ -n "$short" ] && echo "incomplete:$short" || echo "Everything is published."
  exit 0
fi

if [ $# -gt 0 ]; then
  TOURS="$*"
else
  echo "Checking what is already on the volume:"
  reconcile
  TOURS="$short"
  echo
  [ -n "$TOURS" ] || { echo "Nothing to send."; exit 0; }
  echo "Sending:$TOURS"
fi

ok=0; failed=""
for t in $TOURS; do
  src="$TOURS_DIR/$t"
  [ -f "$src/manifest.json" ] || { echo "  skip $t (no manifest.json)"; continue; }
  printf "  %-42s %6s ... " "$t" "$(du -sh "$src" | cut -f1 | tr -d ' ')"

  n=0
  while [ $n -lt 4 ]; do
    n=$((n + 1))
    if out=$(railway volume files --volume "$VOLUME" upload "$src" "/tours/$t" --overwrite 2>&1); then
      echo "ok"; ok=$((ok + 1)); break
    fi
    if [ $n -eq 4 ]; then
      echo "FAILED"; echo "$out" | sed 's/^/        /' >&2; failed="$failed $t"
    else
      printf "retry %s ... " "$n"; sleep $((PAUSE * n))
    fi
  done
  sleep "$PAUSE"
done

echo
echo "$ok walk(s) sent."
echo "Verifying against the volume:"
reconcile
BASE="${PUBLIC_BASE_URL:-https://tours.worldasitwas.com}"
echo
echo "service reports: $(curl -s "$BASE/health")"
[ -z "$short" ] || { echo "still incomplete:$short — re-run" >&2; exit 1; }
[ -z "$failed" ] || { echo "failed:$failed" >&2; exit 1; }
