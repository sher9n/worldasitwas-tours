import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  cover: { image: "http://x/cover.webp" },
  companion: {
    name: "Nell Baker",
    role: "Flower seller",
    bio: "Sells violets.",
    portrait: "http://x/nell.webp",
    greeting: { text: "Mind the mud." },
    voice: { provider: "openai-realtime", voice: "marin" },
    faceReel: [],
  },
  stops: [
    {
      id: "stop_01",
      order: 1,
      title: "Ludgate Hill",
      geo: { lat: 51.5139, lng: -0.1015 },
      arrival: { line: { text: "See the dome?" }, hotspots: [] },
      cards: [
        { id: "s01c01", kind: "image", media: { image: "http://x/a.webp", origin: "reconstruction" }, caption: "Busy.", claims: [{ text: "Fare 6d", confidence: "known", sourceId: "src1" }], hotspots: [] },
      ],
    },
  ],
  sources: [{ id: "src1", title: "Mayhew", url: "http://x/m", license: "public-domain" }],
  provenance: { generatedAt: "2026-08-29T10:00:00.000Z", reviewedBy: "none", models: ["mock"], costUsd: 0 },
};

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-api-"));
  await fs.mkdir(path.join(dir, tour.id), { recursive: true });
  await fs.writeFile(path.join(dir, tour.id, "manifest.json"), JSON.stringify(tour));
  await fs.writeFile(path.join(dir, tour.id, "hello.txt"), "media");
  app = await buildApp({ toursDir: dir, platformKeys: ["k1"], openaiApiKey: "", realtimeModel: "gpt-realtime-2", dev: true });
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
