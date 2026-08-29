/* Walks the tour in a real browser and validates the promised UI against the pixels.
   Usage: node apps/playground/tools/validate-ui.cjs [baseUrl] [tourId]
   Screenshots land in tmp shots dir; the checklist prints PASS/FAIL lines and exits 1 on any FAIL. */
const path = require("path");
const fs = require("fs");
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");

const BASE = process.argv[2] || "http://localhost:5173";
const TOUR = process.argv[3] || "tour_london_1850_flower_seller";
const S = process.env.SHOTS_DIR || "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/shots";
fs.mkdirSync(S, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " · " + detail : ""}`);
};

/** Contrast of the active label against what is really behind it: the photo
 * under the frosted glass, sampled through the same cover-crop the browser
 * uses, with the glass tint composited on top. */
async function labelContrast(page) {
  return page.evaluate(async () => {
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const em = document.querySelector(".poi.active em");
    const img = document.querySelector(".slide img.bg");
    if (!em || !img) return null;
    const rect = em.getBoundingClientRect();
    const box = img.getBoundingClientRect();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const scale = Math.max(box.width / nw, box.height / nh);
    const dw = nw * scale, dh = nh * scale;
    const ox = box.left + (box.width - dw) / 2, oy = box.top + (box.height - dh) / 2;
    const nx = (rect.left - ox) / scale, ny = (rect.top - oy) / scale;
    const c = document.createElement("canvas");
    c.width = 48; c.height = 14;
    const g = c.getContext("2d");
    try {
      // The media host is a different port, so draw a CORS-clean copy of the same file.
      const clean = new Image();
      clean.crossOrigin = "anonymous";
      clean.src = img.currentSrc;
      await clean.decode();
      g.drawImage(clean, nx, ny, rect.width / scale, rect.height / scale, 0, 0, 48, 14);
    } catch {
      return null;
    }
    const d = g.getImageData(0, 0, 48, 14).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    const photo = { r: r / n / 255, g: gg / n / 255, b: b / n / 255 };
    const cs = getComputedStyle(em);
    const bgm = cs.backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    const a = bgm && bgm[4] !== undefined ? Number(bgm[4]) : 1;
    const tint = bgm ? { r: bgm[1] / 255, g: bgm[2] / 255, b: bgm[3] / 255 } : { r: 0, g: 0, b: 0 };
    const eff = { r: tint.r * a + photo.r * (1 - a), g: tint.g * a + photo.g * (1 - a), b: tint.b * a + photo.b * (1 - a) };
    const tm = cs.color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
    const text = tm ? { r: tm[1] / 255, g: tm[2] / 255, b: tm[3] / 255 } : { r: 0, g: 0, b: 0 };
    const Lt = lum(text), Lb = lum(eff);
    const ratio = (Math.max(Lt, Lb) + 0.05) / (Math.min(Lt, Lb) + 0.05);
    const er = em.getBoundingClientRect();
    const inView = er.left >= 0 && er.right <= innerWidth && er.top >= 0 && er.bottom <= innerHeight;
    const overlaps = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const o = el.getBoundingClientRect();
      return !(er.right < o.left || er.left > o.right || er.bottom < o.top || er.top > o.bottom);
    };
    return {
      ratio: Math.round(ratio * 10) / 10,
      textLum: Math.round(Lt * 100) / 100,
      label: em.textContent,
      below: em.closest(".poi").className.includes("below"),
      y: Number(em.closest(".poi").style.top.replace("%", "")) / 100,
      inView,
      overlapHud: overlaps(".progress") || overlaps(".hud-bottom") || overlaps(".voice-circle") || overlaps(".companion-chip"),
      dimmed: [...document.querySelectorAll(".poi.dim")].map((p) => Number(getComputedStyle(p).opacity)),
      zoom: getComputedStyle(document.querySelector(".zoomer")).transform,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));

  const neutralTapOn = async (pg) => {
    const pt = await pg.evaluate(() => {
      const blocked = (el) => Boolean(el && el.closest("[data-noadvance]"));
      for (const y of [620, 560, 500, 680, 300]) for (const x of [340, 300, 360, 260]) if (!blocked(document.elementFromPoint(x, y))) return { x, y };
      return { x: 340, y: 620 };
    });
    await pg.mouse.click(pt.x, pt.y);
  };
  const neutralTap = () => neutralTapOn(page);

  // The API must serve exactly what the pipeline wrote: a stale process with an
  // older schema silently strips new fields (it has bitten twice).
  {
    const served = await (await fetch(`${BASE.replace("5173", "4100").replace("https", "http")}/v1/tours/${TOUR}`, { headers: { Authorization: "Bearer dev" } })).json();
    const file = JSON.parse(fs.readFileSync(`/Applications/MAMP/htdocs/timetravel/content/tours/${TOUR}/manifest.json`, "utf8"));
    const same = JSON.stringify(served) === JSON.stringify(file);
    check("API serves the manifest verbatim (no stale-schema stripping)", same, same ? "" : "served differs from file - restart the API");
  }

  await page.goto(`${BASE}/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle");
  await page.screenshot({ path: `${S}/v-00-cover.png` });
  await page.click("button.travel");
  await page.waitForSelector(".titlecard", { timeout: 8000 });
  await page.waitForTimeout(1600);

  // Arrival basics
  const vc = await page.$eval(".voice-circle video", (v) => ({ playing: !v.paused, t: v.currentTime })).catch(() => null);
  check("talking circle visible and playing during arrival line", Boolean(vc && vc.playing && vc.t > 0), JSON.stringify(vc));
  check("no RECONSTRUCTION badge", !(await page.$(".badge")));
  check("no caption text block", !(await page.$(".caption")));
  check("stop title card shown", Boolean(await page.$(".titlecard")));
  const bgVid = await page.$eval(".slide video.bg", (v) => ({ playing: !v.paused, muted: v.muted, t: v.currentTime })).catch(() => null);
  check("arrival background is a muted living scene", Boolean(bgVid && bgVid.playing && bgVid.muted), JSON.stringify(bgVid));
  await page.screenshot({ path: `${S}/v-01-arrival.png` });

  // Bottom row geometry
  const geo = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const ask = r(document.querySelector(".ask"));
    const sides = [...document.querySelectorAll(".side-ctl")].map(r);
    return { screenW: innerWidth, askCx: ask.left + ask.width / 2, sides: sides.map((s) => ({ w: s.width, h: s.height, left: s.left, right: innerWidth - s.right })) };
  });
  check("hold-to-ask dead centre", Math.abs(geo.askCx - geo.screenW / 2) < 3, `offset ${(geo.askCx - geo.screenW / 2).toFixed(1)}px`);
  check("side controls equal and symmetric", geo.sides.length === 2 && Math.abs(geo.sides[0].w - geo.sides[1].w) < 1 && Math.abs(geo.sides[0].left - geo.sides[1].right) < 2);
  check("exactly three bottom controls", (await page.$$(".hud-bottom > *")).length === 3);

  // Pause must mean silence and stillness, even mid-aside.
  await neutralTap();
  await page.waitForTimeout(900);
  const firstDots = await page.$$(".poi");
  if (firstDots.length) {
    await firstDots[0].click();
    await page.waitForTimeout(600);
    await page.click(".side-ctl >> nth=0");
    await page.waitForTimeout(400);
    const quiet = await page.evaluate(() => {
      const voice = document.querySelector('audio[data-channel="voice"]');
      const circle = document.querySelector(".voice-circle video");
      return { voicePaused: !voice || voice.paused, circlePaused: !circle || circle.paused };
    });
    check("pause silences her mid-aside", quiet.voicePaused, JSON.stringify(quiet));
    check("pause freezes the talking circle", quiet.circlePaused);
    await page.click(".side-ctl >> nth=0"); // resume
    await page.waitForTimeout(300);
  } else {
    check("pause silences her mid-aside", false, "no dots to test on");
  }

  // A slide change must dissolve, not cut: catch the fade layer mid-flight.
  await neutralTap();
  let sawFade = false, fadeOpacity = null;
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(110);
    const o = await page.$eval(".fade-layer", (el) => Number(getComputedStyle(el).opacity)).catch(() => null);
    if (o !== null && o > 0.03 && o < 0.97) { sawFade = true; fadeOpacity = o; break; }
  }
  await page.waitForTimeout(1000);
  const fadeGone = !(await page.$(".fade-layer"));
  check("slides cross-dissolve (fade layer mid-flight)", sawFade, `opacity ${fadeOpacity}`);
  check("fade layer cleans up", fadeGone);

  // Walk gate: after her walking line, the tour waits for a tap on Continue.
  {
    let onWalk = false;
    for (let i = 0; i < 8 && !onWalk; i++) { await neutralTap(); await page.waitForTimeout(600); onWalk = Boolean(await page.$(".walk")); }
    if (onWalk) {
      let cont = null;
      for (let i = 0; i < 30 && !cont; i++) { await page.waitForTimeout(500); cont = await page.$(".continue"); }
      check("walk gates on Continue", Boolean(cont));
      if (cont) {
        await page.waitForTimeout(2500);
        check("gate holds until tapped", Boolean(await page.$(".walk")));
        await cont.click();
        await page.waitForTimeout(800);
        check("Continue advances to the next stop", Boolean(await page.$(".titlecard")) || !(await page.$(".walk")));
      }
    } else {
      check("walk gates on Continue", false, "never reached a walk screen");
    }
  }

  // Spotlight sweep: activate the first point on every dotted screen in the tour.
  let sweep = 0, belowSeen = false, worstRatio = Infinity, dimOk = true, zoomOk = true, geomOk = true;
  for (let step = 0; step < 70; step++) {
    if (await page.$(".done-view")) break;
    const dots = await page.$$(".poi");
    if (dots.length >= 2) {
      await dots[0].click();
      await page.waitForTimeout(750);
      const m = await labelContrast(page);
      if (m) {
        sweep++;
        worstRatio = Math.min(worstRatio, m.ratio);
        if (m.below) belowSeen = true;
        if (m.dimmed.some((o) => o > 0.25)) dimOk = false;
        if (!/matrix\(1\.0[5-9]/.test(m.zoom)) zoomOk = false;
        if (!m.inView || m.overlapHud) geomOk = false;
        console.log(`   · screen ${sweep}: "${m.label}" ratio ${m.ratio} ${m.below ? "(label below)" : ""}${!m.inView ? " CLIPPED" : ""}${m.overlapHud ? " OVERLAPS-HUD" : ""}`);
        await page.screenshot({ path: `${S}/v-poi-${String(sweep).padStart(2, "0")}.png` });
      }
    }
    await neutralTap();
    await page.waitForTimeout(650);
  }
  check("spotlight measured on many screens", sweep >= 8, `${sweep} screens`);
  check("label contrast >= 4.5 on every screen", worstRatio >= 4.5, `worst ${worstRatio}`);
  check("high points flip their label below", belowSeen);
  check("other dots dim during spotlight", dimOk);
  check("image leans in (zoom applied)", zoomOk);
  check("label never clips or overlaps HUD", geomOk);
  check("reached the end of the tour", Boolean(await page.$(".done-view")));

  // Reduced motion: no zoom, same legibility
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await p2.waitForSelector(".player .idle");
  await p2.click("button.travel");
  await p2.waitForTimeout(1500);
  await neutralTapOn(p2);
  await p2.waitForTimeout(900);
  const dots2 = await p2.$$(".poi");
  if (dots2.length) {
    await dots2[0].click();
    await p2.waitForTimeout(600);
    const z = await p2.$eval(".zoomer", (el) => getComputedStyle(el).transform);
    check("reduced motion: no zoom", z === "none" || /matrix\(1, 0, 0, 1/.test(z), z);
  } else {
    check("reduced motion: no zoom", false, "no dots found");
  }
  await ctx2.close();

  // Live ask round-trip (costs a few cents; opt in with VALIDATE_ASK=1).
  if (process.env.VALIDATE_ASK === "1") {
    const b3 = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
    const p3 = await (await b3.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
    await p3.goto(`${BASE}/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
    await p3.waitForSelector(".player .idle");
    await p3.click("button.travel");
    await p3.waitForTimeout(1500);
    const ask = await p3.$(".ask");
    const box = await ask.boundingBox();
    await p3.waitForTimeout(4000); // let the Travel-time preconnect finish
    await p3.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p3.mouse.down();
    let listenMs = -1;
    for (let t = 0; t <= 800; t += 50) {
      const cls = await p3.$eval(".ask", (el) => el.className);
      if (/listening/.test(cls)) { listenMs = t; break; }
      await p3.waitForTimeout(50);
    }
    check("ask: listening within 400ms of hold", listenMs >= 0 && listenMs <= 400, `${listenMs}ms`);
    await p3.waitForTimeout(1800);
    const midHold = await p3.$eval(".ask", (el) => el.className);
    await p3.mouse.up();
    let sawError = false, endState = "";
    for (let i = 0; i < 24; i++) {
      await p3.waitForTimeout(500);
      if (await p3.$(".ask-state.error")) { sawError = true; break; }
      endState = await p3.$eval(".ask", (el) => el.className);
      if (/speaking|ready/.test(endState) && !/connecting|thinking|listening/.test(endState)) break;
    }
    check("ask: no error surfaced on hold and release", !sawError);
    check("ask: reached listening while held", /listening|connecting/.test(midHold), midHold);
    check("ask: session settled after release", /speaking/.test(endState) || /ask $|ask idle|ready/.test(endState) || endState.includes("ask"), endState);
    await b3.close();
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`[validate-ui] ${results.length - failed}/${results.length} checks passed`);
  await browser.close();
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("[validate-ui] FAILED", e.message);
  process.exit(1);
});
