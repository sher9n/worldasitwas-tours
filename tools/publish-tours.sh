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
#
# And the one that cost an afternoon: send the walk to the directory it lives
# IN, not to its own path. The destination is treated as a parent, so uploading
# to /tours/<id> buries the walk at /tours/<id>/<id> while every line prints
# "ok" and the service goes on serving the old one. Uploading to /tours with
# --overwrite puts the files exactly where the service reads them.
#
# There used to be a rename dance here to clear the old walk first. It is gone:
# it was working around the wrong destination, and it failed silently often
# enough on Railway's SFTP endpoint that walks reported success for uploads
# nobody ever saw. If you find old /broken_<id>.<timestamp> directories on the
# volume, they are from that era and can be deleted.
set -u

VOLUME="${VOLUME:-worldasitwas-tours-volume}"
PAUSE="${PAUSE:-5}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOURS_DIR="$ROOT/content/tours"

[ -n "${RAILWAY_TOKEN:-}" ] || { echo "RAILWAY_TOKEN is not set. Use the tour project's token." >&2; exit 1; }

local_tours() { (cd "$TOURS_DIR" && ls -d tour_* 2>/dev/null); }
local_count() { find "$TOURS_DIR/$1" -type f | wc -l | tr -d ' '; }

# NOTE: this listing is NOT trustworthy and is kept only for a rough look. A
# timed-out listing is indistinguishable from an empty directory, so it reports
# zero for walks the service is demonstrably serving. Anything that has to be
# right uses tools/verify-tours.sh, which asks the service.
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
  echo "Which walks are missing (asking the service):"
  TOURS=$("$(dirname "$0")/verify-tours.sh" 2>/dev/null | sed -n 's/^incomplete://p')
  [ -n "$TOURS" ] || { echo "Nothing to send — every walk is live."; exit 0; }
  echo "Sending:$TOURS"
fi

ok=0; failed=""
for t in $TOURS; do
  src="$TOURS_DIR/$t"
  [ -f "$src/manifest.json" ] || { echo "  skip $t (no manifest.json)"; continue; }
  printf "  %-42s %6s ... " "$t" "$(du -sh "$src" | cut -f1 | tr -d ' ')"

  # Send the walk to the directory it lives IN, not to its own path. Given its
  # own path the CLI treats that as a parent and buries the walk at
  # /tours/<id>/<id>, which is what the rename dance here used to be working
  # around, badly: the rename failed silently often enough that walks reported
  # "ok" for an upload the service never saw. With the parent as the target and
  # --overwrite, the files land exactly where the service reads them.
  n=0
  while [ $n -lt 4 ]; do
    n=$((n + 1))
    # Exit status is not enough: the CLI has returned zero having transferred
    # only part of a walk. The word it prints on a real success is checked too.
    out=$(railway volume files --volume "$VOLUME" upload "$src" "/tours" --overwrite --concurrency 8 2>&1)
    if printf '%s' "$out" | grep -q "Uploaded"; then
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
echo
# Ask the service, not the volume: an upload can exit 0 having transferred only
# part of a walk, and only the service can say whether one is actually usable.
exec "$(dirname "$0")/verify-tours.sh"
