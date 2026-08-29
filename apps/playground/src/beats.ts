/**
 * A tour is a continuous walk, not a deck of cards. The manifest is flattened
 * into an ordered list of beats: she arrives and speaks, each card plays under
 * her narration, then she walks you to the next stop. Playback is driven by her
 * voice, so a beat ends when she stops talking, not when someone taps.
 */
import type { Card, Tour } from "@timetravel/schema";

export type BeatKind = "arrival" | "card" | "walk";

export interface Beat {
  key: string;
  kind: BeatKind;
  stopIndex: number;
  /** Index of this beat within its stop, and how many the stop has. */
  indexInStop: number;
  beatsInStop: number;
  card?: Card;
  /** Audio carrying her voice for this beat, when it is a plain audio file. */
  audioUrl?: string;
  /** Video carrying her voice (the talking portrait), when there is one. */
  voiceVideoUrl?: string;
  text: string;
  /** Fallback length when the media has no duration or fails to load. */
  estSec: number;
}

/** Speaking pace of the pre-recorded narration, characters per second. */
const CHARS_PER_SEC = 14;

export function estimateSec(text: string | undefined): number {
  if (!text) return 4;
  return Math.max(3, Math.min(30, text.length / CHARS_PER_SEC));
}

/** Extra dwell so a card is not gone before it can be looked at or used. */
function minHold(kind: BeatKind, card?: Card): number {
  if (kind === "arrival") return 5;
  if (kind === "walk") return 4;
  void card;
  return 6;
}

export function buildBeats(tour: Tour): Beat[] {
  const beats: Beat[] = [];
  tour.stops.forEach((stop, si) => {
    const isLast = si === tour.stops.length - 1;
    const stopBeats: Beat[] = [];

    const portrait = stop.arrival.talkingPortrait;
    stopBeats.push({
      key: `${stop.id}:arrival`,
      kind: "arrival",
      stopIndex: si,
      indexInStop: 0,
      beatsInStop: 0,
      // Every video plays muted; her line always comes through the voice channel.
      // The portrait was lip-synced to this same recording, so starting both
      // together keeps her mouth and her voice aligned.
      voiceVideoUrl: portrait?.video,
      audioUrl: stop.arrival.line.audio,
      text: stop.arrival.line.text,
      estSec: Math.max(portrait?.durationSec ?? stop.arrival.line.durationSec ?? estimateSec(stop.arrival.line.text), minHold("arrival")),
    });

    for (const card of stop.cards) {
      // This version is image-driven and reconstruction-only: framed archive
      // scans and big-type text screens are left out of the flow.
      if (card.kind === "archive" || card.kind === "text") continue;
      const spoken = card.narration?.text ?? card.caption ?? "";
      stopBeats.push({
        key: `${stop.id}:${card.id}`,
        kind: "card",
        stopIndex: si,
        indexInStop: 0,
        beatsInStop: 0,
        card,
        audioUrl: card.narration?.audio,
        text: spoken,
        estSec: Math.max(card.narration?.durationSec ?? estimateSec(spoken), minHold("card", card)),
      });
    }

    if (stop.transitionOut && !isLast) {
      stopBeats.push({
        key: `${stop.id}:walk`,
        kind: "walk",
        stopIndex: si,
        indexInStop: 0,
        beatsInStop: 0,
        audioUrl: stop.transitionOut.audio,
        text: stop.transitionOut.text,
        estSec: Math.max(stop.transitionOut.durationSec ?? estimateSec(stop.transitionOut.text), minHold("walk")),
      });
    }

    stopBeats.forEach((b, i) => {
      b.indexInStop = i;
      b.beatsInStop = stopBeats.length;
    });
    beats.push(...stopBeats);
  });
  return beats;
}

export interface RoutePoint {
  x: number;
  y: number;
  title: string;
}

/**
 * The stops projected into a 0..1 box, keeping the real shape of the walk.
 * Longitude is scaled by cos(latitude) so the route is not stretched sideways,
 * and the whole path is padded so end dots are not clipped.
 */
export function projectRoute(tour: Tour): RoutePoint[] {
  const pts = tour.stops.map((s) => ({ lat: s.geo.lat, lng: s.geo.lng, title: s.title }));
  if (pts.length === 0) return [];
  const meanLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const k = Math.cos((meanLat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k);
  const ys = pts.map((p) => -p.lat); // north is up
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // One scale for both axes keeps the route's true proportions.
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 0.12;
  const usable = 1 - pad * 2;
  const offX = (span - (maxX - minX)) / 2;
  const offY = (span - (maxY - minY)) / 2;
  return pts.map((p, i) => ({
    x: pad + ((xs[i] - minX + offX) / span) * usable,
    y: pad + ((ys[i] - minY + offY) / span) * usable,
    title: p.title,
  }));
}
