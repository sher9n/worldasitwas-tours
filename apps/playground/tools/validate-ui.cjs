/* Walks the tour in a real browser and validates the promised UI against the pixels.
   Screenshots land in tmp/shots/v-*.png; the checklist prints PASS/FAIL lines. */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const S = "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/shots";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " · " + detail : ""}`); };
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));

  // Tap somewhere that advances: the right zone, never on a point of interest or control.
  const neutralTap = async () => {
    const pt = await page.evaluate(() => {
      const blocked = (el) => Boolean(el && (el.closest("[data-noadvance]")));
      for (const y of [620, 560, 500, 680, 300]) {
        for (const x of [340, 300, 360, 260]) {
          if (!blocked(document.elementFromPoint(x, y))) return { x, y };
        }
      }
      return { x: 340, y: 620 };
    });
    await page.mouse.click(pt.x, pt.y);
  };
  await page.goto("http://localhost:5173/?tour=tour_london_1850_flower_seller&play=1", { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle");
  await page.screenshot({ path: `${S}/v-00-cover.png` });
  await page.click("button.travel");
  await page.waitForSelector(".titlecard", { timeout: 8000 });
  await page.waitForTimeout(1600);

  // Arrival: title card, talking circle while she speaks, no badge, no caption text
  await page.screenshot({ path: `${S}/v-01-arrival.png` });
  const vc = await page.$eval(".voice-circle video", (v) => ({ playing: !v.paused, t: v.currentTime })).catch(() => null);
  check("talking circle visible and playing during arrival line", Boolean(vc && vc.playing && vc.t > 0), JSON.stringify(vc));
  check("no RECONSTRUCTION badge", !(await page.$(".badge")));
  check("no caption text block", !(await page.$(".caption")));
  check("stop title card shown", Boolean(await page.$(".titlecard")));

  // Bottom row geometry: ask centered, side controls symmetric and equal
  const geo = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const ask = r(document.querySelector(".ask"));
    const sides = [...document.querySelectorAll(".side-ctl")].map(r);
    return { screenW: innerWidth, askCx: ask.left + ask.width / 2, sides: sides.map((s) => ({ w: s.width, h: s.height, left: s.left, right: innerWidth - s.right })) };
  });
  check("hold-to-ask dead centre", Math.abs(geo.askCx - geo.screenW / 2) < 3, `offset ${(geo.askCx - geo.screenW / 2).toFixed(1)}px`);
  check("side controls equal size", geo.sides.length === 2 && Math.abs(geo.sides[0].w - geo.sides[1].w) < 1 && Math.abs(geo.sides[0].h - geo.sides[1].h) < 1);
  check("side controls symmetric margins", Math.abs(geo.sides[0].left - geo.sides[1].right) < 2, `${geo.sides[0].left.toFixed(0)} vs ${geo.sides[1].right.toFixed(0)}`);
  check("exactly three bottom controls", (await page.$$(".hud-bottom > *")).length === 3);
  check("no CC or sources buttons", !(await page.$(".round")) );

  // Card 1: dots present; tap one -> label + voice circle stays; screenshot
  await neutralTap();
  await page.waitForTimeout(1200);
  const dots1 = await page.$$(".poi");
  check("points of interest on card 1", dots1.length >= 2, `${dots1.length} dots`);
  await page.screenshot({ path: `${S}/v-02-card1-dots.png` });
  if (dots1.length) {
    await dots1[0].click();
    await page.waitForTimeout(1000);
    check("tapped point shows label", Boolean(await page.$(".poi.active em")));
    const vc2 = await page.$eval(".voice-circle video", (v) => !v.paused).catch(() => false);
    check("talking circle during point line", vc2);
    await page.screenshot({ path: `${S}/v-03-poi-active.png` });
    await page.waitForTimeout(400);
  }

  // Next screen: the then-image, should also carry dots now
  await neutralTap();
  await page.waitForTimeout(1200);
  const dots2 = await page.$$(".poi");
  check("points of interest on then-image screen", dots2.length >= 2, `${dots2.length} dots`);
  await page.screenshot({ path: `${S}/v-04-thenimage.png` });

  // Pause control toggles
  await page.click(".side-ctl >> nth=0");
  await page.waitForTimeout(300);
  check("pause toggles to resume glyph", (await page.$eval(".side-ctl >> nth=0", (b) => b.textContent.trim())) === "▶");
  await page.click(".side-ctl >> nth=0");

  // Walk screen appears at stop boundary (one tap from the last card of stop 1)
  await neutralTap(); await page.waitForTimeout(700);
  const onWalk = Boolean(await page.$(".walk"));
  check("walk screen at stop boundary", onWalk);
  if (onWalk) await page.screenshot({ path: `${S}/v-05-walk.png` });

  check("no page errors", errors.length === 0, errors.join(" | "));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`[validate-ui] ${results.length - failed}/${results.length} checks passed`);
  await browser.close();
  if (failed) process.exit(1);
})().catch((e) => { console.error("[validate-ui] FAILED", e.message); process.exit(1); });
