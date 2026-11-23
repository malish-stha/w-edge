import { Callbacks, Client, Predict, type Room } from "@colyseus/sdk";
import type { CharacterLook } from "./render/character.ts";
import {
  PLAYER_MAX_HP, ROOM_WORLD, STEP_SECONDS,
  createMoveState, defaultMantlePathFor, defaultTechniqueFor, getColossusArena, getWorld, stepMovement,
  type Fx, type MoveInput, type MoveState, type PingMessage, type World,
} from "@worlds-edge/shared";

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
  ability2Cooldown: number;
  exploreCooldown: number;
  ultCharge: number;
  giant: boolean;
  technique: string;
  mantlePath: string;
  questStep: number;
  guarding: boolean;
  classCharge: number;
  classCooldown: number;
  party: string;
  reviveProgress: number;
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

export interface BossView {
  phase: number;
  hp: number; maxHp: number;
  armour: number; maxArmour: number;
  exposed: number;
  anchorsLeft: number;
  wave: number; waveDirX: number; waveDirZ: number;
  slamX: number; slamZ: number; slamT: number;
  sweepT: number;
  objective: string;
}

export interface Roster {
  partyId: string;
  rally: { x: number; y: number; z: number } | null;
  targetId: string | null;
  members: Array<{ id: number; name: string; leader: boolean; roomId: string | null; sessionId: string | null }>;
}

export interface OnlinePlayerInfo {
  id: number;
  name: string;
  roomId: string;
  roomName: string;
  level: number;
  inParty: boolean;
}

export type Place = "solo" | "world" | "colossus";

/** Server messages the app reacts to (beyond effects and notices). */
export interface SessionEvents {
  onFx?: (list: Fx[]) => void;
  onNotice?: (text: string) => void;
  onParty?: (roster: Roster | null) => void;
  onInvite?: (from: string) => void;
  onReadyCheck?: (leader: string, seconds: number) => void;
  onTransfer?: (roomId: string, kind: "world" | "colossus") => void;
  onCleared?: (time: string, xp: number) => void;
  onPing?: (ping: PingMessage) => void;
  onOnlinePlayers?: (list: OnlinePlayerInfo[]) => void;
}

export interface Session extends SessionEvents {
  readonly kind: "online" | "offline";
  readonly place: Place;
  /** The geometry this session moves through. */
  readonly world: World;
  /** Advance the simulation for this frame; `sample` builds one fixed-step input. */
  frame(now: number, sample: () => MoveInput): void;
  players(): PlayerView[];
  enemies(): EnemyView[];
  boss(): BossView | null;
  self(): PlayerView | undefined;
  status(): string;
  dispose(): void | Promise<void>;
}

const MOVE_FIELDS = [
  "x", "y", "z", "vx", "vy", "vz", "mode", "stamina", "exhausted", "facing",
  "dodgeTime", "dodgeCooldown", "dodgeX", "dodgeZ", "safeX", "safeY", "safeZ",
  "attackTime", "attackCooldown", "attackCombo", "comboWindow", "downTime", "level",
] as const satisfies readonly (keyof MoveState)[];

function copyMove(from: MoveState, to: MoveState) {
  for (const f of MOVE_FIELDS) to[f] = from[f];
}

/** Solo flight with the same movement code: no server, so no enemies or progress. */
export class OfflineSession implements Session {
  readonly kind = "offline";
  readonly place = "solo";
  readonly world = getWorld();
  private state: MoveState;
  private prev: MoveState;
  private acc = 0;
  private last = -1;

  constructor(private name: string, private look: CharacterLook & { mantle: string }, private reason: string, start?: MoveState) {
    this.state = createMoveState(this.world.spawn);
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
      stepMovement(this.state, sample(), STEP_SECONDS, this.world);
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
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, level: 1, xp: 0, mantleAwakened: false,
      abilityCooldown: 0, ability2Cooldown: 0, exploreCooldown: 0, ultCharge: 0, giant: false,
      technique: defaultTechniqueFor(this.look.classId), mantlePath: defaultMantlePathFor(this.look.mantle), questStep: 2,
      guarding: false, classCharge: 0, classCooldown: 0,
      party: "", reviveProgress: 0,
    };
  }

  players() { return [this.self()]; }
  enemies() { return []; }
  boss() { return null; }
  status() { return `Solo · ${this.reason}`; }
  dispose() { }
}

/** Thrown when the server says this character belongs in a live dungeon. */
export class DungeonRedirect extends Error {
  constructor(readonly roomId: string) { super("Returning to your dungeon"); }
}

/**
 * Online play in the overworld or a dungeon. The local player is predicted
 * with the shared movement code and reconciled against the server; everyone
 * else is interpolated ~100 ms behind.
 */
export class OnlineSession implements Session {
  readonly kind = "online";
  readonly world: World;
  private predict: Predict<any>;
  private input: ReturnType<Room["input"]>;
  private me: ReturnType<Predict<any>["reconciler"]>;
  private selfSchema: any;
  private reconnecting = false;
  onFx?: SessionEvents["onFx"];
  onNotice?: SessionEvents["onNotice"];
  onParty?: SessionEvents["onParty"];
  onInvite?: SessionEvents["onInvite"];
  onReadyCheck?: SessionEvents["onReadyCheck"];
  onTransfer?: SessionEvents["onTransfer"];
  onCleared?: SessionEvents["onCleared"];
  onPing?: SessionEvents["onPing"];
  onOnlinePlayers?: SessionEvents["onOnlinePlayers"];
  /** Called once if the connection is lost for good, with our last predicted state. */
  onDisconnect?: (last: MoveState, reason: string) => void;
  /** Party roster messages that arrived before the app attached its handler. */
  roster: Roster | null = null;

  private constructor(private room: Room, selfSchema: any, readonly place: Place) {
    this.world = place === "colossus" ? getColossusArena() : getWorld();
    this.selfSchema = selfSchema;
    this.predict = Predict.get(room, { mode: "lerp", delay: 100 });
    this.predict.attachAll("players", { fields: ["x", "y", "z", "vx", "vy", "vz"] });
    this.predict.attachAll("enemies", { fields: ["x", "y", "z"] });
    this.input = room.input({ mode: "reliable" });
    const world = this.world;
    this.me = this.predict.reconciler(selfSchema, {
      input: this.input,
      fields: MOVE_FIELDS,
      step: (ctx, state, command) => stepMovement(state as MoveState, command as MoveInput, ctx.dt, world),
    });
    room.onMessage("fx", (list: Fx[]) => this.onFx?.(list));
    room.onMessage("notice", (text: string) => this.onNotice?.(text));
    room.onMessage("party", (r: Roster | null) => { this.roster = r; this.onParty?.(r); });
    room.onMessage("party:invite", (m: { from: string }) => this.onInvite?.(m.from));
    room.onMessage("ready-check", (m: { leader: string; seconds: number }) => this.onReadyCheck?.(m.leader, m.seconds));
    room.onMessage("transfer", (m: { roomId: string; kind: "world" | "colossus" }) => this.onTransfer?.(m.roomId, m.kind));
    room.onMessage("cleared", (m: { time: string; xp: number }) => this.onCleared?.(m.time, m.xp));
    room.onMessage("ping", (m: PingMessage) => this.onPing?.(m));
    room.onMessage("party:online", (list: OnlinePlayerInfo[]) => this.onOnlinePlayers?.(list));
    // The SDK retries dropped connections itself; onLeave means the room is gone for good.
    room.onDrop(() => { this.reconnecting = true; });
    room.onReconnect(() => { this.reconnecting = false; });
    room.onLeave((code) => {
      this.onDisconnect?.({ ...(this.me.state as MoveState) }, code === 1000 ? "left the world" : `disconnected (${code})`);
    });
  }

  get roomId() { return this.room.roomId; }
  get sessionId() { return this.room.sessionId; }

  /**
   * Join a room: a specific one by id (a dungeon, or the world copy you came
   * from), or any open world copy. If the server says the character is still
   * in a live dungeon, throws {@link DungeonRedirect}.
   */
  static async connect(url: string, token: string, characterId: number, target?: { roomId: string; place: Place }, timeoutMs = 8000): Promise<OnlineSession> {
    const client = new Client(url);
    client.auth.token = token;
    const options = { characterId };
    const join = async () => {
      if (target?.roomId) {
        try { return await client.joinById(target.roomId, options); }
        catch (err) { if (target.place === "colossus") throw err; } // old world copy closed: any copy will do
      }
      return client.joinOrCreate(ROOM_WORLD, options);
    };
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs));
    let room: Room;
    try {
      room = await Promise.race([join(), timeout]);
    } catch (err) {
      const m = /dungeon:(\S+)/.exec((err as Error).message ?? "");
      if (m) throw new DungeonRedirect(m[1]);
      throw err;
    }
    const selfSchema = await new Promise<any>((resolve) => {
      Callbacks.get(room).onAdd("players" as never, (player: unknown, key: unknown) => {
        if (key === room.sessionId) resolve(player);
      }, true);
    });
    return new OnlineSession(room, selfSchema, room.name === "colossus" ? "colossus" : "world");
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
      hp: p.hp, maxHp: p.maxHp, level: p.level, xp: p.xp, mantleAwakened: p.mantleAwakened === 1,
      abilityCooldown: p.abilityCooldown ?? 0,
      ability2Cooldown: p.ability2Cooldown ?? 0,
      exploreCooldown: p.exploreCooldown ?? 0,
      ultCharge: p.ultCharge ?? 0,
      giant: p.giant === 1,
      technique: p.technique || defaultTechniqueFor(p.classId),
      mantlePath: p.mantlePath || defaultMantlePathFor(p.mantle),
      questStep: p.questStep ?? 0,
      guarding: p.guarding === 1,
      classCharge: p.classCharge ?? 0,
      classCooldown: p.classCooldown ?? 0,
      party: p.party ?? "", reviveProgress: p.reviveProgress ?? 0,
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

  boss(): BossView | null {
    if (this.place !== "colossus") return null;
    return (this.room.state as any).boss as BossView;
  }

  self(): PlayerView {
    return this.view(this.room.sessionId, this.selfSchema);
  }

  send(type: string, payload?: unknown) {
    this.room.send(type, payload);
  }

  /** Test accounts only: jump somewhere (used by playtests and automated checks). */
  devTeleport(x: number, y: number, z: number) {
    this.room.send("dev:teleport", { x, y, z });
  }

  status() {
    if (this.reconnecting) return "Connection lost · reconnecting…";
    const count = (this.room.state as any).players.size as number;
    const rtt = Math.round(this.room.clock.smoothedRtt());
    const where = this.place === "colossus" ? "Drowned Colossus" : "Online";
    return `${where} · ${count} ${count === 1 ? "player" : "players"} here · ${rtt} ms`;
  }

  /** Leave the room; resolves once the server has saved and released the character. */
  async dispose() {
    this.room.onLeave.clear();
    await this.room.leave().catch(() => { });
  }
}
