/**
 * "Integrate" — how a developer opens one of our walks from a button in their
 * own app.
 *
 * The whole tab answers one question: somebody tapped Travel, now what? It is
 * written for the app that is actually going to do this (World As It Was, an
 * Expo app whose Travel row already routes to a screen reserved for us), with
 * a plain-React and a REST path beside it for anyone else.
 */
import { useState } from "react";
import type { Tour, TourSummary } from "@timetravel/schema";
import { CodeBlock } from "./CodeBlock.tsx";
import {
  contextFor,
  EVENT_DOCS,
  expoAnalytics,
  expoApi,
  expoButton,
  expoEnv,
  expoInstall,
  expoScreen,
  expoSource,
  feedCurl,
  feedMapLibre,
  feedNativeMap,
  feedProxy,
  feedShape,
  nativeRender,
  restCurl,
  webButton,
} from "./snippets.ts";

const TARGETS = [
  { id: "expo", label: "Expo · React Native", hint: "World As It Was" },
  { id: "web", label: "React · web", hint: "iframe" },
  { id: "rest", label: "REST", hint: "any language" },
] as const;
type Target = (typeof TARGETS)[number]["id"];

export function Integrate({ tour, summary }: { tour: Tour | null; summary: TourSummary | null }) {
  const [target, setTarget] = useState<Target>("expo");
  const [showNative, setShowNative] = useState(false);
  const c = contextFor(tour, summary);

  return (
    <div className="panel doc">
      <header className="doc-head">
        <h2>Open a walk from a button</h2>
        <p>
          Two ways in. <b>Hosted</b> is one screen of code: we render the walk, her voice and the live
          companion, and you get typed events back. <b>Native</b> hands you the manifest to draw yourself.
          Start hosted; a walk is a lot of moving parts to own on day one, and a new city then needs no app
          release.
        </p>
        <p className="doc-live">
          Every snippet below is built from the walk selected on the left — <b>{c.title}</b>, {c.city} {c.year},{" "}
          {c.stopCount} stops with {c.companion}. Copy it and it runs.
        </p>
      </header>

      <nav className="seg" aria-label="Choose a platform">
        {TARGETS.map((t) => (
          <button key={t.id} className={target === t.id ? "on" : ""} onClick={() => setTarget(t.id)}>
            {t.label}
            <em>{t.hint}</em>
          </button>
        ))}
      </nav>

      {target === "expo" && (
        <>
          <Step n={1} title="One dependency, two variables">
            <CodeBlock lang="sh" file="terminal" code={expoInstall} />
            <CodeBlock lang="env" file="apps/mobile/.env" code={expoEnv(c)} />
          </Step>

          <Step
            n={2}
            title="Ask your own API which walk to open"
            note="One method on the TourSource contract, and one route on your Fastify service. This is the only place the platform key exists."
          >
            <CodeBlock lang="ts" file="apps/mobile/src/data/TourSource.ts  ·  httpSource.ts  ·  fixtureSource.ts" code={expoSource(c)} />
            <CodeBlock lang="ts" file="apps/api/src/routes/tours.ts" code={expoApi(c)} />
          </Step>

          <Step
            n={3}
            title="Replace the placeholder screen"
            note="apps/mobile/app/(app)/travel/[placeId]/[year].tsx is already reserved for the tour UI. This is the whole of it."
          >
            <CodeBlock lang="tsx" file="apps/mobile/app/(app)/travel/[placeId]/[year].tsx" code={expoScreen(c)} />
          </Step>

          <Step n={4} title="The button does not change" note="EraList already pushes that route. Nothing to do here — it is shown so you can see there is no step you missed.">
            <CodeBlock lang="tsx" file="apps/mobile/src/eras/EraList.tsx" code={expoButton(c)} />
          </Step>

          <Step n={5} title="Declare the events you want to keep" note="Optional. Your EventName union is closed, so a tour event has to be named before PostHog can receive it.">
            <CodeBlock lang="ts" file="apps/mobile/src/analytics/events.ts" code={expoAnalytics} />
          </Step>
        </>
      )}

      {target === "web" && (
        <Step n={1} title="A button and an iframe">
          <CodeBlock lang="tsx" file="TravelButton.tsx" code={webButton(c)} />
        </Step>
      )}

      {target === "rest" && (
        <Step n={1} title="Three calls, and a URL you can put anywhere">
          <CodeBlock lang="sh" file="terminal" code={restCurl(c)} />
        </Step>
      )}

      <section className="doc-sec">
        <h3>Put every walk on your own map</h3>
        <p className="muted">
          Everything above answers "they pressed Travel, now what". This answers the question before it: how does
          anyone find a walk at all? <code>GET /v1/feed</code> returns every published walk with its stops, so our
          walks appear on your map where they physically happen, and a walk we publish tomorrow appears without
          anyone shipping anything. See it running on the <b>Atlas</b> tab.
        </p>
        <Step n={1} title="Read it, and serve it on from your own origin" note="The platform key is server-side. Cache it: it changes when we publish, which is rarely, and the ETag makes the check nearly free.">
          <CodeBlock lang="sh" file="terminal" code={feedCurl(c)} />
          <CodeBlock lang="ts" file="your API" code={feedProxy} />
        </Step>
        <Step n={2} title="One walk, as the feed gives it to you">
          <CodeBlock lang="json" file="GET /v1/feed → tours[0]" code={feedShape} />
        </Step>
        <Step n={3} title="Draw it" note="The route is a line through the stops in order; the stops are pins on it. Both platforms, same document.">
          <CodeBlock lang="ts" file="MapLibre  ·  apps/web" code={feedMapLibre} />
          <CodeBlock lang="tsx" file="react-native-maps  ·  apps/mobile" code={feedNativeMap} />
        </Step>
      </section>

      <section className="doc-sec">
        <h3>What comes back</h3>
        <p className="muted">
          The player posts these to whatever is hosting it — <code>window.ReactNativeWebView</code> in a WebView,{" "}
          <code>window.parent</code> in an iframe. <code>parseTourEvent</code> gives you a typed event or{" "}
          <code>null</code>; anything that is not ours reads as null rather than throwing, because a host screen
          must not crash on a stray message. Watch them arrive on the <b>Embed</b> tab.
        </p>
        <table className="doc-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>When</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {EVENT_DOCS.map((e) => (
              <tr key={e.name}>
                <td>
                  <code>{e.name}</code>
                </td>
                <td>
                  {e.when}
                  {e.act && <b className="doc-act">{e.act}</b>}
                </td>
                <td className="mono doc-payload">{e.payload}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="doc-sec">
        <h3 className="doc-toggle">
          <button onClick={() => setShowNative((v) => !v)}>{showNative ? "▾" : "▸"} Render it yourself instead</button>
        </h3>
        {showNative && <CodeBlock lang="ts" file="native rendering" code={nativeRender(c)} />}
      </section>

      <section className="doc-sec doc-warn">
        <h3>The one rule</h3>
        <p>
          The platform key is a server-side credential. It must never appear in an app bundle, a web page or a URL —
          an <code>EXPO_PUBLIC_</code> variable ships inside the <code>.ipa</code> and can be read straight out of
          it. Point the client at your own backend and let that attach the key. The hosted player needs no key in
          the client at all, which is the quiet second reason to prefer it.
        </p>
      </section>
    </div>
  );
}

function Step({ n, title, note, children }: { n: number; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="doc-step">
      <h3>
        <span className="doc-n">{n}</span>
        {title}
      </h3>
      {note && <p className="muted">{note}</p>}
      {children}
    </section>
  );
}
