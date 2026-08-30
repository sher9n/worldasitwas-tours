import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  parseTourEvent,
  tourCommand,
  tourCommandScript,
  TimeTravelError,
  PLAYER_MESSAGE_SOURCE,
  type Catalog,
  type TourMatches,
  type TourSummary,
} from "./index.ts";

/* ── helpers ─────────────────────────────────────────────────────────── */

type Call = { url: string; init?: RequestInit };

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function summary(over: Partial<TourSummary> = {}): TourSummary {
  return {
    id: "tour_london_1850_flower_seller",
    version: "v1",
    title: "A Walk with a Flower Seller",
    summary: "…",
    city: "london",
    year: 1850,
    yearRange: [1840, 1860],
    lang: "en",
    durationMin: 20,
    stopCount: 6,
    companion: { name: "Nell Baker", role: "flower seller", portrait: "/p.jpg" },
    cover: { image: "/c.jpg" },
    start: { lat: 51.5, lng: -0.1 },
    distanceYears: 0,
    ...over,
  };
}

/* ── requests ────────────────────────────────────────────────────────── */

test("catalog sends the key and strips a trailing slash from baseUrl", async () => {
  const cat: Catalog = { cities: [], updatedAt: new Date().toISOString() };
  const { f, calls } = stubFetch(() => json(cat));
  const c = createClient({ baseUrl: "https://tours.example.com/", apiKey: "k1", fetch: f });

  assert.deepEqual(await c.catalog(), cat);
  assert.equal(calls[0].url, "https://tours.example.com/v1/catalog");
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer k1");
});

test("no key configured means no authorization header at all", async () => {
  // The proxy case: the app's own backend attaches the key. An empty Bearer
  // would be worse than none — it reads as a bad key, not as an absent one.
  const { f, calls } = stubFetch(() => json({ cities: [], updatedAt: "" }));
  await createClient({ baseUrl: "https://api.worldasitwas.com/tours", fetch: f }).catalog();
  assert.equal("authorization" in (calls[0].init?.headers as Record<string, string>), false);
});

test("find encodes city and year, and passes lang only when given", async () => {
  const { f, calls } = stubFetch(() => json({ city: "london", year: 1850, matches: [], nearest: [] }));
  const c = createClient({ baseUrl: "https://t.example", fetch: f });

  await c.find({ city: "new york", year: 1850 });
  assert.equal(calls[0].url, "https://t.example/v1/tours?city=new%20york&year=1850");
  await c.find({ city: "london", year: 1850, lang: "sv" });
  assert.match(calls[1].url, /lang=sv$/);
});

/* ── resolve: the one call a Travel button makes ─────────────────────── */

test("resolve prefers an exact match over a near one", async () => {
  const body: TourMatches = {
    city: "london",
    year: 1850,
    matches: [summary({ id: "tour_exact" })],
    nearest: [summary({ id: "tour_near", distanceYears: 45 })],
  };
  const { f } = stubFetch(() => json(body));
  const got = await createClient({ baseUrl: "https://t.example", fetch: f }).resolve({ city: "london", year: 1850 });
  assert.equal(got?.id, "tour_exact");
});

test("resolve falls back to the nearest year when nothing matches exactly", async () => {
  const { f } = stubFetch(() =>
    json({ city: "london", year: 1912, matches: [], nearest: [summary({ id: "tour_near", distanceYears: 52 })] }),
  );
  const got = await createClient({ baseUrl: "https://t.example", fetch: f }).resolve({ city: "london", year: 1912 });
  assert.equal(got?.id, "tour_near");
  assert.equal(got?.distanceYears, 52);
});

test("resolve returns null for a city we do not cover, and does not throw", async () => {
  const { f } = stubFetch(() => json({ error: { code: "city_not_found", message: 'Unknown city "atlantis"' } }, 404));
  const got = await createClient({ baseUrl: "https://t.example", fetch: f }).resolve({ city: "atlantis", year: 1850 });
  assert.equal(got, null);
});

test("resolve still throws on a bad key — an empty result would hide it", async () => {
  const { f } = stubFetch(() => json({ error: { code: "unauthorized", message: "Missing or invalid platform key" } }, 401));
  await assert.rejects(
    () => createClient({ baseUrl: "https://t.example", apiKey: "wrong", fetch: f }).resolve({ city: "london", year: 1850 }),
    (err: unknown) => err instanceof TimeTravelError && err.code === "unauthorized" && err.status === 401,
  );
});

/* ── errors ──────────────────────────────────────────────────────────── */

test("a 429 carries retryAfterSec so the caller can say how long", async () => {
  const { f } = stubFetch(() =>
    json({ error: { code: "session_limit", message: "Her voice is resting; try again in 42 seconds" } }, 429, {
      "retry-after": "42",
    }),
  );
  await assert.rejects(
    () => createClient({ baseUrl: "https://t.example", fetch: f }).companionSession("tour_x", { travellerId: "t1" }),
    (err: unknown) => err instanceof TimeTravelError && err.code === "session_limit" && err.retryAfterSec === 42,
  );
});

test("a non-JSON gateway error still becomes a TimeTravelError", async () => {
  const { f } = stubFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  await assert.rejects(
    () => createClient({ baseUrl: "https://t.example", fetch: f }).catalog(),
    (err: unknown) => err instanceof TimeTravelError && err.code === "http_502" && err.status === 502,
  );
});

test("a dead network is code network, not an unhandled throw", async () => {
  const f = (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch;
  await assert.rejects(
    () => createClient({ baseUrl: "https://t.example", fetch: f }).catalog(),
    (err: unknown) => err instanceof TimeTravelError && err.code === "network",
  );
});

/* ── the player URL ──────────────────────────────────────────────────── */

test("playerUrl carries no key and encodes its parameters", () => {
  const c = createClient({
    baseUrl: "https://tours.example.com",
    apiKey: "secret-key",
    playerUrl: "https://play.example.com/",
    fetch: (() => {}) as unknown as typeof fetch,
  });
  const url = c.playerUrl("tour_london_1850_flower_seller", { travellerId: "t_a b", stopId: "s1" });
  assert.equal(
    url,
    "https://play.example.com/?tour=tour_london_1850_flower_seller&play=1&traveller=t_a%20b&stop=s1",
  );
  assert.equal(url.includes("secret-key"), false);
});

test("playerUrl falls back to baseUrl when the player is served from the same origin", () => {
  const c = createClient({ baseUrl: "https://tours.example.com", fetch: (() => {}) as unknown as typeof fetch });
  assert.equal(c.playerUrl("tour_x"), "https://tours.example.com/?tour=tour_x&play=1");
});

/* ── the event bridge ────────────────────────────────────────────────── */

test("parseTourEvent reads the raw string a React Native WebView hands over", () => {
  const raw = JSON.stringify({
    source: PLAYER_MESSAGE_SOURCE,
    v: 1,
    type: "event",
    name: "stop_entered",
    payload: { tourId: "tour_x", stopId: "s2", order: 2 },
    t: 1234,
  });
  const ev = parseTourEvent(raw);
  assert.equal(ev?.name, "stop_entered");
  assert.equal(ev?.payload.stopId, "s2");
  assert.equal(ev?.t, 1234);
});

test("parseTourEvent reads the already-parsed object a browser gives", () => {
  const ev = parseTourEvent({ source: "timetravel", v: 1, type: "event", name: "tour_left", payload: {}, t: 1 });
  assert.equal(ev?.name, "tour_left");
});

test("parseTourEvent ignores everything that is not ours", () => {
  // A host screen sees Metro's traffic, React DevTools, browser extensions and
  // any other library's postMessage. None of it may crash the screen.
  for (const junk of [
    null,
    undefined,
    "",
    "not json {",
    "{}",
    42,
    { source: "webpack", type: "event", name: "tour_left" },
    { source: "timetravel", type: "command", name: "exit" },
    { source: "timetravel", type: "event", name: "definitely_not_an_event" },
  ]) {
    assert.equal(parseTourEvent(junk), null, `should ignore ${JSON.stringify(junk)}`);
  }
});

test("parseTourEvent survives a missing payload and a missing timestamp", () => {
  const ev = parseTourEvent({ source: "timetravel", v: 1, type: "event", name: "ready" });
  assert.deepEqual(ev?.payload, {});
  assert.equal(typeof ev?.t, "number");
});

test("a command round-trips through the injected script", () => {
  const script = tourCommandScript("exit");
  const inner = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(',"*")')));
  assert.deepEqual(JSON.parse(inner as string), tourCommand("exit"));
});
