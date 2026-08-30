const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const OUT = "/Applications/MAMP/htdocs/timetravel/content/tours/_socials/shots";
const TOURS = process.argv.slice(2);
// Buttons make a shot read as a product screenshot; without them it reads as a
// place. A social manager wants both, so every walk gives both.
const HIDE_HUD = ".hud-bottom, .side-ctl, .ask, .ask-state { opacity: 0 !important; }";
(async () => {
  const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  for (const t of TOURS) {
    try {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true });
      const p = await ctx.newPage();
      await p.goto(`http://localhost:5173/?tour=${t}&play=1`, { waitUntil: "networkidle", timeout: 120000 });
      await p.waitForSelector(".player .idle", { timeout: 120000 });
      await p.waitForTimeout(2500);
      await p.screenshot({ path: `${OUT}/${t}-cover.png` });
      await p.click("button.travel");
      await p.waitForTimeout(9000);
      await p.screenshot({ path: `${OUT}/${t}-scene1.png` });
      await p.addStyleTag({ content: HIDE_HUD });
      await p.waitForTimeout(600);
      await p.screenshot({ path: `${OUT}/${t}-clean1.png` });
      await p.waitForTimeout(12000);
      await p.screenshot({ path: `${OUT}/${t}-clean2.png` });
      console.log(`ok   ${t}`);
      await ctx.close();
    } catch (e) {
      console.log(`FAIL ${t}: ${String(e).split("\n")[0].slice(0, 90)}`);
    }
  }
  await b.close();
})();
