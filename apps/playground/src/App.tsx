import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type { Catalog, Tour, TourSummary } from "@timetravel/schema";
import { api } from "./api.ts";
import { Player, type PlayerControls } from "./Player.tsx";
import type { CompanionState } from "./companion.ts";
import { hasHost, onHostCommand, postToHost } from "./host.ts";
import { Integrate } from "./integration/Integrate.tsx";
import { Embed } from "./integration/Embed.tsx";

interface Ev {
  t: string;
  name: string;
  payload: Record<string, unknown>;
}

const TABS = ["events", "manifest", "cost", "companion", "integrate", "embed"] as const;
type Tab = (typeof TABS)[number];

/** What each tab is called and what it is for, above the panel. */
const TAB_LABEL: Record<Tab, string> = {
  events: "Events",
  manifest: "Manifest",
  cost: "Cost",
  companion: "Companion",
  integrate: "Integrate",
  embed: "Embed",
};

function useQuery() {
  return useMemo(() => new URLSearchParams(location.search), []);
}

export function App() {
  const q = useQuery();
  const playOnly = q.get("play") === "1";
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [city, setCity] = useState(q.get("city") || "london");
  const [year, setYear] = useState(Number(q.get("year") || 1850));
  const [list, setList] = useState<{ matches: TourSummary[]; nearest: TourSummary[] } | null>(null);
  const [tourId, setTourId] = useState<string | null>(q.get("tour"));
  const [tour, setTour] = useState<Tour | null>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<Ev[]>([]);
  const [tab, setTab] = useState<Tab>("events");
  const [ledger, setLedger] = useState<{ totalUsd: number; byProvider: Record<string, number>; entries: unknown[] } | null>(null);
  const [qr, setQr] = useState("");
  const [gallery, setGallery] = useState<TourSummary[] | null>(null);
  const [cState, setCState] = useState<CompanionState>("idle");
  const [transcript, setTranscript] = useState<{ who: string; text: string }[]>([]);

  useEffect(() => {
    api
      .catalog()
      .then((c) => {
        setCatalog(c);
        // Every published tour, so the whole set can be browsed and played from here.
        api.allTours(c.cities.map((x) => ({ id: x.id, years: x.years }))).then(setGallery).catch(() => setGallery([]));
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!catalog) return;
    api
      .tours(city, year)
      .then((r) => {
        setList(r);
        if (!tourId) {
          const first = r.matches[0] ?? r.nearest[0];
          if (first) setTourId(first.id);
        }
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, city, year]);

  useEffect(() => {
    if (!tourId) return;
    setTour(null);
    api.tour(tourId).then(setTour).catch((e) => setError(e.message));
    api.ledger(tourId).then(setLedger).catch(() => setLedger(null));
    const url = `${location.origin}/?tour=${encodeURIComponent(tourId)}&play=1`;
    QRCode.toDataURL(url, { margin: 1, width: 160, color: { dark: "#1B2230", light: "#ffffff" } }).then(setQr).catch(() => setQr(""));
  }, [tourId]);

  const onEvent = useCallback((name: string, payload: Record<string, unknown>) => {
    setEvents((ev) => [{ t: new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" }) + " IST", name, payload }, ...ev].slice(0, 200));
  }, []);
  const onCompanion = useCallback((s: CompanionState, t: { who: string; text: string }[]) => {
    setCState(s);
    setTranscript([...t]);
  }, []);

  if (playOnly) {
    return <HostedPlayer tour={tour} error={error} startStopId={q.get("stop") ?? undefined} onEvent={onEvent} onCompanion={onCompanion} />;
  }


  return (
    <div className="pg">
      <header className="pg-head">
        <div>
          <div className="eyebrow">Time Travel · playground</div>
          <h1>Tour engine</h1>
        </div>
        <div className="pg-count">{gallery ? `${gallery.length} walks in ${new Set(gallery.map((t) => t.city)).size} cities` : "loading walks…"}</div>
      </header>
      {error && <div className="pg-error">{error}</div>}

      {gallery && gallery.length > 0 && (
        <nav className="tourcards" aria-label="Choose a walk">
          {Object.entries(
            gallery.reduce<Record<string, TourSummary[]>>((acc, t) => {
              (acc[t.city] ??= []).push(t);
              return acc;
            }, {}),
          ).map(([cityId, tours]) => (
            <div className="tourcard-city" key={cityId}>
              <h3>{catalog?.cities.find((c) => c.id === cityId)?.name ?? cityId}</h3>
              <div className="tourcard-row">
                {tours.map((t) => (
                  <button
                    key={t.id}
                    className={`tourcard ${t.id === tourId ? "on" : ""}`}
                    onClick={() => {
                      setTourId(t.id);
                      setCity(t.city);
                      setYear(t.year);
                    }}
                  >
                    <img src={t.cover.image} alt="" loading="lazy" />
                    <span className="tourcard-year">{t.year}</span>
                    <span className="tourcard-title">{t.title}</span>
                    <span className="tourcard-who">
                      {t.companion.name} · {t.stopCount} stops
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      )}

      <main className="pg-main">
        <section className="pg-phone">
          <div className="phone">
            <div className="screen">{tour ? <Player key={tour.id + tour.version} tour={tour} onEvent={onEvent} onCompanion={onCompanion} /> : <div className="loading">{list && !tourId ? "No tours published yet. Run the pipeline." : "Loading…"}</div>}</div>
          </div>
          <div className="qr">
            {qr && <img src={qr} alt="QR to open on a phone" />}
            <small>
              Open on a phone on this network. Accept the local certificate once; the microphone needs HTTPS.
              <br />
              <code>{tourId ? `${location.origin}/?tour=${tourId}&play=1` : ""}</code>
            </small>
          </div>
        </section>

        <section className="pg-side">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
                {t === "companion" && cState !== "idle" ? ` · ${cState}` : ""}
              </button>
            ))}
          </nav>
          {tab === "events" && (
            <div className="panel">
              {events.length === 0 && <p className="muted">Events the player emits appear here (tour_started, stop_entered, card_viewed, then_now_used, ask_started…).</p>}
              <ul className="events">
                {events.map((e, i) => (
                  <li key={i}>
                    <span className="t">{e.t}</span> <b>{e.name}</b> <code>{JSON.stringify(e.payload)}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {tab === "manifest" && (
            <div className="panel">
              <pre>{tour ? JSON.stringify(tour, null, 2) : "…"}</pre>
            </div>
          )}
          {tab === "cost" && (
            <div className="panel">
              {ledger ? (
                <>
                  <p>
                    <b>${ledger.totalUsd.toFixed(2)}</b> total ·{" "}
                    {Object.entries(ledger.byProvider)
                      .map(([k, v]) => `${k} $${v.toFixed(2)}`)
                      .join(" · ")}
                  </p>
                  <pre>{JSON.stringify(ledger.entries, null, 1)}</pre>
                </>
              ) : (
                <p className="muted">No ledger for this tour.</p>
              )}
            </div>
          )}
          {tab === "integrate" && <Integrate tour={tour} summary={gallery?.find((t) => t.id === tourId) ?? null} />}
          {tab === "embed" && <Embed tour={tour} />}
          {tab === "companion" && (
            <div className="panel">
              <p>
                State: <b>{cState}</b>
              </p>
              <ul className="transcript">
                {transcript.map((t, i) => (
                  <li key={i} className={t.who}>
                    <b>{t.who === "you" ? "You" : tour?.companion.name}</b> {t.text}
                  </li>
                ))}
              </ul>
              {transcript.length === 0 && <p className="muted">Hold the Ask button on the phone and speak. The transcript appears here.</p>}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}


/**
 * The player as a host sees it: a full-bleed walk that reports what the
 * traveller does and obeys what the host tells it.
 *
 * This is the exact page a WebView or an iframe loads, so anything the
 * integration promises has to be true here — which is why the bridge lives on
 * this path rather than in a wrapper only the playground uses.
 */
function HostedPlayer({
  tour,
  error,
  startStopId,
  onEvent,
  onCompanion,
}: {
  tour: Tour | null;
  error: string;
  startStopId?: string;
  onEvent: (name: string, payload: Record<string, unknown>) => void;
  onCompanion: (s: CompanionState, t: { who: string; text: string }[]) => void;
}) {
  const controls = useRef<PlayerControls | null>(null);
  const onControls = useCallback((c: PlayerControls) => {
    controls.current = c;
  }, []);

  // Everything the player emits goes to the host as well as to the playground's
  // own Events tab, so the two can never disagree about what happened.
  const emit = useCallback(
    (name: string, payload: Record<string, unknown>) => {
      onEvent(name, payload);
      postToHost(name as Parameters<typeof postToHost>[0], payload);
    },
    [onEvent],
  );

  // Announced once per tour, not once per mount. A host may act on `ready` by
  // dismissing its own spinner or starting a timer, and a remount (React's
  // StrictMode in development, a re-render after a resize) must not make that
  // happen twice. The same goes for a failure.
  const announced = useRef("");
  useEffect(() => {
    if (!tour) return;
    const key = `${tour.id}@${tour.version}`;
    if (announced.current === key) return;
    announced.current = key;
    postToHost("ready", { tourId: tour.id, version: tour.version, title: tour.title, stopCount: tour.stops.length, durationMin: tour.durationMin });
  }, [tour]);

  useEffect(() => {
    // A host that only ever hears silence cannot tell "still loading" from
    // "this tour does not exist", so a failure is an event too.
    if (!error || announced.current === `error:${error}`) return;
    announced.current = `error:${error}`;
    postToHost("error", { message: error });
  }, [error]);

  useEffect(
    () =>
      onHostCommand((name) => {
        if (name === "pause") controls.current?.pause();
        if (name === "resume") controls.current?.resume();
        if (name === "exit") controls.current?.leave();
      }),
    [],
  );

  return (
    <div className="play-only" data-hosted={hasHost() ? "1" : "0"}>
      {tour ? (
        <Player tour={tour} startStopId={startStopId} onControls={onControls} onEvent={emit} onCompanion={onCompanion} />
      ) : (
        <div className="loading">{error || "Loading tour…"}</div>
      )}
    </div>
  );
}
