/**
 * Enemy spawning, AI and damage. Runs on the server only; clients see the
 * resulting positions and states.
 *
 * Reef Wretch: rushes in groups, rears up (telegraph) before lunging.
 * Hullbreaker: shield faces the nearest threat; charges, then briefly exposes its back.
 * Training dummy: takes hits in the training yard and resets.
 */
import {
  ENEMY_KINDS, ENEMY_SIZE, EnemyState, type Fx, type World,
  groundHeightAt,
} from "@worlds-edge/shared";
import { Enemy, type Player, type WorldState } from "./schema.ts";

export interface Spawn { kind: string; x: number; z: number; leash: number; y?: number }

/** Overworld spawns. Island tops: first island (160,-300); western isle (-120,-380). */
export const WORLD_SPAWNS: Spawn[] = [
  { kind: "dummy", x: -66, z: 38, leash: 0 },
  { kind: "dummy", x: -54, z: 40, leash: 0 },
  { kind: "wretch", x: 152, z: -292, leash: 22 },
  { kind: "wretch", x: 166, z: -290, leash: 22 },
  { kind: "wretch", x: 158, z: -308, leash: 22 },
  { kind: "wretch", x: 170, z: -306, leash: 22 },
  { kind: "hullbreaker", x: -120, z: -380, leash: 16 },
  { kind: "wretch", x: -132, z: -372, leash: 14 },
  { kind: "wretch", x: -108, z: -390, leash: 14 },
];

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
      if (e.kind === "wretch") this.wretch(e, b, sid, p, dt);
      else this.hullbreaker(e, b, sid, p, dt);
    });
  }

  private pickTarget(e: Enemy, b: Brain): [string, Player] | null {
    const k = ENEMY_KINDS[e.kind];
    let best: [string, Player] | null = null;
    let bestD = Infinity;
    this.host.state.players.forEach((p, sid) => {
      if (p.downTime > 0 || p.away) return;
      const dy = p.y - e.y;
      if (dy < -3 || dy > 7) return; // high fliers are out of reach
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
          if (d > 1.6) this.step(e, b, p.x, p.z, ENEMY_KINDS.wretch.speed, dt);
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
          this.step(e, b, p.x, p.z, ENEMY_KINDS.hullbreaker.speed, dt);
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
    const ground = groundHeightAt(this.host.world, nx, nz, e.y + 1.5);
    if (!Number.isFinite(ground) || Math.abs(ground - b.homeY) > 3) return; // edge of the island
    e.x = nx; e.z = nz; e.y = ground;
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10;
