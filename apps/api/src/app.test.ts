import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { signPlayerToken } from "@timetravel/client";
import { buildApp } from "./app.ts";
import { buildInstructions, mintSession } from "./companion.ts";
import type { Tour } from "@timetravel/schema";

const tour: Tour = {
  schema: "tour/1",
  id: "tour_london_1850_test",
  version: "2026-08-29.1",
  city: "london",
  year: 1850,
  yearRange: [1848, 1852],
  lang: "en",
  title: "Test walk",
  summary: "A test.",
  durationMin: 12,
  cover: { image: "http://localhost:4100/media/tour_london_1850_test/cover.jpg?v=aaaa111122" },
  companion: {
    name: "Nell Baker",
    role: "Flower seller",
    bio: "Sells violets.",
    portrait: "http://localhost:4100/media/tour_london_1850_test/nell.jpg?v=bbbb222233",
    greeting: { text: "Mind the mud." },
    voice: { provider: "openai-realtime", voice: "marin" },
      narrationVoice: "Lily",
    faceReel: [],
  },
  stops: [
    {
      id: "stop_01",
      order: 1,
      title: "Ludgate Hill",
      geo: { lat: 51.5139, lng: -0.1015 },
      arrival: {
        still: { image: "http://localhost:4100/media/tour_london_1850_test/s01_hero.jpg?v=cccc333344", origin: "reconstruction" },
        line: { text: "See the dome?", audio: "http://localhost:4100/media/tour_london_1850_test/s01_arrival.mp3?v=dddd444455" },
        hotspots: [],
      },
      cards: [
        { id: "s01c01", kind: "image", media: { image: "http://localhost:4100/media/tour_london_1850_test/s01_c1.jpg?v=eeee555566", origin: "reconstruction" }, caption: "Busy.", claims: [{ text: "Fare 6d", confidence: "known", sourceId: "src1" }], hotspots: [] },
      ],
    },
  ],
  sources: [{ id: "src1", title: "Mayhew", url: "http://x/m", license: "public-domain" }],
  provenance: { generatedAt: "2026-08-29T10:00:00.000Z", reviewedBy: "none", models: ["mock"], costUsd: 0 },
};

const SECRET = "player-secret-for-tests";
let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-api-"));
  await fs.mkdir(path.join(dir, tour.id), { recursive: true });
  await fs.writeFile(path.join(dir, tour.id, "manifest.json"), JSON.stringify(tour));
  await fs.writeFile(path.join(dir, tour.id, "hello.txt"), "media");
  app = await buildApp({ toursDir: dir, mediaBaseUrl: "https://media.example.com", playerTokenSecret: SECRET, platformKeys: ["k1"], openaiApiKey: "", realtimeModel: "gpt-realtime-2", dev: true });
});
after(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("rejects missing key", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/catalog" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "unauthorized");
});

test("catalog lists the city with its years", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/catalog", headers: { authorization: "Bearer k1" } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.cities[0].id, "london");
  assert.deepEqual(body.cities[0].years, [1850]);
});

test("tours endpoint: exact match and nearest fallback", async () => {
  const hit = await app.inject({ method: "GET", url: "/v1/tours?city=london&year=1849", headers: { authorization: "Bearer k1" } });
  assert.equal(hit.json().matches.length, 1);
  const miss = await app.inject({ method: "GET", url: "/v1/tours?city=london&year=1837", headers: { authorization: "Bearer k1" } });
  assert.equal(miss.json().matches.length, 0);
  assert.equal(miss.json().nearest[0].distanceYears, 11);
  const bad = await app.inject({ method: "GET", url: "/v1/tours?city=paris&year=1850", headers: { authorization: "Bearer k1" } });
  assert.equal(bad.statusCode, 404);
  assert.equal(bad.json().error.code, "city_not_found");
});

test("manifest is served with an ETag and honours If-None-Match", async () => {
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: { authorization: "Bearer k1" } });
  assert.equal(res.statusCode, 200);
  const etag = res.headers.etag as string;
  assert.ok(etag);
  const again = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: { authorization: "Bearer k1", "if-none-match": etag } });
  assert.equal(again.statusCode, 304);
  const missing = await app.inject({ method: "GET", url: "/v1/tours/tour_nope", headers: { authorization: "Bearer k1" } });
  assert.equal(missing.json().error.code, "tour_not_found");
});

test("media is served from the tour folder", async () => {
  const res = await app.inject({ method: "GET", url: `/media/${tour.id}/hello.txt` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "media");
});

test("companion session returns 503 when no voice key is configured", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/v1/tours/${tour.id}/companion/session`,
    headers: { authorization: "Bearer k1" },
    payload: { travellerId: "t1", stopId: "stop_01" },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "companion_unavailable");
});

test("instructions carry persona, year lock, cards and safety", () => {
  const text = buildInstructions(tour, "She says 'love' a lot.", { travellerId: "t", stopId: "stop_01", cardId: "s01c01" });
  assert.match(text, /You are Nell Baker/);
  assert.match(text, /know nothing after 1852/);
  assert.match(text, /\[s01c01\] image/);
  assert.match(text, /She says 'love' a lot/);
  assert.match(text, /SAFETY/);
});

test("mintSession sends push-to-talk config and maps the response", async () => {
  let captured: unknown;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ value: "ek_test", expires_at: 1_800_000_000, session: { id: "sess_1" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const s = await mintSession({ apiKey: "k", model: "gpt-realtime-2", tour, request: { travellerId: "t" }, fetchImpl });
  assert.equal(s.realtime.clientSecret, "ek_test");
  assert.equal(s.sessionId, "sess_1");
  const body = captured as { session: { audio: { input: { turn_detection: unknown }; output: { voice: string } }; tools: unknown[] } };
  assert.equal(body.session.audio.input.turn_detection, null);
  assert.equal(body.session.audio.output.voice, "marin");
  assert.equal(body.session.tools.length, 2);
});

test("media is re-pointed at wherever this deployment actually serves it", async () => {
  // The fixture manifest was published against http://localhost:4100, the way
  // every real one is. A deployed service must not hand a player links to the
  // laptop that made the tour.
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: { authorization: "Bearer k1" } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as typeof tour;
  const urls = JSON.stringify(body).match(/https?:\/\/[^"]+/g) ?? [];
  const media = urls.filter((u) => /\.(jpg|png|mp3|m4a|mp4)/.test(u));
  assert.ok(media.length > 0, "fixture should contain media urls");
  for (const u of media) {
    assert.ok(u.startsWith("https://media.example.com/"), `not re-pointed: ${u}`);
    assert.ok(!u.includes("localhost"), `still points at the publishing machine: ${u}`);
  }
});

test("a source citation is not media and is left alone", async () => {
  // The rebasing is keyed on the /media/ path, not on "looks like a URL". A
  // link to Mayhew is a fact about the world, not an asset we host.
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: { authorization: "Bearer k1" } });
  assert.equal((res.json() as typeof tour).sources[0].url, "http://x/m");
});

test("the content hash survives the re-pointing", async () => {
  // Losing ?v=… would make every deploy serve stale audio from a browser cache
  // under a filename that never changes.
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: { authorization: "Bearer k1" } });
  const hashed = (JSON.stringify(res.json()).match(/https?:\/\/[^"]+\?v=[0-9a-f]+/g) ?? []).length;
  assert.ok(hashed > 0, "expected at least one hashed media url to come through");
});

test("moving the media changes the ETag", async () => {
  // A player holding a manifest full of old links must be told it is stale.
  const other = await buildApp({ toursDir: dir, mediaBaseUrl: "https://cdn.example.net", platformKeys: ["k1"], openaiApiKey: "", realtimeModel: "gpt-realtime-2", dev: true });
  const a = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: { authorization: "Bearer k1" } });
  const b = await other.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: { authorization: "Bearer k1" } });
  assert.notEqual(a.headers.etag, b.headers.etag);
  await other.close();
});

test("health reports what is actually mounted", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; tours: number; cities: number };
  assert.equal(body.ok, true);
  assert.equal(body.tours, 1);
});

/* ── the player's own credential ──────────────────────────────────────────
   The hosted player runs in a browser, so it cannot hold the platform key.
   What it holds instead must open exactly one walk and nothing else. */

const player = (token: string) => ({ authorization: `Player ${token}` });

test("a signed token opens the walk it was issued for", async () => {
  const token = await signPlayerToken(SECRET, tour.id, "t_traveller");
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: player(token) });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as typeof tour).id, tour.id);
});

test("a token for one walk does not open another", async () => {
  // The whole point. A token is not a key: holding one must not turn into
  // holding the catalogue.
  const token = await signPlayerToken(SECRET, "tour_some_other_walk", "t_traveller");
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: player(token) });
  assert.equal(res.statusCode, 401);
});

test("a token never opens the catalogue or a search", async () => {
  const token = await signPlayerToken(SECRET, tour.id, "t_traveller");
  for (const url of ["/v1/catalog", "/v1/tours?city=london&year=1850"]) {
    const res = await app.inject({ method: "GET", url, headers: player(token) });
    assert.equal(res.statusCode, 401, `${url} should stay platform-key only`);
  }
});

test("a token is short-lived by default, not open-ended", async () => {
  // The default is the whole of the exposure window for a URL that ends up in
  // a browser history and a WebView. An hour covers a fifteen-minute walk and
  // a long pause; a day would not be a credential, it would be a key.
  const { PLAYER_TOKEN_TTL_SEC } = await import("@timetravel/client");
  assert.ok(PLAYER_TOKEN_TTL_SEC <= 3600, `default ttl is ${PLAYER_TOKEN_TTL_SEC}s`);
  const token = await signPlayerToken(SECRET, tour.id, "t_traveller");
  const claimedExpiry = Number(token.split(".")[0]);
  const seconds = claimedExpiry - Math.floor(Date.now() / 1000);
  assert.ok(seconds > 0 && seconds <= 3600, `token lives ${seconds}s`);
});

test("an expired token is refused", async () => {
  const token = await signPlayerToken(SECRET, tour.id, "t_traveller", -60);
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: player(token) });
  assert.equal(res.statusCode, 401);
});

test("a tampered expiry does not extend a token", async () => {
  // Pushing the clock forward is the obvious attack, and the signature covers
  // the expiry precisely so that it fails.
  const token = await signPlayerToken(SECRET, tour.id, "t_traveller", -60);
  const [, traveller, sig] = token.split(".");
  const forged = `${Math.floor(Date.now() / 1000) + 3600}.${traveller}.${sig}`;
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: player(forged) });
  assert.equal(res.statusCode, 401);
});

test("a token signed with the wrong secret is refused", async () => {
  const token = await signPlayerToken("not-the-secret", tour.id, "t_traveller");
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: player(token) });
  assert.equal(res.statusCode, 401);
});

test("rubbish in the Player header is refused, not crashed on", async () => {
  for (const bad of ["", "...", "abc", "1.2", "9999999999.t.", `${Math.floor(Date.now()/1000)+60}.t.zzzz`]) {
    const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: player(bad) });
    assert.equal(res.statusCode, 401, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("the platform key still works on the player routes", async () => {
  const res = await app.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: { authorization: "Bearer k1" } });
  assert.equal(res.statusCode, 200);
});

test("with no secret configured, a token opens nothing", async () => {
  const other = await buildApp({ toursDir: dir, mediaBaseUrl: "https://m.example.com", platformKeys: ["k1"], openaiApiKey: "", realtimeModel: "gpt-realtime-2", dev: true });
  const token = await signPlayerToken(SECRET, tour.id, "t_traveller");
  const res = await other.inject({ method: "GET", url: `/v1/tours/${tour.id}`, headers: player(token) });
  assert.equal(res.statusCode, 401);
  await other.close();
});

/* ─────────────────────────── the feed ─────────────────────────── */

test("the feed needs a platform key, like the catalogue", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/feed" });
  assert.equal(res.statusCode, 401);
});

test("a player token does not open the feed", async () => {
  // The token authorises one walk for one traveller. The feed is every walk we
  // have, so a page holding one must not be able to read the catalogue through it.
  const token = await signPlayerToken(SECRET, tour.id, "t_1");
  const res = await app.inject({ method: "GET", url: "/v1/feed", headers: { authorization: `Player ${token}` } });
  assert.equal(res.statusCode, 401);
});

test("the feed carries what a map needs to draw a walk", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/feed", headers: { authorization: "Bearer k1" } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, "feed/1");
  assert.equal(body.tours.length, 1);

  const t = body.tours[0];
  assert.equal(t.id, tour.id);
  assert.equal(t.title, "Test walk");
  assert.equal(t.year, 1850);
  assert.equal(t.durationMin, 12);
  assert.equal(t.stopCount, 1);
  assert.equal(t.companion.name, "Nell Baker");
  assert.deepEqual(t.city, { id: "london", name: "London", country: "GB" });
  // The pin for the walk as a whole is its first stop.
  assert.deepEqual(t.start, { lat: 51.5139, lng: -0.1015 });

  const stop = t.stops[0];
  assert.equal(stop.name, "Ludgate Hill");
  assert.equal(stop.lat, 51.5139);
  assert.equal(stop.lng, -0.1015);
  // No blurb in the fixture, so the description falls back to the card caption.
  assert.equal(stop.description, "Busy.");
});

test("feed media is re-pointed the same way a manifest is", async () => {
  // The cover is what a host draws on its card, so a feed still pointing at the
  // laptop that published the walk is a broken image on somebody else's site.
  const res = await app.inject({ method: "GET", url: "/v1/feed", headers: { authorization: "Bearer k1" } });
  const t = res.json().tours[0];
  assert.ok(t.cover.image.startsWith("https://media.example.com/"), t.cover.image);
  assert.ok(t.companion.portrait.startsWith("https://media.example.com/"), t.companion.portrait);
});


test("a browsing pass opens the catalogue, and only when it is genuine", async () => {
  const app = await buildApp({ toursDir: dir, mediaBaseUrl: "https://media.example.com", playerTokenSecret: SECRET, platformKeys: ["k1"], openaiApiKey: "", realtimeModel: "gpt-realtime-2", dev: true });
  await app.ready();

  const locked = await app.inject({ method: "GET", url: "/v1/catalog" });
  assert.equal(locked.statusCode, 401);

  const pass = await app.inject({ method: "GET", url: "/bypass" });
  assert.equal(pass.statusCode, 302);
  const cookie = String(pass.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const value = cookie.split(";")[0];
  const opened = await app.inject({ method: "GET", url: "/v1/catalog", headers: { cookie: value } });
  assert.equal(opened.statusCode, 200);

  const forged = await app.inject({ method: "GET", url: "/v1/catalog", headers: { cookie: "tt_pass=not-the-signature" } });
  assert.equal(forged.statusCode, 401);
  await app.close();
});

test("the feed is ETagged over its walks, not over the time it was asked for", async () => {
  const first = await app.inject({ method: "GET", url: "/v1/feed", headers: { authorization: "Bearer k1" } });
  const etag = first.headers.etag as string;
  assert.ok(etag, "feed should carry an ETag");

  // updatedAt moves on every call. If the tag were taken over the body, a host
  // polling an unchanged catalogue would re-download it every single time.
  const second = await app.inject({ method: "GET", url: "/v1/feed", headers: { authorization: "Bearer k1" } });
  assert.equal(second.headers.etag, etag);

  const third = await app.inject({
    method: "GET",
    url: "/v1/feed",
    headers: { authorization: "Bearer k1", "if-none-match": etag },
  });
  assert.equal(third.statusCode, 304);
  assert.equal(third.body, "");
});
