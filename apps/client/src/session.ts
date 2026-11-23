import { Callbacks, Client, Predict, type Room } from "@colyseus/sdk";
import type { CharacterLook } from "./render/character.ts";
import {
  PLAYER_MAX_HP, ROOM_WORLD, STEP_SECONDS,
  createMoveState, getWorld, stepMovement,
  type Fx, type MoveInput, type MoveState,
} from "@worlds-edge/shared";

const world = getWorld();

/** Everything the renderer and HUD need about one player this frame. */
export interface PlayerView extends CharacterLook {
  id: string;
  name: string;
  isSelf: boolean;
  /** Connection dropped; the server is holding their place. */
  away: boolean;
  mantle: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  facing: number;
  mode: number;
  stamina: number;
  exhausted: number;
  attackTime: number;
  attackCombo: number;
  downTime: number;
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  mantleAwakened: boolean;
  abilityCooldown: number;
}

export interface EnemyView {
  id: string;
  kind: string;
  x: number; y: number; z: number;
  facing: number;
  hp: number; maxHp: number;
  guard: number; maxGuard: number;
  state: number;
}

export interface Session {
  readonly kind: "online" | "offline";
  /** Advance the simulation for this frame; `sample` builds one fixed-step input. */
  frame(now: number, sample: () => MoveInput): void;
  players(): PlayerView[];
  enemies(): EnemyView[];
  self(): PlayerView | undefined;
  status(): string;
  /** Effects and notices from the server. */
  onFx?: (list: Fx[]) => void;
  onNotice?: (text: string) => void;
  dispose(): void | Promise<void>;
}

const MOVE_FIELDS = [
  "x", "y", "z", "vx", "vy", "vz", "mode", "stamina", "exhausted", "facing",
  "dodgeTime", "dodgeCooldown", "dodgeX", "dodgeZ", "safeX", "safeY", "safeZ",
  "attackTime", "attackCooldown", "attackCombo", "comboWindow", "downTime",
] as const satisfies readonly (keyof MoveState)[];

function copyMove(from: MoveState, to: MoveState) {
  for (const f of MOVE_FIELDS) to[f] = from[f];
}

/** Solo flight with the same movement code: no server, so no enemies or progress. */
export class OfflineSession implements Session {
  readonly kind = "offline";
  private state: MoveState;
  private prev: MoveState;
  private acc = 0;
  private last = -1;
  onFx?: (list: Fx[]) => void;
  onNotice?: (text: string) => void;

  constructor(private name: string, private look: CharacterLook & { mantle: string }, private reason: string, start?: MoveState) {
    this.state = createMoveState(world.spawn);
    if (start) copyMove(start, this.state);
    this.state.downTime = 0;
    this.prev = { ...this.state };
  }

  frame(now: number, sample: () => MoveInput) {
    if (this.last < 0) this.last = now;
    this.acc += Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    while (this.acc >= STEP_SECONDS) {
      copyMove(this.state, this.prev);
      stepMovement(this.state, sample(), STEP_SECONDS, world);
      this.acc -= STEP_SECONDS;
    }
  }

  self(): PlayerView {
    const a = this.acc / STEP_SECONDS;
    const s = this.state, p = this.prev;
    const lerp = (k: "x" | "y" | "z") => p[k] + (s[k] - p[k]) * a;
    return {
      id: "self", name: this.name, isSelf: true, away: false, ...this.look,
      x: lerp("x"), y: lerp("y"), z: lerp("z"),
      vx: s.vx, vy: s.vy, vz: s.vz,
      facing: s.facing, mode: s.mode, stamina: s.stamina, exhausted: s.exhausted,
      attackTime: s.attackTime, attackCombo: s.attackCombo, downTime: 0,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, level: 1, xp: 0, mantleAwakened: false, abilityCooldown: 0,
    };
  }

  players() { return [this.self()]; }
  enemies() { return []; }
  status() { return `Solo · ${this.reason}`; }
  dispose() {}
}

/**
 * Online play. The local player is predicted with the shared movement code and
 * reconciled against the server; everyone else is interpolated ~100 ms behind.
 */
export class OnlineSession implements Session {
  readonly kind = "online";
  private predict: Predict<any>;
  private input: ReturnType<Room["input"]>;
  private me: ReturnType<Predict<any>["reconciler"]>;
  private selfSchema: any;
  private reconnecting = false;
  onFx?: (list: Fx[]) => void;
  onNotice?: (text: string) => void;
  /** Called once if the connection is lost for good, with our last predicted state. */
  onDisconnect?: (last: MoveState, reason: string) => void;

  private constructor(private room: Room, selfSchema: any) {
    this.selfSchema = selfSchema;
    this.predict = Predict.get(room, { mode: "lerp", delay: 100 });
    this.predict.attachAll("players", { fields: ["x", "y", "z", "vx", "vy", "vz"] });
    this.predict.attachAll("enemies", { fields: ["x", "y", "z"] });
    this.input = room.input({ mode: "reliable" });
    this.me = this.predict.reconciler(selfSchema, {
      input: this.input,
      fields: MOVE_FIELDS,
      step: (ctx, state, command) => stepMovement(state as MoveState, command as MoveInput, ctx.dt, world),
    });
    room.onMessage("fx", (list: Fx[]) => this.onFx?.(list));
    room.onMessage("notice", (text: string) => this.onNotice?.(text));
    // The SDK retries dropped connections itself; onLeave means the room is gone for good.
    room.onDrop(() => { this.reconnecting = true; });
    room.onReconnect(() => { this.reconnecting = false; });
    room.onLeave((code) => {
      this.onDisconnect?.({ ...(this.me.state as MoveState) }, code === 1000 ? "left the world" : `disconnected (${code})`);
    });
  }

  static async connect(url: string, token: string, characterId: number, timeoutMs = 8000): Promise<OnlineSession> {
    const client = new Client(url);
    client.auth.token = token;
    const join = client.joinOrCreate(ROOM_WORLD, { characterId });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs));
    const room = await Promise.race([join, timeout]);
    const selfSchema = await new Promise<any>((resolve) => {
      Callbacks.get(room).onAdd("players" as never, (player: unknown, key: unknown) => {
        if (key === room.sessionId) resolve(player);
      }, true);
    });
    return new OnlineSession(room, selfSchema);
  }

  frame(now: number, sample: () => MoveInput) {
    // Send the inputs that are due first, then read render values (SDK requirement).
    const due = this.predict.tick(now);
    for (let i = 0; i < due; i++) {
      const cmd = sample();
      const d = this.input.data as MoveInput;
      d.moveX = cmd.moveX; d.moveZ = cmd.moveZ; d.yaw = cmd.yaw; d.pitch = cmd.pitch; d.buttons = cmd.buttons;
      this.input.send();
    }
  }

  private view(id: string, p: any): PlayerView {
    const isSelf = id === this.room.sessionId;
    const logic = isSelf ? (this.me.state as MoveState) : p;
    return {
      id, name: p.name, isSelf, away: p.away === 1,
      classId: p.classId, origin: p.origin, skin: p.skin, hair: p.hair, outfit: p.outfit, mantle: p.mantle,
      x: this.predict.value(p, "x"), y: this.predict.value(p, "y"), z: this.predict.value(p, "z"),
      vx: logic.vx, vy: logic.vy, vz: logic.vz,
      facing: logic.facing, mode: logic.mode, stamina: logic.stamina, exhausted: logic.exhausted,
      attackTime: logic.attackTime, attackCombo: logic.attackCombo, downTime: logic.downTime,
      hp: p.hp, maxHp: p.maxHp, level: p.level, xp: p.xp, mantleAwakened: p.mantleAwakened === 1, abilityCooldown: p.abilityCooldown,
    };
  }

  players(): PlayerView[] {
    const out: PlayerView[] = [];
    (this.room.state as any).players.forEach((p: any, id: string) => out.push(this.view(id, p)));
    return out;
  }

  enemies(): EnemyView[] {
    const out: EnemyView[] = [];
    (this.room.state as any).enemies.forEach((e: any, id: string) => out.push({
      id, kind: e.kind,
      x: this.predict.value(e, "x"), y: this.predict.value(e, "y"), z: this.predict.value(e, "z"),
      facing: e.facing, hp: e.hp, maxHp: e.maxHp, guard: e.guard, maxGuard: e.maxGuard, state: e.state,
    }));
    return out;
  }

  self(): PlayerView {
    return this.view(this.room.sessionId, this.selfSchema);
  }

  /** Test accounts only: jump somewhere (used by playtests and automated checks). */
  devTeleport(x: number, y: number, z: number) {
    this.room.send("dev:teleport", { x, y, z });
  }

  status() {
    if (this.reconnecting) return "Connection lost · reconnecting…";
    const count = (this.room.state as any).players.size as number;
    const rtt = Math.round(this.room.clock.smoothedRtt());
    return `Online · ${count} ${count === 1 ? "player" : "players"} here · ${rtt} ms`;
  }

  /** Leave the world; resolves once the server has saved and released the character. */
  async dispose() {
    this.room.onLeave.clear();
    await this.room.leave().catch(() => {});
  }
}
