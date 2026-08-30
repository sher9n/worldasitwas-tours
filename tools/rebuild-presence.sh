#!/usr/bin/env bash
# Rebuilds every guide's presence loop and republishes their walk.
#
# Clearing a companion's reel directory is what makes the pipeline build a new
# one: the reel belongs to the CHARACTER, not the walk, so it is generated once
# and every tour with that guide reuses it. Everything else in a re-run comes
# from cache and costs nothing.
#
#   tools/rebuild-presence.sh                    # all twelve, four at a time
#   tools/rebuild-presence.sh rome-1600-herb-seller
#   LANES=2 tools/rebuild-presence.sh            # gentler on the provider
#
# The old loop is kept in content/work/old-reels so a guide can be put back.
set -uo pipefail
cd "$(dirname "$0")/.."
LANES="${LANES:-4}"
mkdir -p content/work/old-reels content/work/logs

# One recipe. Re-invoked by the parallel path below, one process per lane.
if [ $# -gt 0 ]; then
  set -a; . ./.env; set +a
  status=0
  for name in "$@"; do
    recipe="content/recipes/$name.json"
    slug=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['companion']['name'].lower().replace(' ','-'))" "$recipe")
    # Back up whatever is there, not just a file called presence.mp4: older
    # guides carry a two-clip reel_01/reel_02 reel, and deleting files that were
    # never copied anywhere is how a rebuild becomes unrecoverable.
    if compgen -G "content/companions/$slug/reel/*.mp4" >/dev/null; then
      mkdir -p "content/work/old-reels/$slug"
      cp "content/companions/$slug/reel/"*.mp4 "content/work/old-reels/$slug/"
    fi
    rm -f "content/companions/$slug/reel/"*.mp4
    if npm run pipeline -- run "$PWD/$recipe" --provider fal --image-model nano-banana-pro --no-portrait >"content/work/logs/$name.log" 2>&1; then
      echo "done  $name ($slug)"
    else
      echo "FAIL  $name ($slug) - see content/work/logs/$name.log"
      status=1
    fi
  done
  exit $status
fi

ls content/recipes/*.json | xargs -n1 basename | sed 's/\.json$//' \
  | xargs -P "$LANES" -I{} "$0" {}
