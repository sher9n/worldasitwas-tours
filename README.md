# Time Travel tour engine

Batch pipeline, tour API and mobile playground for the Time Travel project. The
map and app shell live elsewhere; this repo starts at "the traveller picked a
place and a year" and owns everything after: the tour, its media, the sources,
and the live companion you can talk to.

Integration brief for the platform team: see the shared artifact (API contract,
manifest schema, experience spec). The schema in `packages/schema` is the
source of truth for the manifest shape.

**Integrating a walk into an app** starts in the playground: the **Integrate**
tab is the code, per platform, built from whichever walk is selected; the
**Embed** tab is the player running in a real frame with the event bridge live,
so you can watch `stop_entered` arrive and send `pause` back. Copy-in files for
World As It Was are in `integration/worldasitwas-app/`.

## Layout

```
packages/schema     tour/1 manifest schema (zod) + recipe schema + tests
packages/client     dependency-free client for the API and the hosted player
apps/api            Fastify API: /v1/catalog, /v1/tours, /v1/tours/:id, companion session, /media
apps/pipeline       recipe -> research -> archive -> script -> character -> media -> manifest
apps/playground     Vite + React: phone-frame player, WebRTC companion, events, cost, QR
content/recipes     one JSON recipe per tour (the input)
content/tours       published tours: manifest.json + media + companion.md + ledger.json
content/work        intermediate stage outputs and logs (gitignored)
integration/        copy-in files for the apps that embed a walk
```

## Setup

```
cp .env.example .env    # fill FAL_KEY and OPENAI_API_KEY
npm install
```

## Run

```
npm run api           # http://localhost:4100
npm run playground    # https://localhost:5173 (self-signed cert; HTTPS so a phone can use its mic)
```

## Make a tour

```
# whole flow, real media (needs fal credit):
npm run pipeline -- run content/recipes/london-1850-flower-seller.json --quality draft
# one stop, placeholder media, real research and script (cheap):
npm run pipeline -- run content/recipes/london-1850-flower-seller.json --stops 1 --provider mock
# final quality, no talking portraits:
npm run pipeline -- run content/recipes/london-1850-flower-seller.json --quality final --no-portrait
```

Stage outputs are cached in `content/work/<tourId>/`; re-running reuses them, so a
failed media stage does not repeat the research. `--fresh` clears the cache.

Every paid call is written to the ledger (`ledger.json`) with units, rate and an
estimated cost; the manifest's `provenance.costUsd` is the total.

## Deploying, and publishing walks to it

The service runs on Railway at <https://tours.worldasitwas.com>. Pushing to `main`
builds and deploys it; `railway.json` holds the build and the health gate.

Walks do **not** travel with the code. A walk is about 55 MB of stills, narration
and lip-synced clips against a 100 KB manifest, and generated media has no business
in a git history that keeps every version of it forever. They live on a Railway
volume mounted at `/data`, and the service reads that volume on every request — so a
walk you upload is live immediately, with no redeploy, no restart and no app release.

```
RAILWAY_TOKEN=<project token> tools/publish-tours.sh              # every published walk
RAILWAY_TOKEN=<project token> tools/publish-tours.sh tour_rome_1600_herb_seller
```

Re-running replaces what is there, which is what you want after rewriting a walk.

Media is served by the service from that volume and cached by Railway's CDN at the
edge nearest each traveller. A cache hit never reaches the service, so it costs no
egress and no compute — which is what makes serving a gigabyte of audio from one
container reasonable. Manifests are not cached: they carry an `Authorization`
header, which bypasses the edge by design, and they are small and must be current.

### The variables that matter

| | |
|---|---|
| `PLATFORM_KEYS` | Comma-separated. Server-to-server callers present one as `Authorization: Bearer`. Unset means **every request is allowed** — never in production. |
| `PLAYER_TOKEN_SECRET` | Signs the short-lived token in a player URL. Whoever builds player URLs needs the same value. |
| `PUBLIC_BASE_URL` | The service's own origin. Media URLs are re-pointed onto it as manifests are read. |
| `CONTENT_DIR` | `/data` in production — the volume. Defaults to `./content` locally. |
| `OPENAI_API_KEY` | Only the live companion needs it. Everything else works without. |
| `ENABLE_DEV_ROUTES` | `1` locally for the console's cost tab. Never set it on a public deployment. |

`PLAYER_DIR` and the media base are worked out on their own; do not set `NODE_ENV`,
which would make npm skip the devDependencies the build is made of.

## Tests

```
npm test
npm run check:integration                   # the Integrate and Embed tabs, and the bridge, in a real browser
npm run smoke:realtime -w @timetravel/api   # mints a companion session and talks to it over a websocket
```

`npm test` includes `tools/check-vendored-client.cjs`, which fails if the copies
of the client under `integration/` have drifted from `packages/client/src/index.ts`.
That file is written to be pasted into an app, so it has no dependencies and is
duplicated rather than imported; the check is what stops two copies of a contract
becoming two contracts.

## Accounts

fal.ai for every media model (GPT Image 2, Nano Banana Pro, Seedance 2.5,
OmniHuman 1.5, ElevenLabs speech and sound effects) and OpenAI for research
(gpt-5.4) and the live companion (gpt-realtime-2). Wikimedia Commons needs no
key. Media is served from `content/tours` in dev; production moves it to a
bucket and sets `PUBLIC_BASE_URL`.
