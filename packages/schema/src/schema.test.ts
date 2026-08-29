import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTour, summarize, type Tour } from "./index.ts";

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
    },
    stops: [
      {
        id: "s1",
        order: 1,
        title: "Ludgate Hill",
        geo: { lat: 51.5139, lng: -0.1015, bearing: 78 },
        arrival: { line: { text: "Look up." } },
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
