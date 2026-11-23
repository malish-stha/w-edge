/**
 * Resolving what players do to enemies: basic attacks, the Lancer's Horizon
 * Break (dive impacts and piercing passes) and mantle skills.
 */
import {
  ATTACKS, ENEMY_SIZE, HORIZON_BREAK, MANTLE_SKILLS, Mode,
  raycast, type StepEvents,
} from "@worlds-edge/shared";
import type { Enemies } from "./enemies.ts";
import type { Host } from "./enemies.ts";
import type { Player } from "./schema.ts";

const r1 = (n: number) => Math.round(n * 10) / 10;

export class Combat {
  /** Per player, per enemy: when they may be pierced again. */
  private pierceReady = new Map<string, Map<string, number>>();

  constructor(private host: Host, private enemies: Enemies) {}

  forget(sid: string) { this.pierceReady.delete(sid); }

  /** Resolve everything one step of input produced for one player. */
  resolve(sid: string, p: Player, ev: StepEvents, yaw: number, pitch: number) {
    if (p.downTime > 0) return;
    if (ev.attack) this.attack(sid, p, ev.attack, yaw, pitch);
    if (p.classId === "lancer") {
      if (ev.impactSpeed) this.impact(sid, p, ev.impactSpeed, ev.impactSteep);
      this.pierce(sid, p);
    }
  }

  private attack(sid: string, p: Player, combo: number, yaw: number, pitch: number) {
    const prof = ATTACKS[p.classId] ?? ATTACKS.lancer;
    const health = prof.health[combo - 1];
    const guard = prof.guard[combo - 1];
    const cx = p.x, cy = p.y + 1.2, cz = p.z;

    if (prof.ranged) {
      // Arrow: a ray along the camera's aim, stopped by terrain.
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
      this.host.fx({ t: "shot", from: [r1(cx), r1(cy), r1(cz)], to: [r1(cx + dir.x * dist), r1(cy + dir.y * dist), r1(cz + dir.z * dist)] });
      if (hit) this.enemies.hit(hit.id, sid, p.x, p.z, health, guard);
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
    for (const [id] of targets.slice(0, prof.maxTargets)) this.enemies.hit(id, sid, p.x, p.z, health, guard);
  }

  /** Steep dives crack armour; the faster the dive, the harder the hit. */
  private impact(sid: string, p: Player, speed: number, steep: number) {
    const hb = HORIZON_BREAK;
    this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y), z: r1(p.z), r: hb.impactRadius, kind: "impact" });
    for (const [id] of this.enemies.near(p.x, p.y + 0.5, p.z, hb.impactRadius)) {
      this.enemies.hit(id, sid, p.x, p.z, hb.impactHealth(speed), hb.impactGuard(speed, steep), { heavy: steep > 0.6 });
    }
  }

  /** Shallow, fast passes pierce every enemy you fly through. */
  private pierce(sid: string, p: Player) {
    if (p.mode !== Mode.Flight && p.mode !== Mode.Dive) return;
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    const hb = HORIZON_BREAK;
    if (speed < hb.pierceSpeed) return;
    const now = this.host.now();
    let ready = this.pierceReady.get(sid);
    if (!ready) { ready = new Map(); this.pierceReady.set(sid, ready); }
    for (const [id] of this.enemies.near(p.x, p.y + 0.9, p.z, hb.pierceRadius)) {
      if ((ready.get(id) ?? 0) > now) continue;
      ready.set(id, now + hb.pierceCooldown);
      this.enemies.hit(id, sid, p.x - p.vx, p.z - p.vz, hb.pierceHealth(speed), hb.pierceGuard);
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
      // Undertow: drag enemies into a knot in front of you and interrupt them.
      const px = p.x + fx * 4, pz = p.z + fz * 4;
      this.host.fx({ t: "ring", x: r1(px), y: r1(p.y), z: r1(pz), r: 14, kind: "tide" });
      for (const [id] of this.enemies.near(p.x, p.y + 0.5, p.z, 14)) {
        this.enemies.pull(id, px, pz);
        this.enemies.hit(id, sid, p.x, p.z, 5, 15);
      }
    } else if (p.mantle === "storm") {
      // Chain lightning: nearest enemy, then up to two more nearby.
      const pts = [r1(p.x), r1(p.y + 1.3), r1(p.z)];
      const struck = new Set<string>();
      let from = { x: p.x, y: p.y + 1.3, z: p.z };
      for (let i = 0; i < 3; i++) {
        const next = this.enemies.near(from.x, from.y, from.z, i === 0 ? 22 : 9).find(([id]) => !struck.has(id));
        if (!next) break;
        const [id, e] = next;
        struck.add(id);
        const ey = e.y + ENEMY_SIZE[e.kind].height / 2;
        pts.push(r1(e.x), r1(ey), r1(e.z));
        this.enemies.hit(id, sid, from.x, from.z, i === 0 ? 22 : 14, 12);
        from = { x: e.x, y: ey, z: e.z };
      }
      if (struck.size === 0) { p.abilityCooldown = 0.5; return false; }
      this.host.fx({ t: "bolt", pts });
    } else if (p.mantle === "titan") {
      // Titan Slam: heavy stagger around you.
      this.host.fx({ t: "ring", x: r1(p.x), y: r1(p.y), z: r1(p.z), r: 6.5, kind: "titan" });
      for (const [id] of this.enemies.near(p.x, p.y + 0.5, p.z, 6.5)) this.enemies.hit(id, sid, p.x, p.z, 14, 55, { heavy: true });
    }
    return true;
  }
}
