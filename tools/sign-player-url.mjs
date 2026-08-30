/**
 * Mint a signed player URL from the command line.
 *
 * The player is opened by a browser and must never hold the platform key, so
 * in production every player URL carries a short-lived token instead. This is
 * how you make one by hand — to check a deployment, to hand someone a working
 * link, or to see what the app's own backend will be producing.
 *
 *   PLAYER_TOKEN_SECRET=… node tools/sign-player-url.mjs <tourId> [travellerId]
 *
 * PUBLIC_BASE_URL sets the origin (default http://localhost:4100).
 */
import { createClient } from "@timetravel/client";

const [tourId, travellerId = "t_manual"] = process.argv.slice(2);
const secret = process.env.PLAYER_TOKEN_SECRET;

if (!tourId || !secret) {
  console.error("usage: PLAYER_TOKEN_SECRET=… node tools/sign-player-url.mjs <tourId> [travellerId]");
  process.exit(1);
}

const base = (process.env.PUBLIC_BASE_URL || "http://localhost:4100").replace(/\/$/, "");
const client = createClient({ baseUrl: base, playerSecret: secret });
console.log(await client.signedPlayerUrl(tourId, { travellerId }));
