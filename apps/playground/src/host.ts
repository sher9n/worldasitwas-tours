/**
 * The bridge to whatever is hosting the player.
 *
 * When the player runs at `?play=1` it is usually not the whole app: it is a
 * WebView inside World As It Was, or an iframe in someone's page. This module
 * is the entire contract with that host — events out, commands in — and it is
 * deliberately one-way-safe: if nothing is hosting us, every call here is a
 * no-op and the player behaves exactly as it does standalone.
 *
 * The message shapes live in @timetravel/client, so the sender and the
 * receiver cannot drift apart.
 */
import {
  PLAYER_MESSAGE_SOURCE,
  parseTourEvent,
  type TourCommandName,
  type TourEvent,
  type TourEventName,
} from "@timetravel/client";

interface ReactNativeWebViewBridge {
  postMessage(data: string): void;
}

function rnBridge(): ReactNativeWebViewBridge | undefined {
  return (window as unknown as { ReactNativeWebView?: ReactNativeWebViewBridge }).ReactNativeWebView;
}

/** True when this page is inside a WebView or an iframe that could be listening. */
export function hasHost(): boolean {
  return Boolean(rnBridge()) || window.parent !== window;
}

/**
 * Send one event to the host. Both channels are tried because a page can be in
 * both at once (an iframe inside a WebView), and posting to a channel nobody
 * reads costs nothing.
 */
export function postToHost(name: TourEventName, payload: Record<string, unknown> = {}): void {
  const message: TourEvent = { source: PLAYER_MESSAGE_SOURCE, v: 1, type: "event", name, payload, t: Date.now() };
  const rn = rnBridge();
  if (rn) {
    try {
      rn.postMessage(JSON.stringify(message));
    } catch {
      // A serialisation failure in telemetry must never break the walk.
    }
  }
  if (window.parent && window.parent !== window) {
    try {
      // "*" on purpose: the host origin is not knowable here, and the payload
      // is tour telemetry with nothing private in it. Hosts filter on
      // `source: "timetravel"`, which is what parseTourEvent does for them.
      window.parent.postMessage(message, "*");
    } catch {
      /* cross-origin parent that refuses structured clone; nothing to do */
    }
  }
}

/**
 * Listen for commands the host sends in. Returns the unsubscribe function.
 *
 * A React Native host reaches us with `injectJavaScript(tourCommandScript(...))`,
 * which raises a `message` event on `window`; a browser host uses
 * `iframe.contentWindow.postMessage(tourCommand(...), "*")`. Both land here.
 */
export function onHostCommand(handler: (name: TourCommandName) => void): () => void {
  const listener = (e: MessageEvent) => {
    let data: unknown = e.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== "object") return;
    const m = data as { source?: string; type?: string; name?: string };
    if (m.source !== PLAYER_MESSAGE_SOURCE || m.type !== "command") return;
    if (m.name === "pause" || m.name === "resume" || m.name === "exit") handler(m.name);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

/** Re-exported so the playground's own demo host can read what it is sent. */
export { parseTourEvent };
