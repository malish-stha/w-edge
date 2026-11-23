/**
 * Browser smoke test: opens the client, joins, flies around, saves screenshots
 * and fails on console errors. Usage: npx tsx scripts/smoke.ts <outDir> [url] [browserPath]
 */
import { chromium } from "playwright-core";

const out = process.argv[2] ?? "shots";
const url = process.argv[3] ?? "http://localhost:5173/";
const exe = process.argv[4] ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); else console.log(`[${m.type()}]`, m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

// A second player joins first, so the main page should see them.
const friendPage = await browser.newPage({ viewport: { width: 640, height: 360 } });
friendPage.on("pageerror", (e) => errors.push(`friend: ${e}`));
if (!url.includes("offline")) {
  await friendPage.goto(url);
  await friendPage.fill("#name", "Friend");
  await friendPage.click("#play");
  await friendPage.waitForSelector("#hud:not([hidden])", { timeout: 10000 });
}

await page.goto(url);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/0-start.png` });
await page.fill("#name", "Tester");
await page.click("#play");
await page.waitForSelector("#hud:not([hidden])", { timeout: 10000 });
await page.waitForTimeout(1500);
const status = await page.textContent("#status");
console.log("status:", status);
await page.screenshot({ path: `${out}/1-joined.png` });

const hold = async (key: string, ms: number) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
await hold("KeyW", 800);
await page.keyboard.press("Space"); await page.waitForTimeout(250); await page.keyboard.press("Space");
await hold("Space", 1500);
await page.screenshot({ path: `${out}/2-flying.png` });
console.log("after take-off:", await page.textContent("#mode"), await page.textContent("#altitude"), await page.textContent("#compass"));
await page.keyboard.down("KeyW"); await page.keyboard.down("ShiftLeft");
await page.waitForTimeout(2000);
console.log("boosting:", await page.textContent("#mode"), await page.textContent("#speed"));
await page.screenshot({ path: `${out}/3-boost.png` });
await page.keyboard.up("ShiftLeft"); await page.keyboard.up("KeyW");
await page.keyboard.press("F3");
await page.waitForTimeout(500);
console.log("debug:", await page.textContent("#debug"));
await page.screenshot({ path: `${out}/4-debug.png` });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
process.exit(errors.length ? 1 : 0);
