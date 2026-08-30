/**
 * "Embed" — the UI integration.
 *
 * The Integrate tab is the code. This tab is the screen: what the walk looks
 * like inside somebody else's app, where the seam between their chrome and our
 * player falls, and proof that the bridge actually carries.
 *
 * The frame below is not a mock. It is the real player, loaded from the real
 * play URL, in an iframe — the same channel a React Native WebView uses. The
 * events listed beside it arrived over postMessage, and the Pause, Resume and
 * Close buttons are host commands going the other way. If the bridge breaks,
 * this tab stops working, which is the point of building the demo out of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseTourEvent, tourCommand, type TourCommandName } from "@timetravel/client";
import type { Tour } from "@timetravel/schema";
import { CodeBlock } from "./CodeBlock.tsx";
import { contextFor } from "./snippets.ts";

interface Seen {
  name: string;
  detail: string;
  at: string;
}

/** The interesting field of each event, so the log reads as a story. */
function detailOf(name: string, p: Record<string, unknown>): string {
  const s = (k: string) => (p[k] == null ? "" : String(p[k]));
  if (name === "ready") return `${s("stopCount")} stops · ${s("durationMin")} min`;
  if (name === "stop_entered") return `${s("stopId")} (${s("order")})`;
  if (name === "card_viewed") return `${s("cardId")} · ${s("dwellMs")}ms · ${s("cause")}`;
  if (name === "hotspot_opened") return s("label");
  if (name === "tour_completed" || name === "tour_left") return `${s("stopId")} · ${s("elapsedSec")}s`;
  if (name === "error") return s("message");
  return s("version") || s("stopId") || "";
}

export function Embed({ tour }: { tour: Tour | null }) {
  const c = contextFor(tour, null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [running, setRunning] = useState(false);
  const [resumeStop, setResumeStop] = useState("");
  const [seen, setSeen] = useState<Seen[]>([]);
  const [lastStop, setLastStop] = useState<string | null>(null);

  const src = useMemo(() => {
    const q = new URLSearchParams({ tour: c.tourId, play: "1", traveller: "t_playground_embed" });
    if (resumeStop) q.set("stop", resumeStop);
    return `${c.playerOrigin}/?${q.toString()}`;
  }, [c.tourId, c.playerOrigin, resumeStop]);

  // Exactly what a host does: listen, parse, ignore what is not ours, and act
  // on the one event that means "the traveller is done here".
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const ev = parseTourEvent(e.data);
      if (!ev) return;
      setSeen((prev) =>
        [{ name: ev.name, detail: detailOf(ev.name, ev.payload), at: new Date(ev.t).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" }) }, ...prev].slice(0, 60),
      );
      if (ev.name === "stop_entered" && typeof ev.payload.stopId === "string") setLastStop(ev.payload.stopId);
      if (ev.name === "tour_left" || ev.name === "tour_completed") setRunning(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const send = useCallback((name: TourCommandName) => {
    frame.current?.contentWindow?.postMessage(tourCommand(name), "*");
  }, []);

  const open = () => {
    setSeen([]);
    setRunning(true);
  };

  return (
    <div className="panel doc">
      <header className="doc-head">
        <h2>The walk inside your app</h2>
        <p>
          One screen, edge to edge. The player owns everything inside the frame: the stills, her voice, the points
          of interest, the pause, the live Ask. You own the frame — the route, the safe areas, the close
          affordance, and what happens when the walk ends.
        </p>
        <p className="doc-live">
          This is the real player over the real bridge, not a picture of one. Press Open, then use the host
          controls; the events are arriving over <code>postMessage</code>.
        </p>
      </header>

      <section className="doc-demo">
        <div className="demo-device">
          <div className="demo-chrome">
            <span>Your app</span>
            <div className="demo-cmds">
              <button onClick={() => send("pause")} disabled={!running}>Pause</button>
              <button onClick={() => send("resume")} disabled={!running}>Resume</button>
              <button onClick={() => send("exit")} disabled={!running}>Close</button>
            </div>
          </div>
          <div className="demo-screen">
            {running ? (
              <iframe
                ref={frame}
                src={src}
                title={`A walk through ${c.city} in ${c.year}`}
                allow="autoplay; microphone; fullscreen"
              />
            ) : (
              <div className="demo-idle">
                <button className="demo-open" onClick={open}>Open the walk</button>
                <small>
                  {c.title} · {c.city} {c.year}
                </small>
                {lastStop && (
                  <label className="demo-resume">
                    <input type="checkbox" checked={resumeStop === lastStop} onChange={(e) => setResumeStop(e.target.checked ? lastStop : "")} />
                    Resume at <code>{lastStop}</code>
                  </label>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="demo-log">
          <h4>Events your screen received</h4>
          {seen.length === 0 ? (
            <p className="muted">Nothing yet. Open the walk and they appear here as they happen.</p>
          ) : (
            <ul>
              {seen.map((e, i) => (
                <li key={i}>
                  <span className="t">{e.at}</span> <b>{e.name}</b> <span className="muted">{e.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="doc-sec">
        <h3>Where the seam falls</h3>
        <table className="doc-table">
          <thead>
            <tr>
              <th>You own</th>
              <th>We own</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>The route, the transition onto the screen, and popping it again.</td>
              <td>Everything drawn inside the frame, once it is on screen.</td>
            </tr>
            <tr>
              <td>The close affordance, placed in your safe area over the player.</td>
              <td>Pause, skip, points of interest, the Ask button, the end of the walk.</td>
            </tr>
            <tr>
              <td>Entitlement: whether this traveller may open this walk at all.</td>
              <td>Which walk exists for a city and a year, and what is in it.</td>
            </tr>
            <tr>
              <td>Analytics, and remembering the stop they left at.</td>
              <td>Emitting the events those two are built from.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="doc-sec">
        <h3>Five things a host has to get right</h3>
        <ol className="doc-list">
          <li>
            <b>Act on <code>tour_left</code>.</b> The player's own close button emits it and then returns to the
            cover; if you do not pop your screen, the traveller is stuck looking at a cover they already left.{" "}
            <code>tour_completed</code> means the same thing at the other end of the walk.
          </li>
          <li>
            <b>Pause when the app backgrounds.</b> A WebView keeps playing audio behind a lock screen on Android.
            Send <code>pause</code> on blur and <code>resume</code> on focus — she stops mid-sentence and picks up
            where she was, rather than talking to nobody.
          </li>
          <li>
            <b>Let the media start itself.</b> The walk is audio-led and she speaks on arrival, so the WebView
            needs <code>mediaPlaybackRequiresUserAction=&#123;false&#125;</code> and{" "}
            <code>allowsInlineMediaPlayback</code>. Without them the first stop is silent and looks broken.
          </li>
          <li>
            <b>Ask for the microphone properly.</b> The Ask button opens a live conversation. iOS needs{" "}
            <code>mediaCapturePermissionGrantType="grant"</code> plus <code>NSMicrophoneUsageDescription</code> in
            the Info.plist; Android needs <code>RECORD_AUDIO</code> and an{" "}
            <code>onPermissionRequest</code> that grants it. Everything else in the walk works without it.
          </li>
          <li>
            <b>Give it the whole screen.</b> Every beat is a full-bleed still with her circle over it. A header bar
            or a tab bar across it crops the picture the walk is made of.
          </li>
        </ol>
      </section>

      <section className="doc-sec">
        <h3>Pausing with the app lifecycle</h3>
        <CodeBlock
          lang="tsx"
          file="apps/mobile/app/(app)/travel/[placeId]/[year].tsx"
          note="The remaining twenty lines of the screen from the Integrate tab."
          code={`import { AppState } from "react-native";
import { tourCommandScript } from "../../../../src/tours/timetravel";

// A backgrounded WebView keeps playing on Android, so the walk carries on
// without anybody watching it. Quieten her, and pick up where she stopped.
useEffect(() => {
  const sub = AppState.addEventListener("change", (state) => {
    webRef.current?.injectJavaScript(tourCommandScript(state === "active" ? "resume" : "pause"));
  });
  return () => sub.remove();
}, []);

// Android's hardware back button, and the iOS swipe: let the player close
// itself so it can stop her mid-sentence and emit tour_left with the stop
// they reached — which is what you store to offer "resume" next time.
useEffect(() => {
  const sub = BackHandler.addEventListener("hardwareBackPress", () => {
    webRef.current?.injectJavaScript(tourCommandScript("exit"));
    return true;   // we handled it; do not pop the screen yet
  });
  return () => sub.remove();
}, []);`}
        />
      </section>

      <section className="doc-sec">
        <h3>Resuming a half-finished walk</h3>
        <p className="muted">
          <code>tour_left</code> carries the stop they reached. Hand it back on the URL and the walk starts there
          instead of at the cover. A stop that no longer exists — the tour was republished with a different
          route — quietly starts from the beginning rather than failing.
        </p>
        <CodeBlock
          lang="ts"
          file="resume"
          code={`// when they leave
if (ev.name === "tour_left") await saveProgress(placeId, year, ev.payload.stopId);

// next time they press Travel
const stopId = await loadProgress(placeId, year);
const url = tours.playerUrl("${c.tourId}", { travellerId, stopId });
// → ${c.playerOrigin}/?tour=${c.tourId}&play=1&traveller=…&stop=…`}
        />
      </section>
    </div>
  );
}
