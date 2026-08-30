#!/bin/sh
#
# A link someone can open, for one walk, without holding a platform key.
#
# The hosted player takes a signed token in the URL. It authorises exactly one
# walk for one traveller until it expires, so it can live in a browser, in a
# message, or on a phone without giving anything else away.
#
#   RAILWAY_TOKEN=<project token> tools/player-link.sh tour_rome_1750_cicerone [days]
#
set -eu
TOUR="${1:?usage: player-link.sh <tourId> [days]}"
DAYS="${2:-7}"
SECRET=$(RAILWAY_TOKEN="${RAILWAY_TOKEN:?set RAILWAY_TOKEN}" railway variables --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.PLAYER_TOKEN_SECRET||"")})')
[ -n "$SECRET" ] || { echo "the service has no PLAYER_TOKEN_SECRET set" >&2; exit 1; }
BASE=$(RAILWAY_TOKEN="$RAILWAY_TOKEN" railway variables --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.PUBLIC_BASE_URL||"https://tours.worldasitwas.com")})')
TOUR="$TOUR" DAYS="$DAYS" SECRET="$SECRET" BASE="$BASE" node -e '
  const crypto = require("crypto");
  const { TOUR, DAYS, SECRET, BASE } = process.env;
  const traveller = "guest_" + crypto.randomBytes(5).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + Number(DAYS) * 86400;
  const sig = crypto.createHmac("sha256", SECRET).update(`${TOUR}\n${traveller}\n${expiresAt}`).digest("base64url");
  const tk = `${expiresAt}.${encodeURIComponent(traveller)}.${sig}`;
  console.log(`${BASE.replace(/\/$/, "")}/?tour=${TOUR}&tk=${encodeURIComponent(tk)}`);
  console.error(`valid ${DAYS} day(s), for this walk only`);
'
