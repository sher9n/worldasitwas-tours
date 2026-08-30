import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { Catalog, Tour, TourSummary } from "@timetravel/schema";
import { api } from "./api.ts";
import { Player } from "./Player.tsx";
import type { CompanionState } from "./companion.ts";

interface Ev {
  t: string;
  name: string;
  payload: Record<string, unknown>;
}

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
  const [tab, setTab] = useState<"events" | "manifest" | "cost" | "companion">("events");
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
    return (
      <div className="play-only">
        {tour ? <Player tour={tour} onEvent={onEvent} onCompanion={onCompanion} /> : <div className="loading">{error || "Loading tour…"}</div>}
      </div>
    );
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
        <nav className="walks" aria-label="Choose a walk">
          {Object.entries(
            gallery.reduce<Record<string, TourSummary[]>>((acc, t) => {
              (acc[t.city] ??= []).push(t);
              return acc;
            }, {}),
          ).map(([cityId, tours]) => (
            <div className="walk-city" key={cityId}>
              <h3>{catalog?.cities.find((c) => c.id === cityId)?.name ?? cityId}</h3>
              <div className="walk-row">
                {tours.map((t) => (
                  <button
                    key={t.id}
                    className={`walk ${t.id === tourId ? "on" : ""}`}
                    onClick={() => {
                      setTourId(t.id);
                      setCity(t.city);
                      setYear(t.year);
                    }}
                  >
                    <img src={t.cover.image} alt="" loading="lazy" />
                    <span className="walk-year">{t.year}</span>
                    <span className="walk-title">{t.title}</span>
                    <span className="walk-who">
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
            {(["events", "manifest", "cost", "companion"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t}
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
