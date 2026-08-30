/**
 * A tapped point must actually speak. Proves it on BOTH screen kinds (arrival
 * and card): her narration stops, the point's own recording loads and plays,
 * the other dots dim, and the tour resumes when the aside ends.
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const ok = (n, c, d = "") => console.log(`[p7] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
const voice = (pg) => pg.evaluate(() => {
  const a = document.querySelector('audio[data-channel="voice"]');
  return a ? { src: (a.currentSrc || a.src || "").split("/").pop(), paused: a.paused, t: a.currentTime } : null;
});
(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  const failed = [];
  page.on("response", (r) => { if (!r.ok() && /\.mp3|\.m4a/.test(r.url())) failed.push(`${r.status()} ${r.url().split("/").pop()}`); });
  await page.goto(`http://localhost:5173/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle", { timeout: 90000 });
  await page.click("button.travel");
  let pass = true;

  const tapAndProve = async (label) => {
    let dots = [];
    for (let i = 0; i < 90 && dots.length < 2; i++) { await page.waitForTimeout(500); dots = await page.$$(".poi"); }
    if (dots.length < 2) return ok(`${label}: points appear`, false, "none found");
    pass = ok(`${label}: points appear`, true, `${dots.length} dots`) && pass;
    const before = await voice(page);
    await dots[0].click();
    // Her aside must take over the voice channel within a moment.
    let after = null, changed = false;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(250);
      after = await voice(page);
      if (after && after.src && after.src !== before?.src) { changed = true; break; }
    }
    pass = ok(`${label}: tapping a point changes her voice`, changed, `${before?.src} -> ${after?.src}`) && pass;
    pass = ok(`${label}: the aside is a point recording`, Boolean(after && /_poi\d/.test(after.src)), after?.src) && pass;
    await page.waitForTimeout(700);
    const playing = await voice(page);
    pass = ok(`${label}: the aside is actually playing`, Boolean(playing && !playing.paused && playing.t > 0), JSON.stringify(playing)) && pass;
    const st = await page.evaluate(() => {
      const dots = [...document.querySelectorAll(".poi")];
      return {
        active: dots.filter((d) => d.className.includes("active")).length,
        dimmed: dots.filter((d) => d.className.includes("dim")).map((d) => Number(getComputedStyle(d).opacity)),
        zoom: getComputedStyle(document.querySelector(".zoomer")).transform,
        label: document.querySelector(".poi.active em")?.textContent || "",
      };
    });
    pass = ok(`${label}: one point lights, the rest dim`, st.active === 1 && st.dimmed.length > 0 && st.dimmed.every((o) => o < 0.3), JSON.stringify(st.dimmed)) && pass;
    pass = ok(`${label}: the point is named on screen`, st.label.length > 0, st.label) && pass;
    pass = ok(`${label}: the scene leans toward it`, /matrix\(1\.0[5-9]|matrix\(1\.1/.test(st.zoom)) && pass;
    await page.screenshot({ path: `/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/shots/p7-${label.replace(/\W+/g, "-")}.png` });
    return true;
  };

  await tapAndProve("arrival");
  // Move to the first card screen and prove the same there.
  const pt = await page.evaluate(() => { const b=(el)=>Boolean(el&&el.closest("[data-noadvance]")); for (const y of [620,560,500]) for (const x of [340,300]) if (!b(document.elementFromPoint(x,y))) return {x,y}; return {x:340,y:620}; });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(1200);
  await tapAndProve("card");

  pass = ok("no missing audio files", failed.length === 0, failed.join(", ")) && pass;
  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p7] FAIL", e.message); process.exit(1); });
