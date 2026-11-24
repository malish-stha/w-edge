/**
 * Visual tour of the dressed areas: teleports a test character to each island
 * and saves a screenshot. Needs the dev server + client running.
 * Usage: npx tsx scripts/env-tour.ts <outDir> [http://localhost:5173/] [browserPath]
 */
import { BROWSER_ARGS } from "./browser-args.ts";
import { chromium } from "playwright-core";

const out = process.argv[2] ?? "shots";
const base = process.argv[3] ?? "http://localhost:5173/";
const exe = process.argv[4] ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4);
const errors: string[] = [];

const browser = await chromium.launch({ executablePath: exe, headless: true, args: BROWSER_ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("GL Driver")) errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}?test`);
await page.waitForSelector("#dev-account", { timeout: 15000 });
await page.fill("#dev-account", `tour${tag}`);
await page.click("text=Continue with test account");
await page.waitForSelector("#char-name");
await page.fill("#char-name", `Tourist ${tag}`);
await page.click("text=Create and play");
await page.waitForSelector("#hud:not([hidden])", { timeout: 15000 });
await page.keyboard.press("KeyH");

const we = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__we[f as string](...(a as unknown[])), [fn, args] as const);

// [name, teleport x, y, z, yaw, pitch]
const stops: Array<[string, number, number, number, number, number]> = [
  ["harbour", 0, 15, -70, 0, -0.3],
  ["harbour-west", -95, 5, -20, Math.PI * 0.5, -0.15],
  ["harbour-docks", 20, 5, 105, 0.3, -0.25],
  ["wretch-isle", 160, 21, -272, Math.PI, -0.2],
  ["pinecrest", 60, 43, -406, Math.PI, -0.2],
  ["castaway-camp", -110, 29, -360, Math.PI * 1.1, -0.2],
  ["farmstead", 140, 35, -680, Math.PI, -0.25],
  ["smugglers-cove", 30, 25, -950, Math.PI, -0.2],
  ["settlement", 0, -88, -1440, Math.PI, -0.1],
];
for (const [name, x, y, z, yaw, pitch] of stops) {
  await we("teleport", x, y, z);
  await we("look", yaw, pitch);
  await page.waitForTimeout(4500); // land and let the area's models load
  await page.screenshot({ path: `${out}/env-${name}.png` });
  console.log("shot", name);
}
console.log("errors:", errors.length ? errors : "none");
await browser.close();
