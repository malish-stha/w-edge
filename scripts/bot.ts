/**
 * Headless test bot: signs in with a test account, makes a character if it has
 * none, joins the world, walks and takes off, then checks the server
 * acknowledged every input and agrees with local prediction.
 *
 * Usage: npx tsx scripts/bot.ts [http://localhost:2567] [account]
 */
import { Client, Callbacks } from "@colyseus/sdk";
import {
  Buttons, ROOM_WORLD, STEP_SECONDS, createMoveState, getWorld, randomDraft, stepMovement,
  type CharacterSummary, type MoveState,
} from "@worlds-edge/shared";

const base = (process.argv[2] ?? "http://localhost:2567").replace(/^ws/, "http").replace(/\/$/, "");
const account = process.argv[3] ?? "bot";
const world = getWorld();

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
  });
  const body = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(body as { error?: string }).error}`);
  return body as T;
}

const { token } = await api<{ token: string }>("/auth/dev", { method: "POST", body: JSON.stringify({ player: account }) });
let { characters } = await api<{ characters: CharacterSummary[] }>("/characters", { token });
if (characters.length === 0) {
  const name = `Bot ${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 5)}`;
  const { character } = await api<{ character: CharacterSummary }>("/characters", {
    method: "POST", token, body: JSON.stringify({ name, ...randomDraft() }),
  });
  characters = [character];
}
const character = characters[0];
console.log(`signed in as "${account}", playing ${character.name} (${character.origin} ${character.classId})`);

const client = new Client(base);
client.auth.token = token;
const room = await client.joinOrCreate(ROOM_WORLD, { characterId: character.id });
console.log("joined", room.roomId, "as", room.sessionId);

await new Promise<void>((resolve) => {
  Callbacks.get(room).onAdd("players" as never, (_p: unknown, key: unknown) => { if (key === room.sessionId) resolve(); }, true);
});
const me = (room.state as any).players.get(room.sessionId);
console.log("spawned at", me.x.toFixed(2), me.y.toFixed(2), me.z.toFixed(2));

const input = room.input({ mode: "reliable" });
const local: MoveState = createMoveState({ x: 0, y: 0, z: 0 });
for (const k of Object.keys(local) as (keyof MoveState)[]) (local as any)[k] = me[k];

const script = [
  { buttons: 0, moveZ: 0, n: 30 },
  { buttons: 0, moveZ: 100, n: 30 },
  { buttons: Buttons.JumpPressed, moveZ: 0, n: 1 },
  { buttons: 0, moveZ: 0, n: 6 },
  { buttons: Buttons.JumpPressed | Buttons.JumpHeld, moveZ: 0, n: 1 },
  { buttons: Buttons.JumpHeld, moveZ: 0, n: 60 },
  { buttons: Buttons.Descend, moveZ: 0, n: 150 },
];
let sent = 0;
for (const step of script) {
  for (let i = 0; i < step.n; i++) {
    input.data.moveX = 0; input.data.moveZ = step.moveZ; input.data.yaw = Math.fround(Math.PI); input.data.pitch = 0; input.data.buttons = step.buttons;
    const seq = input.send();
    const cmd = input.at(seq)!;
    stepMovement(local, { moveX: cmd.moveX, moveZ: cmd.moveZ, yaw: cmd.yaw, pitch: cmd.pitch, buttons: cmd.buttons }, STEP_SECONDS, world);
    sent++;
    await new Promise((r) => setTimeout(r, 1000 * STEP_SECONDS));
  }
}
for (let i = 0; i < 50 && input.lastProcessed < sent; i++) await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => setTimeout(r, 150));
console.log("sent", sent, "acked", input.lastProcessed);
console.log("server", me.x.toFixed(3), me.y.toFixed(3), me.z.toFixed(3), "mode", me.mode);
console.log("local ", local.x.toFixed(3), local.y.toFixed(3), local.z.toFixed(3), "mode", local.mode);
const err = Math.hypot(me.x - local.x, me.y - local.y, me.z - local.z);
console.log("prediction error (m):", err.toFixed(4));
await room.leave();
process.exit(err < 0.05 && input.lastProcessed === sent ? 0 : 1);
