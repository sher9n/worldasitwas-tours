const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const ok = (n, c, d = "") => console.log(`[p2] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  await page.goto("http://localhost:5173/?tour=tour_london_1850_flower_seller&play=1", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("tt.hintExplore"));
  await page.waitForSelector(".player .idle");
  await page.click("button.travel");
  let pass = true;
  // Arrival (no dots) must auto-advance to card 1 with no tap.
  let autoAdvanced = false;
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(600); if (await page.$(".poi")) { autoAdvanced = true; break; } }
  pass = ok("arrival auto-advances without a tap", autoAdvanced) && pass;
  // Dotted card gates: chevron + first-time hint appear, no advance while we wait.
  let chevron = null;
  for (let i = 0; i < 40 && !chevron; i++) { await page.waitForTimeout(500); chevron = await page.$(".edge-chevron.right"); }
  pass = ok("explore gate opens (right chevron)", Boolean(chevron)) && pass;
  pass = ok("first-time hint shown", Boolean(await page.$(".gate-hint"))) && pass;
  const imgBefore = await page.$eval(".slide img.bg, .slide video.bg", (el) => (el.currentSrc || "").split("/").pop());
  await page.waitForTimeout(3000);
  const imgAfter = await page.$eval(".slide img.bg, .slide video.bg", (el) => (el.currentSrc || "").split("/").pop());
  pass = ok("gate holds the card", imgBefore === imgAfter, `${imgBefore}`) && pass;
  const beckon = await page.$eval(".poi", (el) => el.className.includes("beckon"));
  pass = ok("dots beckon while gated", beckon) && pass;
  const parked = await page.$eval(".progress span.cur i", (el) => parseFloat(el.style.width));
  pass = ok("progress parks short of full", parked < 100, `${parked}%`) && pass;
  await page.screenshot({ path: "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/shots/p2-gate.png" });
  // Chevron advances; the next dotted card must NOT show the hint again.
  await chevron.click();
  await page.waitForTimeout(1000);
  let chevron2 = null;
  for (let i = 0; i < 40 && !chevron2; i++) { await page.waitForTimeout(500); chevron2 = await page.$(".edge-chevron.right"); }
  pass = ok("next dotted card gates too", Boolean(chevron2)) && pass;
  pass = ok("hint shows only once", !(await page.$(".gate-hint"))) && pass;
  pass = ok("back chevron present past the first card", Boolean(await page.$(".edge-chevron.left"))) && pass;
  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p2] FAIL", e.message); process.exit(1); });
