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
  // Every scene in the tour is a still that drifts: no video ever sits behind the story.
  pass = ok("arrival is a still (no video)", !(await page.$(".slide video.bg"))) && pass;
  const drift = () => page.evaluate(() => {
    const el = document.querySelector(".slide img.bg");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { name: cs.animationName, state: cs.animationPlayState, fill: cs.animationFillMode, iter: cs.animationIterationCount, transform: cs.transform };
  });
  const d0 = await drift();
  pass = ok("arrival still drifts (parallax running)", Boolean(d0 && /kb-/.test(d0.name) && d0.state === "running"), JSON.stringify(d0)) && pass;
  pass = ok("drift runs once and holds its last frame", Boolean(d0 && d0.iter === "1" && d0.fill === "forwards")) && pass;
  // Move on: the next screen is a still too, and it drifts the other way.
  const pt = await page.evaluate(() => { const b=(el)=>Boolean(el&&el.closest("[data-noadvance]")); for (const y of [620,560,500]) for (const x of [340,300]) if (!b(document.elementFromPoint(x,y))) return {x,y}; return {x:340,y:620}; });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(1200);
  const d1 = await drift();
  pass = ok("next screen is a drifting still", Boolean(d1 && /kb-/.test(d1.name) && d1.state === "running"), JSON.stringify(d1)) && pass;
  pass = ok("neighbouring screens drift in opposite directions", Boolean(d0 && d1 && d0.name !== d1.name), `${d0?.name} then ${d1?.name}`) && pass;
  // The image actually moves: sample the transform twice.
  const t0 = (await drift()).transform;
  await page.waitForTimeout(900);
  const t1 = (await drift()).transform;
  pass = ok("the scene visibly moves", t0 !== t1, `${t0} -> ${t1}`) && pass;
  // Pause stops the drift dead, resume continues it.
  await page.click(".side-ctl >> nth=0");
  await page.waitForTimeout(350);
  const dp = await drift();
  pass = ok("pause freezes the drift", dp.state === "paused", dp.state) && pass;
  const p0 = dp.transform;
  await page.waitForTimeout(900);
  const p1 = (await drift()).transform;
  pass = ok("nothing moves while paused", p0 === p1) && pass;
  await page.click(".side-ctl >> nth=0");
  await page.waitForTimeout(400);
  const dr = await drift();
  pass = ok("resume continues the drift", dr.state === "running", dr.state) && pass;
  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p6] FAIL", e.message); process.exit(1); });
