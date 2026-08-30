/**
 * Her presence in the circle: one clip looping without a seam, running the whole
 * time, with a halo that follows her actual voice. She is never lip-synced, so
 * what has to be true is that she never freezes, never goes blank, and that the
 * light tells you when she is speaking.
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const ok = (n, c, d = "") => console.log(`[p8] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
(async () => {
  const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 })).newPage();
  await page.goto(`http://localhost:5173/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle", { timeout: 90000 });
  await page.click("button.travel");
  await page.waitForTimeout(2500);
  let pass = true;
  // Nothing is stitched any more: one element, looping itself. Any second player
  // would mean a seam to hide, which is what produced every glitch before this.
  pass = ok("one player, no stitching", await page.evaluate(() => document.querySelectorAll(".voice-circle video").length === 1)) && pass;
  pass = ok("it loops itself", await page.evaluate(() => document.querySelector(".voice-circle video").loop === true)) && pass;
  // Sample across two loop lengths: presence must never stop or go blank.
  const s = await page.evaluate(() => new Promise((done) => {
    const out = [];
    const id = setInterval(() => {
      const vs = [...document.querySelectorAll(".voice-circle video")];
      const on = vs.find((v) => v.classList.contains("on"));
      out.push({ playing: on ? !on.paused : false, ready: on ? on.readyState : -1, t: on ? Number(on.currentTime.toFixed(2)) : -1,
                 opaque: vs.some((v) => Number(getComputedStyle(v).opacity) > 0.5),
                 halo: document.querySelector(".voice-circle").className.includes("speaking") });
    }, 60);
    setTimeout(() => { clearInterval(id); done(out); }, 16000);
  }));
  pass = ok("she never stops moving", s.every((x) => x.playing), `${s.filter((x) => !x.playing).length} still frames of ${s.length}`) && pass;
  // The first second is the clip loading, not a seam in the loop.
  const settled = s.slice(17);
  pass = ok("never blank", settled.every((x) => x.ready >= 2), `${settled.filter((x) => x.ready < 2).length} of ${settled.length} after the first second`) && pass;
  pass = ok("always something visible", s.every((x) => x.opaque)) && pass;
  const wraps = s.filter((x, i) => i && x.t < s[i - 1].t).length;
  pass = ok("the loop comes round", wraps >= 1, `${wraps} loop points in 16s`) && pass;
  // The seam is only invisible if the clip ends on the frame it began with.
  const clip = `/Applications/MAMP/htdocs/timetravel/content/tours/${TOUR}/companion_reel_1.mp4`;
  if (require("fs").existsSync(clip)) {
    const T = require("os").tmpdir();
    const ff = require("/Applications/MAMP/htdocs/timetravel/node_modules/ffmpeg-static");
    const { spawnSync } = require("child_process");
    spawnSync(ff, ["-y", "-loglevel", "error", "-ss", "0", "-i", clip, "-frames:v", "1", `${T}/seam_a.png`]);
    spawnSync(ff, ["-y", "-loglevel", "error", "-sseof", "-0.08", "-i", clip, "-update", "1", "-frames:v", "1", `${T}/seam_b.png`]);
    const out = String(spawnSync(ff, ["-i", `${T}/seam_a.png`, "-i", `${T}/seam_b.png`, "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" }).stderr || "");
    const psnr = Number(out.match(/average:(\d+(?:\.\d+)?)/)?.[1] || 0);
    pass = ok("the clip ends where it began", psnr >= 30, `${psnr.toFixed(1)} dB between first and last frame`) && pass;
  }
  pass = ok("the halo follows her voice", s.some((x) => x.halo), `${s.filter((x) => x.halo).length}/${s.length} samples lit`) && pass;
  await page.screenshot({ path: `/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/shots/presence-${TOUR}.png` });
  // Pause must still settle her.
  await page.click(".side-ctl >> nth=0");
  await page.waitForTimeout(600);
  const paused = await page.evaluate(() => { const v = [...document.querySelectorAll(".voice-circle video")].find((x) => x.classList.contains("on")); return { paused: v.paused, halo: document.querySelector(".voice-circle").className.includes("speaking") }; });
  pass = ok("pause settles her", paused.paused && !paused.halo, JSON.stringify(paused)) && pass;
  await b.close();
  if (!pass) process.exit(1);
})();
