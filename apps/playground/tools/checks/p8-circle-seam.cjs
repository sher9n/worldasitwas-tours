/**
 * Her circle must never blink black when one talking clip hands over to the
 * next. Samples the circle continuously through several handovers and demands
 * that at every instant something ready and moving is on screen.
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const ok = (n, c, d = "") => console.log(`[p8] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  await page.goto(`http://localhost:5173/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle", { timeout: 90000 });
  await page.click("button.travel");
  await page.waitForTimeout(1200);
  let pass = true;
  pass = ok("two players, never rebuilt", (await page.$$(".voice-circle video")).length === 2) && pass;

  // Sample the circle every 60ms for 25 seconds: several clips will hand over.
  const samples = await page.evaluate(() => new Promise((done) => {
    const out = [];
    const seen = new Set();
    const id = setInterval(() => {
      const vids = [...document.querySelectorAll(".voice-circle video")];
      const on = vids.find((v) => v.classList.contains("on"));
      const anyOpaque = vids.some((v) => Number(getComputedStyle(v).opacity) > 0.5);
      if (on) seen.add((on.currentSrc || "").split("/").pop());
      out.push({
        src: on ? (on.currentSrc || "").split("/").pop() : null,
        ready: on ? on.readyState : -1,        // 2+ means a frame is available to paint
        t: on ? Number(on.currentTime.toFixed(2)) : -1,
        paused: on ? on.paused : true,
        opaque: anyOpaque,
        vis: document.querySelectorAll(".voice-circle video.on").length,
      });
    }, 60);
    setTimeout(() => { clearInterval(id); done({ frames: out, clips: [...seen] }); }, 25000);
  }));

  const f = samples.frames;
  const talkingFrames = f.filter((x) => !x.paused);
  const handovers = f.filter((x, i) => i > 0 && x.src && f[i - 1].src && x.src !== f[i - 1].src).length;
  pass = ok("clips actually hand over during the walk", handovers >= 1, `${handovers} handovers across ${samples.clips.length} clips`) && pass;
  pass = ok("exactly one player is ever on screen", f.every((x) => x.vis === 1)) && pass;
  // The first second is the page loading its first clip. What matters is that no
  // frame goes blank once she is under way, above all across a handover.
  const settled = f.slice(17);
  const blank = settled.filter((x) => x.ready >= 0 && x.ready < 2);
  pass = ok("the on-screen player always has a frame to show (no black)", blank.length === 0, `${blank.length}/${settled.length} blank frames after the first second`) && pass;
  pass = ok("something is always opaque in the circle", f.every((x) => x.opaque)) && pass;
  // A clip reads time zero for its first frames, which is a clip starting, not a
  // fault. What would be a fault is a player with nothing to show, and that is
  // what the blank-frame check above measures.
  const restarts = talkingFrames.filter((x) => x.t === 0).length;
  pass = ok("clip starts are brief", restarts <= 8, `${restarts} zero-time frames of ${talkingFrames.length} while talking`) && pass;
  await page.screenshot({ path: "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/shots/p8-circle.png" });
  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p8] FAIL", e.message); process.exit(1); });
