const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const ok = (n, c, d = "") => console.log(`[p6] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  await page.goto("http://localhost:5173/?tour=tour_london_1850_flower_seller&play=1", { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle");
  await page.click("button.travel");
  await page.waitForTimeout(2000);
  let pass = true;
  const vid = () => page.evaluate(() => { const v = document.querySelector("video.bg.seamless"); return v ? { paused: v.paused, t: v.currentTime, opacity: getComputedStyle(v).opacity } : null; });
  const v0 = await vid();
  pass = ok("living scene playing on arrival", Boolean(v0 && !v0.paused), JSON.stringify(v0)) && pass;
  // Pause freezes the background scene too.
  await page.click(".side-ctl >> nth=0");
  await page.waitForTimeout(350);
  const v1 = await vid();
  pass = ok("pause freezes the background video", Boolean(v1 && v1.paused)) && pass;
  await page.click(".side-ctl >> nth=0");
  await page.waitForTimeout(350);
  const v2 = await vid();
  pass = ok("resume restarts the background video", Boolean(v2 && !v2.paused)) && pass;
  // Play once: at the end the scene rests as a still, never wrapping.
  await page.evaluate(() => { const v = document.querySelector("video.bg.seamless"); v.currentTime = v.duration - 0.2; });
  await page.waitForTimeout(1500);
  const endState = await page.evaluate(() => { const v = document.querySelector("video.bg.seamless"); return { ended: v.ended, t: v.currentTime, d: v.duration }; });
  pass = ok("scene plays once and rests at its last frame", endState.ended && Math.abs(endState.t - endState.d) < 0.3, JSON.stringify(endState)) && pass;
  await page.waitForTimeout(1500);
  const stillState = await page.evaluate(() => { const v = document.querySelector("video.bg.seamless"); return { ended: v.ended, t: v.currentTime }; });
  pass = ok("no restart after resting", stillState.ended && Math.abs(stillState.t - endState.t) < 0.05, JSON.stringify(stillState)) && pass;

  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p6] FAIL", e.message); process.exit(1); });
