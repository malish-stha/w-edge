/**
 * Two headless players run the whole party + Drowned Colossus flow against a dev
 * server: invite/accept, ready check at the gate, transfer into a private dungeon,
 * all four phases, a mid-fight disconnect + reconnect, the clear reward, and the
 * return to the overworld. Uses test accounts and dev helpers (teleport, XP, boss HP).
 *
 * Usage: npx tsx scripts/dungeon-bot.ts [http://localhost:2567]
 */
import { Client, Callbacks, type Room } from "@colyseus/sdk";
import {
  ANCHORS, BossPhase, Buttons, COLOSSUS, ROOM_WORLD, STEP_SECONDS, type CharacterSummary, type Fx,
} from "@worlds-edge/shared";

const base = (process.argv[2] ?? "http://localhost:2567").replace(/^ws/, "http");
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "✔" : "✖"} ${what}`); if (!ok) failures.push(what); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, step = 50) {
  for (let t = 0; t < ms && !cond(); t += step) await sleep(step);
  return cond();
}

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${body.error}`);
  return body as T;
}

class Bot {
  client!: Client;
  room!: Room;
  token!: string;
  character!: CharacterSummary;
  fx: Fx[] = [];
  notices: string[] = [];
  messages: Array<[string, any]> = [];
  input!: ReturnType<Room["input"]>;
  get state() { return this.room.state as any; }
  get me() { return this.state.players.get(this.room.sessionId); }

  constructor(readonly label: string) {}

  async create(classId: string, mantle: string) {
    const account = `${this.label}${Date.now().toString(36)}`;
    ({ token: this.token } = await api<{ token: string }>("/auth/dev", { method: "POST", body: JSON.stringify({ player: account }) }));
    const name = `${this.label} ${account.replace(/[^a-z]/g, "").slice(-5)}`;
    ({ character: this.character } = await api<{ character: CharacterSummary }>("/characters", {
      method: "POST", token: this.token,
      body: JSON.stringify({ name, origin: "skyborn", classId, mantle, appearance: { skin: "#e9b48a", hair: "#2b2f3a", outfit: "#669bbc" } }),
    }));
    this.client = new Client(base);
    this.client.auth.token = this.token;
  }

  private async attach(room: Room) {
    this.room = room;
    await new Promise<void>((r) => Callbacks.get(room).onAdd("players" as never, (_p: unknown, k: unknown) => { if (k === room.sessionId) r(); }, true));
    room.onMessage("fx", (list: Fx[]) => this.fx.push(...list));
    room.onMessage("notice", (t: string) => this.notices.push(t));
    for (const type of ["party", "party:invite", "ready-check", "transfer", "cleared"]) room.onMessage(type, (m: unknown) => this.messages.push([type, m]));
    this.input = room.input({ mode: "reliable" });
  }

  async joinWorld() { await this.attach(await this.client.joinOrCreate(ROOM_WORLD, { characterId: this.character.id })); }
  async joinById(roomId: string) { await this.attach(await this.client.joinById(roomId, { characterId: this.character.id })); }
  async leave() { await this.room.leave(); }
  last(type: string) { return [...this.messages].reverse().find(([t]) => t === type)?.[1]; }

  send(c: { moveZ?: number; yaw?: number; pitch?: number; buttons?: number } = {}) {
    const d = this.input.data as any;
    d.moveX = 0; d.moveZ = c.moveZ ?? 0; d.yaw = Math.fround(c.yaw ?? 0); d.pitch = Math.fround(c.pitch ?? 0); d.buttons = c.buttons ?? 0;
    this.input.send();
  }
  teleport(x: number, y: number, z: number) { this.room.send("dev:teleport", { x, y, z }); }
  yawTo(x: number, z: number) { return Math.atan2(x - this.me.x, z - this.me.z); }
}

/** Drive both bots at the simulation rate for `steps` steps. */
async function run(bots: Bot[], steps: number, make: (b: Bot, i: number) => Parameters<Bot["send"]>[0]) {
  for (let i = 0; i < steps; i++) {
    for (const b of bots) b.send(make(b, i));
    await sleep(1000 * STEP_SECONDS);
  }
}

const a = new Bot("Lead");
const b = new Bot("Mate");
await a.create("lancer", "tide");
await b.create("archer", "storm");
await a.joinWorld();
await b.joinWorld();
check(a.room.roomId === b.room.roomId, "both players share a world copy");

// Party up.
a.room.send("party:invite", { sessionId: b.room.sessionId });
check(await until(() => !!b.last("party:invite"), 2000), "invitee receives the invitation");
b.room.send("party:accept");
check(await until(() => a.last("party")?.members?.length === 2 && b.last("party")?.members?.length === 2, 2000), "both see a two-member roster");
check(a.me.party !== "" && a.me.party === b.me.party, "both players carry the same party id");

// Level gate, then ready up at the gate.
const gate = COLOSSUS.gate;
a.teleport(gate.x, gate.y + 1, gate.z + 4); b.teleport(gate.x + 2, gate.y + 1, gate.z + 4);
await run([a, b], 20, () => ({}));
a.send({ buttons: Buttons.InteractPressed });
check(await until(() => a.notices.some((n) => n.includes("needs to reach level")), 1500), "the gate refuses under-levelled parties");
a.room.send("dev:xp", { amount: 500 }); b.room.send("dev:xp", { amount: 500 });
await run([a, b], 10, () => ({}));
check(a.me.level >= COLOSSUS.minLevel && b.me.level >= COLOSSUS.minLevel, `both reach level ${COLOSSUS.minLevel}`);
a.send({ buttons: Buttons.InteractPressed });
check(await until(() => !!b.last("ready-check"), 2000), "party members get a ready check");
b.room.send("party:ready");
check(await until(() => !!a.last("transfer") && !!b.last("transfer"), 3000), "everyone is sent to the same new dungeon");
const dungeonId = a.last("transfer").roomId;
const worldId = a.room.roomId;
await a.leave(); await b.leave();
await a.joinById(dungeonId); await b.joinById(dungeonId);
const boss = () => a.state.boss;
check(boss().phase === BossPhase.Anchors && boss().anchorsLeft === 3, "the dungeon starts at the anchors");
check(a.last("party")?.members?.length === 2, "the party survives the move into the dungeon");

// Strangers can't wander in.
{
  const c = new Bot("Stranger");
  await c.create("saber", "titan");
  let refused = false;
  try { await c.joinById(dungeonId); } catch { refused = true; }
  check(refused, "players outside the party can't join the dungeon");
}

// Revive: A goes down, B holds E next to them.
{
  const e0 = COLOSSUS.entry;
  a.teleport(e0.x, e0.y + 0.5, e0.z); b.teleport(e0.x + 1.5, e0.y + 0.5, e0.z);
  await run([a, b], 20, () => ({}));
  a.room.send("dev:down");
  check(await until(() => a.me.downTime > 0, 1500), "a player can go down");
  await run([a, b], 30 * 2.6, (bot) => (bot === b ? { buttons: Buttons.InteractHeld } : {}));
  check(a.me.downTime === 0 && a.me.hp > 0 && a.notices.some((n) => n.includes("revived you")), "holding E next to a downed teammate revives them");
}

// Wipe: break one anchor, then everyone goes down; the phase resets to its checkpoint.
{
  const anchor = ANCHORS[0];
  for (let tries = 0; tries < 40 && a.state.enemies.get("anchor0").state !== 6; tries++) {
    for (const bot of [a, b]) bot.teleport(anchor.x * 1.12, anchor.y + 0.6, anchor.z * 1.12);
    await run([a, b], 9, (bot, k) => ({ yaw: bot.yawTo(anchor.x, anchor.z), buttons: k % 9 === 8 ? Buttons.AttackPressed : 0 }));
  }
  check(boss().anchorsLeft === 2, "an anchor breaks");
  a.room.send("dev:down"); b.room.send("dev:down");
  check(await until(() => boss().anchorsLeft === 3, 2000), "a full party wipe restores the anchors (phase checkpoint)");
  // Clients keep sending input every frame; downed timers advance with it.
  for (let i = 0; i < 30 * 5 && !(a.me.downTime === 0 && b.me.downTime === 0); i++) await run([a, b], 1, () => ({}));
  await run([a, b], 30, () => ({}));
  check(a.me.downTime === 0 && b.me.downTime === 0, "everyone recovers after the wipe");
  check(Math.hypot(a.me.x - COLOSSUS.entry.x, a.me.z - COLOSSUS.entry.z) < 6, "…on the entry platform");
}

// Phase 1: break the anchors (B drops its connection and reconnects in the middle).
let reconnected = false;
for (const [i, anchor] of ANCHORS.entries()) {
  const id = `anchor${i}`;
  for (let tries = 0; tries < 40 && a.state.enemies.get(id).state !== 6; tries++) {
    for (const bot of [a, b]) bot.teleport(anchor.x * 1.12, anchor.y + 0.6, anchor.z * 1.12);
    await run([a, b], 9, (bot, k) => ({ yaw: bot.yawTo(anchor.x, anchor.z), buttons: k % 9 === 8 ? Buttons.AttackPressed : 0 }));
    if (i === 1 && !reconnected) {
      const token = b.room.reconnectionToken;
      const sid = b.room.sessionId;
      // Drop the connection without leaving. The SDK reconnects on its own (rooms
      // older than 5 s); otherwise reconnect manually with the token.
      let auto = false;
      b.room.onReconnect(() => { auto = true; });
      void b.room.leave(false); // resolves only if the room really ends, so don't wait on it
      if (!(await until(() => auto, 6000))) {
        const room = await b.client.reconnect(token);
        await (b as any).attach(room);
      }
      await run([a, b], 10, () => ({}));
      reconnected = b.room.sessionId === sid && !!b.me && boss().anchorsLeft < 3;
      check(reconnected, "a dropped player reconnects into the same dungeon with progress intact");
    }
  }
}
check(await until(() => boss().phase === BossPhase.Wave, 3000), "breaking all three anchors starts the wave");

// Phase 2: A stands on the entry platform (gets hit); B flies high above (stays dry).
const e = COLOSSUS.entry;
a.teleport(e.x - 3, e.y + 0.6, e.z);
b.teleport(e.x + 3, e.y + 0.6, e.z);
await run([a, b], 2, () => ({}));
b.send({ buttons: Buttons.JumpPressed }); await sleep(120);
await run([b], 4, () => ({}));
b.send({ buttons: Buttons.JumpPressed });
await run([b], 45, () => ({ buttons: Buttons.JumpHeld })); // climb above the wave
const waveMark = a.fx.length;
await until(() => boss().phase !== BossPhase.Wave, 30000, 100);
await run([a, b], 1, () => ({}));
const waveHurts = a.fx.slice(waveMark).filter((f) => f.t === "hurt");
const aId = a.room.sessionId, bId = b.room.sessionId;
check(waveHurts.some((f) => f.t === "hurt" && f.id === aId), "the wave hits a player standing in the open");
check(!waveHurts.some((f) => f.t === "hurt" && f.id === bId), "a player flying above the wave stays dry");
check(boss().phase === BossPhase.Heart, "after the waves the heart phase begins");

// Phase 3: break the chest plate from the ledge, then hit the exposed heart.
const h = COLOSSUS.heart;
const ledge = { x: 0, y: 11.6, z: 5.5 };
let exposedSeen = false, weakSeen = false;
for (let tries = 0; tries < 60 && boss().phase === BossPhase.Heart && !(exposedSeen && weakSeen); tries++) {
  a.teleport(ledge.x - 1, ledge.y, ledge.z); b.teleport(ledge.x + 1, ledge.y, ledge.z);
  const mark = a.fx.length;
  await run([a, b], 10, (bot, k) => ({ yaw: bot.yawTo(h.x, h.z), pitch: 0.4, buttons: k % 10 === 9 ? Buttons.AttackPressed : 0 }));
  if (boss().exposed > 0) exposedSeen = true;
  if (a.fx.slice(mark).some((f) => f.t === "hit" && f.weak)) weakSeen = true;
}
check(exposedSeen, "enough hits break the chest plate and expose the heart");
check(weakSeen, "hits on the exposed heart count as weak-point hits");

// Phase 4: bring it near the threshold, push it into flight, then finish it in the air.
a.room.send("dev:boss", { hp: 0.26 });
await run([a, b], 3, () => ({}));
for (let tries = 0; tries < 20 && boss().phase === BossPhase.Heart; tries++) {
  a.teleport(ledge.x, ledge.y, ledge.z);
  await run([a], 10, (bot, k) => ({ yaw: bot.yawTo(h.x, h.z), pitch: 0.4, buttons: k === 9 ? Buttons.AttackPressed : 0 }));
}
check(boss().phase === BossPhase.Flight, "dropping below a quarter health sends the heart into flight");
const xpBefore = [a.me.xp, b.me.xp];
a.room.send("dev:boss", { hp: 0.02 });
for (let tries = 0; tries < 40 && boss().phase !== BossPhase.Cleared; tries++) {
  const heart = a.state.enemies.get("heart");
  for (const bot of [a, b]) bot.teleport(heart.x, heart.y + 1, heart.z + 3.5);
  await run([a, b], 6, (bot, k) => ({ yaw: Math.PI, pitch: 0.3, buttons: k === 5 ? Buttons.AttackPressed : 0 }));
}
check(await until(() => boss().phase === BossPhase.Cleared, 3000), "the heart falls and the dungeon is cleared");
check(await until(() => !!a.last("cleared") && !!b.last("cleared"), 3000), "both players get the clear result");
check(a.me.xp === Math.min(65535, xpBefore[0] + COLOSSUS.clearXp) && b.me.xp === Math.min(65535, xpBefore[1] + COLOSSUS.clearXp), `each player gets +${COLOSSUS.clearXp} XP exactly once`);

// Back to the world, into the same copy, still partied.
a.room.send("dungeon:leave");
check(await until(() => a.last("transfer")?.kind === "world", 2000), "leaving sends the player home");
await a.leave();
// The old world copy closes if everyone left it; then any open copy will do.
try { await a.joinById(worldId); } catch { await a.joinWorld(); }
check(!!a.room, "they return to the world");
check(Math.hypot(a.me.x - gate.x, a.me.z - gate.z) < 20, "and arrive back at the gate");
check(a.last("party")?.members?.length === 2, "still in the party");

await a.leave(); await b.leave();
console.log(failures.length ? `${failures.length} check(s) failed` : "all party and dungeon checks passed");
process.exit(failures.length ? 1 : 0);
