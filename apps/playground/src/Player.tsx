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
  if (beat.kind === "arrival") return stop.arrival.still?.image ?? stop.arrival.livingScene?.poster ?? tour.cover.image;
  if (beat.kind === "walk") {
    const next = tour.stops[beat.stopIndex + 1];
    return next?.arrival.still?.image ?? next?.arrival.livingScene?.poster ?? tour.cover.image;
  }
  const card = beat.card!;
  if (card.kind === "image") return card.media.image;
  if (card.kind === "thenNow") return card.then.image;
  if (card.kind === "archive") return card.media.image;
  return undefined;
}

/**
 * What a host can do to a running walk from outside the player: quieten it when
 * the app goes to the background, and close it when a hardware back button is
 * pressed. Handed out once, on mount, through `onControls`.
 */
export interface PlayerControls {
  pause(): void;
  resume(): void;
  /** Ends the walk and returns to the cover, emitting tour_left. */
  leave(): void;
}

export function Player({
  tour,
  onEvent,
  onCompanion,
  startStopId,
  onControls,
}: {
  tour: Tour;
  onEvent: EventSink;
  onCompanion?: (s: CompanionState, transcript: { who: string; text: string }[]) => void;
  /** Begin at this stop instead of the first. Unknown ids fall back to the start. */
  startStopId?: string;
  onControls?: (controls: PlayerControls) => void;
}) {
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
  const [gated, setGated] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [sideFlash, setSideFlash] = useState<{ side: "left" | "right"; n: number } | null>(null);
  const flash = (side: "left" | "right") => setSideFlash((f) => ({ side, n: (f?.n ?? 0) + 1 }));
  // The wayfinding panes are a moment, not furniture: they show for ~3s when a
  // gate opens, then leave; the edges stay tappable throughout.
  const [showPanes, setShowPanes] = useState(false);
  useEffect(() => {
    if (!gated) {
      setShowPanes(false);
      return;
    }
    setShowPanes(true);
    const t = window.setTimeout(() => setShowPanes(false), 3200);
    return () => window.clearTimeout(t);
  }, [gated]);

  const engine = useRef<AudioEngine | null>(null);
  const prevCState = useRef<CompanionState>("idle");
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
  const [holdingAsk, setHoldingAsk] = useState(false);
  const hotspotRef = useRef<{ stop: () => void } | null>(null);

  const beat: Beat | undefined = beats[bi];
  const stop = beat ? tour.stops[beat.stopIndex] : tour.stops[0];

  // Cross-dissolve: the outgoing image lingers above the incoming one and fades,
  // so a slide change reads as the camera moving on, not a picture swap.
  const [fadeImg, setFadeImg] = useState<string | null>(null);
  const lastImgRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (phase !== "playing" || !beat) return;
    const current = beatImage(tour, beat);
    const previous = lastImgRef.current;
    lastImgRef.current = current;
    if (previous && previous !== current) {
      setFadeImg(previous);
      const t = window.setTimeout(() => setFadeImg(null), 800);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, bi]);

  const emit = useCallback((name: string, payload: Record<string, unknown> = {}) => onEvent(name, { tourId: tour.id, ...payload }), [onEvent, tour.id]);

  const companion = useMemo(() => {
    const c = new CompanionSession(tour.id, {
      onState: (s, d) => {
        const prev = prevCState.current;
        prevCState.current = s;
        setCState(s);
        setCDetail(d ?? "");
        // Connecting in the background is not asking: only a live exchange
        // holds the tour. askDown pauses narration itself when the hold begins.
        askingRef.current = s === "listening" || s === "thinking" || s === "speaking";
        if (askingRef.current) engine.current?.pauseVoice();
        // Her live answer ended: the recorded walk picks back up.
        if (s === "ready" && (prev === "speaking" || prev === "thinking")) engine.current?.resumeVoice();
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
    engine.current?.fadeStopVoice();
    beatState.current.voiceStop = () => {};
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
      setGated(false);
      setShowHint(false);
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
      if (bs.voiceDone && active >= expected) {
        // Gates, not conveyor belts: the walk waits for Continue, and a card
        // with points of interest waits so they can actually be explored.
        const explorable =
          (beat.kind === "card" && cardHotspots(beat.card).length > 0) ||
          (beat.kind === "arrival" && (tour.stops[beat.stopIndex].arrival.hotspots?.length ?? 0) > 0);
        if (beat.kind === "walk" || explorable) {
          setGated((g) => {
            if (!g && explorable && !localStorage.getItem("tt.hintExplore")) {
              try {
                localStorage.setItem("tt.hintExplore", "1");
              } catch {
                // storage unavailable; the hint just shows again next time
              }
              setShowHint(true);
            }
            return true;
          });
        } else goToRef.current(bi + 1, "auto");
      }
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [phase, bi, paused, beat]);

  /* ------------------------------ interactions ---------------------------- */

  /**
   * Where `start` begins. A host that stored the stopId from a tour_left event
   * can hand it back to resume the walk; a stop that no longer exists (the tour
   * was republished with different stops) quietly starts from the beginning
   * rather than showing nothing.
   */
  const startBeat = useMemo(() => {
    if (!startStopId) return 0;
    const stopIndex = tour.stops.findIndex((s) => s.id === startStopId);
    if (stopIndex < 0) return 0;
    const at = beats.findIndex((b) => b.stopIndex === stopIndex);
    return at < 0 ? 0 : at;
  }, [beats, startStopId, tour.stops]);

  const start = () => {
    engine.current = engine.current ?? new AudioEngine();
    engine.current.unlock(); // inside the tap
    startedAt.current = Date.now();
    emit("tour_started", { version: tour.version, startStopId: startBeat > 0 ? startStopId : undefined });
    setPhase("playing");
    setBi(startBeat);
    // Pre-connect her ears so the first hold listens instantly; mic stays off
    // until held. A failure here is silent - holding will simply retry.
    void companion.connect(tour.stops[beats[startBeat]?.stopIndex ?? 0].id).catch(() => undefined);
  };

  const togglePause = () => setPaused((p) => !p);

  // Pause means silence and stillness, whatever was talking: her narration,
  // an aside about a tapped point, or a live answer, and her circle freezes too.
  // The scene itself is a still that drifts, and the drift halts with the CSS
  // hold class, so pause only has her voice and her circle to quieten.
  const circleVideo = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (phase !== "playing") return;
    if (paused) {
      engine.current?.pauseVoice();
      companionRef.current?.stopSpeaking();
      circleVideo.current?.pause();
    } else {
      engine.current?.resumeVoice();
    }
  }, [paused, phase]);

  /* --------------------------- her presence ------------------------------ */

  // One clip that begins and ends on the same frame, looping natively. Every
  // seam we tried before came from stitching: cutting between clips snapped her
  // back to the starting pose, dissolving showed the same woman twice, and
  // reversing walked the crowd behind her backwards. With the loop closed there
  // is nothing to stitch, so the player is a single element that never stops.
  const reel = tour.companion.faceReel?.length ? tour.companion.faceReel : stop.arrival.talkingPortrait ? [stop.arrival.talkingPortrait] : [];
  const clip = reel[0]?.video;
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (phase !== "playing") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setInterval(() => {
      const v = circleVideo.current;
      if (!v) return;
      const live = Boolean(companionRef.current?.isSpeakingAudio());
      setSpeaking(((Boolean(engine.current?.isVoicePlaying()) && !askingRef.current) || live) && !paused);
      if (paused || reduced) {
        if (!v.paused) v.pause();
        return;
      }
      if (v.paused) v.play().catch(() => undefined);
    }, 150);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, paused, clip]);

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
    if (x < 0.28) {
      flash("left");
      goTo(bi - 1, "tap_back");
    } else {
      flash("right");
      goTo(bi + 1, "tap_skip");
    }
  };

  const openHotspot = (h: Hotspot) => {
    // Arrival screens carry points too, and they have no card behind them.
    if (!beat) return;
    emit("hotspot_opened", { cardId: beat.card?.id ?? `${stop.id}_arrival`, hotspotId: h.id, label: h.label });
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
    setHoldingAsk(true);
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
    setHoldingAsk(false);
    companion.pttEnd();
  };

  const leave = () => {
    emit("tour_left", { stopId: stop?.id, cardId: beat?.card?.id, elapsedSec: Math.round((Date.now() - startedAt.current) / 1000) });
    companion.close();
    engine.current?.stop();
    setPhase("cover");
  };

  // Held in a ref because `leave` closes over the current beat and is rebuilt on
  // every render, while the controls object must stay the one the host was
  // handed on mount.
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => {
    onControls?.({
      pause: () => setPaused(true),
      resume: () => setPaused(false),
      leave: () => leaveRef.current(),
    });
  }, [onControls]);

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
              {tour.stops.length} {tour.stops.length === 1 ? "stop" : "stops"} · about {tour.durationMin} min · {tour.companion.name.split(" ")[0]} talks, you can interrupt
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
  const spots = beat?.kind === "card" ? cardHotspots(beat.card) : beat?.kind === "arrival" ? (stop.arrival.hotspots ?? []) : [];
  // Dots arrive as her line winds down, not the moment the screen appears.
  const spotsRevealed = gated || beatFrac > 0.62;
  const nextStop = beat?.kind === "walk" ? tour.stops[beat.stopIndex + 1] : undefined;

  return (
    <div className={`player ${paused ? "paused" : ""} ${beat?.kind === "walk" ? "walking" : ""}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => holdTimer.current && window.clearTimeout(holdTimer.current)}>
      {/* progress: one segment per stop, filling beat by beat as she speaks */}
      <div className="progress">
        {tour.stops.map((s, i) => {
          // A gated beat parks its fill just short, so the wait is visible.
          const frac = gated ? Math.min(beatFrac, 0.9) : beatFrac;
          const fill = !beat ? 0 : i < beat.stopIndex ? 1 : i > beat.stopIndex ? 0 : (beat.indexInStop + frac) / beat.beatsInStop;
          return (
            <span key={s.id} className={fill >= 1 ? "done" : fill > 0 ? "cur" : ""}>
              <i style={{ width: `${Math.min(100, fill * 100)}%` }} />
            </span>
          );
        })}
      </div>

      <div className="hud-top">
        <button className={`companion-chip ${speakingUi ? "speaking" : ""}`} data-noadvance onClick={() => setSheet(!sheet)}>
          <img src={tour.companion.portrait} alt="" />
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
            {gated ? (
              <button className="continue" data-noadvance onClick={() => goTo(bi + 1, "continue")}>
                Continue to {nextStop.title} →
              </button>
            ) : (
              <div className="walk-dots" aria-label={`Stop ${beat.stopIndex + 2} of ${tour.stops.length}`}>
                {tour.stops.map((s, i) => (
                  <span key={s.id} className={i === beat.stopIndex + 1 ? "on" : ""} />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="slide">
          {img && (
            <div className={`zoomer ${hotspot ? "focus" : ""}`} style={hotspot ? { transformOrigin: `${hotspot.x * 100}% ${hotspot.y * 100}%` } : undefined}>
              <img className={`bg kenburns ${bi % 2 ? "kb-b" : "kb-a"} ${paused || hotspot ? "hold" : ""}`} src={img} alt="" />
            </div>
          )}
          {hotspot && (
            <div
              className="vignette"
              style={{ background: `radial-gradient(circle at ${hotspot.x * 100}% ${hotspot.y * 100}%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,.52) 55%)` }}
            />
          )}
          {beat?.kind === "arrival" && (
            <div className="titlecard" key={beat.key}>
              <small>
                Stop {stop.order} of {tour.stops.length}
              </small>
              <h2>{stop.title}</h2>
            </div>
          )}
          {gated && showPanes && (
            <>
              {bi > 0 && (
                <button className="side-pane left" data-noadvance onClick={() => { flash("left"); goTo(bi - 1, "pane_back"); }} aria-label="Back">
                  <span>‹</span>
                </button>
              )}
              <button className="side-pane right" data-noadvance onClick={() => { flash("right"); goTo(bi + 1, "pane_next"); }} aria-label="Continue">
                <span>›</span>
              </button>
              {showHint && <div className="gate-hint">tap the right side to continue</div>}
            </>
          )}
          {spotsRevealed && spots.map((h) => {
            // Her circle sits low on the right. A marker underneath it cannot be
            // tapped, so anything that lands there is moved clear of it.
            const underCircle = h.x > 0.62 && h.y > 0.68 && h.y < 0.93;
            const x = underCircle ? Math.max(0.08, h.x - 0.34) : h.x;
            const active = hotspot?.id === h.id;
            const below = h.y < 0.28; // a high point gets its label underneath, clear of the HUD
            const low = h.y > 0.68; // a low point lifts its label clear of the controls and her circle
            const edge = x < 0.22 ? "edge-l" : x > 0.78 || (low && x > 0.5) ? "edge-r" : "";
            return (
              <button
                key={h.id}
                className={`poi ${gated ? "beckon" : ""} ${active ? "active" : ""} ${hotspot && !active ? "dim" : ""} ${below ? "below" : ""} ${low ? "low" : ""} ${edge}`}
                style={{ left: `${x * 100}%`, top: `${h.y * 100}%` }}
                data-noadvance
                onClick={() => openHotspot(h)}
                aria-label={h.label}
              >
                <i />
                {active && <em>{h.label}</em>}
              </button>
            );
          })}
        </div>
      )}

      {fadeImg && <img className="fade-layer" src={fadeImg} alt="" />}

      {sideFlash && (
        <div key={sideFlash.n} className={`side-flash ${sideFlash.side}`} onAnimationEnd={() => setSideFlash(null)}>
          <span>{sideFlash.side === "right" ? "›" : "‹"}</span>
        </div>
      )}

      {/* her, talking: the large circle that makes the voice a person */}
      <div className={`voice-circle ${speaking ? "speaking" : ""}`} data-noadvance>
        {/* Her reel: reusable talking clips rotate while any of her audio plays
            (recorded or live) and freeze the instant it stops. */}
        {clip ? (
          <video ref={circleVideo} className="on" src={clip} muted autoPlay loop playsInline preload="auto" />
        ) : (
          <img src={tour.companion.portrait} alt="" />
        )}
      </div>

      {/* bottom shade so the controls always read over any image */}
      <div className="hud-shade" />
      <div className="hud-bottom">
        <button className={`side-ctl ${paused ? "on" : ""}`} data-noadvance onClick={togglePause} aria-label={paused ? "Resume tour" : "Pause tour"}>
          {paused ? "▶" : "❚❚"}
        </button>
        <button className={`ask ${cState}`} data-noadvance onPointerDown={askDown} onPointerUp={askUp} onPointerCancel={askUp} aria-label="Hold to ask">
          {cState === "thinking" || (cState === "connecting" && holdingAsk) ? (
            <span className="tdots"><i /><i /><i /></span>
          ) : cState === "listening" ? (
            "Listening"
          ) : cState === "speaking" ? (
            "Speaking"
          ) : (
            "Hold to ask"
          )}
        </button>
        <button className="side-ctl" data-noadvance onClick={leave} aria-label="Leave the tour">
          ×
        </button>
      </div>

      {(cState === "listening" || cState === "thinking" || (cState === "connecting" && holdingAsk)) && (
        <div className="ask-state" data-noadvance>
          {cState === "listening" ? (
            "Listening…"
          ) : (
            <>
              {tour.companion.name} is thinking
              <span className="tdots"><i /><i /><i /></span>
            </>
          )}
        </div>
      )}
      {cState === "error" && <div className="ask-state error">Voice hiccup, hold to try again{cDetail ? ` (${cDetail.slice(0, 60)})` : ""}</div>}

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
              {tour.companion.name} is not a real historical person, but is built from the records of people who did this work, and knows nothing after {tour.yearRange[1]}. Everything you see is a reconstruction; sources travel with the tour's data.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
