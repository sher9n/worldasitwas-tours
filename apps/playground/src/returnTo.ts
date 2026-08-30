/**
 * Where a visitor goes when they close a walk or reach the end of one.
 *
 * The player is opened two ways and they need opposite behaviour. Inside a
 * WebView or an iframe the HOST owns navigation: it is told `tour_left` or
 * `tour_completed` and pops its own screen, and a player that navigated itself
 * would fight it. Opened as the whole page, which is what a web app does when
 * it sends someone to the player URL, there is nobody to pop anything, and
 * closing the walk used to land back on its own cover with no way out.
 *
 * The rule about which addresses are acceptable lives in @timetravel/client, so
 * a host can check a value before putting it in a URL and get the same answer
 * the player will give.
 */
import { DEFAULT_RETURN_URL, isReturnUrlAllowed } from "@timetravel/client";

export { DEFAULT_RETURN_URL };

/**
 * The address to leave to. A `return` we do not recognise is not an error worth
 * showing anyone: it falls back to the map, which is where they were going.
 */
export function returnUrl(search: string = location.search): string {
  const raw = new URLSearchParams(search).get("return");
  if (!raw) return DEFAULT_RETURN_URL;
  try {
    // Resolved against this page first, so a host may pass a bare path.
    const absolute = new URL(raw, location.href).toString();
    return isReturnUrlAllowed(absolute) ? absolute : DEFAULT_RETURN_URL;
  } catch {
    return DEFAULT_RETURN_URL;
  }
}
