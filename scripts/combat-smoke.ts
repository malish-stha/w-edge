/**
 * Browser check of the combat slice with screenshots: training dummy, shrine,
 * Reef Wretches with Undertow, and the Hullbreaker. Needs dev server + client.
 * Usage: npx tsx scripts/combat-smoke.ts <outDir> [http://localhost:5173/] [browserPath]
 */
import { chromium, type Page } from "playwright-core";

const out = process.argv[2] ?? "shots";
const base = process.argv[3] ?? "http://localhost:5173/";
const exe = process.argv[4] ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4);
const errors: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "✔" : "✖"} ${what}`); if (!ok) errors.push(what); };

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("GL Driver")) errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}?test`);

await page.waitForSelector("#dev-account", { timeout: 15000 });
await page.fill("#dev-account", `lancer${tag}`);
await page.click("text=Continue with test account");
await page.waitForSelector("#char-name");
await page.fill("#char-name", `Lancer ${tag}`);
await page.click('.choice:text-is("Harbourfolk")');
await page.click('.choice:text-is("Lancer")');
await page.click('.choice:text-is("Tide")');
await page.click("text=Create and play");
await page.waitForSelector("#hud:not([hidden])", { timeout: 15000 });
await page.keyboard.press("KeyH"); // hide help for cleaner shots

const we = <T>(fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__we[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const self = () => we<any>("self");
const enemies = () => we<any[]>("enemies");
async function teleport(x: number, y: number, z: number) { await we("teleport", x, y, z); await page.waitForTimeout(700); }
async function face(x: number, z: number, pitch = -0.25) {
  const me = await self();
  await we("look", Math.atan2(x - me.x, z - me.z), pitch);
}
async function attack(times: number, gap = 380) {
  for (let i = 0; i < times; i++) { await page.keyboard.press("KeyF"); await page.waitForTimeout(gap); }
}

// Training dummy.
await teleport(-66, 4, 34.5);
await face(-66, 38);
await attack(4);
const dummy = (await enemies()).find((e) => e.kind === "dummy" && Math.abs(e.z - 38) < 1);
check(!!dummy && dummy.hp < dummy.maxHp, `dummy takes hits (${dummy && Math.round(dummy.hp)}/${dummy?.maxHp})`);
await page.screenshot({ path: `${out}/c1-dummy.png` });

// Shrine.
await teleport(-45, 4, 26);
await face(-45, 30, -0.1);
await page.waitForTimeout(300);
check(await page.isVisible("#prompt"), "shrine shows an awaken prompt");
await page.screenshot({ path: `${out}/c2-shrine-prompt.png` });
await page.keyboard.press("KeyE");
await page.waitForTimeout(600);
check((await self()).mantleAwakened === true, "pressing E awakens the mantle");
await page.screenshot({ path: `${out}/c3-awakened.png` });

// Reef Wretches on the first island.
await teleport(150, 22, -280);
const wretch = (await enemies()).filter((e) => e.kind === "wretch" && e.x > 100).sort((a, b) => a.z - b.z)[0];
await face(wretch.x, wretch.z);
await page.waitForTimeout(1200);
await page.keyboard.press("Digit1");
await page.waitForTimeout(450);
await page.screenshot({ path: `${out}/c4-undertow.png` });
for (let i = 0; i < 12; i++) {
  const list = (await enemies()).filter((e) => e.kind === "wretch" && e.x > 100 && e.state !== 6);
  if (!list.length) break;
  const me = await self();
  const t = list.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
  await face(t.x, t.z);
  await attack(1, 330);
  if (i === 4) await page.screenshot({ path: `${out}/c5-fight.png` });
}
check((await self()).xp > 0, `fighting wretches earns XP (${(await self()).xp})`);

// The Hullbreaker charges, then exposes its back.
const hb = (await enemies()).find((e) => e.kind === "hullbreaker")!;
await teleport(hb.x + Math.sin(hb.facing) * 11, hb.y + 1, hb.z + Math.cos(hb.facing) * 11);
await face(hb.x, hb.z, -0.15);
let exposedShot = false;
for (let i = 0; i < 40 && !exposedShot; i++) {
  await page.waitForTimeout(150);
  const h = (await enemies()).find((e) => e.kind === "hullbreaker")!;
  if (h.state === 2 && i < 30) await page.screenshot({ path: `${out}/c6-hull-telegraph.png` });
  if (h.state === 5) {
    const me = await self();
    await teleport(h.x - Math.sin(h.facing) * 3.5, h.y + 1, h.z - Math.cos(h.facing) * 3.5);
    await face(h.x, h.z, -0.2);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${out}/c7-hull-exposed.png` });
    exposedShot = true;
    void me;
  }
}
check(exposedShot, "the Hullbreaker exposes its back after charging");

console.log("errors:", errors.length ? errors : "none");
await browser.close();
process.exit(errors.length ? 1 : 0);
