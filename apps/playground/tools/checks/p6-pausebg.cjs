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
  // Loop seam: near the end the video dissolves to its first-frame still, then back.
  await page.evaluate(() => { const v = document.querySelector("video.bg.seamless"); v.currentTime = v.duration - 0.65; });
  let minOpacity = 1;
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(80); const s2 = await vid(); if (s2) minOpacity = Math.min(minOpacity, Number(s2.opacity)); }
  pass = ok("seam dissolves out near the end", minOpacity < 0.35, `min opacity ${minOpacity.toFixed(2)}`) && pass;
  await page.waitForTimeout(1200);
  const wrapped = await vid();
  pass = ok("dissolves back in after the wrap", wrapped && !wrapped.paused && Number(wrapped.opacity) > 0.7, JSON.stringify(wrapped)) && pass;
  const still = await page.$eval(".zoomer img.bg", (el) => Boolean(el));
  pass = ok("first-frame still sits beneath the video", still) && pass;
  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p6] FAIL", e.message); process.exit(1); });
