# The one addition to the TourSource contract

`TourSource` is the seam between the app and its data, and every screen already
goes through it. The tour needs exactly one more method on it, so the Travel
screen can be written against the fixtures with no backend running.

## `apps/mobile/src/data/TourSource.ts`

```ts
export interface TourSource {
  listPlaces(): Promise<Place[]>;
  getEras(placeId: string): Promise<EraSummary[] | null>;
  // …everything already there…

  /**
   * Which walk to open for a place and year, and the URL that opens it.
   * Null means we hold the place but have no walk for that year — an answer
   * the Travel screen renders, not an error it throws on.
   */
  resolveTour(placeId: string, year: number): Promise<ResolvedTour | null>;
}

export interface ResolvedTour {
  tourId: string;
  title: string;
  companion: string;
  stopCount: number;
  durationMin: number;
  /** Built by the API. Carries no credential; safe in a WebView. */
  playerUrl: string;
}
```

## `apps/mobile/src/data/httpSource.ts`

Same shape as `getEras`: a 404 is a null, not a throw.

```ts
async resolveTour(placeId, year) {
  const r = await call<ResolvedTour>(
    `/places/${encodeURIComponent(placeId)}/eras/${year}/tour`,
  );
  // 404: no walk for that year. 402: they have not paid for it. Both are
  // states the screen draws; only a 5xx (thrown by `call`) is a failure.
  return r.status === 404 || r.status === 402 ? null : r.body;
},
```

## `apps/mobile/src/data/fixtureSource.ts`

So the screen runs against the published walks with no API and no Auth0.

```ts
const PLAYER = process.env.EXPO_PUBLIC_TOURS_PLAYER_URL ?? "http://localhost:5173";

const WALKS: Record<string, Omit<ResolvedTour, "playerUrl">> = {
  "london:1850": { tourId: "tour_london_1850_flower_seller", title: "A Walk with a Flower Seller", companion: "Nell Baker", stopCount: 6, durationMin: 14 },
  "london:1666": { tourId: "tour_london_1666_waterman",      title: "The Waterman",                companion: "Will Chandler", stopCount: 5, durationMin: 12 },
  "rome:1600":   { tourId: "tour_rome_1600_herb_seller",     title: "The Herb Seller",             companion: "Caterina Ruspoli", stopCount: 5, durationMin: 12 },
};

async resolveTour(placeId, year) {
  const walk = WALKS[`${placeId}:${year}`];
  if (!walk) return null;
  return { ...walk, playerUrl: `${PLAYER}/?tour=${walk.tourId}&play=1&traveller=t_fixture` };
},
```

`GET /v1/catalog` on the tour service lists every city and year currently
published, if you would rather generate that map than hand-write it.

## `apps/mobile/src/analytics/events.ts`

The union is closed on purpose, so the tour's events have to be declared before
PostHog can receive them. Add the four the Travel screen sends:

```ts
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
}
```
