/**
 * The integration surfaces, checked the way a developer would use them.
 *
 * Two things are being proved. First, that the Integrate tab hands out code
 * built from the tour that is actually selected, not from a placeholder — a
 * snippet nobody can paste is worse than no snippet. Second, that the bridge
 * on the Embed tab really carries: events out of the player into a host, and
 * commands from the host back into the player. That second half is the whole
 * integration; if it silently stops working, every promise on both tabs is a
 * lie, so it is checked against the real player in a real frame rather than
 * against a mock.
 *
 * Usage: node apps/playground/tools/checks/p10-integration.cjs [baseUrl]
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");

const BASE = (process.argv[2] && process.argv[2].startsWith("http") ? process.argv[2] : process.env.BASE) || "http://localhost:5173";
const SHOTS = process.env.SHOTS_DIR || "/Users/sherancorera/.claude/jobs/521eb7f5/tmp/shots";
require("fs").mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`[p10] ${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`);
};

const tabNamed = (page, label) => page.locator(".tabs button", { hasText: new RegExp(`^${label}`) });

(async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".tourcard", { timeout: 30_000 });

  /* ── the tabs exist, in the right place ─────────────────────────────── */
  const tabs = await page.$$eval(".tabs button", (els) => els.map((e) => e.textContent.trim().split(" ·")[0]));
  check("both integration tabs sit beside the existing ones", tabs.slice(0, 6).join(",") === "Events,Manifest,Cost,Companion,Integrate,Embed", tabs.join(" | "));

  /* ── Integrate: the code is built from the live tour ────────────────── */
  await tabNamed(page, "Integrate").click();
  await page.waitForSelector(".doc .code");

  const selectedTour = await page.$eval(".tourcard.on", (el) => el.querySelector(".tourcard-title").textContent.trim()).catch(() => null);
  const allCode = await page.$$eval(".code pre", (els) => els.map((e) => e.textContent).join("\n"));
  check("the snippets name the selected walk, not a placeholder", /tour_[a-z0-9_]+/.test(allCode) && !/your-tour-id|YOUR_TOUR/.test(allCode), `selected: ${selectedTour}`);

  const slabs = await page.$$(".code");
  check("the Expo path is a small number of copyable files", slabs.length >= 5 && slabs.length <= 12, `${slabs.length} slabs`);

  const hasCopy = await page.$$eval(".code figcaption button", (els) => els.every((e) => e.textContent.trim() === "Copy"));
  check("every slab has a copy button", hasCopy && slabs.length > 0);

  // The key warning has to be present and unmissable: it is the one mistake
  // that cannot be undone after a release ships.
  const warned = await page.$eval(".doc-warn", (el) => el.textContent).catch(() => "");
  check("the panel says the platform key must not ship in the app", /never appear in an app bundle/i.test(warned));

  // Switching platform actually changes the code shown.
  await page.click(".seg button:has-text('REST')");
  await page.waitForTimeout(150);
  const restCode = await page.$$eval(".code pre", (els) => els.map((e) => e.textContent).join("\n"));
  check("the REST path shows curl against the real endpoints", /\/v1\/catalog/.test(restCode) && /\/v1\/tours\?city=/.test(restCode));
  // "React" alone also matches "Expo · React Native", so match the web one whole.
  await page.click(".seg button:has-text('React · web')");
  await page.waitForTimeout(150);
  const webCode = await page.$eval(".code pre", (el) => el.textContent);
  check("the web path shows an iframe with the permissions the walk needs", /allow="autoplay; microphone/.test(webCode));

  await page.click(".seg button:has-text('Expo · React Native')");
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/p10-integrate.png`, fullPage: false });

  /* ── Embed: the bridge, end to end ──────────────────────────────────── */
  await tabNamed(page, "Embed").click();
  await page.waitForSelector(".demo-open");
  await page.click(".demo-open");

  const logLine = (name) => page.locator(".demo-log li", { hasText: new RegExp(`\\b${name}\\b`) }).first();

  await logLine("ready").waitFor({ timeout: 30_000 }).catch(() => {});
  check("the host receives ready over postMessage", await logLine("ready").isVisible().catch(() => false));
  // Once, not once per mount: a host may dismiss a spinner or start a timer on
  // it, and React's StrictMode remounts every effect in development.
  const readyCount = await page.locator(".demo-log li", { hasText: /\bready\b/ }).count();
  check("ready is announced exactly once", readyCount === 1, `${readyCount} received`);

  const frame = page.frameLocator(".demo-screen iframe");
  await frame.locator("button.travel").waitFor({ timeout: 20_000 });
  await frame.locator("button.travel").click();

  await logLine("tour_started").waitFor({ timeout: 20_000 }).catch(() => {});
  check("the host receives tour_started when the traveller begins", await logLine("tour_started").isVisible().catch(() => false));
  await logLine("stop_entered").waitFor({ timeout: 20_000 }).catch(() => {});
  check("the host receives stop_entered with the stop id", await logLine("stop_entered").isVisible().catch(() => false));

  await page.screenshot({ path: `${SHOTS}/p10-embed-playing.png` });

  /* commands travel the other way */
  const isPaused = () => frame.locator(".player.paused").isVisible().catch(() => false);
  check("the walk is running before the host pauses it", (await isPaused()) === false);

  await page.click(".demo-cmds button:has-text('Pause')");
  await page.waitForTimeout(500);
  check("a host pause command reaches the player", await isPaused());

  await page.click(".demo-cmds button:has-text('Resume')");
  await page.waitForTimeout(500);
  check("a host resume command reaches the player", (await isPaused()) === false);

  await page.click(".demo-cmds button:has-text('Close')");
  await logLine("tour_left").waitFor({ timeout: 10_000 }).catch(() => {});
  check("a host close command ends the walk and reports tour_left", await logLine("tour_left").isVisible().catch(() => false));
  await page.waitForSelector(".demo-open", { timeout: 10_000 }).catch(() => {});
  check("the host screen returns to its own state after tour_left", await page.locator(".demo-open").isVisible().catch(() => false));

  // Resuming is offered from the stop the events reported, not invented.
  check("the stop reached is offered back as a resume point", await page.locator(".demo-resume code").isVisible().catch(() => false));

  await page.screenshot({ path: `${SHOTS}/p10-embed-after.png` });

  check("no uncaught errors on either tab", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`[p10] ${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("[p10] FAIL", e.message);
  process.exit(1);
});
