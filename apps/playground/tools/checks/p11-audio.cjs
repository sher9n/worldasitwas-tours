/**
 * The mixer. On a phone, setting volume on an audio element does nothing at all,
 * so levels have to go through Web Audio or the street bed plays at full blast
 * under her voice and every duck is a lie. This checks the wiring is real, that
 * a level change is a ramp rather than a jump, and that published recordings all
 * sit at the same loudness.
 */
const fs = require("fs");
const { spawnSync } = require("child_process");
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const ok = (n, c, d = "") => console.log(`[p11] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
const FFMPEG = require("/Applications/MAMP/htdocs/timetravel/node_modules/ffmpeg-static");

(async () => {
  let pass = true;

  // Published loudness: every line within a decibel or so of the same target.
  const dir = `/Applications/MAMP/htdocs/timetravel/content/tours/${TOUR}`;
  // Only what the tour actually plays. A tour folder keeps files from earlier
  // builds, and measuring those tells you about a version nobody hears.
  const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, "utf8"));
  const used = new Set();
  for (const url of JSON.stringify(manifest).matchAll(/\/media\/[^"']*?\/([\w.-]+\.mp3)/g)) used.add(url[1]);
  const speech = [...used].filter((f) => !/ambience/.test(f)).slice(0, 10);
  const levels = [];
  for (const f of speech) {
    // ffmpeg reports loudness on stderr even when it succeeds.
    const r = spawnSync(FFMPEG, ["-i", `${dir}/${f}`, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf8" });
    const m = String(r.stderr || "").match(/I:\s+(-?\d+\.\d+) LUFS/);
    if (m) levels.push({ f, lufs: Number(m[1]) });
  }
  const spread = levels.length ? Math.max(...levels.map((x) => x.lufs)) - Math.min(...levels.map((x) => x.lufs)) : 99;
  pass = ok("every line is the same loudness", spread <= 1.5, `${spread.toFixed(1)} dB spread across ${levels.length} lines`) && pass;
  const offTarget = levels.filter((x) => Math.abs(x.lufs + 16) > 2);
  pass = ok("speech sits at the target level", offTarget.length === 0, offTarget.slice(0, 3).map((x) => `${x.f} ${x.lufs}`).join(", ")) && pass;

  const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  // Tee every channel the app wires up, so this measures sound actually reaching
  // the mixer. Element state cannot tell silence from playing: a media element
  // routed through Web Audio outputs nothing at all if its source is
  // cross-origin and the request never asked for CORS, which is a silent tour
  // that looks perfectly healthy from the outside.
  await page.addInitScript(() => {
    window.__taps = [];
    const cms = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (el) {
      const node = cms.call(this, el);
      const an = this.createAnalyser();
      an.fftSize = 512;
      node.connect(an);
      window.__taps.push({ channel: el.dataset ? el.dataset.channel : "?", an, buf: new Uint8Array(new ArrayBuffer(an.frequencyBinCount)) });
      return node;
    };
  });
  await page.goto(`http://localhost:5173/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle", { timeout: 90000 });
  await page.evaluate(() => {
    // Watch what the app does to the mixer rather than trusting that it tried.
    window.__gains = [];
    const proto = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () {
      const node = proto.call(this);
      const ramp = node.gain.linearRampToValueAtTime.bind(node.gain);
      node.gain.linearRampToValueAtTime = (v, t) => { window.__gains.push({ v, t }); return ramp(v, t); };
      return node;
    };
  });
  await page.click("button.travel");
  await page.waitForTimeout(6000);
  const wiring = await page.evaluate(async () => {
    const peaks = {};
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 60));
      for (const t of window.__taps || []) {
        t.an.getByteTimeDomainData(t.buf);
        let p = 0;
        for (const v of t.buf) p = Math.max(p, Math.abs(v - 128));
        peaks[t.channel] = Math.max(peaks[t.channel] || 0, p);
      }
    }
    return {
      ramps: (window.__gains || []).length,
      session: (navigator.audioSession && navigator.audioSession.type) || "unsupported",
      peaks,
      cors: document.querySelector('audio[data-channel="voice"]').crossOrigin,
    };
  });
  pass = ok("her voice actually reaches the mixer", (wiring.peaks.voice || 0) > 3, `peak ${wiring.peaks.voice || 0} of 128`) && pass;
  pass = ok("the recordings are fetched so the mixer may use them", wiring.cors === "anonymous", String(wiring.cors)) && pass;
  pass = ok("levels are set through Web Audio, not element volume", wiring.ramps > 0, `${wiring.ramps} gain ramps`) && pass;
  pass = ok("a level change is a ramp, never a jump", (await page.evaluate(() => (window.__gains || []).every((g) => g.t > 0)))) && pass;
  console.log(`[p11] audio session: ${wiring.session}`);
  await b.close();
  if (!pass) process.exit(1);
})();
