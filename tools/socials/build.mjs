/**
 * Builds the socials pack: every post, its copy for four platforms, and the
 * pictures to attach.
 *
 *   node tools/socials/build.mjs
 *
 * Everything is derived from the walks themselves, so the pack cannot drift
 * from the product. Screenshots come from tools/socials/shots (captured against
 * the running player), clips from tools/social-clip.sh, and the copy from
 * posts.json beside this file.
 *
 * Output goes to content/tours/_socials, served at /media/_socials/. That path
 * needs no key, and a folder with no manifest.json is skipped by the catalogue,
 * so this cannot appear as a walk or affect the app in any way.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const OUT = path.join(root, "content/tours/_socials");
// Working pictures live outside the published folder on purpose: only what is
// actually served should be uploaded, and the raw screenshots are 134 MB of
// intermediate that nobody downloads.
const WORK = path.join(root, "content/work/socials");
const SHOTS = path.join(WORK, "shots");
const CLIPS = path.join(WORK, "clips");
// Flat, not a media/ subfolder. The volume ended up with a FILE called
// "media" at this path (a single-file upload addressed to a directory that did
// not exist yet creates the file under that name), and every later folder
// upload then failed with "not a directory". Flat has no such trap.
const MEDIA = OUT;

import crypto from "node:crypto";
const FP = new Map();
async function fp(file) {
  if (!FP.has(file)) {
    const buf = await fs.readFile(path.join(OUT, file));
    FP.set(file, crypto.createHash("sha1").update(buf).digest("hex").slice(0, 10));
  }
  return FP.get(file);
}
const ff = (args) =>
  new Promise((ok, bad) => execFile("ffmpeg", ["-v", "error", "-y", ...args], (e) => (e ? bad(e) : ok())));
// ImageMagick does the composites, because ffmpeg on this machine is built
// without drawtext and the year labels are the whole point of a picture that
// shows the same place twice.
const mg = (args) =>
  new Promise((ok, bad) => execFile("magick", args.map(String), (e, _o, err) => (e ? bad(new Error(err || String(e))) : ok())));
// The player stamps the year in Cormorant Garamond; the composites stamp it in
// the same place in the nearest serif this machine actually ships, so the
// picture speaks the product's own language and the build needs no font file.
const SERIF = "/System/Library/Fonts/Supplemental/Georgia.ttf";
const exists = (f) => fs.access(f).then(() => true, () => false);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The four shapes a social manager actually needs, and who wants each. */
const FORMATS = [
  { key: "portrait", w: 1080, h: 1350, label: "Instagram feed", note: "4:5" },
  { key: "square", w: 1080, h: 1080, label: "LinkedIn, X, square", note: "1:1" },
  { key: "story", w: 1080, h: 1920, label: "Stories, Reels, Snap", note: "9:16" },
];

/** Fills the frame from the middle. Phone screenshots are taller than every
 *  target, so this crops the sides of nothing and the top and bottom a little. */
async function crop(src, dst, w, h) {
  await ff(["-i", src, "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, "-q:v", "3", dst]);
}

/** A grid, for the posts that are about the whole set rather than one walk.
 *  A short last row is CENTRED on the ground colour rather than left ragged:
 *  vstack refuses rows of different widths, so the twelve-walk grid broke the
 *  build the day the thirteenth walk landed. */
async function grid(sources, dst, cols, cell) {
  const rows = [];
  for (let i = 0; i < sources.length; i += cols) rows.push(sources.slice(i, i + cols));
  const width = cols * cell;
  const args = ["-size", `${width}x${rows.length * cell}`, "xc:#100E0B"];
  for (const [r, row] of rows.entries()) {
    const pad = Math.round((width - row.length * cell) / 2);
    for (const [c, src] of row.entries()) {
      args.push("(", src, "-resize", `${cell}x${cell}^`, "-gravity", "center", "-extent", `${cell}x${cell}`, ")",
                // back to none, or -composite reads the crop's gravity and
                // measures the offset from that corner instead of the origin
                "-gravity", "none", "-geometry", `+${pad + c * cell}+${r * cell}`, "-composite");
    }
  }
  await mg([...args, "-quality", "88", dst]);
}

// ---------------------------------------------------------------- build media

await fs.mkdir(MEDIA, { recursive: true });
const recipes = (await fs.readdir(path.join(root, "content/recipes"))).filter((f) => f.endsWith(".json")).sort();
const tours = [];
for (const f of recipes) {
  const r = JSON.parse(await fs.readFile(path.join(root, "content/recipes", f), "utf8"));
  const slug = r.companion.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  tours.push({
    id: r.id, city: r.cityName, year: r.year, title: r.title,
    guide: r.companion.name, role: r.companion.role, slug,
    dir: path.join(root, "content/tours", r.id),
  });
}
tours.sort((a, b) => a.city.localeCompare(b.city) || a.year - b.year);

const withV = async (src) => `${src}?v=${await fp(src)}`;

const made = [];
for (const t of tours) {
  // Captured at the aspect they ship in, interface visible, so every picture
  // is the product full-bleed: what the app actually looks like in the hand,
  // Hold to ask included. The square is the walk's own art, edge to edge.
  const story = path.join(SHOTS, `${t.id}-story.png`);
  const feed = path.join(SHOTS, `${t.id}-feed.png`);
  const hero = path.join(t.dir, "s01_hero.jpg");
  if (!(await exists(story)) || !(await exists(feed))) { console.warn(`no shots for ${t.id}`); continue; }

  await crop(feed, path.join(MEDIA, `${t.id}-portrait.jpg`), 1080, 1350);
  await crop(story, path.join(MEDIA, `${t.id}-story.jpg`), 1080, 1920);
  await crop(hero, path.join(MEDIA, `${t.id}-square.jpg`), 1080, 1080);

  made.push(t.id);
}

// The picture for the post about tapping the scene. shots.cjs grabs a walk
// eight seconds in, before the tap points have finished appearing, so this one
// is captured separately by tools/socials/shot-hotspots.cjs.
{
  const hot = path.join(SHOTS, "tour_istanbul_1616_water_carrier-hotspots.png");
  if (await exists(hot)) await crop(hot, path.join(MEDIA, "shot-hotspots.jpg"), 1080, 1350);
  else console.warn("no hotspots shot: node tools/socials/shot-hotspots.cjs tour_istanbul_1616_water_carrier");
}

// The whole cast, and one city per city, for the posts about the set.
await grid(tours.map((t) => path.join(t.dir, "companion_portrait.jpg")), path.join(MEDIA, "montage-guides.jpg"), 4, 340);
{
  // One hero per city, earliest year first: the label says cities, so it has
  // to BE cities. Taking the first six walks gave three Colombos and two
  // Istanbuls the moment the fifth city landed.
  const seen = new Set();
  const one = tours.filter((t) => !seen.has(t.city) && seen.add(t.city));
  await grid(one.map((t) => path.join(t.dir, "s01_hero.jpg")), path.join(MEDIA, "montage-cities.jpg"), 3, 420);
}

// ------------------------------------------------------------- composites
/**
 * A composite is several of the walks' own frames in one picture, because some
 * of what this product does only shows up when two of them are side by side:
 * the same building unfinished in two different centuries, one city three
 * times, the same corner then and now. Nothing is drawn that was not already
 * in a walk; the only ink added is the year, stamped where the player stamps
 * it, so a reader can tell which panel is which without the caption.
 */
const GAP = 4;
function split(total, n) {
  const each = Math.floor((total - GAP * (n - 1)) / n);
  const sizes = Array(n).fill(each);
  sizes[n - 1] = total - GAP * (n - 1) - each * (n - 1); // the remainder lands on the last panel
  return sizes;
}
async function strip(items, dst, { W, H, dir }) {
  const sizes = split(dir === "h" ? W : H, items.length);
  const args = ["-size", `${W}x${H}`, "xc:#100E0B"];
  let off = 0;
  for (const [i, it] of items.entries()) {
    const w = dir === "h" ? sizes[i] : W;
    const h = dir === "h" ? H : sizes[i];
    args.push("(", it.src, "-resize", `${w}x${h}^`, "-gravity", it.gravity ?? "center", "-extent", `${w}x${h}`);
    if (it.label) {
      const pt = Math.max(26, Math.round(Math.min(w, h) * 0.085));
      const x = Math.round(pt * 0.62), y = Math.round(pt * 0.5);
      args.push("-font", SERIF, "-pointsize", String(pt), "-gravity", "northeast",
                "-fill", "rgba(16,14,11,0.5)", "-annotate", `+${x - 2}+${y + 2}`, it.label,
                "-fill", "#EFE7D9", "-annotate", `+${x}+${y}`, it.label);
    }
    args.push(")", "-gravity", "none", "-geometry", dir === "h" ? `+${off}+0` : `+0+${off}`, "-composite");
    off += sizes[i] + GAP;
  }
  await mg([...args, "-quality", "88", dst]);
}

const T = (id) => path.join(root, "content/tours", id);
const ISTANBUL_1616 = T("tour_istanbul_1616_water_carrier");
const ISTANBUL_1660 = T("tour_istanbul_1660_midwife");
const COLOMBO_1999 = T("tour_colombo_1999_three_wheeler");

// The Yeni Cami at Eminönü: a stalled shell in Yusuf's year, and rising again
// in Emine's. Two walks, forty-four years apart, one building.
await strip([
  { src: `${ISTANBUL_1616}/s04_c2_then.jpg`, label: "1616" },
  { src: `${ISTANBUL_1660}/s04_hero.jpg`, label: "1660", gravity: "west" },
], path.join(MEDIA, "pair-yeni-cami.jpg"), { W: 1080, H: 1350, dir: "h" });

// One city, three walks, three centuries.
await strip([
  { src: `${T("tour_colombo_1700_cinnamon")}/s01_hero.jpg`, label: "1700" },
  { src: `${T("tour_colombo_1905_rickshaw")}/s01_hero.jpg`, label: "1905" },
  { src: `${COLOMBO_1999}/s01_hero.jpg`, label: "1999" },
], path.join(MEDIA, "trio-colombo.jpg"), { W: 1080, H: 1350, dir: "h" });

// The same view twice: the walk's reconstruction, and a photograph of the spot
// as it stands. The comparison is a card inside every walk.
// The lane below the Süleymaniye, because of the four then-and-now pairs in
// this walk it is the one where the photograph and the reconstruction are
// unmistakably the same viewpoint. Side by side, not stacked: the subject is a
// narrow lane and a letterbox band throws away the thing being compared.
await strip([
  { src: `${ISTANBUL_1616}/s03_c2_then.jpg`, label: "1616" },
  { src: `${ISTANBUL_1616}/s03_c2_now.jpg`, label: "Today" },
], path.join(MEDIA, "pair-then-now.jpg"), { W: 1080, H: 1350, dir: "h" });

/** Rectangular cells, for a picture that is about six things at once. Unlike
 *  grid() the cells are not square, because the walks' frames are tall and a
 *  square cell of a tall frame is a keyhole. */
async function mosaic(items, dst, { W, H, cols }) {
  const rows = Math.ceil(items.length / cols);
  const cw = split(W, cols), ch = split(H, rows);
  const args = ["-size", `${W}x${H}`, "xc:#100E0B"];
  for (const [i, it] of items.entries()) {
    const c = i % cols, r = Math.floor(i / cols);
    const x = cw.slice(0, c).reduce((a, b) => a + b + GAP, 0);
    const y = ch.slice(0, r).reduce((a, b) => a + b + GAP, 0);
    args.push("(", it.src, "-resize", `${cw[c]}x${ch[r]}^`, "-gravity", it.gravity ?? "center",
              "-extent", `${cw[c]}x${ch[r]}`, ")", "-gravity", "none", "-geometry", `+${x}+${y}`, "-composite");
  }
  await mg([...args, "-quality", "88", dst]);
}

// Two frames that carry a post on their own: the road with no towers on it,
// and the millennium-party banner three days after the bomb.
await crop(`${COLOMBO_1999}/s05_hero.jpg`, path.join(MEDIA, "tour_colombo_1999_three_wheeler-galle-road.jpg"), 1080, 1350);
await crop(`${COLOMBO_1999}/s06_c2_then.jpg`, path.join(MEDIA, "tour_colombo_1999_three_wheeler-millennium.jpg"), 1080, 1350);

// Six of the walks at the moment the guide is working, rather than six faces:
// a skin filled at a fountain, a hand on a handlebar, herbs, copper on a quay,
// rickshaws waiting, a door in a quarter. Nobody in this picture is important.
await mosaic([
  { src: `${ISTANBUL_1616}/s01_c1.jpg`, gravity: "south" },
  { src: `${COLOMBO_1999}/s01_c1.jpg`, gravity: "south" },
  { src: `${T("tour_rome_1600_herb_seller")}/s01_c1.jpg`, gravity: "south" },
  { src: `${T("tour_stockholm_1650_porter")}/s01_c1.jpg`, gravity: "south" },
  { src: `${T("tour_colombo_1905_rickshaw")}/s01_c1.jpg` },
  { src: `${ISTANBUL_1660}/s02_c1.jpg` },
], path.join(MEDIA, "montage-trades.jpg"), { W: 1080, H: 1350, cols: 2 });


// ----------------------------------------------------------------- build page

const PLATFORMS = [
  { key: "linkedin", name: "LinkedIn" },
  { key: "instagram", name: "Instagram" },
  { key: "twitter", name: "X / Twitter" },
  { key: "snapchat", name: "Snapchat" },
  { key: "tiktok", name: "TikTok" },
];
// A post names its platforms when the default four are not the right set; the
// two films are cut for LinkedIn and TikTok and say so.
const platformsFor = (p) =>
  p.platforms ? PLATFORMS.filter((x) => p.platforms.includes(x.key)) : PLATFORMS.filter((x) => x.key !== "tiktok");

const copy = JSON.parse(await fs.readFile(path.join(here, "posts.json"), "utf8"));

/**
 * A post that is missing anything fails the BUILD, loudly, with every problem
 * named. The alternative is a card or an agent brief that ships half-made and
 * is discovered by the sales team, which is the one way this page must never
 * break. Adding a post is: edit posts.json, run this build, fix what it names.
 */
{
  const problems = [];
  const ids = new Set();
  const platformKeys = new Set(PLATFORMS.map((x) => x.key));
  const all = [...copy.posts.map((p) => ({ ...p, _src: "posts" })),
               ...Object.entries(copy.tourPosts).map(([id, p]) => ({ id, kind: "tour", title: id, hook: p.hook, ...p, _src: "tourPosts" }))];
  for (const p of all) {
    const where = `${p._src}:${p.id ?? "?"}`;
    if (!p.id) problems.push(`${where}: no id`);
    else if (ids.has(p.id)) problems.push(`${where}: duplicate id`);
    else ids.add(p.id);
    if (!p.title) problems.push(`${where}: no title`);
    if (!p.hook) problems.push(`${where}: no hook`);
    const plats = p.platforms ?? PLATFORMS.filter((x) => x.key !== "tiktok").map((x) => x.key);
    for (const k of plats) {
      if (!platformKeys.has(k)) problems.push(`${where}: unknown platform "${k}"`);
      else if (typeof p[k] !== "string" || !p[k].trim()) problems.push(`${where}: no ${k} caption`);
    }
    if (p.schedule !== undefined && (typeof p.schedule !== "string" || !p.schedule.trim()))
      problems.push(`${where}: schedule must be a non-empty string when given`);
    for (const f of [p.video, p.poster].filter(Boolean)) {
      if (!(await exists(path.join(MEDIA, f)))) problems.push(`${where}: file not built: ${f}`);
    }
  }
  if (problems.length) {
    console.error("posts.json is not publishable:\n  " + problems.join("\n  "));
    process.exit(1);
  }
}

const posts = [];

/**
 * What a brand post can ask for by name. A key either IS a built file or points
 * at one of a NAMED walk's shots; it must never be a position in the tour list,
 * which is sorted by city and year and therefore moves under you every time a
 * walk is added. It moved twice: the post about asking Caterina a question in
 * Rome had been showing a picture of Colombo since the day it was written.
 */
const PICTURES = {
  "montage-guides.jpg": { src: "montage-guides.jpg", label: `All ${tours.length} guides` },
  "montage-cities.jpg": { src: "montage-cities.jpg", label: "One walk per city" },
  "montage-trades.jpg": { src: "montage-trades.jpg", label: "Six guides at work" },
  "pair-yeni-cami.jpg": { src: "pair-yeni-cami.jpg", label: "Eminönü, 1616 and 1660" },
  "trio-colombo.jpg": { src: "trio-colombo.jpg", label: "Colombo, 1700 / 1905 / 1999" },
  "pair-then-now.jpg": { src: "pair-then-now.jpg", label: "The same view, 1616 and today" },
  "shot-hotspots.jpg": { src: "shot-hotspots.jpg", label: "Tap points, in the walk" },
  "shot-ask.jpg": { src: "tour_rome_1600_herb_seller-story.jpg", label: "In the walk" },
  "shot-sources.jpg": { src: "tour_london_1850_flower_seller-portrait.jpg", label: "In the walk" },
  "shot-galle-road.jpg": { src: "tour_colombo_1999_three_wheeler-galle-road.jpg", label: "Galle Road, 1999" },
  "shot-millennium.jpg": { src: "tour_colombo_1999_three_wheeler-millennium.jpg", label: "Town Hall, December 1999" },
};

for (const p of copy.posts) {
  const media = [];
  // A film post carries its film and nothing else; picture posts list pictures.
  const want = p.media ?? [];
  if (p.video) media.push({ src: p.video, kind: "vid", poster: p.poster, label: "Vertical film, sound on" });
  for (const key of want) {
    const pic = PICTURES[key];
    if (!pic) { console.error(`posts.json: ${p.id} asks for an unknown picture "${key}"`); process.exit(1); }
    media.push({ ...pic, kind: "img" });
  }
  posts.push({ ...p, media });
}

for (const t of tours) {
  const c = copy.tourPosts[t.id];
  if (!c) continue;
  posts.push({
    id: t.id, kind: "tour", title: `${t.city} ${t.year} — ${t.title}`,
    hook: c.hook, guide: `${t.guide}, ${t.role}`, schedule: c.schedule,
    linkedin: c.linkedin, instagram: c.instagram, twitter: c.twitter, snapchat: c.snapchat,
    hashtags: `#history #${t.city.toLowerCase()} #storytelling #travel #ai`,
    media: [
      { src: `${t.id}-portrait.jpg`, kind: "img", label: "Instagram feed, 4:5" },
      { src: `${t.id}-square.jpg`, kind: "img", label: "Square, 1:1" },
      { src: `${t.id}-story.jpg`, kind: "img", label: "Story, 9:16" },
    ],
  });
}



/**
 * The hand-off brief: everything an agent needs to publish one post, in one
 * block. Absolute asset URLs, which file goes to which platform, the caption
 * verbatim, and the rules. Generated from the same data as the visible card,
 * so the brief and the page cannot disagree.
 */
const LIVE = "https://tours.worldasitwas.com/media/_socials";
function briefData(p, plats) {
  const caption = (key) =>
    p[key] + (p.hashtags && (key === "instagram" || key === "linkedin") ? "\n\n" + p.hashtags : "");
  const byShape = Object.fromEntries(p.media.map((m) => [m.label, m]));
  const pick = (key) => {
    const film = p.media.find((m) => m.kind === "vid");
    if (film) return film;
    if (p.kind === "tour") {
      if (key === "twitter") return byShape["Square, 1:1"] ?? p.media[0];
      if (key === "snapchat") return byShape["Story, 9:16"] ?? p.media[0];
      return byShape["Instagram feed, 4:5"] ?? p.media[0];
    }
    return p.media[0];
  };
  return {
    id: p.id,
    title: p.title,
    schedule: p.schedule ?? null,
    assets: p.media.map((m) => ({ url: `${LIVE}/${m.vsrc}`, label: m.label })),
    steps: plats.map((pl) => {
      const m = pick(pl.key);
      return {
        platform: pl.name,
        attach: `${LIVE}/${m.vsrc}`,
        postAs: m.kind === "vid" ? "native video, vertical 9:16, sound on" : "single image",
        altText: m.kind === "vid" ? null : p.title,
        caption: caption(pl.key),
      };
    }),
  };
}

const RULES = [
  "The caption is final: add nothing, remove nothing, no extra hashtags or emoji.",
  "Upload the asset file itself; never crop, filter, or screenshot it.",
  "Films must go up with sound on; if a platform strips audio, stop and report.",
  "If a platform rejects the caption length or the file, stop and report; do not edit to fit.",
  "Honour the schedule: schedule for that time if one is named, otherwise publish now.",
  "Keep a ledger of post ids you have published and skip any id already in it; the same id is never published twice.",
  "One platform failing does not block the others; report what failed and carry on.",
];

function agentBrief(p, plats) {
  const d = briefData(p, plats);
  const L = [];
  L.push(`TASK: publish the post "${d.title}" (id: ${d.id})`);
  L.push(`SCHEDULE: ${d.schedule ?? "none given — publish immediately, unless the operator names a time"}`);
  L.push("");
  L.push("ASSETS — download these first:");
  for (const a of d.assets) L.push(`  ${a.url}   (${a.label})`);
  L.push("");
  for (const [n, st] of d.steps.entries()) {
    L.push(`STEP ${n + 1} — ${st.platform}`);
    L.push(`  attach: ${st.attach}`);
    L.push(st.altText === null
      ? "  post as a NATIVE video upload (not a link), vertical 9:16, sound on."
      : `  post as a single image. alt text: "${st.altText}".`);
    L.push("  caption — paste EXACTLY as between the markers, keeping every line break:");
    L.push("  ---CAPTION START---");
    L.push(st.caption);
    L.push("  ---CAPTION END---");
    L.push("");
  }
  L.push("RULES");
  for (const r of RULES) L.push(`  - ${r}`);
  return L.join("\n");
}

// A film's poster is one of its own frames, so the card shows the film
// before play, full-bleed, rather than an unrelated padded picture.
for (const p of posts) {
  const film = p.media.find((m) => m.kind === "vid");
  if (film) {
    const poster = film.src.replace(/\.mp4$/, "-poster.jpg");
    await ff(["-ss", "1.6", "-i", path.join(MEDIA, film.src), "-frames:v", "1", "-q:v", "3", path.join(MEDIA, poster)]);
    film.poster = poster;
  }
}

// A post whose picture was never built would otherwise fail at the fingerprint
// with a bare ENOENT. Name every missing file at once instead, the way the
// copy check does, so one run tells you everything that is wrong.
{
  const missing = [];
  for (const p of posts)
    for (const m of p.media)
      if (!(await exists(path.join(MEDIA, m.src)))) missing.push(`${p.id}: ${m.src}`);
  if (missing.length) {
    console.error("media referenced but not built:\n  " + missing.join("\n  "));
    process.exit(1);
  }
}

// Every reference the page or the feed makes carries the content hash.
for (const p of posts) {
  for (const m of p.media) {
    m.vsrc = await withV(m.src);
    if (m.poster) m.vposter = await withV(m.poster);
  }
}

const card = (p, i) => `
<article class="post" id="${esc(p.id)}">
  <header class="post-head">
    <div>
      <div class="no">${String(i + 1).padStart(2, "0")} &middot; ${p.kind === "tour" ? "Tour post" : "Brand post"}</div>
      <h2>${esc(p.title)}</h2>
      <p class="hook">${esc(p.hook)}${p.guide ? ` &middot; ${esc(p.guide)}` : ""}</p>
    </div>
  </header>

  <div class="assets">
    ${p.media.map((m) => m.kind === "vid"
      ? `<figure class="vid"><video controls playsinline preload="none"${m.vposter ? ` poster="${m.vposter}"` : ""} src="${m.vsrc}"></video><figcaption>${esc(m.label)}<a href="${m.vsrc}" download>Download</a></figcaption></figure>`
      : `<figure><img loading="lazy" src="${m.vsrc}" alt="${esc(m.label)}"><figcaption>${esc(m.label)}<a href="${m.vsrc}" download>Download</a></figcaption></figure>`).join("")}
  </div>

  <div class="copyblocks">
    ${platformsFor(p).map((pl) => `
    <div class="block">
      <div class="block-head">
        <span class="plat">${pl.name}</span>
        <span class="count" data-for="${esc(p.id)}-${pl.key}"></span>
        <button class="copy" data-target="${esc(p.id)}-${pl.key}">Copy</button>
      </div>
      <pre id="${esc(p.id)}-${pl.key}">${esc(p[pl.key])}${pl.key === "instagram" || pl.key === "linkedin" ? "\n\n" + esc(p.hashtags) : ""}</pre>
    </div>`).join("")}
  </div>

  <details class="agent">
    <summary>Hand this post to an agent</summary>
    <div class="block">
      <div class="block-head">
        <span class="plat">One block, the whole job</span>
        <button class="copy" data-target="${esc(p.id)}-agent">Copy</button>
      </div>
      <pre id="${esc(p.id)}-agent">${esc(agentBrief(p, platformsFor(p)))}</pre>
    </div>
  </details>
</article>`;

const films = posts.filter((p) => p.media.some((m) => m.kind === "vid")).length;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Socials Pack</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,500;1,300&family=JetBrains+Mono:wght@500&family=Source+Sans+3:wght@400;600;700&display=swap">
<style>
  :root {
    --room:#100E0B; --wall:#17130E; --panel:#1E1913; --gilt:#C9A24A; --gilt-d:#6E5828;
    --bone:#EFE7D9; --muted:#9A8C77; --hair:rgba(201,162,74,.20);
    color-scheme: dark;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; }
  body {
    margin:0; background:radial-gradient(120% 60% at 50% -8%, #241D14 0%, rgba(36,29,20,0) 58%), var(--room);
    color:var(--bone); font:400 16px/1.6 "Source Sans 3", system-ui, -apple-system, sans-serif; padding-bottom:80px;
  }
  .eyebrow { font:500 10px/1 "JetBrains Mono", ui-monospace, monospace; letter-spacing:.22em; text-transform:uppercase; color:var(--gilt); }
  header.top { max-width:900px; margin:0 auto; padding:54px 22px 26px; text-align:center; display:flex; flex-direction:column; gap:16px; align-items:center; }
  header.top h1 { font:300 clamp(38px,8vw,60px)/1.02 "Cormorant Garamond", Georgia, serif; margin:0; text-wrap:balance; }
  header.top h1 em { font-style:italic; color:var(--gilt); }
  header.top p { margin:0; max-width:62ch; color:var(--muted); text-wrap:pretty; }

  .how { max-width:900px; margin:10px auto 0; padding:0 22px; }
  .how ol { margin:0; padding:18px 22px 18px 40px; background:var(--wall); border:1px solid var(--hair); border-radius:14px; color:var(--muted); font-size:14px; }
  .how li { margin:5px 0; }
  .how b { color:var(--bone); font-weight:600; }

  nav.index { max-width:900px; margin:26px auto 0; padding:0 22px; display:flex; flex-wrap:wrap; gap:8px; }
  nav.index a { font:500 11px/1 "JetBrains Mono", monospace; color:var(--muted); background:var(--panel); border:1px solid var(--hair); border-radius:999px; padding:9px 12px; text-decoration:none; }
  nav.index a:hover { color:var(--gilt); border-color:var(--gilt); }

  main { max-width:900px; margin:0 auto; padding:0 22px; }
  .post { margin:44px 0 0; padding:26px; background:var(--panel); border:1px solid var(--hair); border-radius:18px; scroll-margin-top:20px; }
  .post-head .no { font:500 10px/1 "JetBrains Mono", monospace; letter-spacing:.2em; color:var(--gilt-d); }
  .post-head h2 { font:500 27px/1.15 "Cormorant Garamond", Georgia, serif; margin:9px 0 6px; }
  .hook { margin:0; color:var(--muted); font-size:14px; }

  .assets { display:flex; flex-wrap:wrap; gap:18px; padding:20px 0 6px; }
  figure { margin:0; width:262px; max-width:100%; }
  /* A post with one picture is showing THE picture, so it gets real space. */
  figure:only-child { width:480px; }
  figure img, figure video { width:100%; border-radius:12px; display:block; background:#0B0906; border:1px solid var(--hair); }
  figure.vid, figure.vid:only-child { width:340px; }
  figcaption { font:500 9px/1.5 "JetBrains Mono", monospace; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); margin-top:8px; display:flex; justify-content:space-between; gap:8px; }
  figcaption a { color:var(--gilt); text-decoration:none; border-bottom:1px solid var(--hair); }

  .copyblocks { display:grid; gap:14px; margin-top:12px; }
  @media (min-width:820px) { .copyblocks { grid-template-columns:1fr 1fr; } }
  .block { background:var(--wall); border:1px solid var(--hair); border-radius:14px; overflow:hidden; }
  .block-head { display:flex; align-items:center; gap:10px; padding:11px 14px; border-bottom:1px solid var(--hair); }
  .plat { font:600 11px/1 "Source Sans 3", sans-serif; letter-spacing:.12em; text-transform:uppercase; color:var(--bone); flex:1; }
  .count { font:500 9px/1 "JetBrains Mono", monospace; color:var(--gilt-d); }
  button.copy { font:600 10px/1 "Source Sans 3", sans-serif; letter-spacing:.1em; text-transform:uppercase; color:var(--bone); background:var(--panel); border:1px solid var(--hair); border-radius:999px; padding:8px 13px; cursor:pointer; }
  button.copy:hover { border-color:var(--gilt); color:var(--gilt); }
  button.copy.done { border-color:var(--gilt); color:var(--gilt); }
  pre { margin:0; padding:15px 16px; font:400 14px/1.62 "Source Sans 3", sans-serif; white-space:pre-wrap; word-wrap:break-word; color:var(--bone); max-height:290px; overflow-y:auto; }

  details.agent { margin-top:14px; }
  details.agent summary {
    cursor:pointer; font:600 11px/1 "Source Sans 3",sans-serif; letter-spacing:.12em;
    text-transform:uppercase; color:var(--gilt); padding:12px 2px; list-style-position:inside;
  }
  details.agent .block { margin-top:8px; }
  details.agent pre { font:400 12.5px/1.6 "JetBrains Mono",monospace; color:var(--muted); max-height:340px; }

  footer { max-width:900px; margin:56px auto 0; padding:0 22px; text-align:center; color:var(--muted); font-size:13px; text-wrap:pretty; }
</style>
</head>
<body>

<header class="top">
  <span class="eyebrow">${posts.length} posts &middot; 4 platforms &middot; ${made.length} walks</span>
  <h1>Everything you need to <em>post</em> about this</h1>
  <p>One card per post: the pictures to attach, and the words already written for each platform. Nothing here needs editing before it goes out, though of course it can be.</p>
</header>

<div class="how">
  <ol>
    <li><b>Pick a post.</b> The first ${copy.posts.length} are about the product; the rest are one per walk.</li>
    <li><b>Take the media.</b> Pictures come in the shape each platform wants; the ${films} films have sound, so post them with sound on.</li>
    <li><b>Copy the words.</b> Each platform has its own version, already the right length. The character count is next to the button.</li>
    <li><b>Link.</b> Send people to <b>app.worldasitwas.com</b>.</li>
    <li><b>Handing off instead?</b> Every post ends with <b>Hand this post to an agent</b>: one copyable block holding the whole job — the files to fetch, which platform gets which, the captions verbatim, and the rules. Paste it into Claude Code and it has everything.</li>
  </ol>
</div>

<details class="agent" style="max-width:900px;margin:26px auto 0;padding:0 22px;">
  <summary>Agent? Start here</summary>
  <div class="block">
    <div class="block-head">
      <span class="plat">How this page works for you</span>
      <button class="copy" data-target="agent-start">Copy</button>
    </div>
    <pre id="agent-start">You are publishing social posts for World As It Was.

EVERYTHING you need is on this page, and in machine form at:
  ${LIVE}/briefs.json
That file lists every post: its id, schedule, asset URLs, and per-platform
steps with the caption verbatim. It is regenerated whenever posts change, so
fetch it fresh each run rather than caching it.

PER RUN
  1. Fetch briefs.json.
  2. Compare against your ledger of already-published post ids; the same id is
     never published twice.
  3. For each new post: honour its schedule (null means publish now, unless the
     operator names a time), then follow its steps in order.
  4. Record each id you publish in your ledger, per platform.

Each post on this page also carries the same brief as a copyable block under
"Hand this post to an agent", for doing one post by hand.

RULES
${RULES.map((r) => "  - " + r).join("\n")}</pre>
  </div>
</details>

<nav class="index">
  ${posts.map((p, i) => `<a href="#${esc(p.id)}">${String(i + 1).padStart(2, "0")} ${esc(p.kind === "tour" ? p.title.split(" — ")[0] : p.title)}</a>`).join("")}
</nav>

<main>
${posts.map(card).join("")}
</main>

<footer>
  Every picture here is a real screenshot of the product or one of its own reconstructions, and the ${films} films are built from the walks' own scenes and voices; nothing is a mock-up.
  Rebuild the pack after any change with <b>node tools/socials/build.mjs</b>.
</footer>

<script>
// One voice at a time: starting a film pauses the other.
document.addEventListener("play", (e) => {
  document.querySelectorAll("video").forEach((v) => { if (v !== e.target) v.pause(); });
}, true);

// Character counts matter: X cuts at 280 and Instagram gets truncated in feed.
document.querySelectorAll("pre").forEach((pre) => {
  const el = document.querySelector('.count[data-for="' + pre.id + '"]');
  if (!el) return;
  const n = pre.textContent.length;
  const limit = pre.id.endsWith("-twitter") ? 280 : null;
  el.textContent = limit ? n + " / " + limit : n + " chars";
  if (limit && n > limit) el.style.color = "#E4674A";
});

document.querySelectorAll("button.copy").forEach((b) => {
  b.addEventListener("click", async () => {
    const text = document.getElementById(b.dataset.target).textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Clipboard permission can be refused; selecting the text still lets a
      // person copy it by hand rather than leaving them with nothing.
      const r = document.createRange();
      r.selectNodeContents(document.getElementById(b.dataset.target));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    b.textContent = "Copied";
    b.classList.add("done");
    setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1600);
  });
});

</script>
</body>
</html>
`;

await fs.writeFile(path.join(OUT, "index.html"), html);
await fs.writeFile(
  path.join(OUT, "briefs.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      page: `${LIVE}/index.html`,
      note: "One entry per post. Follow steps in order; captions are verbatim. See rules.",
      rules: RULES,
      posts: posts.map((p) => briefData(p, platformsFor(p))),
    },
    null,
    2,
  ),
);
console.log(`${posts.length} posts, ${made.length} walks with media -> content/tours/_socials/index.html`);
