#!/bin/sh
#
# Ask the service what it can actually serve.
#
# The obvious check — list the volume over SFTP and count files — turned out to
# lie: it reports zero for walks the service is demonstrably serving, because a
# timed-out listing looks exactly like an empty directory. So completeness is
# measured where it matters instead: can the manifest be fetched, and do the
# media files it points at actually come back.
#
#   RAILWAY_TOKEN=<project token> tools/verify-tours.sh
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE="${PUBLIC_BASE_URL:-https://tours.worldasitwas.com}"
HOST=$(echo "$BASE" | sed 's|https\{0,1\}://||; s|/.*||')

if [ -z "${TOURS_PLATFORM_KEY:-}" ]; then
  [ -n "${RAILWAY_TOKEN:-}" ] || { echo "set TOURS_PLATFORM_KEY or RAILWAY_TOKEN" >&2; exit 1; }
  TOURS_PLATFORM_KEY=$(railway variables --service "${SERVICE:-worldasitwas-tours}" --kv 2>/dev/null | grep '^PLATFORM_KEYS=' | cut -d= -f2-)
fi

# This machine's resolver can lag behind a freshly added record; go straight to
# the edge so a stale cache never reads as an outage.
IP=$(dig +short @1.1.1.1 "$(echo "$BASE" | sed 's|.*//||; s|/.*||')" A 2>/dev/null | grep -E '^[0-9]' | tail -1)
[ -n "$IP" ] && RES="--resolve $HOST:443:$IP" || RES=""

missing=""
for t in $(cd "$ROOT/content/tours" && ls -d tour_* 2>/dev/null); do
  [ -f "$ROOT/content/tours/$t/manifest.json" ] || continue
  body=$(curl -s $RES -H "Authorization: Bearer $TOURS_PLATFORM_KEY" "$BASE/v1/tours/$t")
  urls=$(printf '%s' "$body" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit(1)
s=d['stops']
picks=[d['cover']['image'], d['companion']['portrait']]
for st in (s[0], s[len(s)//2], s[-1]):
    a=st['arrival']
    if a.get('still'): picks.append(a['still']['image'])
    if a['line'].get('audio'): picks.append(a['line']['audio'])
print('\n'.join(u for u in picks if u))
" 2>/dev/null) || { printf "  %-42s MANIFEST MISSING\n" "$t"; missing="$missing $t"; continue; }

  bad=0
  for u in $urls; do
    code=$(curl -s $RES -o /dev/null -w '%{http_code}' -I "$u")
    [ "$code" = "200" ] || bad=$((bad + 1))
  done
  total=$(printf '%s\n' "$urls" | grep -c .)
  if [ "$bad" -eq 0 ]; then
    printf "  %-42s ok (%s/%s media)\n" "$t" "$total" "$total"
  else
    printf "  %-42s MEDIA MISSING (%s of %s)\n" "$t" "$bad" "$total"
    missing="$missing $t"
  fi
done

echo
if [ -n "$missing" ]; then
  echo "incomplete:$missing"
  echo "  RAILWAY_TOKEN=… tools/publish-tours.sh$missing"
  exit 1
fi
echo "Every local walk is live and its media resolves."
