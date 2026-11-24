/**
 * Browser smoke test of the whole first-session flow with test accounts:
 * sign in → create a character → play → see a second player → sign out →
 * sign back in → the character and its position are still there.
 *
 * Usage (server + client dev servers running):
 *   npx tsx scripts/smoke.ts <outDir> [http://localhost:5173/] [browserPath]
 */
import { BROWSER_ARGS } from "./browser-args.ts";
import { chromium, type Page } from "playwright-core";

const out = process.argv[2] ?? "shots";
const base = process.argv[3] ?? "http://localhost:5173/";
const exe = process.argv[4] ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const url = `${base}${base.includes("?") ? "&" : "?"}test`;
const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4);

const browser = await chromium.launch({ executablePath: exe, headless: true, args: BROWSER_ARGS });
const errors: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "✔" : "✖"} ${what}`); if (!ok) errors.push(what); };

async function open(name: string, size = { width: 1280, height: 720 }) {
  const page = await browser.newPage({ viewport: size });
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("GL Driver")) errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  await page.goto(url);
  return page;
}

async function signIn(page: Page, account: string) {
  await page.waitForSelector("#dev-account", { timeout: 15000 });
  await page.fill("#dev-account", account);
  await page.click("text=Continue with test account");
}

async function create(page: Page, name: string, origin: string, cls: string) {
  await page.waitForSelector("#char-name", { timeout: 10000 });
  await page.fill("#char-name", name);
  await page.click(`.choice:text-is("${origin}")`);
  await page.click(`.choice:text-is("${cls}")`);
}

const pos = async (page: Page) => {
  const text = (await page.textContent("#debug")) ?? "";
  const m = text.match(/pos (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)/);
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};

// Player two: a Stonekin Vanguard waiting in the world.
const friend = await open("friend", { width: 640, height: 360 });
await signIn(friend, `bob${tag}`);
await create(friend, `Bob ${tag}`, "Stonekin", "Vanguard");
await friend.click("text=Create and play");
await friend.waitForSelector("#hud:not([hidden])", { timeout: 15000 });

// Player one.
const page = await open("main");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/0-sign-in.png` });
await signIn(page, `alice${tag}`);
await create(page, `Alice ${tag}`, "Skyborn", "Archer");
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/1-create.png` });
await page.click("text=Create and play");
await page.waitForSelector("#hud:not([hidden])", { timeout: 15000 });
await page.waitForTimeout(1500);
check((await page.textContent("#status"))?.includes("2 players") ?? false, "both players are in the same world");
check((await page.textContent("#who"))?.includes("Skyborn Archer") ?? false, "HUD shows the character");
await page.screenshot({ path: `${out}/2-world.png` });

// Fly off and land somewhere new.
const hold = async (key: string, ms: number) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
await page.keyboard.press("F3");
await page.keyboard.press("Space"); await page.waitForTimeout(250); await page.keyboard.press("Space");
await hold("Space", 1200);
await page.keyboard.down("KeyW"); await page.waitForTimeout(1500); await page.keyboard.up("KeyW");
await page.screenshot({ path: `${out}/3-flying.png` });
await hold("KeyC", 4000);
await page.waitForTimeout(500);
const landed = await pos(page);
console.log("landed at", landed, await page.textContent("#mode"));

// Sign out, sign back in: same character, same place.
await page.evaluate(() => (document.getElementById("menu-signout") as HTMLButtonElement).click());
await signIn(page, `alice${tag}`);
await page.waitForSelector("#screen .character", { timeout: 10000 });
check((await page.textContent("#screen .characters"))?.includes(`Alice ${tag}`) ?? false, "character is listed after signing back in");
await page.screenshot({ path: `${out}/4-characters.png` });
await page.click("#screen .character >> text=Play");
await page.waitForSelector("#hud:not([hidden])", { timeout: 15000 });
await page.waitForTimeout(1500);
await page.keyboard.press("F3");
const resumed = await pos(page);
console.log("resumed at", resumed);
check(!!landed && !!resumed && Math.hypot(landed.x - resumed.x, landed.z - resumed.z) < 4, "resumes where it landed");
await page.screenshot({ path: `${out}/5-resumed.png` });

console.log("errors:", errors.length ? errors : "none");
await browser.close();
process.exit(errors.length ? 1 : 0);
