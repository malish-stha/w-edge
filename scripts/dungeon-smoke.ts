/**
 * Two browsers: party up through the party panel, ready up at the gate, enter
 * the Drowned Colossus, see each phase, clear it and return. Screenshots of each
 * step. Uses test accounts and dev helpers (XP, teleport, boss phase/health).
 * Usage: npx tsx scripts/dungeon-smoke.ts <outDir> [http://localhost:5173/] [browserPath]
 */
import { chromium, type Page } from "playwright-core";

const out = process.argv[2] ?? "shots";
const base = process.argv[3] ?? "http://localhost:5173/";
const exe = process.argv[4] ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4);
const errors: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "✔" : "✖"} ${what}`); if (!ok) errors.push(what); };

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

async function player(name: string, cls: string, size = { width: 1280, height: 720 }) {
  const page = await browser.newPage({ viewport: size });
  // A 522 is expected when returning: the old world copy closed and the client falls back to any open copy.
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("GL Driver") && !m.text().includes("522")) errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  await page.goto(`${base}?test`);
  await page.waitForSelector("#dev-account", { timeout: 15000 });
  await page.fill("#dev-account", `${name.toLowerCase()}${tag}`);
  await page.click("text=Continue with test account");
  await page.waitForSelector("#char-name");
  await page.fill("#char-name", `${name} ${tag}`);
  await page.click(`.choice:text-is("${cls}")`);
  await page.click("text=Create and play");
  await page.waitForSelector("#hud:not([hidden])", { timeout: 15000 });
  await page.keyboard.press("KeyH");
  return page;
}
const we = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__we[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const waitFor = async (page: Page, fn: string, pred: (v: any) => boolean, ms = 10000) => {
  for (let t = 0; t < ms; t += 200) { if (pred(await we(page, fn))) return true; await page.waitForTimeout(200); }
  return false;
};

const lead = await player("Lead", "Lancer");
const mate = await player("Mate", "Vanguard", { width: 800, height: 450 });

// Invite through the party panel.
await lead.keyboard.press("KeyP");
await lead.waitForSelector("#party-panel:not([hidden])");
// Other players may be around (e.g. from earlier test runs): invite the teammate by name.
const mateInvite = lead.locator("#party-nearby li", { hasText: `Mate ${tag}` }).locator("button");
await mateInvite.waitFor({ timeout: 8000 });
await lead.screenshot({ path: `${out}/d1-party-panel.png` });
await mateInvite.click();
await mate.waitForTimeout(600);
await mate.keyboard.press("KeyY");
check(await waitFor(lead, "roster", (r) => r?.members?.length === 2), "invite through the panel + Y forms a party");
await lead.waitForTimeout(400);
await lead.screenshot({ path: `${out}/d2-party-formed.png` });
await lead.click("#party-close");

// Level up (test helper) and meet at the gate.
for (const p of [lead, mate]) await we(p, "send", "dev:xp", { amount: 500 });
const gate = { x: 0, y: -89, z: -1484 };
await we(lead, "teleport", gate.x - 1.5, gate.y, gate.z + 4);
await we(mate, "teleport", gate.x + 1.5, gate.y, gate.z + 4);
await lead.waitForTimeout(1500);
await we(lead, "look", Math.PI, -0.1);
await lead.waitForTimeout(300);
await lead.screenshot({ path: `${out}/d3-gate.png` });
check((await lead.textContent("#prompt"))?.includes("Lead your party") ?? false, "the leader sees the gate prompt");
await lead.keyboard.press("KeyE");
await mate.waitForTimeout(800);
await mate.keyboard.press("KeyY");
check(await waitFor(lead, "place", (p) => p === "colossus", 15000), "the leader is moved into the dungeon");
check(await waitFor(mate, "place", (p) => p === "colossus", 15000), "so is the teammate");
await lead.waitForTimeout(2500);
await we(lead, "look", Math.PI, 0.05);
await lead.waitForTimeout(500);
await lead.screenshot({ path: `${out}/d4-arena.png` });
check(await lead.isVisible("#boss"), "the boss bar shows");

// Phase 2: the wave.
await we(lead, "send", "dev:boss", { phase: 1 });
await waitFor(lead, "boss", (b) => b?.wave > 0.15, 15000);
await lead.screenshot({ path: `${out}/d5-wave.png` });

// Phase 3: from the chest ledge, break the plate.
await we(lead, "send", "dev:boss", { phase: 2 });
await we(lead, "teleport", 0, 11.6, 6);
await lead.waitForTimeout(900);
await we(lead, "look", Math.PI, 0.35);
for (let i = 0; i < 6; i++) { await lead.keyboard.press("KeyF"); await lead.waitForTimeout(350); }
await lead.screenshot({ path: `${out}/d6-heart-phase.png` });

// Phase 4: the heart in flight, then the clear.
await we(lead, "send", "dev:boss", { phase: 3 });
await lead.waitForTimeout(1500);
const enemies = await we<any[]>(lead, "enemies");
const heart = enemies.find((e) => e.kind === "heart");
await we(lead, "teleport", heart.x, heart.y + 9, heart.z + 14);
await lead.waitForTimeout(700);
await we(lead, "look", Math.PI, -0.3);
await lead.waitForTimeout(300);
await lead.screenshot({ path: `${out}/d7-flight.png` });
await we(lead, "send", "dev:boss", { hp: 0.01 });
for (let i = 0; i < 25 && (await we<any>(lead, "boss"))?.phase !== 4; i++) {
  const h = (await we<any[]>(lead, "enemies")).find((e) => e.kind === "heart");
  await we(lead, "teleport", h.x, h.y + 1, h.z + 3.5);
  await we(lead, "look", Math.PI, 0.3);
  await lead.waitForTimeout(250);
  await lead.keyboard.press("KeyF");
  await lead.waitForTimeout(250);
}
check(await waitFor(lead, "boss", (b) => b?.phase === 4, 5000), "the Colossus is defeated");
await we(lead, "teleport", 0, 9, 84);
await lead.waitForTimeout(1500);
await lead.screenshot({ path: `${out}/d8-cleared.png` });
check((await lead.textContent("#prompt"))?.includes("Return to the world") ?? false, "the exit prompt appears on the entry platform");
await lead.keyboard.press("KeyE");
check(await waitFor(lead, "place", (p) => p === "world", 15000), "pressing E returns to the world");
await lead.waitForTimeout(2000);
await lead.screenshot({ path: `${out}/d9-home.png` });

console.log("errors:", errors.length ? errors : "none");
await browser.close();
process.exit(errors.length ? 1 : 0);
