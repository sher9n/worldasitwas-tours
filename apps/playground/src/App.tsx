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
  const [cState, setCState] = useState<CompanionState>("idle");
  const [transcript, setTranscript] = useState<{ who: string; text: string }[]>([]);

  useEffect(() => {
    api.catalog().then(setCatalog).catch((e) => setError(e.message));
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

  const years = catalog?.cities.find((c) => c.id === city)?.years ?? [];

  return (
    <div className="pg">
      <header className="pg-head">
        <div>
          <div className="eyebrow">Time Travel · playground</div>
          <h1>Tour engine</h1>
        </div>
        <div className="pg-controls">
          <label>
            City
            <select value={city} onChange={(e) => setCity(e.target.value)}>
              {(catalog?.cities ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Year
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} list="years" />
            <datalist id="years">
              {years.map((y) => (
                <option key={y} value={y} />
              ))}
            </datalist>
          </label>
          <label>
            Tour
            <select value={tourId ?? ""} onChange={(e) => setTourId(e.target.value)}>
              {[...(list?.matches ?? []), ...(list?.nearest ?? [])].map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} ({t.year}){t.distanceYears ? ` · ${t.distanceYears} yrs away` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {error && <div className="pg-error">{error}</div>}

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
