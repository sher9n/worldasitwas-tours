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

const ff = (args) =>
  new Promise((ok, bad) => execFile("ffmpeg", ["-v", "error", "-y", ...args], (e) => (e ? bad(e) : ok())));
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

/** The phone kept whole, on a blurred bed of itself. Nothing is cut off. */
async function pad(src, dst, w, h) {
  await ff([
    "-i", src, "-i", src,
    "-filter_complex",
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=22:2,eq=brightness=-0.16[bg];` +
      `[1:v]scale=-2:${Math.round(h * 0.94)}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`,
    "-q:v", "3", dst,
  ]);
}

/** A grid, for the posts that are about the whole set rather than one walk. */
async function grid(sources, dst, cols, cell) {
  const ins = sources.flatMap((s) => ["-i", s]);
  const scaled = sources.map((_, i) => `[${i}:v]scale=${cell}:${cell}:force_original_aspect_ratio=increase,crop=${cell}:${cell}[c${i}]`);
  const rows = [];
  for (let r = 0; r * cols < sources.length; r++) {
    const cells = sources.slice(r * cols, r * cols + cols).map((_, i) => `[c${r * cols + i}]`).join("");
    rows.push(`${cells}hstack=inputs=${Math.min(cols, sources.length - r * cols)}[r${r}]`);
  }
  const stack = rows.map((_, i) => `[r${i}]`).join("") + `vstack=inputs=${rows.length}`;
  await ff([...ins, "-filter_complex", `${scaled.join(";")};${rows.join(";")};${stack}`, "-q:v", "3", dst]);
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

const made = [];
for (const t of tours) {
  const cover = path.join(SHOTS, `${t.id}-cover.png`);
  const clean = path.join(SHOTS, `${t.id}-clean1.png`);
  const hero = path.join(t.dir, "s01_hero.jpg");
  if (!(await exists(cover))) { console.warn(`no shots for ${t.id}`); continue; }

  // The phone kept whole where the product is the point, the world edge to edge
  // where the place is the point.
  await pad(cover, path.join(MEDIA, `${t.id}-portrait.jpg`), 1080, 1350);
  await pad(clean, path.join(MEDIA, `${t.id}-story.jpg`), 1080, 1920);
  await crop(hero, path.join(MEDIA, `${t.id}-square.jpg`), 1080, 1080);

  made.push(t.id);
}

// The whole cast, and the whole world, for the posts about the set.
await grid(tours.map((t) => path.join(t.dir, "companion_portrait.jpg")), path.join(MEDIA, "montage-guides.jpg"), 4, 340);
await grid(tours.slice(0, 6).map((t) => path.join(t.dir, "s01_hero.jpg")), path.join(MEDIA, "montage-cities.jpg"), 3, 420);


// ----------------------------------------------------------------- build page

const copy = JSON.parse(await fs.readFile(path.join(here, "posts.json"), "utf8"));
const posts = [];

for (const p of copy.posts) {
  const media = [];
  // A film post carries its film and nothing else; picture posts list pictures.
  const want = p.media ?? [];
  if (p.video) media.push({ src: p.video, kind: "vid", poster: p.poster, label: "Vertical film, sound on" });
  if (want.includes("montage-guides.jpg")) media.push({ src: "montage-guides.jpg", kind: "img", label: "All twelve guides" });
  if (want.includes("montage-cities.jpg")) media.push({ src: "montage-cities.jpg", kind: "img", label: "Six of the cities" });
  if (want.includes("shot-ask.jpg")) media.push({ src: `${tours[0].id}-story.jpg`, kind: "img", label: "In the walk" });
  if (want.includes("shot-sources.jpg")) media.push({ src: `${tours[4].id}-portrait.jpg`, kind: "img", label: "In the walk" });
  posts.push({ ...p, media });
}

for (const t of tours) {
  const c = copy.tourPosts[t.id];
  if (!c) continue;
  posts.push({
    id: t.id, kind: "tour", title: `${t.city} ${t.year} — ${t.title}`,
    hook: c.hook, guide: `${t.guide}, ${t.role}`,
    linkedin: c.linkedin, instagram: c.instagram, twitter: c.twitter, snapchat: c.snapchat,
    hashtags: `#history #${t.city.toLowerCase()} #storytelling #travel #ai`,
    media: [
      { src: `${t.id}-portrait.jpg`, kind: "img", label: "Instagram feed, 4:5" },
      { src: `${t.id}-square.jpg`, kind: "img", label: "Square, 1:1" },
      { src: `${t.id}-story.jpg`, kind: "img", label: "Story, 9:16" },
    ],
  });
}

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
      ? `<figure class="vid"><video controls playsinline preload="none"${m.poster ? ` poster="${m.poster}"` : ""} src="${m.src}"></video><figcaption>${esc(m.label)}<a href="${m.src}" download>Download</a></figcaption></figure>`
      : `<figure><img loading="lazy" src="${m.src}" alt="${esc(m.label)}"><figcaption>${esc(m.label)}<a href="${m.src}" download>Download</a></figcaption></figure>`).join("")}
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
</article>`;

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
    <li><b>Pick a post.</b> The first four are about the product; the rest are one per walk.</li>
    <li><b>Take the media.</b> Pictures come in the shape each platform wants; the two films have sound, so post them with sound on.</li>
    <li><b>Copy the words.</b> Each platform has its own version, already the right length. The character count is next to the button.</li>
    <li><b>Link.</b> Send people to <b>tours.worldasitwas.com</b>.</li>
  </ol>
</div>

<nav class="index">
  ${posts.map((p, i) => `<a href="#${esc(p.id)}">${String(i + 1).padStart(2, "0")} ${esc(p.kind === "tour" ? p.title.split(" — ")[0] : p.title)}</a>`).join("")}
</nav>

<main>
${posts.map(card).join("")}
</main>

<footer>
  Every picture here is a real screenshot of the product or one of its own reconstructions, and the two films are built from the walks' own scenes and voices; nothing is a mock-up.
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
console.log(`${posts.length} posts, ${made.length} walks with media -> content/tours/_socials/index.html`);
