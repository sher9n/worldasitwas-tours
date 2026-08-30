/**
 * The client's types are hand-written so the file can be pasted into an app
 * with no dependency on zod. That freedom is exactly how a contract drifts, so
 * this file makes drift a compile error: it assigns the real schema's types to
 * the client's and back again, in both directions.
 *
 * If you add a field to packages/schema, `npm run typecheck` fails here until
 * the client learns about it too. There is nothing to run at runtime; the test
 * below only exists so the file is a valid node:test target.
 */
import { test } from "node:test";
import type * as Schema from "@timetravel/schema";
import type * as Client from "./index.ts";

/** Both directions: neither side may hold a field the other has never heard of. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : ["client is missing something from schema", B]) : ["schema is missing something from client", A];

// Each line is the assertion. A mismatch shows up as "Type ... is not assignable
// to type 'true'", with the offending shape named in the tuple above.
const _tour: Mutual<Schema.Tour, Client.Tour> = true;
const _summary: Mutual<Schema.TourSummary, Client.TourSummary> = true;
const _catalog: Mutual<Schema.Catalog, Client.Catalog> = true;
const _feed: Mutual<Schema.Feed, Client.Feed> = true;
const _feedTour: Mutual<Schema.FeedTour, Client.FeedTour> = true;
const _feedStop: Mutual<Schema.FeedStop, Client.FeedStop> = true;
const _stop: Mutual<Schema.Stop, Client.Stop> = true;
const _card: Mutual<Schema.Card, Client.Card> = true;
const _companion: Mutual<Schema.Companion, Client.Companion> = true;
const _hotspot: Mutual<Schema.Hotspot, Client.Hotspot> = true;
const _spoken: Mutual<Schema.SpokenLine, Client.SpokenLine> = true;
const _image: Mutual<Schema.ImageAsset, Client.ImageAsset> = true;
const _video: Mutual<Schema.VideoAsset, Client.VideoAsset> = true;
const _claim: Mutual<Schema.Claim, Client.Claim> = true;
const _source: Mutual<Schema.Source, Client.Source> = true;
const _prov: Mutual<Schema.Provenance, Client.Provenance> = true;
const _geo: Mutual<Schema.GeoPoint, Client.GeoPoint> = true;
const _confidence: Mutual<Schema.Confidence, Client.Confidence> = true;
const _origin: Mutual<Schema.Origin, Client.Origin> = true;

test("the client's hand-written types still match the tour/1 schema", () => {
  // Proven by the assignments above at compile time; nothing to check here.
  void [_tour, _summary, _catalog, _feed, _feedTour, _feedStop, _stop, _card, _companion, _hotspot, _spoken, _image, _video, _claim, _source, _prov, _geo, _confidence, _origin];
});
