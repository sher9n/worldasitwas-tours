/**
 * One picture for the post about tapping the scene.
 *
 *   node tools/socials/shot-hotspots.cjs <tour_id> [stop_id] [seconds]
 *
 * shots.cjs grabs each walk eight seconds in, which is before the tap points
 * have finished appearing (the player reveals them once the scene is 62% told).
 * This waits longer on purpose, so the dots are actually in the frame, and
 * captures at 4:5 because the picture is going into a feed.
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const OUT = "/Applications/MAMP/htdocs/timetravel/content/work/socials/shots";
const tour = process.argv[2];
// The player gates on taps, so it will not walk itself to a later stop: start
// there instead. Without this the only scene you can ever photograph is the
// first one, which is also the scene the walk's own post already uses.
const stop = process.argv[3] && process.argv[3] !== "-" ? process.argv[3] : "";
const dwell = Number(process.argv[4] || 26) * 1000;
(async () => {
  const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const ctx = await b.newContext({ viewport: { width: 400, height: 500 }, deviceScaleFactor: 3, hasTouch: true });
  const p = await ctx.newPage();
  const url = `http://localhost:5173/?tour=${tour}&play=1${stop ? `&stop=${stop}` : ""}`;
  await p.goto(url, { waitUntil: "networkidle", timeout: 120000 });
  await p.waitForSelector(".player .idle", { timeout: 120000 });
  await p.waitForTimeout(1200);
  await p.click("button.travel");
  await p.waitForSelector(".voice-circle", { timeout: 60000 });
  await p.waitForTimeout(dwell);
  const dots = await p.locator(".poi").count();
  await p.screenshot({ path: `${OUT}/${tour}-hotspots.png` });
  console.log(`ok ${tour} hotspots, ${dots} tap point(s) on screen`);
  await b.close();
})();
