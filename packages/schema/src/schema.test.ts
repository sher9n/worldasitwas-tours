import { test } from "node:test";
import assert from "node:assert/strict";
import { feedTour, parseTour, stopDescription, summarize, type Stop, type Tour } from "./index.ts";

function minimalTour(): Tour {
  return {
    schema: "tour/1",
    id: "tour_test_1850",
    version: "2026-08-29.1",
    city: "london",
    year: 1850,
    yearRange: [1848, 1852],
    lang: "en",
    title: "Test",
    summary: "A test tour.",
    durationMin: 10,
    cover: { image: "https://cdn/x.webp" },
    companion: {
      name: "Nell",
      role: "Flower seller",
      bio: "Bio.",
      portrait: "https://cdn/nell.webp",
      greeting: { text: "Hello." },
      voice: { provider: "openai-realtime", voice: "marin" },
      faceReel: [],
    },
    stops: [
      {
        id: "s1",
        order: 1,
        title: "Ludgate Hill",
        geo: { lat: 51.5139, lng: -0.1015, bearing: 78 },
        arrival: { line: { text: "Look up." }, hotspots: [] },
        cards: [
          {
            id: "c1",
            kind: "image",
            media: { image: "https://cdn/c1.webp", origin: "reconstruction" },
            caption: "A street.",
            claims: [{ text: "Fare is 6d", confidence: "known", sourceId: "src1" }],
            hotspots: [],
          },
        ],
      },
    ],
    sources: [{ id: "src1", title: "Mayhew", url: "https://archive.org/x", license: "public-domain" }],
    provenance: { generatedAt: "2026-08-29T10:00:00.000Z", reviewedBy: "none", models: ["mock"], costUsd: 0 },
  };
}

test("valid manifest parses", () => {
  const t = parseTour(minimalTour());
  assert.equal(t.stops.length, 1);
});

test("claim with unknown source is rejected", () => {
  const t = minimalTour();
  (t.stops[0].cards[0] as { claims: { sourceId: string }[] }).claims[0].sourceId = "nope";
  assert.throws(() => parseTour(t), /unknown source/);
});

test("thenNow now image cannot be a reconstruction", () => {
  const t = minimalTour();
  t.stops[0].cards.push({
    id: "c2",
    kind: "thenNow",
    then: { image: "https://cdn/then.webp", origin: "reconstruction" },
    now: { image: "https://cdn/now.webp", origin: "reconstruction" },
    claims: [],
    hotspots: [],
  });
  assert.throws(() => parseTour(t), /photograph or archive/);
});

test("summarize computes distanceYears outside the range", () => {
  const s = summarize(parseTour(minimalTour()), 1837);
  assert.equal(s.distanceYears, 11);
  assert.equal(summarize(parseTour(minimalTour()), 1850).distanceYears, 0);
});

/* ─────────────────────────── the feed ─────────────────────────── */

/** A stop with only what the argument under test needs. */
function stopWith(over: Partial<Stop>): Stop {
  return {
    id: "s1",
    order: 1,
    title: "Ludgate Hill",
    geo: { lat: 51.5, lng: -0.1 },
    arrival: { line: { text: "Mind the mud." }, hotspots: [] },
    cards: [{ id: "c1", kind: "text", text: "Body.", claims: [], hotspots: [] }],
    ...over,
  } as Stop;
}

test("a stop's own blurb wins, because it was written for exactly this", () => {
  const stop = stopWith({ blurb: "Where the flower girls stood.", cards: [{ id: "c1", kind: "text", text: "x", caption: "A caption.", claims: [], hotspots: [] }] });
  assert.equal(stopDescription(stop), "Where the flower girls stood.");
});

test("with no blurb, a card caption stands in", () => {
  const stop = stopWith({ cards: [{ id: "c1", kind: "text", text: "x", caption: "A caption.", claims: [], hotspots: [] }] });
  assert.equal(stopDescription(stop), "A caption.");
});

test("with neither, her arrival line does, because every manifest has one", () => {
  assert.equal(stopDescription(stopWith({})), "Mind the mud.");
});

test("a long spoken line is cut at a sentence, never mid-clause", () => {
  const long = `${"The dome rises over the smoke and the whole hill smells of horses. ".repeat(4)}And then some more.`;
  const out = stopDescription(stopWith({ arrival: { line: { text: long }, hotspots: [] } }));
  assert.ok(out.length <= 205, `too long: ${out.length}`);
  assert.ok(out.endsWith(".") , `should end on a full stop: ${JSON.stringify(out.slice(-30))}`);
  assert.ok(!out.includes("..."), "a sentence boundary was available, so no ellipsis");
});

test("feedTour sorts the stops so joining them draws the route", () => {
  const tour = minimalTour();
  tour.stops = [
    stopWith({ id: "s3", order: 3, title: "Third", geo: { lat: 3, lng: 3 } }),
    stopWith({ id: "s1", order: 1, title: "First", geo: { lat: 1, lng: 1 } }),
    stopWith({ id: "s2", order: 2, title: "Second", geo: { lat: 2, lng: 2 } }),
  ];
  const feed = feedTour(parseTour(tour), { name: "London", country: "GB" });
  assert.deepEqual(feed.stops.map((s) => s.name), ["First", "Second", "Third"]);
  // The pin for the walk is where it begins, not whichever stop was listed first.
  assert.deepEqual(feed.start, { lat: 1, lng: 1 });
  assert.equal(feed.stopCount, 3);
});

test("feedTour keeps a bearing when the manifest has one, and omits it otherwise", () => {
  const tour = minimalTour();
  tour.stops = [
    stopWith({ id: "s1", order: 1, geo: { lat: 1, lng: 1, bearing: 210 } }),
    stopWith({ id: "s2", order: 2, geo: { lat: 2, lng: 2 } }),
  ];
  const feed = feedTour(parseTour(tour), { name: "London", country: "GB" });
  assert.equal(feed.stops[0].bearing, 210);
  assert.ok(!("bearing" in feed.stops[1]), "no bearing should mean no key, not undefined");
});
