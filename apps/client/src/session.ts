import { Callbacks, Client, Predict, type Room } from "@colyseus/sdk";
import {
  ROOM_WORLD, STEP_SECONDS,
  createMoveState, getWorld, stepMovement,
  type MoveInput, type MoveState,
} from "@worlds-edge/shared";

const world = getWorld();

/** Everything the renderer needs to draw one player this frame. */
export interface PlayerView {
  id: string;
  name: string;
  color: string;
  isSelf: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  facing: number;
  mode: number;
  stamina: number;
  exhausted: number;
}

export interface Session {
  readonly kind: "online" | "offline";
  /** Advance the simulation for this frame; `sample` builds one fixed-step input. */
  frame(now: number, sample: () => MoveInput): void;
  players(): PlayerView[];
  self(): PlayerView | undefined;
  status(): string;
  dispose(): void;
}

const MOVE_FIELDS = [
  "x", "y", "z", "vx", "vy", "vz", "mode", "stamina", "exhausted", "facing",
  "dodgeTime", "dodgeCooldown", "dodgeX", "dodgeZ", "safeX", "safeY", "safeZ",
] as const satisfies readonly (keyof MoveState)[];

function copyMove(from: MoveState, to: MoveState) {
  for (const f of MOVE_FIELDS) to[f] = from[f];
}

/** Solo play with the same movement code, used when no server is reachable. */
export class OfflineSession implements Session {
  readonly kind = "offline";
  private state: MoveState;
  private prev: MoveState;
  private acc = 0;
  private last = -1;

  constructor(private name: string, private reason: string, start?: MoveState) {
    this.state = createMoveState(world.spawn);
    if (start) copyMove(start, this.state);
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
      id: "self", name: this.name, color: "#e4572e", isSelf: true,
      x: lerp("x"), y: lerp("y"), z: lerp("z"),
      vx: s.vx, vy: s.vy, vz: s.vz,
      facing: s.facing, mode: s.mode, stamina: s.stamina, exhausted: s.exhausted,
    };
  }

  players() { return [this.self()]; }
  status() { return `Solo · ${this.reason}`; }
  /** The exact current state, so an online session can hand over without a jump. */
  snapshot(): MoveState { return { ...this.state }; }
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
  /** Called once if the connection drops, with our last predicted state. */
  onDisconnect?: (last: MoveState, reason: string) => void;

  private constructor(private room: Room, selfSchema: any) {
    this.selfSchema = selfSchema;
    this.predict = Predict.get(room, { mode: "lerp", delay: 100 });
    this.predict.attachAll("players", { fields: ["x", "y", "z", "vx", "vy", "vz"] });
    this.input = room.input({ mode: "reliable" });
    this.me = this.predict.reconciler(selfSchema, {
      input: this.input,
      fields: MOVE_FIELDS,
      step: (ctx, state, command) => stepMovement(state as MoveState, command as MoveInput, ctx.dt, world),
    });
    room.onLeave((code) => {
      this.onDisconnect?.({ ...(this.me.state as MoveState) }, code === 1000 ? "left the world" : `disconnected (${code})`);
    });
  }

  static async connect(url: string, name: string, timeoutMs = 6000): Promise<OnlineSession> {
    const client = new Client(url);
    const join = client.joinOrCreate(ROOM_WORLD, { name });
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
      id, name: p.name, color: p.color, isSelf,
      x: this.predict.value(p, "x"), y: this.predict.value(p, "y"), z: this.predict.value(p, "z"),
      vx: logic.vx, vy: logic.vy, vz: logic.vz,
      facing: logic.facing, mode: logic.mode, stamina: logic.stamina, exhausted: logic.exhausted,
    };
  }

  players(): PlayerView[] {
    const out: PlayerView[] = [];
    (this.room.state as any).players.forEach((p: any, id: string) => out.push(this.view(id, p)));
    return out;
  }

  self(): PlayerView {
    return this.view(this.room.sessionId, this.selfSchema);
  }

  status() {
    const count = (this.room.state as any).players.size as number;
    const rtt = Math.round(this.room.clock.smoothedRtt());
    return `Online · ${count} ${count === 1 ? "player" : "players"} here · ${rtt} ms`;
  }

  dispose() {
    this.room.onLeave.clear();
    this.room.leave().catch(() => {});
  }
}
