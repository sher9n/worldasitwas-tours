const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const ok = (n, c, d = "") => console.log(`[p3] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  await page.goto(`http://localhost:5173/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle", { timeout: 90000 });
  await page.click("button.travel");
  await page.waitForTimeout(2500);
  let pass = true;
  const amb = () => page.evaluate(() => { const a = document.querySelector('audio[data-channel="ambience"]'); return a ? { paused: a.paused, t: a.currentTime, d: a.duration } : null; });
  const a0 = await amb();
  pass = ok("ambience playing on arrival", Boolean(a0 && !a0.paused), JSON.stringify(a0)) && pass;
  // Seek to just before the end: first ended -> should replay from the top.
  await page.evaluate(() => { const a = document.querySelector('audio[data-channel="ambience"]'); a.currentTime = a.duration - 0.25; });
  await page.waitForTimeout(1200);
  const a1 = await amb();
  pass = ok("first end replays the bed", Boolean(a1 && !a1.paused && a1.t < 3), JSON.stringify(a1)) && pass;
  // Second end: the bed rests.
  await page.evaluate(() => { const a = document.querySelector('audio[data-channel="ambience"]'); a.currentTime = a.duration - 0.25; });
  await page.waitForTimeout(1200);
  const a2 = await amb();
  pass = ok("second end rests in silence", Boolean(a2 && a2.paused), JSON.stringify(a2)) && pass;
  // Beat changes on the same stop must not resurrect it.
  await page.mouse.click(340, 620);
  await page.waitForTimeout(1500);
  const a3 = await amb();
  pass = ok("finished bed stays finished within the stop", Boolean(a3 && a3.paused)) && pass;
  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p3] FAIL", e.message); process.exit(1); });
