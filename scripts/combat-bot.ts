/**
 * Headless combat check against a running dev server (uses test accounts and the
 * dev teleport): hit the training dummy, awaken the mantle at the shrine, fight
 * Reef Wretches with attacks + Undertow, and land a Horizon Break dive.
 *
 * Usage: npx tsx scripts/combat-bot.ts [http://localhost:2567]
 */
import { Client, Callbacks } from "@colyseus/sdk";
import { Buttons, ROOM_WORLD, STEP_SECONDS, type CharacterSummary, type Fx } from "@worlds-edge/shared";

const base = (process.argv[2] ?? "http://localhost:2567").replace(/^ws/, "http");
const results: string[] = [];
const check = (ok: boolean, what: string) => { results.push(`${ok ? "✔" : "✖"} ${what}`); console.log(results.at(-1)); };

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${body.error}`);
  return body as T;
}

const account = `fighter${Date.now().toString(36)}`;
const { token } = await api<{ token: string }>("/auth/dev", { method: "POST", body: JSON.stringify({ player: account }) });
const { character } = await api<{ character: CharacterSummary }>("/characters", {
  method: "POST", token,
  body: JSON.stringify({
    name: `Tide ${account.replace(/[^a-z]/g, "").slice(-6)}`, origin: "harbourfolk", classId: "lancer", mantle: "tide",
    appearance: { skin: "#e9b48a", hair: "#2b2f3a", outfit: "#2ec4b6" },
  }),
});

const client = new Client(base);
client.auth.token = token;
const room = await client.joinOrCreate(ROOM_WORLD, { characterId: character.id });
await new Promise<void>((r) => Callbacks.get(room).onAdd("players" as never, (_p: unknown, k: unknown) => { if (k === room.sessionId) r(); }, true));
const state = room.state as any;
const me = state.players.get(room.sessionId);
const fx: Fx[] = [];
const notices: string[] = [];
room.onMessage("fx", (list: Fx[]) => fx.push(...list));
room.onMessage("notice", (text: string) => { notices.push(text); console.log("  notice:", text); });

const input = room.input({ mode: "reliable" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function send(n: number, make: () => { moveX?: number; moveZ?: number; yaw?: number; pitch?: number; buttons?: number }) {
  for (let i = 0; i < n; i++) {
    const c = make();
    input.data.moveX = c.moveX ?? 0; input.data.moveZ = c.moveZ ?? 0;
    input.data.yaw = Math.fround(c.yaw ?? 0); input.data.pitch = Math.fround(c.pitch ?? 0); input.data.buttons = c.buttons ?? 0;
    input.send();
    await sleep(1000 * STEP_SECONDS);
  }
}
async function teleport(x: number, y: number, z: number) {
  room.send("dev:teleport", { x, y, z });
  await send(20, () => ({}));
}
const enemy = (id: string) => state.enemies.get(id);
const yawTo = (x: number, z: number) => Math.atan2(x - me.x, z - me.z);
let tick = 0;
const attackEvery = (n: number) => (tick++ % n === 0 ? Buttons.AttackPressed : 0);

// 1. Training dummy (e0 at -66, 38).
await teleport(-66, 4, 35.5);
const dummyHp = enemy("e0").hp;
await send(45, () => ({ yaw: yawTo(-66, 38), buttons: attackEvery(4) }));
const hits = fx.filter((f) => f.t === "hit").length;
check(enemy("e0").hp < dummyHp && hits >= 3, `basic attacks hit the dummy (${hits} hits, hp ${dummyHp} → ${Math.round(enemy("e0").hp)})`);

// 2. Mantle skill is locked until the shrine.
await send(2, () => ({ buttons: Buttons.Ability1Pressed }));
await sleep(200);
check(notices.some((n) => n.includes("dormant")), "mantle skill is locked before the shrine");
await teleport(-45, 4, 27);
await send(2, () => ({ buttons: Buttons.InteractPressed }));
await sleep(300);
check(me.mantleAwakened === 1, "interacting at the shrine awakens the mantle");

// 3. Fight the wretch pack on the first island.
await teleport(150, 22, -282);
const xpBefore = me.xp;
let pulled = false;
for (let i = 0; i < 30 * 25 && me.xp === xpBefore; i++) {
  // Face the nearest living wretch and keep attacking; open with Undertow.
  let best: any = null, bestD = Infinity;
  state.enemies.forEach((e: any) => { if (e.kind === "wretch" && e.state !== 6) { const d = Math.hypot(e.x - me.x, e.z - me.z); if (d < bestD && d < 40) { best = e; bestD = d; } } });
  if (!best) break;
  const buttons = (!pulled && bestD < 12 ? Buttons.Ability1Pressed : 0) | (bestD < 3.5 ? attackEvery(3) : 0);
  if (buttons & Buttons.Ability1Pressed) pulled = true;
  await send(1, () => ({ yaw: yawTo(best.x, best.z), moveZ: bestD > 2.5 ? 100 : 0, buttons }));
  if (me.downTime > 0) await send(30 * 5, () => ({}));
}
check(fx.some((f) => f.t === "ring" && f.kind === "tide"), "Undertow fired");
check(me.xp > xpBefore, `killing a wretch gives XP (${xpBefore} → ${me.xp}, level ${me.level})`);

// Stand still next to a wretch: it should telegraph, then lunge.
{
  let w: any = null;
  state.enemies.forEach((e: any) => { if (!w && e.kind === "wretch" && e.state !== 6 && e.x > 100) w = e; });
  if (w) {
    const mark = fx.length;
    await teleport(w.x + 1.5, w.y + 0.5, w.z + 1.5);
    await send(30 * 4, () => ({}));
    const seen = fx.slice(mark);
    check(seen.some((f) => f.t === "ring" && f.kind === "telegraph"), "a wretch telegraphs before lunging");
    check(seen.some((f) => f.t === "hurt" && f.id === room.sessionId), `the lunge hurts (hp now ${Math.round(me.hp)})`);
  }
}

// Stand in front of the Hullbreaker: it should charge, then expose its back.
{
  const hb = enemy("e6");
  const mark = fx.length;
  let sawExposed = false;
  await teleport(hb.x + Math.sin(hb.facing) * 10, hb.y + 0.5, hb.z + Math.cos(hb.facing) * 10);
  for (let i = 0; i < 30 * 8 && !sawExposed; i++) {
    await send(1, () => ({}));
    if (hb.state === 5) sawExposed = true;
  }
  const seen = fx.slice(mark);
  check(seen.some((f) => f.t === "hurt" && f.id === room.sessionId && f.n === 25), "the Hullbreaker's charge hits for 25");
  check(sawExposed, "the Hullbreaker exposes its back after charging");
  // Its shield blocks a frontal attack (once it has recovered and turned to face us).
  for (let i = 0; i < 30 * 4 && (hb.state === 5 || hb.state === 4); i++) await send(1, () => ({}));
  const front = fx.length;
  for (let tries = 0; tries < 6 && !fx.slice(front).some((f) => f.t === "hit" && f.blocked); tries++) {
    // Step right in front of it (it keeps moving), swing, and let the swing play out.
    await teleport(hb.x + Math.sin(hb.facing) * 2.2, hb.y + 0.5, hb.z + Math.cos(hb.facing) * 2.2);
    await send(1, () => ({ yaw: yawTo(hb.x, hb.z), buttons: Buttons.AttackPressed }));
    await send(10, () => ({ yaw: yawTo(hb.x, hb.z) }));
  }
  check(fx.slice(front).some((f) => f.t === "hit" && f.blocked), "the shield blocks frontal hits");
  await send(30 * 5, () => ({}));
}

// 4. Horizon Break: dive from above onto a wretch (boost and dive unlock at level 2).
room.send("dev:xp", { amount: 40 });
await send(10, () => ({}));
let target: any = null;
state.enemies.forEach((e: any) => { if (!target && e.kind === "wretch" && e.state !== 6) target = e; });
if (target) {
  await teleport(target.x, target.y + 45, target.z + 18);
  await send(1, () => ({ buttons: Buttons.JumpPressed }));
  await send(3, () => ({}));
  await send(1, () => ({ buttons: Buttons.JumpPressed }));
  const before = fx.length;
  for (let i = 0; i < 90; i++) {
    const d = Math.hypot(target.x - me.x, target.z - me.z);
    const pitch = -Math.atan2(me.y - target.y, Math.max(0.1, d));
    await send(1, () => ({ yaw: yawTo(target.x, target.z), pitch, moveZ: 100, buttons: Buttons.Boost }));
    if (fx.slice(before).some((f) => f.t === "ring" && f.kind === "impact")) break;
  }
  const impactHits = fx.slice(before).filter((f) => f.t === "hit").length;
  check(fx.slice(before).some((f) => f.t === "ring" && f.kind === "impact"), `dive impact landed (${impactHits} enemies hit)`);
}

await room.leave();
const failed = results.filter((r) => r.startsWith("✖")).length;
console.log(failed ? `${failed} check(s) failed` : "all combat checks passed");
process.exit(failed ? 1 : 0);
