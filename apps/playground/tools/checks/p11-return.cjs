/**
 * Where a walk hands you back to.
 *
 * The player is opened two ways. Inside a WebView or an iframe the host owns
 * navigation and pops its own screen off `tour_left`. Opened as the whole page,
 * which is what the web app does, closing the walk used to land back on our own
 * cover: no back button, no other walks, nowhere to go.
 *
 * Both halves are checked here, because the second one is a redirect our domain
 * performs on a stranger's instruction, and an unbounded version of that is an
 * open redirect worth real money to a phishing campaign.
 *
 * Usage: node apps/playground/tools/checks/p11-return.cjs [baseUrl]
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");

const BASE = (process.argv[2] && process.argv[2].startsWith("http") ? process.argv[2] : process.env.BASE) || "http://localhost:5173";
const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const DEFAULT_RETURN = "https://app.worldasitwas.com/";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`[p11] ${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`);
};

/** Open the walk, begin it, then press the leave control. Returns where it landed. */
async function walkAndLeave(ctx, returnParam) {
  const page = await ctx.newPage();
  const url = `${BASE}/?tour=${TOUR}&play=1${returnParam ? `&return=${encodeURIComponent(returnParam)}` : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".player", { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.locator(".travel").first().click().catch(() => {});
  await page.waitForTimeout(3000);
  await page.locator('[aria-label="Leave the tour"]').first().click();
  await page.waitForTimeout(2500);
  const landed = page.url();
  await page.close();
  return landed;
}

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, hasTouch: true, isMobile: true });

  // localhost is on the allowlist, so it stands in for app.worldasitwas.com
  // without this check depending on a live site.
  const home = `${BASE}/?came-back=1`;
  const landed = await walkAndLeave(ctx, home);
  check("closing a walk hands the visitor back to where they came from", landed.includes("came-back=1"), landed);

  const hostile = await walkAndLeave(ctx, "https://evil.example.com/");
  check("a return address we do not recognise is refused, not followed", !hostile.includes("evil.example.com"), hostile);
  check("and the refusal falls back to the map rather than nowhere", hostile.startsWith(DEFAULT_RETURN), hostile);

  const noParam = await walkAndLeave(ctx, "");
  check("with no return address at all, the walk still leads somewhere", noParam.startsWith(DEFAULT_RETURN), noParam);

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`[p11] ${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("[p11] FAIL", e.message);
  process.exit(1);
});
