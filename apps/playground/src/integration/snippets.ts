/**
 * The code shown on the Integrate and Embed tabs.
 *
 * Every snippet is built from the tour actually selected in the playground, so
 * what a developer copies runs against something real on the first try instead
 * of against `your-tour-id-here`. Keep them honest: if a snippet stops
 * compiling against the app it targets, it is worse than no snippet at all.
 */
import type { Tour, TourSummary } from "@timetravel/schema";

export interface SnippetContext {
  tourId: string;
  city: string;
  year: number;
  title: string;
  companion: string;
  stopCount: number;
  durationMin: number;
  /** Where this playground is serving the player from, right now. */
  playerOrigin: string;
}

const FALLBACK: SnippetContext = {
  tourId: "tour_london_1850_flower_seller",
  city: "london",
  year: 1850,
  title: "A Walk with a Flower Seller",
  companion: "Nell Baker",
  stopCount: 6,
  durationMin: 20,
  playerOrigin: "https://tours.worldasitwas.com",
};

export function contextFor(tour: Tour | null, summary: TourSummary | null): SnippetContext {
  const origin = typeof location === "undefined" ? FALLBACK.playerOrigin : location.origin;
  if (tour) {
    return {
      tourId: tour.id,
      city: tour.city,
      year: tour.year,
      title: tour.title,
      companion: tour.companion.name,
      stopCount: tour.stops.length,
      durationMin: Math.round(tour.durationMin),
      playerOrigin: origin,
    };
  }
  if (summary) {
    return {
      tourId: summary.id,
      city: summary.city,
      year: summary.year,
      title: summary.title,
      companion: summary.companion.name,
      stopCount: summary.stopCount,
      durationMin: Math.round(summary.durationMin),
      playerOrigin: origin,
    };
  }
  return { ...FALLBACK, playerOrigin: origin };
}

/* ─────────────────── Expo / React Native (World As It Was) ─────────────── */

export const expoInstall = `# One dependency. The player itself is a web page we host, so there is no
# media pipeline, no audio stack and no tour content in your bundle.
npx expo install react-native-webview`;

export const expoEnv = (c: SnippetContext) => `# apps/mobile/.env  — both are public by design (EXPO_PUBLIC_ is baked into the bundle)
EXPO_PUBLIC_TOURS_PLAYER_URL=${c.playerOrigin}
EXPO_PUBLIC_TOURS_API_URL=https://api.worldasitwas.com/tours

# NOT here, and not anywhere in the app: the platform key. It is a server-side
# credential; anything in an EXPO_PUBLIC_ variable ships inside the .ipa and
# can be read out of it. EXPO_PUBLIC_TOURS_API_URL points at your own API,
# which forwards to ours with the key attached.`;

export const expoButton = (c: SnippetContext) => `// The button you already have. Nothing about it changes — the Travel row in
// EraList still pushes the same route; that route just knows what to do now.
//
// apps/mobile/src/eras/EraList.tsx
<EraRow
  era={era}
  onTravel={(year) => {
    track("era_travel_pressed", { placeId: place.id, year });
    router.push(\`/travel/\${place.id}/\${year}\`);   // →  ${c.city} ${c.year}
  }}
  onNotify={...}
  asked={...}
/>`;

export const expoScreen = (c: SnippetContext) => `import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { parseTourEvent, tourCommandScript } from "../../../../src/tours/timetravel";
import { space, type } from "../../../../src/theme/theme";
import { useTheme } from "../../../../src/theme/useTheme";
import { useTourSource } from "../../../../src/data/useTourSource";

// Replaces the placeholder. This is the whole tour integration: resolve a walk
// for the place and year the traveller picked, then hand the screen to it.
export default function Travel() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { placeId, year } = useLocalSearchParams<{ placeId: string; year: string }>();
  const { resolveTour } = useTourSource();
  const webRef = useRef<WebView>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Your API answers with a player URL it built server-side, so the platform
    // key never leaves your backend. ${c.city} ${c.year} → ${c.tourId}
    resolveTour(placeId, Number(year))
      .then((r) => (r ? setUrl(r.playerUrl) : setFailed(true)))
      .catch(() => setFailed(true));
  }, [placeId, year, resolveTour]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const ev = parseTourEvent(e.nativeEvent.data);
      if (!ev) return;   // not ours — ignore it, never throw on a stray message

      // The traveller closed the walk from inside the player. This is the one
      // event you must act on: without it the close button does nothing.
      if (ev.name === "tour_left" || ev.name === "tour_completed") router.back();
    },
    [router],
  );

  if (failed) {
    return (
      <View style={{ flex: 1, backgroundColor: color.ground, padding: space.inset, justifyContent: "center" }}>
        <Text style={[type.cityName, { color: color.paper }]}>Not yet</Text>
        <Text style={[type.rowSub, { color: color.grey, marginTop: space.md }]}>
          There is no walk for this year. It is in the archive.
        </Text>
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={{ marginTop: space.xxl }}>
          <Text style={[type.rowSub, { color: color.grey }]}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      {url ? (
        <WebView
          ref={webRef}
          source={{ uri: url }}
          onMessage={onMessage}
          style={{ flex: 1, backgroundColor: color.ground }}
          // The walk is audio-led and she talks on arrival, so it must be
          // allowed to play without a second tap, and inline rather than in
          // the system full-screen player.
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          // The Ask button opens a live microphone. Without this iOS silently
          // denies getUserMedia and the button looks broken.
          mediaCapturePermissionGrantType="grant"
          // Nothing in the walk is text the traveller types, and a keyboard
          // sliding up over a full-bleed still is never wanted.
          keyboardDisplayRequiresUserAction
          onError={() => setFailed(true)}
          onHttpError={() => setFailed(true)}
        />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={color.amber} />
        </View>
      )}
      {/* Your own close affordance, over the player, in your safe area. */}
      <Pressable
        onPress={() => webRef.current?.injectJavaScript(tourCommandScript("exit"))}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{ position: "absolute", top: insets.top + space.md, left: space.lg, padding: space.sm }}
      >
        <Text style={[type.button, { color: color.paper }]}>Close</Text>
      </Pressable>
    </View>
  );
}`;

export const expoSource = (c: SnippetContext) => `import type { TourSummary } from "@worldasitwas/content";

// Added to the TourSource contract in apps/mobile/src/data/TourSource.ts, next
// to listPlaces and getEras. One method: everything else stays as it is.
export interface ResolvedTour {
  tourId: string;
  title: string;
  companion: string;
  stopCount: number;
  durationMin: number;
  /** Ready for a WebView. Signed and built by your API; carries no key. */
  playerUrl: string;
}

// apps/mobile/src/data/httpSource.ts
async resolveTour(placeId: string, year: number): Promise<ResolvedTour | null> {
  // 404 means "we have no walk for that year", which is an answer the Travel
  // screen renders, not an error it should throw on.
  const r = await call<ResolvedTour>(\`/places/\${encodeURIComponent(placeId)}/eras/\${year}/tour\`);
  return r.status === 404 ? null : r.body;
}

// apps/mobile/src/data/fixtureSource.ts — so the screen works with no backend
async resolveTour(placeId, year) {
  if (placeId !== "${c.city}" || year !== ${c.year}) return null;
  return {
    tourId: "${c.tourId}",
    title: "${c.title}",
    companion: "${c.companion}",
    stopCount: ${c.stopCount},
    durationMin: ${c.durationMin},
    playerUrl: \`\${process.env.EXPO_PUBLIC_TOURS_PLAYER_URL}/?tour=${c.tourId}&play=1\`,
  };
}`;

export const expoApi = (c: SnippetContext) => `import { createClient } from "@timetravel/client";

// apps/api/src/routes/tours.ts — the one place the platform key exists.
const tours = createClient({
  baseUrl: process.env.TOURS_API_URL!,        // https://tours.worldasitwas.com
  apiKey: process.env.TOURS_PLATFORM_KEY!,    // server-side only
  playerUrl: process.env.TOURS_PLAYER_URL!,
});

app.get<{ Params: { id: string; year: string } }>(
  "/places/:id/eras/:year/tour",
  { preHandler: requireAuth },
  async (req, reply) => {
    const found = await tours.resolve({ city: req.params.id, year: Number(req.params.year) });
    if (!found) return reply.code(404).send({ error: "tour_not_found" });

    return {
      tourId: found.id,
      title: found.title,
      companion: found.companion.name,
      stopCount: found.stopCount,
      durationMin: found.durationMin,
      // The traveller id is what the companion's rate limit counts. Use your
      // own opaque user id — never an email, a name or an Auth0 profile field.
      playerUrl: tours.playerUrl(found.id, { travellerId: req.user.id }),
    };
  },
);

// ${c.city} ${c.year} resolves to ${c.tourId}
// (${c.stopCount} stops, about ${c.durationMin} minutes, with ${c.companion})`;

export const expoAnalytics = `// apps/mobile/src/analytics/events.ts — the union is closed on purpose, so
// the tour's events have to be declared before they can be sent.
export type EventName =
  | "city_selected"
  | "era_travel_pressed"
  | "era_notify_pressed"
  | "search_uncovered"
  | "sheet_detent"
  | "tour_started"
  | "tour_stop_entered"
  | "tour_completed"
  | "tour_left";

export interface EventProps {
  // …existing…
  tour_started: { tourId: string; placeId: string; year: number };
  tour_stop_entered: { tourId: string; stopId: string; order: number };
  tour_completed: { tourId: string; elapsedSec: number };
  tour_left: { tourId: string; stopId?: string; elapsedSec: number };
}`;

/* ─────────────────────────── React (web) ─────────────────────────── */

export const webButton = (c: SnippetContext) => `import { useState } from "react";
import { createClient, parseTourEvent } from "@timetravel/client";

// Point baseUrl at your own backend, which forwards to the tour API with the
// platform key attached. A key in a web bundle is a key you have published.
const tours = createClient({ baseUrl: "/api/tours", playerUrl: "${c.playerOrigin}" });

export function TravelButton({ city, year }: { city: string; year: number }) {
  const [url, setUrl] = useState<string | null>(null);

  async function travel() {
    const found = await tours.resolve({ city, year });
    if (!found) return;                       // nothing for that year yet
    setUrl(tours.playerUrl(found.id, { travellerId: currentUserId() }));
  }

  if (url) return <TourFrame src={url} onClose={() => setUrl(null)} />;
  return <button onClick={travel}>Travel to {city} in {year}</button>;
}

function TourFrame({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const ev = parseTourEvent(e.data);
      if (!ev) return;                        // someone else's postMessage
      if (ev.name === "tour_left" || ev.name === "tour_completed") onClose();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onClose]);

  return (
    <iframe
      src={src}
      title="A walk through ${c.city} in ${c.year}"
      // autoplay: she speaks on arrival. microphone: the Ask button.
      allow="autoplay; microphone; fullscreen"
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: 0 }}
    />
  );
}`;

/* ─────────────────────────── REST, any language ─────────────────────── */

export const restCurl = (c: SnippetContext) => `# 1. What is there? Cities and the years each one has walks for.
curl -H "Authorization: Bearer $TOURS_PLATFORM_KEY" \\
  ${c.playerOrigin}/v1/catalog

# 2. Which walk for this place and year? An exact match, or the nearest years.
curl -H "Authorization: Bearer $TOURS_PLATFORM_KEY" \\
  "${c.playerOrigin}/v1/tours?city=${c.city}&year=${c.year}"
# → { "matches": [ { "id": "${c.tourId}", "stopCount": ${c.stopCount}, … } ], "nearest": [] }
#   matches is empty and nearest is filled when we have the city but not the year.

# 3. Open it. No key in this URL — put it straight in a WebView or an iframe.
${c.playerOrigin}/?tour=${c.tourId}&play=1&traveller=$YOUR_OPAQUE_USER_ID

# Or take the manifest and draw the walk yourself.
curl -H "Authorization: Bearer $TOURS_PLATFORM_KEY" \\
  ${c.playerOrigin}/v1/tours/${c.tourId}`;

export const nativeRender = (c: SnippetContext) => `import { createClient, type Tour } from "@timetravel/client";

// The other way in: take the manifest and render it in your own components.
// More work, and every new capability we ship needs an app release — but the
// UI is entirely yours.
const tours = createClient({ baseUrl: "/api/tours" });
const tour: Tour = await tours.tour("${c.tourId}");

tour.stops;                       // ${c.stopCount} stops, in walking order
tour.stops[0].arrival.line;       // what she says as you arrive: text + audio + a face clip
tour.stops[0].arrival.hotspots;   // tappable points, positioned 0..1 inside the still
tour.stops[0].cards;              // image | video | thenNow | archive | text
tour.stops[0].cards[0].claims;    // each with confidence: known | likely | interpretation
tour.sources;                     // what every claim is grounded in
tour.provenance;                  // when it was made, by which models, what it cost

// Two rules the manifest expects a renderer to keep:
//   1. media.origin === "reconstruction" must carry a visible badge. Archive
//      material and generated material have different rights stories.
//   2. claim.confidence is per claim, not per tour. A monarch's name and the
//      price of a pint do not deserve the same certainty.`;

/* ─────────────────────────── events ─────────────────────────── */

export interface EventDoc {
  name: string;
  when: string;
  payload: string;
  act?: string;
}

export const EVENT_DOCS: EventDoc[] = [
  { name: "ready", when: "The manifest loaded and the cover is on screen.", payload: "tourId, version, title, stopCount, durationMin", act: "Hide your own spinner." },
  { name: "tour_started", when: "They pressed begin.", payload: "tourId, version, startStopId?" },
  { name: "stop_entered", when: "They arrived at a stop.", payload: "tourId, stopId, order", act: "Store stopId to resume later." },
  { name: "card_viewed", when: "A screen was left behind.", payload: "tourId, stopId, cardId, kind, dwellMs, cause" },
  { name: "hotspot_opened", when: "They tapped a point of interest.", payload: "tourId, cardId, hotspotId, label" },
  { name: "ask_started", when: "They held Ask and interrupted her.", payload: "tourId, stopId, cardId" },
  { name: "companion_tool", when: "She acted on something they said.", payload: "tourId, name, …args" },
  { name: "tour_completed", when: "They reached the end.", payload: "tourId, stopId, elapsedSec", act: "Pop the screen. Mark it done." },
  { name: "tour_left", when: "They closed the walk early.", payload: "tourId, stopId, cardId, elapsedSec", act: "Pop the screen. Keep stopId." },
  { name: "error", when: "The walk could not be shown.", payload: "message", act: "Show your own failure state." },
];

/* ─────────────────────────── the feed ─────────────────────────── */

export const feedCurl = (c: SnippetContext) => `# Every published walk with its stops, in one document. This is what you plot.
curl -s -H "Authorization: Bearer $TOURS_PLATFORM_KEY" \\
  ${c.playerOrigin}/v1/feed | jq '.tours[0] | {title, year, start, stops: [.stops[] | {order, name, lat, lng}]}'

# It is ETagged over the walks it contains, not over the time you asked, so
# polling an unchanged catalogue costs a 304 and no body.
curl -s -D- -o/dev/null -H "Authorization: Bearer $TOURS_PLATFORM_KEY" \\
  -H 'If-None-Match: "feed:xxxxxxxx"' ${c.playerOrigin}/v1/feed`;

export const feedProxy = `// Your API, not ours. The platform key is a server-side secret: a browser that
// holds it has published it. Serve the feed on from your own origin instead.
//
// Cache it. The feed changes when we publish a walk, which is rarely, and the
// ETag makes a check nearly free.
import { createClient } from "@timetravel/client";

const tours = createClient({
  baseUrl: process.env.TOURS_API_URL!,
  apiKey: process.env.TOURS_PLATFORM_KEY!,   // server-side only
});

let cached: { at: number; feed: Awaited<ReturnType<typeof tours.feed>> } | null = null;
const TTL_MS = 5 * 60_000;

app.get("/tours/feed", async (_req, reply) => {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    cached = { at: Date.now(), feed: await tours.feed() };
  }
  reply.header("Cache-Control", "public, max-age=300");
  return cached.feed;
});`;

export const feedMapLibre = `// MapLibre, which is what World As It Was draws its web map with.
//
// Two things go on the map: where each walk begins, and — once you are close
// enough for it to mean anything — every stop, joined in walking order.
import maplibregl from "maplibre-gl";
import type { Feed, FeedTour } from "@timetravel/client";

const feed: Feed = await fetch("/tours/feed").then((r) => r.json());

// The route is one GeoJSON source for every walk; which of them is drawn is a
// filter, so selecting a walk never rebuilds the source.
map.addSource("tours", {
  type: "geojson",
  data: {
    type: "FeatureCollection",
    features: feed.tours.map((t: FeedTour) => ({
      type: "Feature",
      properties: { tourId: t.id, title: t.title, year: t.year },
      geometry: { type: "LineString", coordinates: t.stops.map((s) => [s.lng, s.lat]) },
    })),
  },
});
map.addLayer({
  id: "tour-routes",
  type: "line",
  source: "tours",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: { "line-color": "#e8b86a", "line-width": 2, "line-dasharray": [2, 1.4] },
});

// The stops themselves. Markers rather than a symbol layer because the Archive
// style ships no glyphs, and a numbered chip reads better than a dot anyway.
for (const tour of feed.tours) {
  for (const stop of tour.stops) {
    const el = document.createElement("button");
    el.className = "stop-pin";
    el.textContent = String(stop.order);
    el.title = \`\${stop.name} — \${stop.description}\`;
    el.onclick = () => openWalk(tour.id);
    new maplibregl.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).addTo(map);
  }
}`;

export const feedNativeMap = `// react-native-maps, which is what the app uses on iOS and Android.
// Same feed, same two things drawn: the route, then the stops on it.
import MapView, { Marker, Polyline } from "react-native-maps";
import type { Feed } from "@timetravel/client";

export function WalksOnTheMap({ feed }: { feed: Feed }) {
  return (
    <MapView style={{ flex: 1 }}>
      {feed.tours.map((tour) => (
        <React.Fragment key={tour.id}>
          <Polyline
            coordinates={tour.stops.map((s) => ({ latitude: s.lat, longitude: s.lng }))}
            strokeColor="#e8b86a"
            strokeWidth={2}
          />
          {tour.stops.map((stop) => (
            <Marker
              key={stop.id}
              coordinate={{ latitude: stop.lat, longitude: stop.lng }}
              title={stop.name}
              description={stop.description}
              onCalloutPress={() => openWalk(tour.id)}
            />
          ))}
        </React.Fragment>
      ))}
    </MapView>
  );
}`;

export const feedShape = `// What one walk looks like in the feed. Everything a card and a route need,
// and nothing a player needs — the manifest is still where the walk itself is.
{
  "id": "tour_london_1850_flower_seller",
  "version": "2026-08-30.1",
  "title": "The flower seller's London",
  "summary": "Violets, fog and the Fleet, with a girl who sells them.",
  "city": { "id": "london", "name": "London", "country": "GB" },
  "year": 1850,
  "yearRange": [1848, 1852],
  "lang": "en",
  "durationMin": 14,
  "stopCount": 6,
  "companion": { "name": "Nell Baker", "role": "Flower seller", "portrait": "https://…/nell.webp" },
  "cover": { "image": "https://…/cover.webp" },
  "start": { "lat": 51.5139, "lng": -0.1015 },
  "stops": [
    {
      "id": "stop_01",
      "order": 1,
      "name": "Ludgate Hill",
      "description": "Where the flower girls stood, under the dome and the smoke.",
      "lat": 51.5139,
      "lng": -0.1015
    }
  ]
}`;
