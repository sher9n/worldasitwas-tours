/**
 * Builds the two promo films: ~15 seconds, vertical, with sound.
 *
 *   FAL_KEY=... node tools/socials/promos.mjs
 *
 * Built from scratch rather than screen-recorded, on purpose. A screen
 * recording shows an interface; these show the experience the interface is
 * for. Each film is three of the walk's own reconstructions brought to life
 * as first-person walking shots, with the guide's real voice talking about
 * the walk over the walk's own ambience, and titles in the product's own
 * type. Everything in them exists in the product; nothing is stock.
 *
 * Generated segments are cached in content/work/socials/promo, so a re-run
 * regenerates nothing it already has and recomposing is free.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = path.join(root, "content/work/socials/promo");
const OUT = path.join(root, "content/tours/_socials");
const FAL = process.env.FAL_KEY;
if (!FAL) throw new Error("set FAL_KEY");

// The player's own playwright install; this repo does not carry one.
const require2 = createRequire("/Applications/MAMP/htdocs/document-capture-service/");
const { chromium } = require2("playwright");

const W = 1080, H = 1920;
const SEG = 5;            // seconds per generated shot
const XF = 0.6;           // dissolve between shots

const PROMOS = [
  {
    name: "promo-walk-back-in-time",
    tour: "tour_rome_1600_herb_seller",
    stills: ["s01_hero.jpg", "s02_hero.jpg", "s05_hero.jpg"],
    voice: "5DTSWAtuA2BoWMSMFTRP", // Caty: Caterina's own narration voice
    vo:
      "Close your eyes. Open them in Rome, sixteen hundred. " +
      "The market is shouting, the new Saint Peter's is climbing over the old, " +
      "and I am waiting in Campo de' Fiori. Come. Walk back in time.",
    eyebrow: "ROME · 1600",
    line: "Walk back in time.",
  },
  {
    name: "promo-hold-to-ask",
    tour: "tour_london_1666_waterman",
    stills: ["s01_hero.jpg", "s03_hero.jpg", "s04_hero.jpg"],
    voice: "George", // Will Chandler's own narration voice
    vo:
      "London is burning, and I am your waterman. Walk with me. " +
      "And when you want to know something, hold the button and ask: " +
      "what the smoke smells like, what a boat costs tonight. " +
      "I will answer you. From sixteen sixty-six.",
    eyebrow: "LONDON · 1666",
    line: "Hold to ask. He answers.",
  },
];

// The one instruction that matters is the camera: it must feel like walking,
// and it must not invent titles of its own.
const MOTION =
  "First person point of view walking slowly forward through the scene at eye height, " +
  "a steady natural walking pace, people going about their business, smoke and cloth moving naturally, " +
  "photoreal and cinematic, the camera simply advances the whole time. No text, no titles, no camera shake.";

const ff = (args) =>
  new Promise((ok, bad) => execFile("ffmpeg", ["-v", "error", "-y", ...args], (e, _o, se) => (e ? bad(new Error(String(se).slice(0, 400))) : ok())));
const probe = (f) =>
  new Promise((ok) => execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], (e, so) => ok(e ? 0 : Number(String(so).trim()))));
const exists = (f) => fs.access(f).then(() => true, () => false);

async function falJson(url, body) {
  // A generation call that will not answer must fail, not hang: the segment
  // loop retries a failure, but nothing retries a fetch that never returns.
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Key ${FAL}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(480000),
  });
  if (!res.ok) throw new Error(`${url} ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function download(url, target) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
}
async function hostFile(local, mime) {
  const init = await falJson(`https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3`, {
    content_type: mime, file_name: path.basename(local),
  });
  const put = await fetch(init.upload_url, { method: "PUT", headers: { "Content-Type": mime }, body: await fs.readFile(local) });
  if (!put.ok) throw new Error(`upload ${put.status}`);
  return init.file_url;
}

/** One generated walking shot, cached. */
async function segment(promo, i) {
  const out = path.join(WORK, `${promo.name}-seg${i + 1}.mp4`);
  if (await exists(out)) return out;
  const still = path.join(root, "content/tours", promo.tour, promo.stills[i]);
  const url = await hostFile(still, "image/jpeg");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const d = await falJson("https://fal.run/fal-ai/kling-video/v3/standard/image-to-video", {
        prompt: MOTION, image_url: url, start_image_url: url, duration: String(SEG),
      });
      await download(d.video.url, out);
      return out;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 15000 * attempt));
    }
  }
}

/** The guide's voice saying the promo line, cached. */
async function voiceover(promo) {
  const out = path.join(WORK, `${promo.name}-vo.mp3`);
  if (await exists(out)) return out;
  const d = await falJson("https://fal.run/fal-ai/elevenlabs/tts/eleven-v3", {
    text: promo.vo, voice: promo.voice, stability: 0.5, output_format: "mp3_44100_128",
  });
  await download(d.audio.url, out);
  return out;
}

/** Title and brand cards, rendered from the product's own type. */
async function cards(promo, browser) {
  const title = path.join(WORK, `${promo.name}-title.png`);
  const brand = path.join(WORK, `${promo.name}-brand.png`);
  if ((await exists(title)) && (await exists(brand))) return { title, brand };
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const html = (body) => `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;1,300&family=JetBrains+Mono:wght@500&display=swap">
    <style>
      html,body{margin:0;width:${W}px;height:${H}px;background:transparent;font-kerning:normal;}
      .eyebrow{font:500 34px/1 "JetBrains Mono",monospace;letter-spacing:.3em;color:#C9A24A;text-transform:uppercase;}
      .line{font:300 118px/1.08 "Cormorant Garamond",serif;color:#EFE7D9;margin-top:34px;text-shadow:0 4px 40px rgba(0,0,0,.9);}
      .lower{position:absolute;left:84px;right:84px;bottom:300px;}
      .scrim{position:absolute;inset:0;background:radial-gradient(90% 70% at 50% 55%, rgba(10,8,6,.62) 0%, rgba(10,8,6,.86) 100%);}
      .centre{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:44px;padding:0 90px;}
      .url{font:500 40px/1 "JetBrains Mono",monospace;letter-spacing:.12em;color:#C9A24A;border:2px solid rgba(201,162,74,.45);border-radius:constant 18px;border-radius:18px;padding:26px 42px;}
    </style></head><body>${body}</body></html>`;
  await page.setContent(html(
    `<div class="lower"><div class="eyebrow">${promo.eyebrow}</div><div class="line">${promo.line}</div></div>`), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: title, omitBackground: true });
  await page.setContent(html(
    `<div class="scrim"></div><div class="centre">
       <div class="eyebrow">WORLD AS IT WAS</div>
       <div class="line" style="font-size:98px">Twelve walks through<br>vanished cities</div>
       <div class="url">app.worldasitwas.com</div>
     </div>`), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: brand, omitBackground: true });
  await page.close();
  return { title, brand };
}

async function compose(promo, segs, vo, card) {
  const out = path.join(WORK, `${promo.name}.mp4`);
  const ambience = path.join(root, "content/tours", promo.tour, "s01_ambience.mp3");

  // The films are fifteen seconds, so the voice fits the film rather than the
  // film stretching for the voice. The model reads with generous pauses, and
  // those go first: capping every silence reclaims a second or two while
  // changing nothing about how she speaks. Only if that is not enough does the
  // pace itself rise, and never past 12 percent, which is the point where a
  // warm read starts to sound hurried. Cutting her off mid-line is not an
  // option at all: the last words are the ones the film exists for.
  const TOTAL = 15.0;
  const LEAD = 0.7, TAIL = 0.7;
  const budget = TOTAL - LEAD - TAIL;
  let fit = path.join(WORK, `${promo.name}-vo-fit.m4a`);
  await ff(["-i", vo, "-af", "silenceremove=stop_periods=-1:stop_duration=0.32:stop_threshold=-38dB",
    "-c:a", "aac", "-b:a", "192k", fit]);
  let voDur = await probe(fit);
  if (voDur > budget) {
    const tempo = Math.min(voDur / budget, 1.12);
    const fit2 = path.join(WORK, `${promo.name}-vo-fit2.m4a`);
    await ff(["-i", fit, "-af", `atempo=${tempo.toFixed(4)}`, "-c:a", "aac", "-b:a", "192k", fit2]);
    fit = fit2;
    voDur = await probe(fit);
  }
  vo = fit;
  const base = 3 * SEG - 2 * XF;                        // the three shots, dissolved
  const total = Math.max(TOTAL, Math.min(voDur + LEAD + TAIL, 16.5));
  if (voDur + LEAD + TAIL > total) console.warn(`${promo.name}: voice still ${voDur.toFixed(1)}s after fitting`);
  const pad = Math.max(0, total - base);
  const brandIn = total - 3.0;                          // the brand card owns the last 3s

  await ff([
    "-i", segs[0], "-i", segs[1], "-i", segs[2],
    "-loop", "1", "-t", String(total), "-i", card.title,
    "-loop", "1", "-t", String(total), "-i", card.brand,
    "-i", vo, "-i", ambience,
    "-filter_complex",
    // Every shot fills the 9:16 frame from the middle.
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=25,setpts=PTS-STARTPTS[v0];` +
    `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=25,setpts=PTS-STARTPTS[v1];` +
    `[2:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=25,setpts=PTS-STARTPTS[v2];` +
    `[v0][v1]xfade=transition=fade:duration=${XF}:offset=${SEG - XF}[va];` +
    `[va][v2]xfade=transition=fade:duration=${XF}:offset=${2 * SEG - 2 * XF}[vb];` +
    // Held on the final frame if the voice needs a moment more than the shots give.
    `[vb]tpad=stop_mode=clone:stop_duration=${pad.toFixed(2)}[vc];` +
    // The opening title breathes in and out over the first shot...
    `[3:v]format=rgba,fade=t=in:st=0.5:d=0.7:alpha=1,fade=t=out:st=3.6:d=0.7:alpha=1[t];` +
    `[vc][t]overlay=0:0[vd];` +
    // ...and the brand card owns the end.
    `[4:v]format=rgba,fade=t=in:st=${brandIn.toFixed(2)}:d=0.8:alpha=1[bc];` +
    `[vd][bc]overlay=0:0[v];` +
    // Her voice leads; the street sits far behind it; one loudness for every phone.
    `[5:a]adelay=700|700[voz];` +
    `[6:a]volume=0.16,atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS[amb];` +
    `[voz][amb]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,` +
    `atrim=0:${total.toFixed(2)},afade=t=out:st=${(total - 0.9).toFixed(2)}:d=0.9[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", String(total.toFixed(2)),
    "-c:v", "libx264", "-crf", "21", "-preset", "medium", "-pix_fmt", "yuv420p", "-g", "50",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    out,
  ]);
  await fs.copyFile(out, path.join(OUT, `${promo.name}.mp4`));
  return { out, total };
}

await fs.mkdir(WORK, { recursive: true });
const browser = await chromium.launch();
for (const promo of PROMOS) {
  // The three shots generate in parallel; nothing else is slow.
  const [vo, segs] = await Promise.all([
    voiceover(promo),
    Promise.all(promo.stills.map((_, i) => segment(promo, i))),
  ]);
  const card = await cards(promo, browser);
  const { total } = await compose(promo, segs, vo, card);
  const size = (await fs.stat(path.join(OUT, `${promo.name}.mp4`))).size;
  console.log(`${promo.name}: ${total.toFixed(1)}s, ${(size / 1048576).toFixed(1)} MB, vo ${(await probe(vo)).toFixed(1)}s`);
}
await browser.close();
