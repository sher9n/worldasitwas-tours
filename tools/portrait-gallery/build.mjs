/**
 * Builds the portrait gallery: every guide's presence loop on one page.
 *
 *   node tools/portrait-gallery/build.mjs
 *
 * Reads the twelve recipes and each companion's finished loop, copies the
 * clips and posters into content/tours/_portraits (which the API serves at
 * /media/_portraits, no key required, and which the catalogue skips because it
 * holds no manifest.json), and writes index.html.
 *
 * The page is generated rather than hand-kept so it cannot drift from what the
 * guides actually look like: run it again after any presence rebuild.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "content/tours/_portraits");

const seconds = (file) =>
  new Promise((ok) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], (err, stdout) =>
      ok(err ? undefined : Number(String(stdout).trim())),
    );
  });

const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const recipes = (await fs.readdir(path.join(root, "content/recipes"))).filter((f) => f.endsWith(".json")).sort();
await fs.mkdir(out, { recursive: true });

const guides = [];
for (const file of recipes) {
  const recipe = JSON.parse(await fs.readFile(path.join(root, "content/recipes", file), "utf8"));
  const slug = slugOf(recipe.companion.name);
  const reel = path.join(root, "content/companions", slug, "reel/presence.mp4");
  const poster = path.join(root, "content/tours", recipe.id, "companion_portrait.jpg");
  try {
    await fs.access(reel);
  } catch {
    console.warn(`skipping ${recipe.companion.name}: no presence loop yet`);
    continue;
  }
  await fs.copyFile(reel, path.join(out, `guide-${slug}.mp4`));
  await fs.copyFile(poster, path.join(out, `guide-${slug}.jpg`)).catch(() => undefined);
  const size = (await fs.stat(reel)).size;
  guides.push({
    slug,
    name: recipe.companion.name,
    role: recipe.companion.role,
    city: recipe.cityName,
    year: recipe.year,
    standing: recipe.companion.presence?.standing ?? "",
    secs: Math.round((await seconds(reel)) ?? 0),
    mb: (size / 1024 / 1024).toFixed(1),
  });
}
guides.sort((a, b) => a.city.localeCompare(b.city) || a.year - b.year);

const cards = guides
  .map(
    (g, i) => `
  <div class="hang" data-slug="${esc(g.slug)}">
    <button class="frame" aria-label="Flag ${esc(g.name)}">
      <video muted loop playsinline preload="none" poster="guide-${esc(g.slug)}.jpg" src="guide-${esc(g.slug)}.mp4"></video>
    </button>
    <div class="plaque">
      <div class="no">${String(i + 1).padStart(2, "0")} &middot; ${esc(g.city)} ${g.year}</div>
      <h2>${esc(g.name)}</h2>
      <p>${esc(g.role)}</p>
      <div class="meta">${g.secs}s loop &middot; ${g.mb} MB</div>
      <div class="truesize">
        <div class="dot"><video muted loop playsinline preload="none" poster="guide-${esc(g.slug)}.jpg" src="guide-${esc(g.slug)}.mp4"></video></div>
        <span>Actual size<br>in the walk</span>
      </div>
      <span class="tag">${esc(g.slug)}</span>
    </div>
  </div>`,
  )
  .join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>The Portrait Gallery</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,500;1,300&family=JetBrains+Mono:wght@500&family=Source+Sans+3:wght@400;600;700&display=swap">
<style>
  :root {
    --room:   #100E0B;
    --wall:   #17130E;
    --panel:  #1E1913;
    --gilt:   #C9A24A;
    --gilt-d: #6E5828;
    --bone:   #EFE7D9;
    --muted:  #9A8C77;
    --hair:   rgba(201,162,74,.20);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: radial-gradient(120% 70% at 50% -10%, #241D14 0%, rgba(36,29,20,0) 62%), var(--room);
    color: var(--bone);
    font: 400 16px/1.6 "Source Sans 3", system-ui, -apple-system, sans-serif;
    padding: 0 0 128px; min-height: 100vh;
  }
  .eyebrow { font: 500 10px/1 "JetBrains Mono", ui-monospace, monospace; letter-spacing: .22em; text-transform: uppercase; color: var(--gilt); }
  header { max-width: 780px; margin: 0 auto; padding: 56px 22px 34px; text-align: center; display: flex; flex-direction: column; gap: 18px; align-items: center; }
  header h1 { font: 300 clamp(38px, 9vw, 62px)/1.02 "Cormorant Garamond", Georgia, serif; margin: 0; text-wrap: balance; letter-spacing: -.01em; }
  header h1 em { font-style: italic; color: var(--gilt); }
  header p { margin: 0; max-width: 56ch; color: var(--muted); text-wrap: pretty; }
  .rule { width: 100%; max-width: 780px; margin: 0 auto; height: 1px; background: linear-gradient(90deg, transparent, var(--hair) 22%, var(--hair) 78%, transparent); }
  .tools { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; padding: 24px 22px 8px; }
  button { font: 600 12px/1 "Source Sans 3", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--bone); background: var(--panel); border: 1px solid var(--hair); padding: 12px 18px; border-radius: 999px; cursor: pointer; transition: border-color .18s ease, color .18s ease; }
  button:hover { border-color: var(--gilt); color: var(--gilt); }
  button:focus-visible { outline: 2px solid var(--gilt); outline-offset: 3px; }
  .wall { max-width: 1180px; margin: 0 auto; padding: 30px 22px 0; display: grid; gap: 44px 30px; grid-template-columns: 1fr; }
  @media (min-width: 720px)  { .wall { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 1080px) { .wall { grid-template-columns: repeat(3, 1fr); } }
  /* Cards stretch to the tallest in the row so the true-size circles line up. */
  .hang { display: flex; flex-direction: column; align-items: center; height: 100%; }
  .frame { position: relative; width: min(300px, 78vw); aspect-ratio: 1; border-radius: 50%; padding: 0; border: none; background: none; cursor: pointer; display: grid; place-items: center; }
  .frame::after { content: ""; position: absolute; inset: -9px; border-radius: 50%; border: 1px solid var(--gilt-d); transition: border-color .2s ease, box-shadow .2s ease; }
  .frame video { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; background: #0B0906; box-shadow: 0 26px 60px rgba(0,0,0,.7), inset 0 0 0 3px rgba(239,231,217,.9); }
  .frame:hover::after { border-color: var(--gilt); }
  .frame:focus-visible { outline: none; }
  .frame:focus-visible::after { border-color: var(--gilt); box-shadow: 0 0 0 3px rgba(201,162,74,.35); }
  .hang.picked .frame::after { border-color: var(--gilt); border-width: 2px; box-shadow: 0 0 34px rgba(201,162,74,.30), inset 0 0 22px rgba(201,162,74,.12); }
  .plaque { text-align: center; padding: 22px 6px 0; max-width: 330px; flex: 1; display: flex; flex-direction: column; align-items: center; }
  .plaque .no { font: 500 10px/1 "JetBrains Mono", monospace; letter-spacing: .2em; color: var(--gilt-d); }
  .hang.picked .plaque .no { color: var(--gilt); }
  .plaque h2 { font: 500 25px/1.15 "Cormorant Garamond", Georgia, serif; margin: 9px 0 8px; }
  .plaque p { margin: 0; font-size: 14px; line-height: 1.55; color: var(--muted); text-wrap: pretty; }
  .meta { margin-top: 12px; font: 500 9px/1.5 "JetBrains Mono", monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--gilt-d); }
  /* True size: exactly how they sit in the walk (132px circle, 3px white ring). */
  .truesize { display: flex; align-items: center; gap: 13px; margin-top: auto; padding: 13px 16px 13px 13px; background: var(--wall); border: 1px solid var(--hair); border-radius: 14px; }
  .truesize .dot { width: 132px; height: 132px; flex: none; border-radius: 50%; overflow: hidden; border: 3px solid #fff; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
  .truesize .dot video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .truesize span { font: 500 9px/1.5 "JetBrains Mono", monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .tag { display: inline-block; margin-top: 14px; font: 500 10px/1 "JetBrains Mono", monospace; letter-spacing: .1em; color: var(--gilt-d); background: rgba(201,162,74,.07); border: 1px solid var(--hair); border-radius: 6px; padding: 6px 9px; }
  .rail { position: fixed; left: 0; right: 0; bottom: 0; z-index: 9; background: rgba(16,14,11,.94); backdrop-filter: blur(14px); border-top: 1px solid var(--hair); padding: 16px 22px calc(16px + env(safe-area-inset-bottom)); display: flex; align-items: center; justify-content: center; gap: 16px; flex-wrap: wrap; text-align: center; }
  .rail .none { color: var(--muted); font-size: 14px; }
  .rail .said { font-size: 15px; }
  .rail .said b { color: var(--bone); font-weight: 600; }
  .rail code { font: 500 13px "JetBrains Mono", monospace; color: var(--gilt); background: rgba(201,162,74,.09); border: 1px solid var(--hair); border-radius: 7px; padding: 6px 10px; margin-left: 8px; display: inline-block; }
  footer { max-width: 720px; margin: 64px auto 0; padding: 0 22px; text-align: center; color: var(--muted); font-size: 13px; text-wrap: pretty; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>

<header>
  <span class="eyebrow">${guides.length} guides &middot; London &middot; Rome &middot; Stockholm &middot; Colombo</span>
  <h1>Everyone who will <em>walk</em> with you</h1>
  <p>Each guide's portrait, in the style you chose. Their attention wanders and comes back: they glance away at something in their own world, look back at you, and settle. Every loop runs about forty seconds and joins without a seam, so nobody repeats often enough to notice.</p>
</header>
<div class="rule"></div>

<div class="tools">
  <button id="sync">Replay all together</button>
  <button id="toggle">Pause all</button>
</div>

<main class="wall" id="wall">${cards}
</main>

<footer>Tap any portrait to flag it and I will rebuild that one. The small circle beside each is the exact size and ring the guide is drawn at inside a walk, so it shows what a traveller actually sees.</footer>

<div class="rail" id="rail"><span class="none">Tap a portrait if one needs redoing.</span></div>

<script>
const GUIDES = ${JSON.stringify(guides.map((g) => ({ slug: g.slug, name: g.name })))};
const rail = document.getElementById("rail");
const vids = [...document.querySelectorAll("video")];
let picked = null;
try { picked = localStorage.getItem("tt_guide_flag"); } catch (e) { picked = null; }

document.querySelectorAll(".hang").forEach((hang) => {
  if (hang.dataset.slug === picked) hang.classList.add("picked");
  hang.querySelector(".frame").addEventListener("click", () => {
    picked = hang.dataset.slug === picked ? null : hang.dataset.slug;
    try { picked ? localStorage.setItem("tt_guide_flag", picked) : localStorage.removeItem("tt_guide_flag"); } catch (e) {}
    document.querySelectorAll(".hang").forEach((h) => h.classList.toggle("picked", h.dataset.slug === picked));
    paint();
  });
});

function paint() {
  const g = GUIDES.find((x) => x.slug === picked);
  rail.innerHTML = g
    ? '<span class="said">Flagged <b>' + g.name + '</b>. Tell me:<code>redo ' + g.slug + '</code></span>'
    : '<span class="none">Tap a portrait if one needs redoing.</span>';
}
paint();

// Twelve clips is more than a phone will decode at once, so only what you can
// see is loaded and played. It is also the better way to look at one.
let paused = false;
const loaded = new WeakSet();
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    const v = e.target;
    if (e.isIntersecting) {
      if (!loaded.has(v)) { v.preload = "auto"; v.load(); loaded.add(v); }
      if (!paused) v.play().catch(() => {});
    } else {
      v.pause();
    }
  });
}, { rootMargin: "150px 0px", threshold: 0.15 });
vids.forEach((v) => io.observe(v));

document.getElementById("sync").addEventListener("click", () => {
  paused = false;
  document.getElementById("toggle").textContent = "Pause all";
  vids.forEach((v) => { try { v.currentTime = 0; v.play().catch(() => {}); } catch (e) {} });
});
document.getElementById("toggle").addEventListener("click", (ev) => {
  paused = !paused;
  ev.target.textContent = paused ? "Play all" : "Pause all";
  vids.forEach((v) => { if (paused) v.pause(); else v.play().catch(() => {}); });
});
</script>
</body>
</html>
`;

await fs.writeFile(path.join(out, "index.html"), html);
console.log(`${guides.length} guides -> ${path.relative(root, path.join(out, "index.html"))}`);
for (const g of guides) console.log(`  ${g.city} ${g.year}  ${g.name.padEnd(18)} ${g.secs}s  ${g.mb} MB`);
