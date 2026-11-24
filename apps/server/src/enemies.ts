/**
 * Enemy spawning, AI and damage. Runs on the server only; clients see the
 * resulting positions and states.
 *
 * Reef Wretch: rushes in groups, rears up (telegraph) before lunging.
 * Hullbreaker: shield faces the nearest threat; charges, then briefly exposes its back.
 * Training dummy: takes hits in the training yard and resets.
 */
import {
  ENEMY_KINDS, ENEMY_SIZE, EnemyState, ISLES, SEA_LEVEL, type Fx, type World,
  getWorld, groundHeightAt, isleRadius,
} from "@worlds-edge/shared";
import { Enemy, type Player, type WorldState } from "./schema.ts";

export interface Spawn { kind: string; x: number; z: number; leash: number; y?: number }

/** Who lives on each isle: [isle index, kind, how many]. Danger rises with distance from the harbour. */
const ISLE_SPAWNS: Array<[number, string, number]> = [
  [0, "slime", 2], [0, "green-blob", 1],
  [1, "mushnub", 2], [1, "green-spiky-blob", 1], [1, "armabee", 1],
  [2, "cactoro", 1],
  [3, "blue-demon", 2], [3, "demon", 1],
  [4, "orc", 2], [4, "goleling", 1],
  [5, "ghost", 2], [5, "ninja", 1], [5, "orc-skull", 1],
  [6, "ninja-2", 1], [6, "orc-2", 2], [6, "tribal", 1],
  [7, "cactoro-2", 1], [7, "frog", 2], [7, "dino", 1],
  [8, "squidle", 2], [8, "fish-4", 1], [8, "mushroom-king", 1],
];
/** Open-water hunters along the route: [kind, x, z]. */
const SEA_SPAWNS: Array<[string, number, number]> = [
  ["manta-ray", 70, -190], ["jellyfish", -60, -250], ["jellyfish", 90, -520],
  ["manta-ray", -150, -560], ["shark", 60, -840], ["shark", -50, -1090],
];
/** Fliers patrolling the gaps between isles: [kind, x, y, z]. */
const SKY_SPAWNS: Array<[string, number, number, number]> = [
  ["hywirl", 100, 55, -360], ["hywirl", -80, 70, -480], ["dragon", 40, 85, -800], ["dragon", -40, 95, -1100],
];

/**
 * A clear, flat spot on an isle's top near (x, z): nothing standing on it (trees,
 * tents, peaks) and away from the spots already taken. Searches outward in a spiral.
 */
function clearSpot(world: World, isle: number, x: number, z: number, taken: Array<{ x: number; z: number }>) {
  const top = ISLES[isle].top + 0.8;
  for (let i = 0; i < 200; i++) {
    const a = i * 2.39996, r = Math.sqrt(i) * 2.2;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    if (Math.hypot(px - ISLES[isle].x, pz - ISLES[isle].z) > isleRadius(isle) * 0.8) continue;
    if (Math.abs(groundHeightAt(world, px, pz, 400) - top) > 0.05) continue;
    if (taken.some((t) => Math.hypot(t.x - px, t.z - pz) < 4)) continue;
    return { x: Math.round(px * 10) / 10, y: top, z: Math.round(pz * 10) / 10 };
  }
  return { x, y: top, z };
}

/** Overworld spawns: training dummies, the starter wretches and Hullbreaker, then each isle's residents. */
export const WORLD_SPAWNS: Spawn[] = [
  { kind: "dummy", x: -66, z: 38, leash: 0 },
  { kind: "dummy", x: -54, z: 40, leash: 0 },
];
{
  const world = getWorld();
  const taken: Array<{ x: number; z: number }> = [];
  const ground = (kind: string, isle: number, x: number, z: number, leash: number) => {
    const p = clearSpot(world, isle, x, z, taken);
    taken.push(p);
    WORLD_SPAWNS.push({ kind, ...p, leash });
  };
  // The starter pack and the Hullbreaker's camp (ids e2–e8, which the checks rely on).
  for (const [x, z] of [[152, -292], [166, -290], [158, -308], [170, -306]]) ground("wretch", 0, x, z, 22);
  ground("hullbreaker", 2, -120, -380, 16);
  ground("wretch", 2, -132, -372, 14);
  ground("wretch", 2, -108, -390, 14);
  for (const [isle, kind, count] of ISLE_SPAWNS) {
    if (!ENEMY_KINDS[kind]) continue;
    const at = ISLES[isle];
    for (let n = 0; n < count; n++) {
      if (ENEMY_KINDS[kind].ai === "flyer") {
        const a = n * 2.1 + isle;
        const r = isleRadius(isle) * 0.5;
        WORLD_SPAWNS.push({ kind, x: Math.round(at.x + Math.cos(a) * r), z: Math.round(at.z + Math.sin(a) * r), y: at.top + 7 + n * 3, leash: 26 });
      } else {
        const a = (taken.length * 2.39996) % (Math.PI * 2);
        const r = isleRadius(isle) * (0.2 + 0.12 * n);
        ground(kind, isle, at.x + Math.cos(a) * r, at.z + Math.sin(a) * r, Math.round(isleRadius(isle) * 0.6));
      }
    }
  }
  for (const [kind, x, z] of SEA_SPAWNS) if (ENEMY_KINDS[kind]) WORLD_SPAWNS.push({ kind, x, z, y: SEA_LEVEL - 0.3, leash: 35 });
  for (const [kind, x, y, z] of SKY_SPAWNS) if (ENEMY_KINDS[kind]) WORLD_SPAWNS.push({ kind, x, z, y, leash: 40 });
}

interface Brain {
  id: string;
  spawn: Spawn;
  homeY: number;
  target: string | null;
  /** Seconds in the current state. */
  t: number;
  /** Attack direction locked at telegraph. */
  dirX: number; dirZ: number;
  /** Players already hit by the current attack. */
  struck: Set<string>;
  cooldown: number;
  lastHit: number;
  respawnAt: number;
  /** Players who hit this enemy recently, for shared reward credit. */
  contributors: Map<string, number>;
  pull: { x: number; z: number; t: number } | null;
  /** Spawned mid-fight (dungeon adds): removed after death instead of respawning. */
  transient: boolean;
}

export interface Host {
  readonly state: WorldState;
  readonly world: World;
  now(): number;
  fx(e: Fx): void;
  damagePlayer(sid: string, amount: number, knockX: number, knockZ: number, power: number): void;
  awardXp(sid: string, xp: number): void;
}

export interface HitOptions {
  /** Heavy hits (dive impacts) crack shields: full guard damage from the front. */
  heavy?: boolean;
  /** Treat as a weak-point strike (e.g. Crossfire from two angles / Return Stroke). */
  weak?: boolean;
}

export interface HitResult { dealt: number; killed: boolean; blocked: boolean; weak: boolean }

const angleTo = (fx: number, fz: number, tx: number, tz: number) => Math.atan2(tx - fx, tz - fz);
function angleDiff(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** A room can take over how particular enemies take damage (the boss heart). */
export type HitOverride = (id: string, e: Enemy, attacker: string, health: number, guard: number, opts: HitOptions) => HitResult | null;

export class Enemies {
  private brains = new Map<string, Brain>();
  private nextId = 0;
  override: HitOverride | null = null;
  /** Called when an enemy dies (after XP is awarded). */
  onKilled: ((id: string, e: Enemy) => void) | null = null;

  constructor(private host: Host, spawns: Spawn[]) {
    for (const spawn of spawns) this.spawn(spawn, false);
  }

  /** Add an enemy. Transient ones (dungeon adds) disappear after dying. */
  spawn(spawn: Spawn, transient = true, id = `e${this.nextId++}`): string {
    const homeY = spawn.y ?? groundHeightAt(this.host.world, spawn.x, spawn.z, 200);
    const b: Brain = {
      id, spawn, homeY, target: null, t: 0, dirX: 0, dirZ: 1, struck: new Set(), cooldown: 0,
      lastHit: -100, respawnAt: 0, contributors: new Map(), pull: null, transient,
    };
    this.brains.set(id, b);
    const e = new Enemy();
    e.kind = spawn.kind;
    this.reset(e, b);
    this.host.state.enemies.set(id, e);
    return id;
  }

  remove(id: string) {
    this.brains.delete(id);
    this.host.state.enemies.delete(id);
  }

  /** Restore an enemy to full health in place (encounter resets). */
  restore(id: string) {
    const e = this.host.state.enemies.get(id);
    const b = this.brains.get(id);
    if (e && b) this.reset(e, b);
  }

  private reset(e: Enemy, b: Brain) {
    const k = ENEMY_KINDS[b.spawn.kind];
    e.x = b.spawn.x; e.y = b.homeY; e.z = b.spawn.z;
    e.facing = Math.PI;
    e.hp = k.hp; e.maxHp = k.hp;
    e.guard = k.guard; e.maxGuard = k.guard;
    e.state = EnemyState.Idle;
    b.target = null; b.t = 0; b.cooldown = 1; b.contributors.clear(); b.pull = null;
  }

  /** Enemies near a point, nearest first. */
  near(x: number, y: number, z: number, radius: number): Array<[string, Enemy]> {
    const out: Array<[string, Enemy, number]> = [];
    this.host.state.enemies.forEach((e, id) => {
      if (e.state === EnemyState.Dead) return;
      const size = ENEMY_SIZE[e.kind];
      const d = Math.hypot(e.x - x, e.y + size.height / 2 - y, e.z - z) - size.radius;
      if (d <= radius) out.push([id, e, d]);
    });
    return out.sort((a, b) => a[2] - b[2]).map(([id, e]) => [id, e]);
  }

  /** Apply a hit from a player. Health and guard damage are separate. */
  hit(id: string, attacker: string, fromX: number, fromZ: number, health: number, guard: number, opts: HitOptions = {}): HitResult {
    const e = this.host.state.enemies.get(id);
    const b = this.brains.get(id);
    const res: HitResult = { dealt: 0, killed: false, blocked: false, weak: false };
    if (!e || !b || e.state === EnemyState.Dead) return res;
    const now = this.host.now();
    b.lastHit = now;
    b.contributors.set(attacker, now);
    if (!b.target && e.kind !== "dummy") b.target = attacker;
    if (this.override) {
      const custom = this.override(id, e, attacker, health, guard, opts);
      if (custom) return custom;
    }

    if (e.kind === "hullbreaker" && e.state !== EnemyState.Stagger) {
      const fromAngle = angleTo(e.x, e.z, fromX, fromZ);
      const off = Math.abs(angleDiff(e.facing, fromAngle));
      if (off < 1.2) {
        // The shield takes it. Heavy dives still crack the guard.
        res.blocked = true;
        health *= 0.15;
        if (!opts.heavy) guard *= 0.2;
      } else if (e.state === EnemyState.Exposed && off > 2.0) {
        res.weak = true;
        health *= 2;
        guard *= 2;
      }
    }
    if (opts.weak && !res.blocked) {
      res.weak = true;
      health *= 1.5;
      guard *= 1.35;
    }
    if (e.state === EnemyState.Stagger) health *= 1.5;

    e.guard = Math.max(0, e.guard - guard);
    let broke = false;
    if (e.guard === 0 && e.maxGuard > 0 && e.state !== EnemyState.Stagger && e.kind !== "dummy") {
      e.state = EnemyState.Stagger;
      b.t = 0;
      broke = true;
    }
    res.dealt = Math.round(health);
    e.hp = Math.max(0, e.hp - health);
    this.host.fx({
      t: "hit", x: r1(e.x), y: r1(e.y + ENEMY_SIZE[e.kind].height), z: r1(e.z), n: res.dealt,
      ...(res.weak ? { weak: 1 as const } : {}), ...(res.blocked ? { blocked: 1 as const } : {}), ...(broke ? { broke: 1 as const } : {}),
    });

    if (e.hp <= 0) {
      if (e.kind === "dummy") { e.hp = 1; return res; }
      res.killed = true;
      e.state = EnemyState.Dead;
      b.respawnAt = now + ENEMY_KINDS[e.kind].respawnSeconds;
      const xp = ENEMY_KINDS[e.kind].xp;
      this.host.fx({ t: "kill", x: r1(e.x), y: r1(e.y + 1), z: r1(e.z), xp });
      // Everyone who helped in the last 30 s gets full credit.
      for (const [sid, at] of b.contributors) if (now - at < 30) this.host.awardXp(sid, xp);
      this.onKilled?.(id, e);
    }
    return res;
  }

  /** Undertow: slide toward a point and cancel any wind-up. */
  pull(id: string, toX: number, toZ: number) {
    const e = this.host.state.enemies.get(id);
    const b = this.brains.get(id);
    if (!e || !b || e.state === EnemyState.Dead || e.kind === "dummy") return;
    b.pull = { x: toX, z: toZ, t: 0.4 };
    if (e.state === EnemyState.Telegraph || e.state === EnemyState.Attack) { e.state = EnemyState.Chase; b.t = 0; b.cooldown = 1.5; }
  }

  update(dt: number) {
    const now = this.host.now();
    this.host.state.enemies.forEach((e, id) => {
      const b = this.brains.get(id)!;
      b.t += dt;
      b.cooldown = Math.max(0, b.cooldown - dt);

      if (e.state === EnemyState.Dead) {
        if (b.transient) { if (b.t > 2) this.remove(id); }
        else if (e.kind !== "anchor" && e.kind !== "heart" && now >= b.respawnAt) this.reset(e, b);
        return;
      }
      if (e.kind === "anchor" || e.kind === "heart") return; // driven by the encounter
      // Guard recovers when left alone.
      if (now - b.lastHit > 4 && e.state !== EnemyState.Stagger) e.guard = Math.min(e.maxGuard, e.guard + 15 * dt);

      if (e.kind === "dummy") {
        if (now - b.lastHit > 5) { e.hp = e.maxHp; e.guard = e.maxGuard; }
        return;
      }

      if (b.pull) {
        const k = Math.min(1, dt / b.pull.t);
        this.moveTo(e, b, e.x + (b.pull.x - e.x) * k, e.z + (b.pull.z - e.z) * k);
        b.pull.t -= dt;
        if (b.pull.t <= 0) b.pull = null;
        return;
      }

      if (e.state === EnemyState.Stagger) {
        if (b.t > 3) { e.state = EnemyState.Chase; e.guard = e.maxGuard; b.t = 0; b.cooldown = 1; }
        return;
      }

      const target = this.pickTarget(e, b);
      if (!target) {
        // Wander home.
        const d = Math.hypot(b.spawn.x - e.x, b.spawn.z - e.z);
        if (d > 1) this.step(e, b, b.spawn.x, b.spawn.z, ENEMY_KINDS[e.kind].speed * 0.6, dt);
        if (e.state !== EnemyState.Idle) { e.state = EnemyState.Idle; b.t = 0; }
        return;
      }
      const [sid, p] = target;
      const ai = ENEMY_KINDS[e.kind]?.ai ?? "wretch";
      if (ai === "hullbreaker") this.hullbreaker(e, b, sid, p, dt);
      else this.wretch(e, b, sid, p, dt);
    });
  }

  private pickTarget(e: Enemy, b: Brain): [string, Player] | null {
    const k = ENEMY_KINDS[e.kind];
    const maxDy = k.ai === "flyer" ? 18 : 7;
    let best: [string, Player] | null = null;
    let bestD = Infinity;
    this.host.state.players.forEach((p, sid) => {
      if (p.downTime > 0 || p.away) return;
      const dy = p.y - e.y;
      if (dy < -5 || dy > maxDy) return; // high fliers are out of reach
      const fromHome = Math.hypot(p.x - b.spawn.x, p.z - b.spawn.z);
      if (fromHome > b.spawn.leash + 10) return;
      const d = Math.hypot(p.x - e.x, p.z - e.z);
      const range = sid === b.target ? k.aggroRange * 1.6 : k.aggroRange;
      if (d < range && d < bestD) { best = [sid, p]; bestD = d; }
    });
    b.target = best ? best[0] : null;
    return best;
  }

  private wretch(e: Enemy, b: Brain, sid: string, p: Player, dt: number) {
    const d = Math.hypot(p.x - e.x, p.z - e.z);
    switch (e.state) {
      case EnemyState.Telegraph:
        if (b.t >= 0.7) { e.state = EnemyState.Attack; b.t = 0; b.struck.clear(); }
        return;
      case EnemyState.Attack: {
        this.step(e, b, e.x + b.dirX * 10, e.z + b.dirZ * 10, 11, dt);
        if (!b.struck.has(sid) && Math.hypot(p.x - e.x, p.z - e.z) < 1.6 && Math.abs(p.y - e.y) < 2) {
          b.struck.add(sid);
          this.host.damagePlayer(sid, 10, b.dirX, b.dirZ, 6);
        }
        if (b.t >= 0.3) { e.state = EnemyState.Chase; b.t = 0; b.cooldown = 1.2; }
        return;
      }
      default:
        e.facing = angleTo(e.x, e.z, p.x, p.z);
        if (d < 2.8 && b.cooldown === 0) {
          e.state = EnemyState.Telegraph; b.t = 0;
          b.dirX = Math.sin(e.facing); b.dirZ = Math.cos(e.facing);
          this.host.fx({ t: "ring", x: r1(e.x), y: r1(e.y), z: r1(e.z), r: 2.5, kind: "telegraph" });
        } else {
          e.state = EnemyState.Chase;
          if (d > 1.6) this.step(e, b, p.x, p.z, ENEMY_KINDS[e.kind].speed, dt);
        }
    }
  }

  private hullbreaker(e: Enemy, b: Brain, sid: string, p: Player, dt: number) {
    const d = Math.hypot(p.x - e.x, p.z - e.z);
    const toward = angleTo(e.x, e.z, p.x, p.z);
    const turn = (rate: number) => {
      const diff = angleDiff(e.facing, toward);
      e.facing += Math.max(-rate * dt, Math.min(rate * dt, diff));
    };
    switch (e.state) {
      case EnemyState.Telegraph:
        turn(1.2);
        b.dirX = Math.sin(e.facing); b.dirZ = Math.cos(e.facing);
        if (b.t >= 1.0) { e.state = EnemyState.Attack; b.t = 0; b.struck.clear(); }
        return;
      case EnemyState.Attack: {
        // Charge in a straight line, trampling anyone in the way.
        this.step(e, b, e.x + b.dirX * 10, e.z + b.dirZ * 10, 15, dt);
        this.host.state.players.forEach((other, osid) => {
          if (b.struck.has(osid) || other.downTime > 0) return;
          if (Math.hypot(other.x - e.x, other.z - e.z) < 2.4 && Math.abs(other.y - e.y) < 2.5) {
            b.struck.add(osid);
            this.host.damagePlayer(osid, 25, b.dirX, b.dirZ, 14);
          }
        });
        if (b.t >= 1.1) { e.state = EnemyState.Exposed; b.t = 0; }
        return;
      }
      case EnemyState.Exposed:
        // Winded after the charge: back exposed, turning slowly.
        turn(0.5);
        if (b.t >= 2.2) { e.state = EnemyState.Chase; b.t = 0; b.cooldown = 1.5; }
        return;
      default:
        e.state = EnemyState.Chase;
        turn(2.2);
        if (b.cooldown === 0 && d > 4 && d < 15 && Math.abs(angleDiff(e.facing, toward)) < 0.4) {
          e.state = EnemyState.Telegraph; b.t = 0;
          this.host.fx({ t: "ring", x: r1(e.x), y: r1(e.y), z: r1(e.z), r: 3.5, kind: "telegraph" });
        } else if (d > 3) {
          this.step(e, b, p.x, p.z, ENEMY_KINDS[e.kind].speed, dt);
        }
    }
  }

  /** Move toward a point at `speed`, staying on the island near home. */
  private step(e: Enemy, b: Brain, tx: number, tz: number, speed: number, dt: number) {
    const dx = tx - e.x, dz = tz - e.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return;
    const k = Math.min(d, speed * dt) / d;
    this.moveTo(e, b, e.x + dx * k, e.z + dz * k);
  }

  private moveTo(e: Enemy, b: Brain, nx: number, nz: number) {
    const fromHome = Math.hypot(nx - b.spawn.x, nz - b.spawn.z);
    if (fromHome > b.spawn.leash) return;
    const ai = ENEMY_KINDS[e.kind]?.ai;
    if (ai === "flyer" || ai === "sea") {
      e.x = nx; e.z = nz; e.y = b.homeY;
      return;
    }
    const ground = groundHeightAt(this.host.world, nx, nz, e.y + 1.5);
    if (!Number.isFinite(ground) || Math.abs(ground - b.homeY) > 3) return; // edge of the island
    e.x = nx; e.z = nz; e.y = ground;
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10;
