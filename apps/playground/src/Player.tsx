/**
 * Image-driven guided player: she walks, you look around.
 *
 * Every screen is a full-bleed still. Her voice drives the timeline and the
 * screens change beneath it; her small circle up top comes alive with her
 * talking footage while she speaks. Taps skip or revisit, points of interest
 * turn her attention, the Pause button (or a long press) holds the walk, and
 * the Ask button interrupts her live. No text on the glass beyond the stop
 * titles and the labels of tapped points.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Card, Tour } from "@timetravel/schema";
import { AudioEngine } from "./audio.ts";
import { buildBeats, type Beat } from "./beats.ts";
import { CompanionSession, type CompanionState } from "./companion.ts";

export type EventSink = (name: string, payload: Record<string, unknown>) => void;

type Phase = "cover" | "playing" | "done";

const BREATH_MS = 900;
const HOLD_MS = 300;
const TICK_MS = 150;

interface Hotspot {
  id: string;
  x: number;
  y: number;
  label: string;
  line: { text: string; audio?: string; durationSec?: number };
}

function cardHotspots(card: Card | undefined): Hotspot[] {
  if (!card) return [];
  const h = (card as { hotspots?: Hotspot[] }).hotspots;
  return Array.isArray(h) ? h : [];
}

/** The still that stands for a beat. Everything renders full-bleed. */
function beatImage(tour: Tour, beat: Beat): string | undefined {
  const stop = tour.stops[beat.stopIndex];
  if (beat.kind === "arrival") return stop.arrival.livingScene?.poster ?? tour.cover.image;
  if (beat.kind === "walk") {
    const next = tour.stops[beat.stopIndex + 1];
    return next?.arrival.livingScene?.poster ?? tour.cover.image;
  }
  const card = beat.card!;
  if (card.kind === "image") return card.media.image;
  if (card.kind === "thenNow") return card.then.image;
  if (card.kind === "archive") return card.media.image;
  return undefined;
}

export function Player({ tour, onEvent, onCompanion }: { tour: Tour; onEvent: EventSink; onCompanion?: (s: CompanionState, transcript: { who: string; text: string }[]) => void }) {
  const beats = useMemo(() => buildBeats(tour), [tour]);
  const [phase, setPhase] = useState<Phase>("cover");
  const [bi, setBi] = useState(0);
  const [paused, setPaused] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [hotspot, setHotspot] = useState<Hotspot | null>(null);
  const [cState, setCState] = useState<CompanionState>("idle");
  const [cDetail, setCDetail] = useState("");
  const [beatFrac, setBeatFrac] = useState(0);
  const [speakingUi, setSpeakingUi] = useState(false);

  const engine = useRef<AudioEngine | null>(null);
  const transcriptRef = useRef<{ who: string; text: string }[]>([]);
  const companionRef = useRef<CompanionSession | null>(null);
  const startedAt = useRef(0);
  const beatState = useRef({
    enteredAt: 0,
    pausedAccum: 0,
    pausedSince: 0,
    voiceDone: false,
    voiceStop: () => {},
    bonusMs: 0,
    expectedMs: 5000,
  });
  const interacting = useRef(false);
  const askingRef = useRef(false);
  const hotspotRef = useRef<{ stop: () => void } | null>(null);

  const beat: Beat | undefined = beats[bi];
  const stop = beat ? tour.stops[beat.stopIndex] : tour.stops[0];

  const emit = useCallback((name: string, payload: Record<string, unknown> = {}) => onEvent(name, { tourId: tour.id, ...payload }), [onEvent, tour.id]);

  const companion = useMemo(() => {
    const c = new CompanionSession(tour.id, {
      onState: (s, d) => {
        setCState(s);
        setCDetail(d ?? "");
        askingRef.current = s === "connecting" || s === "listening" || s === "thinking" || s === "speaking";
        if (askingRef.current) engine.current?.pauseVoice();
        onCompanion?.(s, transcriptRef.current);
      },
      onTranscript: (who, text, final) => {
        if (!final) return;
        transcriptRef.current = [...transcriptRef.current, { who, text }];
        onCompanion?.(companionRef.current?.state ?? "idle", transcriptRef.current);
      },
      onTool: (name, args) => {
        emit("companion_tool", { name, ...args });
        if (name === "show_card" && typeof args.cardId === "string") {
          const idx = beats.findIndex((b) => b.card?.id === args.cardId);
          if (idx >= 0) goTo(idx, "companion");
        }
        if (name === "end_conversation") setTimeout(() => companionRef.current?.close(), 1500);
      },
      onEvent: (name, payload) => emit(name, payload),
    });
    companionRef.current = c;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.id]);

  useEffect(
    () => () => {
      companion.close();
      engine.current?.stop();
    },
    [companion],
  );

  /* ------------------------------- flow core ------------------------------ */

  const clearBeatAudio = useCallback(() => {
    beatState.current.voiceStop();
    hotspotRef.current?.stop();
    hotspotRef.current = null;
    setHotspot(null);
  }, []);

  const goTo = useCallback(
    (index: number, cause: string) => {
      clearBeatAudio();
      if (index >= beats.length) {
        setPhase("done");
        engine.current?.stop();
        emit("tour_completed", { stopId: beats[beats.length - 1]?.stopIndex, elapsedSec: Math.round((Date.now() - startedAt.current) / 1000) });
        return;
      }
      if (index < 0) index = 0;
      const prev = beats[bi];
      if (prev?.kind === "card" && prev.card) {
        emit("card_viewed", { stopId: stop.id, cardId: prev.card.id, kind: prev.card.kind, dwellMs: Date.now() - beatState.current.enteredAt, cause });
      }
      setBi(index);
      setPaused(false);
    },
    [beats, bi, clearBeatAudio, emit, stop],
  );
  const goToRef = useRef(goTo);
  goToRef.current = goTo;

  // Enter a beat: start her line, set the expected length, tell the companion.
  useEffect(() => {
    if (phase !== "playing" || !beat) return;
    const bs = beatState.current;
    bs.enteredAt = Date.now();
    bs.pausedAccum = 0;
    bs.pausedSince = 0;
    bs.voiceDone = !beat.audioUrl;
    bs.bonusMs = 0;
    bs.expectedMs = beat.estSec * 1000;
    setBeatFrac(0);
    setSpeakingUi(Boolean(beat.audioUrl));

    if (beat.kind === "arrival") emit("stop_entered", { stopId: stop.id, order: stop.order });
    const amb = stop.arrival.ambience;
    engine.current?.setAmbience(amb?.audio, amb?.gainDb ?? -14);

    if (beat.audioUrl && engine.current) {
      const v = engine.current.playVoice(beat.audioUrl);
      bs.voiceStop = v.stop;
      const enteredAt = bs.enteredAt;
      v.done.then((result) => {
        if (beatState.current.enteredAt !== enteredAt) return; // stale
        beatState.current.voiceDone = true;
        setSpeakingUi(false);
        if (result === "ended") {
          beatState.current.expectedMs = Math.max(Date.now() - enteredAt + BREATH_MS, beat.estSec * 1000 * 0.4);
        }
      });
    } else {
      bs.voiceStop = () => {};
    }

    if (beat.card?.companionContext) void companion.sendContext(beat.card.companionContext);
    else if (beat.kind === "arrival") void companion.sendContext({ text: `The visitor has just arrived at ${stop.title}. ${stop.arrival.line.text}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, bi]);

  // The clock: advance when her line is done, the dwell is served and nothing holds us.
  useEffect(() => {
    if (phase !== "playing") return;
    const id = window.setInterval(() => {
      const bs = beatState.current;
      if (!beat) return;
      if (paused || askingRef.current || interacting.current || hotspotRef.current) {
        if (!bs.pausedSince) bs.pausedSince = Date.now();
        return;
      }
      if (bs.pausedSince) {
        bs.pausedAccum += Date.now() - bs.pausedSince;
        bs.pausedSince = 0;
      }
      const active = Date.now() - bs.enteredAt - bs.pausedAccum;
      const expected = Math.max(bs.expectedMs + bs.bonusMs, beat.kind === "card" ? 4000 : 3500);
      setBeatFrac(Math.min(1, active / expected));
      if (bs.voiceDone && active >= expected) goToRef.current(bi + 1, "auto");
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [phase, bi, paused, beat]);

  /* ------------------------------ interactions ---------------------------- */

  const start = () => {
    engine.current = engine.current ?? new AudioEngine();
    engine.current.unlock(); // inside the tap
    startedAt.current = Date.now();
    emit("tour_started", { version: tour.version });
    setPhase("playing");
    setBi(0);
  };

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      engine.current?.resumeVoice();
    } else {
      setPaused(true);
      engine.current?.pauseVoice();
    }
  };

  const holdTimer = useRef<number | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const holding = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-noadvance]")) return;
    moved.current = false;
    holding.current = false;
    downAt.current = { x: e.clientX, y: e.clientY };
    holdTimer.current = window.setTimeout(() => {
      if (moved.current) return;
      holding.current = true;
      setPaused(true);
      engine.current?.pauseVoice();
    }, HOLD_MS);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!downAt.current || moved.current) return;
    if (Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) > 10) {
      moved.current = true;
      if (holdTimer.current) window.clearTimeout(holdTimer.current);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-noadvance]")) return;
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    downAt.current = null;
    if (holding.current) {
      holding.current = false;
      setPaused(false);
      engine.current?.resumeVoice();
      return;
    }
    if (moved.current || phase !== "playing") return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.28) goTo(bi - 1, "tap_back");
    else goTo(bi + 1, "tap_skip");
  };

  const openHotspot = (h: Hotspot) => {
    if (!beat?.card) return;
    emit("hotspot_opened", { cardId: beat.card.id, hotspotId: h.id, label: h.label });
    beatState.current.voiceStop();
    hotspotRef.current?.stop();
    setHotspot(h);
    setSpeakingUi(true);
    beatState.current.voiceDone = true;
    beatState.current.bonusMs += 1500;
    const finish = () => {
      hotspotRef.current = null;
      setHotspot(null);
      setSpeakingUi(false);
    };
    if (h.line.audio && engine.current) {
      const v = engine.current.playVoice(h.line.audio);
      hotspotRef.current = { stop: v.stop };
      v.done.then(finish);
    } else {
      const ms = (h.line.durationSec ?? Math.max(3, h.line.text.length / 14)) * 1000;
      const t = window.setTimeout(finish, ms);
      hotspotRef.current = { stop: () => window.clearTimeout(t) };
    }
  };

  const askDown = async (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    engine.current?.pauseVoice();
    hotspotRef.current?.stop();
    if (cState === "idle" || cState === "closed" || cState === "error") {
      try {
        emit("ask_started", { stopId: stop.id, cardId: beat?.card?.id });
        await companion.connect(stop.id, beat?.card?.id);
      } catch {
        return;
      }
    }
    companion.pttStart();
  };
  const askUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    companion.pttEnd();
  };

  const leave = () => {
    emit("tour_left", { stopId: stop?.id, cardId: beat?.card?.id, elapsedSec: Math.round((Date.now() - startedAt.current) / 1000) });
    companion.close();
    engine.current?.stop();
    setPhase("cover");
  };

  /* --------------------------------- render -------------------------------- */

  if (phase === "cover") {
    return (
      <div className="player">
        <div className="idle" style={{ backgroundImage: `url(${tour.cover.image})` }}>
          <div className="idle-shade" />
          <div className="idle-body">
            <div className="idle-year">{tour.year}</div>
            <h1>{tour.title}</h1>
            <p>{tour.summary}</p>
            <div className="idle-companion">
              <img src={tour.companion.portrait} alt="" />
              <div>
                <b>{tour.companion.name}</b>
                <span>{tour.companion.role}</span>
              </div>
            </div>
            <div className="idle-meta">
              {tour.stops.length} {tour.stops.length === 1 ? "stop" : "stops"} · about {tour.durationMin} min · she talks, you can interrupt
            </div>
            <button className="travel" data-noadvance onClick={start}>
              Travel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="player">
        <div className="idle done-view" style={{ backgroundImage: `url(${tour.companion.portrait})` }}>
          <div className="idle-shade" />
          <div className="idle-body">
            <div className="idle-year">{tour.year}</div>
            <h1>You walked with {tour.companion.name}.</h1>
            <p>
              {tour.stops.length} stops, {tour.sources.length} sources, every picture labelled for what it is.
            </p>
            <button className="travel" data-noadvance onClick={() => setPhase("cover")}>
              Back to the start
            </button>
          </div>
        </div>
      </div>
    );
  }

  const img = beat ? beatImage(tour, beat) : undefined;
  const spots = beat?.kind === "card" ? cardHotspots(beat.card) : [];
  const nextStop = beat?.kind === "walk" ? tour.stops[beat.stopIndex + 1] : undefined;
  const talkingLoop = stop.arrival.talkingPortrait?.video;

  return (
    <div className={`player ${paused ? "paused" : ""}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => holdTimer.current && window.clearTimeout(holdTimer.current)}>
      {/* progress: one segment per stop, filling beat by beat as she speaks */}
      <div className="progress">
        {tour.stops.map((s, i) => {
          const fill = !beat ? 0 : i < beat.stopIndex ? 1 : i > beat.stopIndex ? 0 : (beat.indexInStop + beatFrac) / beat.beatsInStop;
          return (
            <span key={s.id} className={fill >= 1 ? "done" : fill > 0 ? "cur" : ""}>
              <i style={{ width: `${Math.min(100, fill * 100)}%` }} />
            </span>
          );
        })}
      </div>

      <div className="hud-top">
        <button className={`companion-chip ${speakingUi ? "speaking" : ""}`} data-noadvance onClick={() => setSheet(!sheet)}>
          {speakingUi && talkingLoop ? <video src={talkingLoop} muted autoPlay loop playsInline /> : <img src={tour.companion.portrait} alt="" />}
          <span>
            <b>{tour.companion.name}</b>
            <small>{stop.title}</small>
          </span>
        </button>
        <div className="year">{tour.year}</div>
      </div>

      {/* ------------------------------ the screen ----------------------------- */}
      {beat?.kind === "walk" && nextStop ? (
        <div className="walk">
          <div className="bg fill blur" style={{ backgroundImage: `url(${img})` }} />
          <div className="walk-body">
            <small>Walking on</small>
            <h2>{nextStop.title}</h2>
            <div className="walk-dots">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      ) : (
        <div className="slide">
          {img && <img className={`bg kenburns ${bi % 2 ? "kb-b" : "kb-a"} ${paused ? "hold" : ""}`} src={img} alt="" />}
          {beat?.kind === "arrival" && (
            <div className="titlecard" key={beat.key}>
              <small>
                Stop {stop.order} of {tour.stops.length}
              </small>
              <h2>{stop.title}</h2>
            </div>
          )}
          {spots.map((h) => (
            <button key={h.id} className={`poi ${hotspot?.id === h.id ? "active" : ""}`} style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%` }} data-noadvance onClick={() => openHotspot(h)} aria-label={h.label}>
              <i />
              {hotspot?.id === h.id && <em>{h.label}</em>}
            </button>
          ))}
        </div>
      )}

      {/* bottom shade so the controls always read over any image */}
      <div className="hud-shade" />
      <div className="hud-bottom">
        <button className={`ctl ${paused ? "on" : ""}`} data-noadvance onClick={togglePause}>
          {paused ? "Resume" : "Pause tour"}
        </button>
        <button className={`ask ${cState}`} data-noadvance onPointerDown={askDown} onPointerUp={askUp} onPointerCancel={askUp} aria-label="Hold to ask">
          {cState === "connecting" ? "…" : cState === "listening" ? "Listening" : cState === "thinking" ? "…" : cState === "speaking" ? "Speaking" : "Hold to ask"}
        </button>
        <button className="leave" data-noadvance onClick={leave} aria-label="Leave">
          ×
        </button>
      </div>

      {(cState === "listening" || cState === "thinking" || cState === "connecting") && (
        <div className="ask-state" data-noadvance>
          {cState === "listening" ? "Listening…" : `${tour.companion.name} is thinking…`}
        </div>
      )}
      {cState === "error" && <div className="ask-state error">Voice unavailable: {cDetail}</div>}

      {sheet && (
        <div className="sheet" data-noadvance onClick={() => setSheet(false)}>
          <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
            <div className="idle-companion">
              <img src={tour.companion.portrait} alt="" />
              <div>
                <b>{tour.companion.name}</b>
                <span>{tour.companion.role}</span>
              </div>
            </div>
            <p>{tour.companion.bio}</p>
            <p className="muted">
              {tour.companion.name} is not a real historical person. She is built from the records of people like her, and she knows nothing after {tour.yearRange[1]}. Everything you see is a reconstruction; sources travel with the tour's data.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
