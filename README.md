# Time Travel tour engine

Batch pipeline, tour API and mobile playground for the Time Travel project. The
map and app shell live elsewhere; this repo starts at "the traveller picked a
place and a year" and owns everything after: the tour, its media, the sources,
and the live companion you can talk to.

Integration brief for the platform team: see the shared artifact (API contract,
manifest schema, experience spec). The schema in `packages/schema` is the
source of truth for the manifest shape.

## Layout

```
packages/schema     tour/1 manifest schema (zod) + recipe schema + tests
apps/api            Fastify API: /v1/catalog, /v1/tours, /v1/tours/:id, companion session, /media
apps/pipeline       recipe -> research -> archive -> script -> character -> media -> manifest
apps/playground     Vite + React: phone-frame player, WebRTC companion, events, cost, QR
content/recipes     one JSON recipe per tour (the input)
content/tours       published tours: manifest.json + media + companion.md + ledger.json
content/work        intermediate stage outputs and logs (gitignored)
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

## Tests

```
npm test
npm run smoke:realtime -w @timetravel/api   # mints a companion session and talks to it over a websocket
```

## Accounts

fal.ai for every media model (GPT Image 2, Nano Banana Pro, Seedance 2.5,
OmniHuman 1.5, ElevenLabs speech and sound effects) and OpenAI for research
(gpt-5.4) and the live companion (gpt-realtime-2). Wikimedia Commons needs no
key. Media is served from `content/tours` in dev; production moves it to a
bucket and sets `PUBLIC_BASE_URL`.
