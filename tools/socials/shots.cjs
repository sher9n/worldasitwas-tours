/**
 * Captures each walk AS THE ASSET SHIPS: at the aspect ratio of the post it
 * will become, with the interface visible.
 *
 *   node tools/socials/shots.cjs <tour_id>...
 *
 * The first version captured one phone shape and padded it onto a blurred bed
 * to fit each platform, which read as a small app floating in a frame, and it
 * hid the buttons for the "clean" shots. Both were wrong: the shots exist to
 * show the product, and the product is full-bleed with Hold to ask on screen.
 * Capturing at the delivery aspect means nothing is padded and nothing is cut.
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const OUT = "/Applications/MAMP/htdocs/timetravel/content/work/socials/shots";
const TOURS = process.argv.slice(2);
// Logical viewports at exactly the delivered aspect; x3 gives 1188x2112 and
// 1200x1500, comfortably above the 1080-wide deliverables.
const SHAPES = [
  { name: "story", w: 396, h: 704 },  // 9:16
  { name: "feed", w: 400, h: 500 },   // 4:5
];
(async () => {
  const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  for (const t of TOURS) {
    for (const shape of SHAPES) {
      try {
        const ctx = await b.newContext({ viewport: { width: shape.w, height: shape.h }, deviceScaleFactor: 3, hasTouch: true });
        const p = await ctx.newPage();
        await p.goto(`http://localhost:5173/?tour=${t}&play=1`, { waitUntil: "networkidle", timeout: 120000 });
        await p.waitForSelector(".player .idle", { timeout: 120000 });
        await p.waitForTimeout(1500);
        if (shape.name === "story") await p.screenshot({ path: `${OUT}/${t}-cover.png` });
        await p.click("button.travel");
        // Past the title card, into the walk, with her circle and the HUD up.
        await p.waitForSelector(".voice-circle", { timeout: 60000 });
        await p.waitForTimeout(8000);
        await p.screenshot({ path: `${OUT}/${t}-${shape.name}.png` });
        await ctx.close();
        console.log(`ok   ${t} ${shape.name}`);
      } catch (e) {
        console.log(`FAIL ${t} ${shape.name}: ${String(e).split("\n")[0].slice(0, 80)}`);
      }
    }
  }
  await b.close();
})();
