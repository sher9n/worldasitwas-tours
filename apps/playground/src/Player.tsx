import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Card, Claim, Stop, Tour } from "@timetravel/schema";
import { CompanionSession, type CompanionState } from "./companion.ts";

export type EventSink = (name: string, payload: Record<string, unknown>) => void;

type Phase = "idle" | "arrival" | "cards" | "transition" | "done";

const HOLD_MS = 220;

function dbToGain(db: number): number {
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)));
}

export function Player({ tour, onEvent, onCompanion }: { tour: Tour; onEvent: EventSink; onCompanion?: (s: CompanionState, transcript: { who: string; text: string }[]) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [si, setSi] = useState(0);
  const [ci, setCi] = useState(0);
  const [paused, setPaused] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [sheet, setSheet] = useState<"none" | "sources" | "companion">("none");
  const [claim, setClaim] = useState<Claim | null>(null);
  const [cState, setCState] = useState<CompanionState>("idle");
  const [cDetail, setCDetail] = useState("");
  const [live, setLive] = useState("");
  const transcriptRef = useRef<{ who: string; text: string }[]>([]);
  const companionRef = useRef<CompanionSession | null>(null);
  const ambienceRef = useRef<HTMLAudioElement | null>(null);
  const narrationRef = useRef<HTMLAudioElement | null>(null);
  const cardEnteredAt = useRef(Date.now());
  const holdTimer = useRef<number | null>(null);
  const holding = useRef(false);
  const startedAt = useRef(0);

  const stop: Stop = tour.stops[si];
  const card: Card | undefined = stop?.cards[ci];

  const emit = useCallback((name: string, payload: Record<string, unknown> = {}) => onEvent(name, { tourId: tour.id, ...payload }), [onEvent, tour.id]);

  const companion = useMemo(() => {
    const c = new CompanionSession(tour.id, {
      onState: (s, d) => {
        setCState(s);
        setCDetail(d ?? "");
        onCompanion?.(s, transcriptRef.current);
        if (s === "speaking") narrationRef.current?.pause();
      },
      onTranscript: (who, text, final) => {
        if (!final) {
          setLive((l) => (who === "companion" ? l + text : l));
          return;
        }
        transcriptRef.current = [...transcriptRef.current, { who, text }];
        if (who === "companion") setLive("");
        onCompanion?.(companionRef.current?.state ?? "idle", transcriptRef.current);
      },
      onTool: (name, args) => {
        emit("companion_tool", { name, ...args });
        if (name === "show_card" && typeof args.cardId === "string") {
          const target = args.cardId;
          const sIdx = tour.stops.findIndex((s) => s.cards.some((c) => c.id === target));
          if (sIdx >= 0) {
            const cIdx = tour.stops[sIdx].cards.findIndex((c) => c.id === target);
            setPhase("cards");
            setSi(sIdx);
            setCi(cIdx);
          }
        }
        if (name === "end_conversation") setTimeout(() => companionRef.current?.close(), 1500);
      },
      onEvent: (name, payload) => emit(name, payload),
    });
    companionRef.current = c;
    return c;
  }, [tour, emit, onCompanion]);

  useEffect(() => () => companion.close(), [companion]);

  // Ambience per stop.
  useEffect(() => {
    const a = ambienceRef.current;
    if (!a) return;
    const amb = stop?.arrival.ambience;
    if (phase === "idle" || phase === "done" || !amb) {
      a.pause();
      return;
    }
    if (a.src !== amb.audio) {
      a.src = amb.audio;
      a.loop = amb.loop;
    }
    a.volume = dbToGain(amb.gainDb);
    a.play().catch(() => undefined);
  }, [phase, si, stop]);

  // Narration and context per card.
  useEffect(() => {
    if (phase !== "cards" || !card) return;
    cardEnteredAt.current = Date.now();
    emit("card_viewed_start", { stopId: stop.id, cardId: card.id, kind: card.kind });
    const n = narrationRef.current;
    if (n) {
      n.pause();
      if (card.narration?.audio) {
        n.src = card.narration.audio;
        n.currentTime = 0;
        n.play().catch(() => undefined);
      }
    }
    if (card.companionContext) void companion.sendContext(card.companionContext);
    return () => {
      emit("card_viewed", { stopId: stop.id, cardId: card.id, kind: card.kind, dwellMs: Date.now() - cardEnteredAt.current });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, si, ci]);

  useEffect(() => {
    if (phase === "arrival") emit("stop_entered", { stopId: stop.id, order: stop.order });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, si]);

  const start = () => {
    startedAt.current = Date.now();
    emit("tour_started", { version: tour.version });
    setSi(0);
    setCi(0);
    setPhase("arrival");
  };

  const next = useCallback(() => {
    if (phase === "arrival") {
      setPhase("cards");
      setCi(0);
      return;
    }
    if (phase === "cards") {
      if (ci + 1 < stop.cards.length) setCi(ci + 1);
      else if (stop.transitionOut && si + 1 < tour.stops.length) setPhase("transition");
      else if (si + 1 < tour.stops.length) {
        setSi(si + 1);
        setCi(0);
        setPhase("arrival");
      } else {
        setPhase("done");
        emit("tour_completed", { stopId: stop.id, cardId: card?.id, elapsedSec: Math.round((Date.now() - startedAt.current) / 1000) });
      }
      return;
    }
    if (phase === "transition") {
      if (si + 1 < tour.stops.length) {
        setSi(si + 1);
        setCi(0);
        setPhase("arrival");
      } else setPhase("done");
    }
  }, [phase, ci, si, stop, tour, emit, card]);

  const prev = useCallback(() => {
    if (phase === "cards" && ci > 0) setCi(ci - 1);
    else if (phase === "cards" && si > 0) {
      setSi(si - 1);
      setCi(tour.stops[si - 1].cards.length - 1);
    } else if (phase === "transition") setPhase("cards");
  }, [phase, ci, si, tour]);

  // Tap zones and hold-to-pause.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-noadvance]")) return;
    holding.current = false;
    holdTimer.current = window.setTimeout(() => {
      holding.current = true;
      setPaused(true);
      narrationRef.current?.pause();
    }, HOLD_MS);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-noadvance]")) return;
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    if (holding.current) {
      setPaused(false);
      narrationRef.current?.play().catch(() => undefined);
      holding.current = false;
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (phase === "idle") return;
    if (x < 0.3) prev();
    else next();
  };

  // Ask button.
  const askDown = async (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    narrationRef.current?.pause();
    if (cState === "idle" || cState === "closed" || cState === "error") {
      try {
        emit("ask_started", { stopId: stop.id, cardId: card?.id });
        await companion.connect(stop.id, card?.id);
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
    emit("tour_left", { stopId: stop?.id, cardId: card?.id, elapsedSec: Math.round((Date.now() - startedAt.current) / 1000) });
    companion.close();
    setPhase("idle");
  };

  const sourcesForStop = useMemo(() => {
    if (!stop) return [];
    const ids = new Set(stop.cards.flatMap((c) => c.claims.map((k) => k.sourceId)));
    return tour.sources.filter((s) => ids.has(s.id));
  }, [stop, tour]);

  return (
    <div className={`player ${paused ? "paused" : ""}`} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => holdTimer.current && window.clearTimeout(holdTimer.current)}>
      <audio ref={ambienceRef} />
      <audio ref={narrationRef} />

      {phase === "idle" && (
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
              {tour.stops.length} stops · about {tour.durationMin} min
            </div>
            <button className="travel" data-noadvance onClick={start}>
              Travel
            </button>
          </div>
        </div>
      )}

      {phase !== "idle" && phase !== "done" && (
        <>
          <div className="progress">
            {tour.stops.map((s, i) => (
              <span key={s.id} className={i < si ? "done" : i === si ? "cur" : ""}>
                {i === si && <i style={{ width: `${phase === "cards" ? ((ci + 1) / s.cards.length) * 100 : phase === "transition" ? 100 : 8}%` }} />}
              </span>
            ))}
          </div>
          <div className="hud-top">
            <button className="companion-chip" data-noadvance onClick={() => setSheet(sheet === "companion" ? "none" : "companion")}>
              <img src={tour.companion.portrait} alt="" />
              <span>
                <b>{tour.companion.name}</b>
                <small>{tour.companion.role}</small>
              </span>
            </button>
            <div className="year">{tour.year}</div>
          </div>
          <div className="stop-title">{stop.title}</div>
        </>
      )}

      {phase === "arrival" && <ArrivalView stop={stop} tour={tour} onDone={next} />}

      {phase === "cards" && card && <CardView key={card.id} card={card} tour={tour} paused={paused} onClaim={setClaim} onThenNow={(pos) => emit("then_now_used", { cardId: card.id, maxPosition: pos })} />}

      {phase === "transition" && stop.transitionOut && <TransitionView stop={stop} nextStop={tour.stops[si + 1]} onDone={next} />}

      {phase === "done" && (
        <div className="idle done-view" style={{ backgroundImage: `url(${tour.companion.portrait})` }}>
          <div className="idle-shade" />
          <div className="idle-body">
            <div className="idle-year">{tour.year}</div>
            <h1>You walked with {tour.companion.name}.</h1>
            <p>{tour.stops.length} stops, {tour.sources.length} sources, every picture labelled for what it is.</p>
            <button className="travel" data-noadvance onClick={() => setPhase("idle")}>
              Back to the start
            </button>
          </div>
        </div>
      )}

      {phase !== "idle" && phase !== "done" && (
        <div className="hud-bottom">
          <button className={`round ${captions ? "on" : ""}`} data-noadvance onClick={() => setCaptions(!captions)} aria-label="Captions">
            CC
          </button>
          <button className={`ask ${cState}`} data-noadvance onPointerDown={askDown} onPointerUp={askUp} onPointerCancel={askUp} aria-label="Hold to ask">
            {cState === "connecting" ? "…" : cState === "listening" ? "Listening" : cState === "thinking" ? "…" : cState === "speaking" ? "Speaking" : "Hold to ask"}
          </button>
          <button className="round" data-noadvance onClick={() => setSheet(sheet === "sources" ? "none" : "sources")} aria-label="Sources">
            ≡
          </button>
          <button className="leave" data-noadvance onClick={leave} aria-label="Leave">
            ×
          </button>
        </div>
      )}

      {captions && phase !== "idle" && (live || cState === "listening" || cState === "thinking") && (
        <div className="live-caption" data-noadvance>
          {cState === "listening" ? "Listening…" : cState === "thinking" && !live ? `${tour.companion.name} is thinking…` : live}
        </div>
      )}
      {cState === "error" && <div className="live-caption error">Voice unavailable: {cDetail}</div>}

      {claim && (
        <div className="sheet" data-noadvance onClick={() => setClaim(null)}>
          <div className="sheet-body">
            <span className={`pill ${claim.confidence}`}>{claim.confidence}</span>
            <p className="claim-text">{claim.text}</p>
            {(() => {
              const s = tour.sources.find((x) => x.id === claim.sourceId);
              return s ? (
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title} <small>({s.license})</small>
                </a>
              ) : null;
            })()}
          </div>
        </div>
      )}

      {sheet === "sources" && (
        <div className="sheet" data-noadvance onClick={() => setSheet("none")}>
          <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
            <h3>Sources at this stop</h3>
            {sourcesForStop.length === 0 && <p className="muted">No claims cited on these cards.</p>}
            <ul>
              {sourcesForStop.map((s) => (
                <li key={s.id}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>{" "}
                  <small>({s.license})</small>
                </li>
              ))}
            </ul>
            <h3>Pictures</h3>
            <ul>
              {stop.cards.map((c) =>
                c.kind === "archive" ? (
                  <li key={c.id}>
                    Real item: {c.credit.title}, {c.credit.holder}, {c.credit.license}
                  </li>
                ) : c.kind === "thenNow" && c.now.credit ? (
                  <li key={c.id}>
                    Today photograph: {c.now.credit.title}, {c.now.credit.holder}, {c.now.credit.license}
                  </li>
                ) : null,
              )}
              <li className="muted">Everything marked Reconstruction was generated for this tour.</li>
            </ul>
            <h3>Provenance</h3>
            <p className="muted mono">
              {tour.provenance.models.join(", ")} · ${tour.provenance.costUsd.toFixed(2)} · {tour.provenance.reviewedBy === "human" ? "reviewed" : "not yet reviewed"}
            </p>
          </div>
        </div>
      )}

      {sheet === "companion" && (
        <div className="sheet" data-noadvance onClick={() => setSheet("none")}>
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
              {tour.companion.name} is not a real historical person. She is built from the records of people like her, and she knows nothing after {tour.yearRange[1]}.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ArrivalView({ stop, tour, onDone }: { stop: Stop; tour: Tour; onDone: () => void }) {
  const [canSkip, setCanSkip] = useState(false);
  const lineRef = useRef<HTMLAudioElement | null>(null);
  const a = stop.arrival;
  useEffect(() => {
    const t = window.setTimeout(() => setCanSkip(true), 2000);
    if (!a.talkingPortrait && a.line.audio && lineRef.current) {
      lineRef.current.src = a.line.audio;
      lineRef.current.play().catch(() => undefined);
    }
    const total = Math.max(a.talkingPortrait?.durationSec ?? 0, a.line.durationSec ?? 0, a.livingScene?.durationSec ?? 0, 4) * 1000 + 800;
    const done = window.setTimeout(onDone, total);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(done);
    };
  }, [a, onDone]);
  return (
    <div className="arrival">
      <audio ref={lineRef} />
      {a.livingScene ? (
        <video className="bg" src={a.livingScene.video} poster={a.livingScene.poster} autoPlay playsInline loop={!a.talkingPortrait} />
      ) : (
        <div className="bg fill" style={{ backgroundImage: `url(${tour.cover.image})` }} />
      )}
      <span className="badge">Reconstruction</span>
      {a.talkingPortrait && (
        <div className="portrait-inset">
          <video src={a.talkingPortrait.video} poster={a.talkingPortrait.poster} autoPlay playsInline />
        </div>
      )}
      <div className="caption arrival-caption">
        <p className="spoken">“{a.line.text}”</p>
        <small className="muted">{canSkip ? "Tap to continue" : ""}</small>
      </div>
    </div>
  );
}

function CardView({ card, tour, paused, onClaim, onThenNow }: { card: Card; tour: Tour; paused: boolean; onClaim: (c: Claim) => void; onThenNow: (pos: number) => void }) {
  return (
    <div className={`card kind-${card.kind}`}>
      {card.kind === "image" && (
        <>
          <img className={`bg drift ${paused ? "hold" : ""}`} src={card.media.image} alt={card.media.alt ?? ""} />
          <span className="badge">{card.media.origin === "reconstruction" ? "Reconstruction" : card.media.origin}</span>
        </>
      )}
      {card.kind === "video" && (
        <>
          <video className="bg" src={card.media.video} poster={card.media.poster} autoPlay playsInline loop muted={false} />
          <span className="badge">Reconstruction</span>
        </>
      )}
      {card.kind === "thenNow" && <ThenNow thenSrc={card.then.image} nowSrc={card.now.image} year={tour.year} onUsed={onThenNow} />}
      {card.kind === "archive" && <ArchiveView card={card} />}
      {card.kind === "text" && (
        <div className="text-card">
          <p>{card.text}</p>
        </div>
      )}
      {(card.caption || card.claims.length > 0) && (
        <div className="caption">
          {card.caption && <p>{card.caption}</p>}
          {card.claims.length > 0 && (
            <div className="chips" data-noadvance>
              {card.claims.map((k, i) => (
                <button key={i} className={`pill ${k.confidence}`} onClick={() => onClaim(k)}>
                  {k.confidence}
                </button>
              ))}
              <span className="pill src">
                {new Set(card.claims.map((k) => k.sourceId)).size} source{new Set(card.claims.map((k) => k.sourceId)).size === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThenNow({ thenSrc, nowSrc, year, onUsed }: { thenSrc: string; nowSrc: string; year: number; onUsed: (pos: number) => void }) {
  const [pos, setPos] = useState(0.15);
  const max = useRef(0.15);
  const dragging = useRef(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const update = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const p = Math.max(0.02, Math.min(0.98, (clientX - r.left) / r.width));
    setPos(p);
    if (p > max.current) max.current = p;
  };
  return (
    <div
      ref={ref}
      className="thennow"
      data-noadvance
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        update(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && update(e.clientX)}
      onPointerUp={() => {
        dragging.current = false;
        onUsed(Math.round(max.current * 100));
      }}
    >
      <img className="bg" src={thenSrc} alt={`${year}`} />
      <img className="bg now" src={nowSrc} alt="Today" style={{ clipPath: `inset(0 0 0 ${pos * 100}%)` }} />
      <span className="badge">Reconstruction</span>
      <span className="tn-label left">{year}</span>
      <span className="tn-label right">Today</span>
      <div className="tn-handle" style={{ left: `${pos * 100}%` }}>
        <span>◂ ▸</span>
      </div>
    </div>
  );
}

function ArchiveView({ card }: { card: Extract<Card, { kind: "archive" }> }) {
  const [alive, setAlive] = useState(false);
  useEffect(() => {
    if (!card.animated) return;
    const t = window.setTimeout(() => setAlive(true), 2000);
    return () => window.clearTimeout(t);
  }, [card]);
  return (
    <div className="archive">
      <div className="frame">
        <img src={card.media.image} alt={card.credit.title} />
        {card.animated && <video className={alive ? "show" : ""} src={card.animated.video} poster={card.animated.poster} autoPlay playsInline loop />}
      </div>
      <span className="badge real">{alive ? "Real picture, animated" : "Real picture"}</span>
      <div className="credit">
        {card.credit.title} · {card.credit.holder} · {card.credit.license}
      </div>
    </div>
  );
}

function TransitionView({ stop, nextStop, onDone }: { stop: Stop; nextStop?: Stop; onDone: () => void }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const t = stop.transitionOut!;
  useEffect(() => {
    if (t.audio && ref.current) {
      ref.current.src = t.audio;
      ref.current.play().catch(() => undefined);
    }
    const done = window.setTimeout(onDone, ((t.durationSec ?? 5) + 1) * 1000);
    return () => window.clearTimeout(done);
  }, [t, onDone]);
  const bg = nextStop?.arrival.livingScene?.poster;
  return (
    <div className="transition">
      <audio ref={ref} />
      {bg && <div className="bg fill blur" style={{ backgroundImage: `url(${bg})` }} />}
      <div className="transition-body">
        <small className="muted">Walking on{nextStop ? ` to ${nextStop.title}` : ""}</small>
        <p className="spoken">“{t.text}”</p>
      </div>
    </div>
  );
}
