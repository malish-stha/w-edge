/**
 * Resolving what players do to enemies: basic attacks, class signature
 * mechanics (Return Stroke, Crossfire, Breakwater, Horizon Break), signature
 * techniques, and mantle skills.
 */
import {
  ATTACKS, ENEMY_SIZE, HORIZON_BREAK, MANTLE_EXPLORE, MANTLE_SKILLS, MANTLE_SKILLS_2, Mode, SEA_LEVEL, UNLOCK_LEVELS,
  raycast, type StepEvents,
} from "@worlds-edge/shared";

const activeTech = (p: Player) => (p.level >= UNLOCK_LEVELS.technique ? p.technique : "");
const activePath = (p: Player) => (p.level >= UNLOCK_LEVELS.upgradePath ? p.mantlePath : "");
import type { Enemies, HitOptions } from "./enemies.ts";
import type { Host } from "./enemies.ts";
import type { Player } from "./schema.ts";

const r1 = (n: number) => Math.round(n * 10) / 10;

interface PlantedArrow { x: number; y: number; z: number; at: number }

interface SaberState { parryUntil: number }

interface VanguardState { wasHeld: boolean; plantedUntil: number }

export class Combat {
  /** Per player, per enemy: when they may be pierced again. */
  private pierceReady = new Map<string, Map<string, number>>();
  private saber = new Map<string, SaberState>();
  private arrows = new Map<string, PlantedArrow[]>();
  private vanguard = new Map<string, VanguardState>();
  private staticMarks = new Map<string, number>();
  private tempestUntil = new Map<string, number>();
  private giantUntil = new Map<string, number>();

  constructor(private host: Host, private enemies: Enemies) {}

  forget(sid: string) {
    this.pierceReady.delete(sid);
    this.saber.delete(sid);
    this.arrows.delete(sid);
    this.vanguard.delete(sid);
    this.tempestUntil.delete(sid);
    this.giantUntil.delete(sid);
  }

  /** Advance per-step class timers & cooldowns. */
  step(sid: string, p: Player, dt: number) {
    p.classCooldown = Math.max(0, p.classCooldown - dt);
    p.ability2Cooldown = Math.max(0, p.ability2Cooldown - dt);
    p.exploreCooldown = Math.max(0, p.exploreCooldown - dt);
    const now = this.host.now();
    p.giant = (this.giantUntil.get(sid) ?? 0) > now ? 1 : 0;
    if (p.classId === "saber") {
      const s = this.saber.get(sid);
      p.guarding = s && s.parryUntil > now ? 1 : 0;
    }
    const list = this.arrows.get(sid);
    if (list?.length) {
      const fresh = list.filter((a) => now - a.at < 18);
      if (fresh.length !== list.length) {
        this.arrows.set(sid, fresh);
        p.classCharge = fresh.length;
      }
    }
  }

  /** Resolve everything one step of input produced for one player. */
  resolve(sid: string, p: Player, ev: StepEvents, yaw: number, pitch: number) {
    if (p.downTime > 0) {
      p.guarding = 0;
      return;
    }
    if (ev.attack) this.attack(sid, p, ev.attack, yaw, pitch);
    this.resolveSecondary(sid, p, ev, yaw, pitch);
    if (p.classId === "lancer") {
      if (ev.impactSpeed) this.impact(sid, p, ev.impactSpeed, ev.impactSteep);
      this.pierce(sid, p);
    }
  }

  /**
   * Called before a player takes damage. Returns true if a Saber parry or
   * Vanguard Breakwater absorbed the hit.
   */
  interceptDamage(sid: string, p: Player): boolean {
    const now = this.host.now();

    // 1. Saber Return Stroke parry (self, or nearby Saber with Cover Parry).
    let parrier: { sid: string; p: Player } | null = null;
    if (p.classId === "saber" && (this.saber.get(sid)?.parryUntil ?? 0) > now) {
      parrier = { sid, p };
    } else {
      this.host.state.players.forEach((other, osid) => {
        if (parrier || other.classId !== "saber" || activeTech(other) !== "cover-parry" || other.downTime > 0) return;
        if ((this.saber.get(osid)?.parryUntil ?? 0) <= now) return;
        if (Math.hypot(other.x - p.x, other.y - p.y, other.z - p.z) <= 8) parrier = { sid: osid, p: other };
      });
    }
    if (parrier) {
      const cap = activeTech(parrier.p) === "held-edge" ? 2 : 1;
      parrier.p.classCharge = Math.min(cap, parrier.p.classCharge + 1);
      parrier.p.classCooldown = 0;
      const st = this.saber.get(parrier.sid);
      if (st) st.parryUntil = 0;
      parrier.p.guarding = 0;
      parrier.p.ultCharge = Math.min(100, parrier.p.ultCharge + 14);
      this.host.fx({ t: "parry", id: parrier.sid, stored: parrier.p.classCharge });
      return true;
    }

    // 2. Vanguard Breakwater guard stance (self, or nearby ally behind Bulwark).
    let guardian: { sid: string; p: Player } | null = null;
    if (p.classId === "vanguard" && p.guarding === 1) {
      guardian = { sid, p };
    } else {
      this.host.state.players.forEach((other, osid) => {
        if (guardian || other.classId !== "vanguard" || other.guarding !== 1 || other.downTime > 0) return;
        const cover = activeTech(other) === "bulwark" ? 7.5 : 4.5;
        if (Math.hypot(other.x - p.x, other.y - p.y, other.z - p.z) <= cover) guardian = { sid: osid, p: other };
      });
    }
    if (guardian) {
      const cap = activeTech(guardian.p) === "bulwark" ? 2 : 1;
      guardian.p.classCharge = Math.min(cap, guardian.p.classCharge + 1);
      guardian.p.ultCharge = Math.min(100, guardian.p.ultCharge + 14);
      this.host.fx({ t: "parry", id: guardian.sid, stored: guardian.p.classCharge });
      return true;
    }

    return false;
  }

  private resolveSecondary(sid: string, p: Player, ev: StepEvents, yaw: number, pitch: number) {
    const now = this.host.now();
    switch (p.classId) {
      case "saber": {
        if (!ev.secondary) return;
        if (p.classCharge > 0) {
          this.releaseReturnStroke(sid, p, yaw, pitch);
          return;
        }
        if (p.classCooldown > 0) return;
        this.saber.set(sid, { parryUntil: now + 0.65 });
        p.guarding = 1;
        p.classCooldown = 1.2;
        this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y + 0.8), z: r1(p.z), r: 1.8, kind: "shrine" });
        break;
      }
      case "archer": {
        if (!ev.secondary || p.classCooldown > 0) return;
        const cp = Math.cos(pitch);
        const dir = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
        const origin = { x: p.x, y: p.y + 1.2, z: p.z };
        const wall = raycast(this.host.world, origin, dir, 40);
        const dist = Math.min(wall, 32);
        const ax = origin.x + dir.x * dist;
        const ay = origin.y + dir.y * dist;
        const az = origin.z + dir.z * dist;
        const list = this.arrows.get(sid) ?? [];
        const tech = activeTech(p);
        const max = tech === "net" ? 3 : tech === "twin-line" ? 2 : 1;
        while (list.length >= max) list.shift();
        list.push({ x: ax, y: ay, z: az, at: now });
        this.arrows.set(sid, list);
        p.classCharge = list.length;
        p.classCooldown = 0.45;
        this.host.fx({ t: "shot", from: [r1(origin.x), r1(origin.y), r1(origin.z)], to: [r1(ax), r1(ay), r1(az)] });
        this.host.fx({ t: "pin", x: r1(ax), y: r1(ay), z: r1(az), kind: "arrow" });
        break;
      }
      case "vanguard": {
        let st = this.vanguard.get(sid);
        if (!st) { st = { wasHeld: false, plantedUntil: 0 }; this.vanguard.set(sid, st); }
        if (ev.secondaryHeld || ev.secondary) {
          p.guarding = 1;
          if (!st.wasHeld) {
            st.plantedUntil = now + (activeTech(p) === "bulwark" ? 4.5 : 2.5);
            this.host.fx({ t: "pin", x: r1(p.x + Math.sin(p.facing) * 1.4), y: r1(p.y + 0.9), z: r1(p.z + Math.cos(p.facing) * 1.4), kind: "shield" });
          }
          st.wasHeld = true;
        } else if (st.wasHeld) {
          st.wasHeld = false;
          p.guarding = 0;
          const tech = activeTech(p);
          if (p.classCharge > 0 || tech === "recoil" || tech === "launch-pad") {
            this.releaseBreakwater(sid, p);
          }
        }
        break;
      }
      case "lancer": {
        if (!ev.secondary || p.classCooldown > 0) return;
        const nearEnemy = this.enemies.near(p.x, p.y + 0.8, p.z, 4.5)[0];
        let allyShield = false;
        this.host.state.players.forEach((other, osid) => {
          if (osid !== sid && other.classId === "vanguard" && other.guarding === 1 && Math.hypot(other.x - p.x, other.y - p.y, other.z - p.z) <= 5) {
            allyShield = true;
          }
        });
        const isVault = activeTech(p) === "vault";
        if (!nearEnemy && !allyShield && !isVault) return;
        p.classCooldown = 2.0;
        p.mode = Mode.Flight;
        p.vy = Math.max(p.vy, 14) + (isVault ? 4 : 0);
        p.vx += Math.sin(yaw) * 6;
        p.vz += Math.cos(yaw) * 6;
        p.stamina = Math.min(100, p.stamina + 25);
        this.host.fx({ t: "vault", id: sid });
        if (nearEnemy) {
          this.enemies.hit(nearEnemy[0], sid, p.x, p.z, isVault ? 18 : 12, 20);
        }
        break;
      }
    }
  }

  private releaseReturnStroke(sid: string, p: Player, yaw: number, _pitch: number) {
    const charges = Math.max(1, p.classCharge);
    p.classCharge = 0;
    p.guarding = 0;
    const tech = activeTech(p);
    const isDash = tech === "riposte-dash";
    const isHeld = tech === "held-edge";
    const mult = isHeld && charges >= 2 ? 2.4 : charges;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);

    if (isDash) {
      p.vx += fx * 26;
      p.vz += fz * 26;
      p.facing = yaw;
    }

    const reach = isDash ? 7.5 : 4.5;
    const health = 26 * mult;
    const guard = (p.mantle === "titan" ? 44 : 24) * mult;
    const opts: HitOptions = { heavy: p.mantle === "titan" || mult >= 2, weak: true };

    const cx = p.x + fx * (isDash ? 3 : 2), cz = p.z + fz * (isDash ? 3 : 2);
    this.host.fx({
      t: "ring", x: r1(cx), y: r1(p.y + 0.6), z: r1(cz), r: reach * 0.65,
      kind: p.mantle === "tide" ? "tide" : p.mantle === "titan" ? "titan" : "impact",
    });

    const hitIds: string[] = [];
    for (const [id] of this.enemies.near(cx, p.y + 0.8, cz, reach)) {
      this.hitWithRelay(id, sid, p.x, p.z, health, guard, opts);
      if (p.mantle === "tide") this.enemies.pull(id, cx, cz);
      hitIds.push(id);
    }

    if (p.mantle === "storm" && hitIds.length > 0) {
      const pts = [r1(p.x), r1(p.y + 1.2), r1(p.z)];
      for (const id of hitIds.slice(0, 3)) {
        const e = this.host.state.enemies.get(id);
        if (e) pts.push(r1(e.x), r1(e.y + ENEMY_SIZE[e.kind].height / 2), r1(e.z));
      }
      this.host.fx({ t: "bolt", pts });
    }
  }

  private releaseBreakwater(sid: string, p: Player) {
    const charges = p.classCharge;
    p.classCharge = 0;
    p.classCooldown = 1.6;
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    const tech = activeTech(p);
    const isLaunch = tech === "launch-pad";
    const isRecoil = tech === "recoil";
    const radius = tech === "bulwark" ? 7.5 : 6.0;
    const cx = p.x + fx * 2.5, cz = p.z + fz * 2.5;

    this.host.fx({ t: "breakwater", x: r1(cx), y: r1(p.y + 0.3), z: r1(cz), r: radius, mantle: p.mantle });

    // Launch nearby allies toward safety or into an aerial dive.
    const allyRadius = isLaunch ? 8.5 : 6.0;
    const pushH = isLaunch ? 20 : 12;
    const pushY = isLaunch ? 16 : 11;
    this.host.state.players.forEach((other, osid) => {
      if (osid === sid || other.downTime > 0) return;
      if (Math.hypot(other.x - p.x, other.y - p.y, other.z - p.z) <= allyRadius) {
        other.vx += fx * pushH;
        other.vz += fz * pushH;
        other.vy = Math.max(other.vy, pushY);
        other.mode = Mode.Flight;
        if (isLaunch) other.stamina = Math.min(100, other.stamina + 40);
      }
    });

    // Disrupt enemies in front.
    const mult = Math.max(1, charges);
    const dmg = (charges > 0 ? 18 : 8) * mult;
    const guard = ((charges > 0 ? 36 : 18) + (isRecoil ? 34 : 0) + (p.mantle === "titan" ? 20 : 0)) * mult;
    for (const [id] of this.enemies.near(cx, p.y + 0.8, cz, radius)) {
      this.hitWithRelay(id, sid, p.x, p.z, dmg, guard, { heavy: charges > 0 || isRecoil });
      if (p.mantle === "tide") this.enemies.pull(id, cx + fx * 4, cz + fz * 4);
    }
  }

  private hitWithRelay(id: string, attacker: string, fromX: number, fromZ: number, health: number, guard: number, opts: HitOptions = {}, grantUlt = true) {
    const p = this.host.state.players.get(attacker);
    const now = this.host.now();
    if (p && (this.giantUntil.get(attacker) ?? 0) > now) {
      health *= 1.8;
      guard *= activePath(p) === "juggernaut" ? 3.0 : 2.5;
      opts = { ...opts, heavy: true };
    }
    const marks = this.staticMarks.get(id) ?? 0;
    if (marks > 0 && p?.mantle === "storm") {
      this.staticMarks.set(id, marks - 1);
      health += activePath(p) === "overcharge" ? 20 : 10;
    }

    const res = this.enemies.hit(id, attacker, fromX, fromZ, health, guard, opts);
    if (p && grantUlt && res.dealt > 0) {
      p.ultCharge = Math.min(100, p.ultCharge + (res.weak || res.killed ? 9 : 4.5));
    }

    // Tempest Crown: all allied hits arc lightning to a nearby enemy.
    if (p && !res.killed) {
      let tempestActive = false;
      this.tempestUntil.forEach((until) => { if (until > now) tempestActive = true; });
      const target = this.host.state.enemies.get(id);
      if (tempestActive && target) {
        const ty = target.y + ENEMY_SIZE[target.kind].height / 2;
        const arc = this.enemies.near(target.x, ty, target.z, 10).find(([eid]) => eid !== id);
        if (arc) {
          const ae = arc[1];
          const aey = ae.y + ENEMY_SIZE[ae.kind].height / 2;
          this.host.fx({ t: "bolt", pts: [r1(target.x), r1(ty), r1(target.z), r1(ae.x), r1(aey), r1(ae.z)] });
          this.enemies.hit(arc[0], attacker, target.x, target.z, 12, 8);
        }
      }
    }

    // Relay technique: any heavy hit triggers nearby Archers' planted arrows onto that enemy.
    if (opts.heavy && !res.killed) {
      const target = this.host.state.enemies.get(id);
      if (!target) return res;
      const ty = target.y + ENEMY_SIZE[target.kind].height / 2;
      this.arrows.forEach((list, archerSid) => {
        if (archerSid === attacker || !list.length) return;
        const archer = this.host.state.players.get(archerSid);
        if (!archer || activeTech(archer) !== "relay") return;
        const a = list.shift()!;
        if (Math.hypot(a.x - target.x, a.y - ty, a.z - target.z) > 40) return;
        archer.classCharge = list.length;
        this.host.fx({ t: "crossfire", pts: [r1(a.x), r1(a.y), r1(a.z), r1(target.x), r1(ty), r1(target.z)], mantle: archer.mantle });
        this.enemies.hit(id, archerSid, a.x, a.z, 22, 18, { weak: true });
      });
    }
    return res;
  }

  private attack(sid: string, p: Player, combo: number, yaw: number, pitch: number) {
    const prof = ATTACKS[p.classId] ?? ATTACKS.lancer;
    const health = prof.health[combo - 1];
    const guard = prof.guard[combo - 1];
    const cx = p.x, cy = p.y + 1.2, cz = p.z;
    const heavy = combo === 3;

    if (prof.ranged) {
      const cp = Math.cos(pitch);
      const dir = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
      const wall = raycast(this.host.world, { x: cx, y: cy, z: cz }, dir, prof.reach);
      let best: { id: string; along: number } | null = null;
      this.host.state.enemies.forEach((e, id) => {
        if (e.state === 6) return;
        const size = ENEMY_SIZE[e.kind];
        const ex = e.x - cx, ey = e.y + size.height / 2 - cy, ez = e.z - cz;
        const along = ex * dir.x + ey * dir.y + ez * dir.z;
        if (along < 0 || along - size.radius > wall) return;
        const off = Math.hypot(ex - dir.x * along, ey - dir.y * along, ez - dir.z * along);
        if (off < size.radius + 0.5 && (!best || along < best.along)) best = { id, along };
      });
      const hit = best as { id: string; along: number } | null;
      const dist = hit ? hit.along : wall;
      const tx = cx + dir.x * dist, ty = cy + dir.y * dist, tz = cz + dir.z * dist;
      this.host.fx({ t: "shot", from: [r1(cx), r1(cy), r1(cz)], to: [r1(tx), r1(ty), r1(tz)] });
      if (hit) this.hitWithRelay(hit.id, sid, p.x, p.z, health, guard, { heavy });

      // Crossfire: trigger any planted arrows toward the target point.
      const planted = this.arrows.get(sid);
      if (planted?.length) {
        const pts: number[] = [];
        let crossfireBonus = false;
        for (const a of planted) {
          pts.push(r1(a.x), r1(a.y), r1(a.z), r1(tx), r1(ty), r1(tz));
          if (hit) {
            const d1x = tx - cx, d1y = ty - cy, d1z = tz - cz;
            const d2x = tx - a.x, d2y = ty - a.y, d2z = tz - a.z;
            const l1 = Math.hypot(d1x, d1y, d1z) || 1;
            const l2 = Math.hypot(d2x, d2y, d2z) || 1;
            const dot = (d1x * d2x + d1y * d2y + d1z * d2z) / (l1 * l2);
            if (dot < 0.92) crossfireBonus = true; // >= ~23 degrees between angles
            const extraHealth = crossfireBonus ? 18 : 10;
            const extraGuard = (crossfireBonus ? 16 : 8) + (p.mantle === "titan" ? 14 : 0);
            this.enemies.hit(hit.id, sid, a.x, a.z, extraHealth, extraGuard, {
              weak: crossfireBonus,
              heavy: p.mantle === "titan",
            });
            if (p.mantle === "tide") this.enemies.pull(hit.id, a.x, a.z);
          }
        }
        // Twin Line / Net also link the planted anchors together and damage enemies near the trap.
        const tech = activeTech(p);
        if ((tech === "twin-line" || tech === "net") && planted.length >= 2) {
          for (let i = 0; i + 1 < planted.length; i++) {
            const a = planted[i], b = planted[i + 1];
            pts.push(r1(a.x), r1(a.y), r1(a.z), r1(b.x), r1(b.y), r1(b.z));
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
            for (const [eid] of this.enemies.near(mx, my, mz, Math.hypot(b.x - a.x, b.z - a.z) * 0.55 + 2)) {
              if (eid === hit?.id) continue;
              this.enemies.hit(eid, sid, mx, mz, 12, 12);
              if (p.mantle === "tide") this.enemies.pull(eid, mx, mz);
            }
          }
        }
        this.host.fx({ t: "crossfire", pts, mantle: p.mantle });
        if (p.mantle === "storm" && hit) {
          const chain = this.enemies.near(tx, ty, tz, 9).find(([eid]) => eid !== hit.id);
          if (chain) {
            const ce = chain[1];
            const cey = ce.y + ENEMY_SIZE[ce.kind].height / 2;
            this.host.fx({ t: "bolt", pts: [r1(tx), r1(ty), r1(tz), r1(ce.x), r1(cey), r1(ce.z)] });
            this.enemies.hit(chain[0], sid, tx, tz, 14, 10);
          }
        }
        planted.length = 0;
        p.classCharge = 0;
      }
      return;
    }

    // Melee: a cone in front, measured on the horizontal plane with some vertical tolerance.
    const targets: Array<[string, number]> = [];
    this.host.state.enemies.forEach((e, id) => {
      if (e.state === 6) return;
      const size = ENEMY_SIZE[e.kind];
      const dx = e.x - p.x, dz = e.z - p.z;
      const d = Math.hypot(dx, dz) - size.radius;
      if (d > prof.reach) return;
      if (p.y + 1.2 < e.y - 1 || p.y > e.y + size.height + 1.5) return;
      let off = Math.atan2(dx, dz) - yaw;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      if (Math.abs(off) <= prof.halfAngle || d < 0.4) targets.push([id, d]);
    });
    targets.sort((a, b) => a[1] - b[1]);
    for (const [id] of targets.slice(0, prof.maxTargets)) {
      this.hitWithRelay(id, sid, p.x, p.z, health, guard, { heavy });
    }
  }

  /** Steep dives crack armour; Long Dive amplifies steep high-speed slams. */
  private impact(sid: string, p: Player, speed: number, steep: number) {
    const hb = HORIZON_BREAK;
    const isLong = activeTech(p) === "long-dive";
    const radius = isLong ? hb.impactRadius + 1.5 : hb.impactRadius;
    const mult = isLong && steep > 0.65 ? 1.45 : 1;
    this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y), z: r1(p.z), r: radius, kind: "impact" });
    for (const [id] of this.enemies.near(p.x, p.y + 0.5, p.z, radius)) {
      this.hitWithRelay(id, sid, p.x, p.z, hb.impactHealth(speed) * mult, hb.impactGuard(speed, steep) * mult, { heavy: steep > 0.6 });
    }
  }

  /** Shallow, fast passes pierce every enemy you fly through; Skimmer chains momentum. */
  private pierce(sid: string, p: Player) {
    if (p.mode !== Mode.Flight && p.mode !== Mode.Dive) return;
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    const hb = HORIZON_BREAK;
    if (speed < hb.pierceSpeed) return;
    const now = this.host.now();
    let ready = this.pierceReady.get(sid);
    if (!ready) { ready = new Map(); this.pierceReady.set(sid, ready); }
    let piercedAny = false;
    for (const [id] of this.enemies.near(p.x, p.y + 0.9, p.z, hb.pierceRadius)) {
      if ((ready.get(id) ?? 0) > now) continue;
      ready.set(id, now + hb.pierceCooldown);
      piercedAny = true;
      this.enemies.hit(id, sid, p.x - p.vx, p.z - p.vz, hb.pierceHealth(speed), hb.pierceGuard);
    }
    if (piercedAny && activeTech(p) === "skimmer") {
      p.stamina = Math.min(100, p.stamina + 15);
      const scale = Math.min(38, speed + 4) / (speed || 1);
      p.vx *= scale; p.vz *= scale;
    }
  }

  /** Mantle skill on key 1. Returns false when it can't be used yet. */
  ability(sid: string, p: Player): boolean {
    if (!p.mantleAwakened || p.abilityCooldown > 0 || p.downTime > 0) return false;
    const skill = MANTLE_SKILLS[p.mantle];
    if (!skill) return false;
    p.abilityCooldown = skill.cooldown;
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);

    if (p.mantle === "tide") {
      const path = activePath(p);
      const wide = path === "maelstrom";
      const breaker = path === "breaker";
      const radius = wide ? 20 : 14;
      const px = p.x + fx * 4, pz = p.z + fz * 4;
      this.host.fx({ t: "ring", x: r1(px), y: r1(p.y), z: r1(pz), r: radius, kind: "tide" });
      for (const [id] of this.enemies.near(p.x, p.y + 0.5, p.z, radius)) {
        this.enemies.pull(id, px, pz);
        this.hitWithRelay(id, sid, p.x, p.z, 5, breaker ? 24 : 15);
      }
      if (wide || breaker) {
        this.host.state.players.forEach((ally) => {
          if (ally.downTime > 0 || Math.hypot(ally.x - p.x, ally.y - p.y, ally.z - p.z) > 12) return;
          if (wide) ally.hp = Math.min(ally.maxHp, ally.hp + 10);
          if (breaker) ally.stamina = Math.min(100, ally.stamina + 25);
        });
      }
    } else if (p.mantle === "storm") {
      const jumps = activePath(p) === "arc" ? 5 : 3;
      const pts = [r1(p.x), r1(p.y + 1.3), r1(p.z)];
      const struck = new Set<string>();
      let from = { x: p.x, y: p.y + 1.3, z: p.z };
      for (let i = 0; i < jumps; i++) {
        const next = this.enemies.near(from.x, from.y, from.z, i === 0 ? 22 : 11).find(([id]) => !struck.has(id));
        if (!next) break;
        const [id, e] = next;
        struck.add(id);
        const ey = e.y + ENEMY_SIZE[e.kind].height / 2;
        pts.push(r1(e.x), r1(ey), r1(e.z));
        this.staticMarks.set(id, Math.min(4, (this.staticMarks.get(id) ?? 0) + 1));
        this.hitWithRelay(id, sid, from.x, from.z, i === 0 ? 22 : 14, 12);
        from = { x: e.x, y: ey, z: e.z };
      }
      if (struck.size === 0) { p.abilityCooldown = 0.5; return false; }
      this.host.fx({ t: "bolt", pts });
    } else if (p.mantle === "titan") {
      const guard = activePath(p) === "juggernaut" ? 85 : 55;
      this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y), z: r1(p.z), r: 6.5, kind: "titan" });
      for (const [id] of this.enemies.near(p.x, p.y + 0.5, p.z, 6.5)) {
        this.hitWithRelay(id, sid, p.x, p.z, 14, guard, { heavy: true });
      }
    }
    return true;
  }

  /** Second mantle combat skill on key 2 (unlocks at level 4). */
  ability2(sid: string, p: Player, yaw: number, pitch: number): boolean {
    if (!p.mantleAwakened || p.level < UNLOCK_LEVELS.secondSkill || p.ability2Cooldown > 0 || p.downTime > 0) return false;
    const skill = MANTLE_SKILLS_2[p.mantle];
    if (!skill) return false;
    p.ability2Cooldown = skill.cooldown;
    const cp = Math.cos(pitch);
    const dir = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
    const path = activePath(p);

    if (p.mantle === "storm") {
      const addMarks = path === "overcharge" ? 2 : 1;
      const pts = [r1(p.x), r1(p.y + 1.2), r1(p.z)];
      this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y + 0.5), z: r1(p.z), r: 12, kind: "shrine" });
      for (const [id, e] of this.enemies.near(p.x, p.y + 0.8, p.z, 12)) {
        this.staticMarks.set(id, Math.min(4, (this.staticMarks.get(id) ?? 0) + addMarks));
        const ey = e.y + ENEMY_SIZE[e.kind].height / 2;
        pts.push(r1(e.x), r1(ey), r1(e.z), r1(p.x), r1(p.y + 1.2), r1(p.z));
        this.hitWithRelay(id, sid, p.x, p.z, 16, 18);
      }
      if (pts.length > 3) this.host.fx({ t: "bolt", pts });
    } else if (p.mantle === "tide") {
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const guard = path === "breaker" ? 72 : 45;
      const toX = p.x + fx * 15, toZ = p.z + fz * 15;
      this.host.fx({ t: "crossfire", pts: [r1(p.x), r1(p.y + 1.1), r1(p.z), r1(toX), r1(p.y + 1.1), r1(toZ)], mantle: "tide" });
      this.host.fx({ t: "ring", x: r1(p.x + fx * 6), y: r1(p.y + 0.3), z: r1(p.z + fz * 6), r: 6, kind: "tide" });
      for (const [id] of this.enemies.near(p.x + fx * 7, p.y + 0.8, p.z + fz * 7, 7.5)) {
        this.enemies.pull(id, toX, toZ);
        this.hitWithRelay(id, sid, p.x, p.z, 18, guard, { heavy: true });
      }
      this.host.state.players.forEach((ally, asid) => {
        if (asid !== sid && ally.downTime <= 0 && Math.hypot(ally.x - p.x, ally.z - p.z) < 9) {
          ally.vx += fx * 8; ally.vz += fz * 8;
        }
      });
    } else if (p.mantle === "titan") {
      const origin = { x: p.x, y: p.y + 1.4, z: p.z };
      const wall = raycast(this.host.world, origin, dir, 28);
      const dist = Math.min(wall, 24);
      const tx = origin.x + dir.x * dist, ty = origin.y + dir.y * dist, tz = origin.z + dir.z * dist;
      const radius = path === "catapult" ? 7.0 : 4.5;
      this.host.fx({ t: "shot", from: [r1(origin.x), r1(origin.y), r1(origin.z)], to: [r1(tx), r1(ty), r1(tz)] });
      this.host.fx({ t: "ring", x: r1(tx), y: r1(ty), z: r1(tz), r: radius, kind: "titan" });
      for (const [id] of this.enemies.near(tx, ty, tz, radius)) {
        this.hitWithRelay(id, sid, p.x, p.z, 26, 45, { heavy: true });
      }
    }
    return true;
  }

  /** Mantle exploration & movement ability on key 3. */
  explore(sid: string, p: Player, yaw: number): boolean {
    if (!p.mantleAwakened || p.exploreCooldown > 0 || p.downTime > 0) return false;
    const skill = MANTLE_EXPLORE[p.mantle];
    if (!skill) return false;
    p.exploreCooldown = skill.cooldown;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);

    if (p.mantle === "storm") {
      // Updraft: lift player and nearby allies into flight.
      this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y), z: r1(p.z), r: 7, kind: "shrine" });
      this.host.state.players.forEach((ally) => {
        if (ally.downTime > 0 || Math.hypot(ally.x - p.x, ally.y - p.y, ally.z - p.z) > 7) return;
        ally.mode = Mode.Flight;
        ally.vy = Math.max(ally.vy, 18);
        ally.stamina = Math.min(100, ally.stamina + 35);
      });
    } else if (p.mantle === "tide") {
      // Surface Ride: surge forward along bearing (extra speed near water).
      const onWater = p.y < SEA_LEVEL + 4;
      const boost = onWater ? 28 : 22;
      p.mode = Mode.Flight;
      p.vx = fx * boost;
      p.vz = fz * boost;
      p.vy = Math.max(p.vy, onWater ? 4 : 6);
      p.stamina = Math.min(100, p.stamina + 35);
      this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y), z: r1(p.z), r: 5, kind: "tide" });
    } else if (p.mantle === "titan") {
      // Peak Leap: giant bound across cliffs.
      p.mode = Mode.Flight;
      p.vy = Math.max(p.vy, 17);
      p.vx += fx * 18;
      p.vz += fz * 18;
      p.stamina = Math.min(100, p.stamina + 30);
      this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y), z: r1(p.z), r: 5.5, kind: "titan" });
      if (activePath(p) === "catapult") {
        for (const [id] of this.enemies.near(p.x, p.y + 0.5, p.z, 6)) {
          this.hitWithRelay(id, sid, p.x, p.z, 14, 35, { heavy: true });
        }
      }
    }
    return true;
  }

  /** Mantle ultimate on key 4 (spends 100 ultimate charge). */
  ultimate(sid: string, p: Player): "ok" | "dormant" | "charge" {
    if (!p.mantleAwakened) return "dormant";
    if (p.ultCharge < 100 || p.downTime > 0) return "charge";
    p.ultCharge = 0;
    const now = this.host.now();
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    const path = activePath(p);

    if (p.mantle === "storm") {
      const duration = path === "arc" ? 12 : 8;
      this.tempestUntil.set(sid, now + duration);
      const pts = [r1(p.x), r1(p.y + 1.5), r1(p.z)];
      const list = this.enemies.near(p.x, p.y + 1, p.z, 28).slice(0, 6);
      for (const [id, e] of list) {
        const marks = this.staticMarks.get(id) ?? 0;
        this.staticMarks.delete(id);
        const markBonus = marks * (path === "overcharge" ? 36 : 18);
        const ey = e.y + ENEMY_SIZE[e.kind].height / 2;
        pts.push(r1(e.x), r1(ey), r1(e.z));
        this.hitWithRelay(id, sid, p.x, p.z, 55 + markBonus, 35, { heavy: true }, false);
      }
      this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y + 0.5), z: r1(p.z), r: 16, kind: "shrine" });
      if (pts.length > 3) this.host.fx({ t: "bolt", pts });
    } else if (p.mantle === "tide") {
      const wide = path === "maelstrom";
      const radius = wide ? 28 : 20;
      const px = p.x + fx * 8, pz = p.z + fz * 8;
      this.host.fx({ t: "ring", x: r1(px), y: r1(p.y + 0.3), z: r1(pz), r: radius, kind: "tide" });
      for (const [id] of this.enemies.near(p.x, p.y + 1, p.z, radius)) {
        this.enemies.pull(id, px, pz);
        this.hitWithRelay(id, sid, p.x, p.z, 45, 55, { heavy: true }, false);
      }
      this.host.state.players.forEach((ally) => {
        if (ally.downTime > 0 || Math.hypot(ally.x - p.x, ally.y - p.y, ally.z - p.z) > radius) return;
        ally.hp = Math.min(ally.maxHp, ally.hp + 35);
        ally.stamina = 100;
        ally.vx += fx * 14;
        ally.vz += fz * 14;
        ally.vy = Math.max(ally.vy, 9);
        ally.mode = Mode.Flight;
      });
    } else if (p.mantle === "titan") {
      const duration = path === "juggernaut" ? 11 : 8;
      this.giantUntil.set(sid, now + duration);
      p.giant = 1;
      this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y + 0.3), z: r1(p.z), r: 9.5, kind: "titan" });
      for (const [id] of this.enemies.near(p.x, p.y + 1, p.z, 9.5)) {
        this.hitWithRelay(id, sid, p.x, p.z, 48, 85, { heavy: true }, false);
      }
    }
    return "ok";
  }
}
