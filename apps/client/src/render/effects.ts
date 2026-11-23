import type { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.js";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Fx, PingKind } from "@worlds-edge/shared";
import type { Fx, PingKind, SkillFxKind } from "@worlds-edge/shared";
import { mat, type FlightFxEvent, type SwingEvent } from "./character.ts";

type RingKind = Extract<Fx, { t: "ring" }>["kind"];
const RING_COLORS: Record<RingKind, string> = {
  impact: "#ffffff", tide: "#5cc8ff", titan: "#ff9b3d", shrine: "#ffd36b", telegraph: "#ff5a4a", revive: "#9fe8a8",
};
const PING_COLORS: Record<PingKind, string> = {
  ping: "#7fe8ff", weak: "#ffd36b", revive: "#9fe8a8", target: "#ff7a6b", rally: "#ffd36b",
};
const MANTLE_HEX: Record<string, string> = {
  storm: "#9fe4ff", tide: "#5cc8ff", titan: "#ffb347",
};

interface Ring { mesh: Mesh; t: number; life: number; r: number; inward: boolean; lift?: number }
interface Line { mesh: LinesMesh; t: number; life: number }
interface Marker { node: TransformNode; t: number; life: number; spin: boolean }
interface Projectile {
  node: TransformNode;
  from: Vector3;
  to: Vector3;
  t: number;
  life: number;
  arc: number;
  spin: boolean;
  onArrive?: () => void;
}
interface SlashArc { node: TransformNode; t: number; life: number; sweep: number; scale: number }
interface AnimatedFx { node: TransformNode; t: number; life: number; update: (k: number, dt: number) => void }

/**
 * World-space effects: flying 3D arrows & boulders, weapon slash arcs & lance
 * thrust streaks, planted Crossfire arrows, pings, and mantle shockwaves.
 * thrust streaks, multi-layered 3D skill vortices/domes/pillars/spikes, and pings.
 */
export class Effects {
  private rings: Ring[] = [];
  private lines: Line[] = [];
  private markers: Marker[] = [];
  private projectiles: Projectile[] = [];
  private slashes: SlashArc[] = [];
  private anims: AnimatedFx[] = [];
  private rallyMesh: Mesh | null = null;
  private rallyBeam: LinesMesh | null = null;

  constructor(private scene: Scene) { }

  ring(x: number, y: number, z: number, r: number, kind: RingKind) {
    const mesh = CreateTorus("ring", { diameter: 2, thickness: kind === "telegraph" ? 0.12 : 0.09, tessellation: 40 }, this.scene);
    mesh.material = mat(this.scene, RING_COLORS[kind], { glow: 1 });
    mesh.position.set(x, y + 0.15, z);
    mesh.isPickable = false;
    const inward = kind === "telegraph";
    const life = inward ? 0.7 : kind === "shrine" ? 1.4 : 0.55;
    this.rings.push({ mesh, t: 0, life, r, inward });

    // Power bursts get an inner rising secondary wave for depth.
    if (!inward && (kind === "tide" || kind === "titan" || kind === "shrine" || kind === "impact")) {
      const inner = CreateTorus("ringInner", { diameter: 2, thickness: 0.06, tessellation: 32 }, this.scene);
      inner.material = mat(this.scene, "#ffffff", { glow: 1, alpha: 0.75 });
      inner.position.set(x, y + 0.35, z);
      inner.isPickable = false;
      this.rings.push({ mesh: inner, t: 0, life: life * 0.7, r: r * 0.65, inward: false, lift: 1.4 });
    }
  }

  ping(x: number, y: number, z: number, kind: PingKind) {
    const hex = PING_COLORS[kind] ?? "#ffd36b";
    const ring = CreateTorus("pingRing", { diameter: 2, thickness: 0.14, tessellation: 24 }, this.scene);
    ring.material = mat(this.scene, hex, { glow: 1 });
    ring.position.set(x, y + 0.25, z);
    ring.isPickable = false;
    this.rings.push({ mesh: ring, t: 0, life: 2.8, r: 2.4, inward: true });

    const beam = CreateLines("pingBeam", { points: [new Vector3(x, y, z), new Vector3(x, y + 16, z)] }, this.scene);
    beam.color = Color3.FromHexString(hex);
    beam.isPickable = false;
    this.lines.push({ mesh: beam, t: 0, life: 4.0 });
  }

  setRally(rally: { x: number; y: number; z: number } | null) {
    if (!rally) {
      this.rallyMesh?.dispose(); this.rallyMesh = null;
      this.rallyBeam?.dispose(); this.rallyBeam = null;
      return;
    }
    if (!this.rallyMesh) {
      this.rallyMesh = CreateTorus("rallyRing", { diameter: 4, thickness: 0.18, tessellation: 32 }, this.scene);
      this.rallyMesh.material = mat(this.scene, "#ffd36b", { glow: 1 });
      this.rallyMesh.isPickable = false;
    }
    this.rallyMesh.position.set(rally.x, rally.y + 0.2, rally.z);
    this.rallyBeam?.dispose();
    this.rallyBeam = CreateLines("rallyBeam", { points: [new Vector3(rally.x, rally.y, rally.z), new Vector3(rally.x, rally.y + 24, rally.z)] }, this.scene);
    this.rallyBeam.color = Color3.FromHexString("#ffd36b");
    this.rallyBeam.isPickable = false;
  }

  pin(x: number, y: number, z: number, kind: "arrow" | "shield") {
    const node = new TransformNode(`pin-${kind}`, this.scene);
    node.position.set(x, y, z);
    if (kind === "arrow") {
      const shaft = CreateBox("pinShaft", { width: 0.06, height: 1.05, depth: 0.06 }, this.scene);
      shaft.parent = node; shaft.position.y = 0.45; shaft.material = mat(this.scene, "#8b6a4a"); shaft.isPickable = false;
      const tip = CreateCylinder("pinTip", { height: 0.22, diameterTop: 0, diameterBottom: 0.14, tessellation: 4 }, this.scene);
      tip.parent = node; tip.position.y = 0.06; tip.rotation.x = Math.PI; tip.material = mat(this.scene, "#ffd36b", { glow: 1 }); tip.isPickable = false;
      const fletch = CreateBox("pinFletch", { width: 0.18, height: 0.18, depth: 0.18 }, this.scene);
      fletch.parent = node; fletch.position.y = 0.96; fletch.material = mat(this.scene, "#ff9b3d", { glow: 0.9 }); fletch.isPickable = false;
      const halo = CreateTorus("pinHalo", { diameter: 0.9, thickness: 0.06, tessellation: 20 }, this.scene);
      halo.parent = node; halo.position.y = 0.08; halo.material = mat(this.scene, "#ffd36b", { glow: 1 }); halo.isPickable = false;
    } else {
      const wall = CreateBox("pinShield", { width: 1.8, height: 1.5, depth: 0.14 }, this.scene);
      wall.parent = node; wall.material = mat(this.scene, "#7fe8ff", { glow: 0.9, alpha: 0.55 }); wall.isPickable = false;
    }
    this.markers.push({ node, t: 0, life: kind === "arrow" ? 18 : 2.5, spin: kind === "arrow" });
  }

  crossfire(pts: number[], mantle: string) {
    const hex = MANTLE_HEX[mantle] ?? "#ffd36b";
    const color = Color3.FromHexString(hex);
    for (let i = 0; i + 5 < pts.length; i += 6) {
      const a = new Vector3(pts[i], pts[i + 1], pts[i + 2]);
      const b = new Vector3(pts[i + 3], pts[i + 4], pts[i + 5]);
      const mesh = CreateLines("crossfire", { points: [a, b] }, this.scene);
      mesh.color = color;
      mesh.isPickable = false;
      this.lines.push({ mesh, t: 0, life: 0.45 });
    }
    for (const m of this.markers) m.t = Math.max(m.t, m.life - 0.1);
  }

  shot(from: [number, number, number], to: [number, number, number]) {
    const a = new Vector3(...from), b = new Vector3(...to);
    const dist = Vector3.Distance(a, b);
    // Faint air trail
    const trail = CreateLines("shotTrail", { points: [a, b] }, this.scene);
    trail.color = new Color3(1, 0.95, 0.8);
    trail.alpha = 0.55;
    trail.isPickable = false;
    this.lines.push({ mesh: trail, t: 0, life: 0.22 });

    // Real 3D arrow projectile flying swiftly to the target
    const arrow = new TransformNode("arrowProj", this.scene);
    arrow.position.copyFrom(a);
    arrow.lookAt(b);
    const shaft = CreateBox("aShaft", { width: 0.04, height: 0.04, depth: 0.95 }, this.scene);
    shaft.parent = arrow; shaft.material = mat(this.scene, "#8b6a4a"); shaft.isPickable = false;
    const head = CreateCylinder("aHead", { height: 0.18, diameterTop: 0, diameterBottom: 0.11, tessellation: 4 }, this.scene);
    head.parent = arrow; head.position.z = 0.54; head.rotation.x = Math.PI / 2;
    head.material = mat(this.scene, "#ffd36b", { glow: 1 }); head.isPickable = false;
    const fletch = CreateBox("aFletch", { width: 0.12, height: 0.12, depth: 0.16 }, this.scene);
    fletch.parent = arrow; fletch.position.z = -0.45;
    fletch.material = mat(this.scene, "#ff6b57", { glow: 0.6 }); fletch.isPickable = false;

    this.projectiles.push({
      node: arrow, from: a, to: b, t: 0,
      life: Math.max(0.06, Math.min(0.32, dist / 95)),
      arc: 0, spin: false,
    });
  }

  boulder(from: [number, number, number], to: [number, number, number], r: number) {
    const a = new Vector3(...from), b = new Vector3(...to);
    const dist = Vector3.Distance(a, b);
    const rock = new TransformNode("boulderProj", this.scene);
    rock.position.copyFrom(a);
    const core = CreateBox("rockCore", { size: 0.9 }, this.scene);
    core.parent = rock; core.material = mat(this.scene, "#8a6d54", { glow: 0.35 }); core.isPickable = false;
    const cap = CreateBox("rockCap", { width: 1.05, height: 0.65, depth: 0.75 }, this.scene);
    cap.parent = rock; cap.rotation.set(0.5, 0.7, 0.3); cap.material = mat(this.scene, "#ff9b3d", { glow: 0.65 }); cap.isPickable = false;

    this.projectiles.push({
      node: rock, from: a, to: b, t: 0,
      life: Math.max(0.14, Math.min(0.45, dist / 55)),
      arc: Math.min(3.5, dist * 0.12), spin: true,
      onArrive: () => this.ring(to[0], to[1], to[2], r, "titan"),
      onArrive: () => {
        this.ring(to[0], to[1], to[2], r, "titan");
        this.spawnSpikes(to[0], to[1], to[2], Math.min(3.5, r * 0.55), 5, "#ff9b3d", 0.9, 0.55);
      },
    });
  }

  private spawnDome(x: number, y: number, z: number, maxR: number, hex: string, life: number, heightScale = 0.65) {
    const node = new TransformNode("fxDome", this.scene);
    node.position.set(x, y, z);
    const dome = CreateSphere("domeMesh", { diameter: 2, segments: 12 }, this.scene);
    dome.parent = node;
    dome.material = mat(this.scene, hex, { glow: 1, alpha: 0.42, twoSided: true });
    dome.isPickable = false;
    this.anims.push({
      node, t: 0, life,
      update: (k) => {
        const s = maxR * (0.2 + 0.8 * Math.sqrt(k));
        node.scaling.set(s, s * heightScale, s);
        dome.visibility = (1 - k) * 0.85;
      },
    });
  }

  private spawnPillar(x: number, y: number, z: number, radius: number, height: number, hex: string, life: number, spin = 6) {
    const node = new TransformNode("fxPillar", this.scene);
    node.position.set(x, y + height * 0.5, z);
    const cyl = CreateCylinder("pillarMesh", { height, diameterTop: radius * 1.4, diameterBottom: radius * 0.65, tessellation: 14 }, this.scene);
    cyl.parent = node;
    cyl.material = mat(this.scene, hex, { glow: 1, alpha: 0.45, twoSided: true });
    cyl.isPickable = false;
    this.anims.push({
      node, t: 0, life,
      update: (k, dt) => {
        node.rotation.y += dt * spin;
        const grow = Math.min(1, k * 4);
        const w = 1 + k * 0.45;
        node.scaling.set(w, grow, w);
        cyl.visibility = (1 - k * k) * 0.85;
      },
    });
  }

  private spawnSpikes(x: number, y: number, z: number, radius: number, count: number, hex: string, scale: number, life: number) {
    const node = new TransformNode("fxSpikes", this.scene);
    node.position.set(x, y, z);
    const spikeMat = mat(this.scene, hex, { glow: 0.85 });
    const shards: Mesh[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const shard = CreateBox(`shard${i}`, { width: 0.45 * scale, height: 1.7 * scale, depth: 0.45 * scale }, this.scene);
      shard.parent = node;
      shard.position.set(Math.cos(a) * radius * 0.65, 0.35 * scale, Math.sin(a) * radius * 0.65);
      shard.rotation.set(Math.sin(a) * 0.45, a, -Math.cos(a) * 0.45);
      shard.material = spikeMat;
      shard.isPickable = false;
      shards.push(shard);
    }
    this.anims.push({
      node, t: 0, life,
      update: (k) => {
        const rise = k < 0.25 ? k / 0.25 : 1 - (k - 0.25) / 0.75;
        node.scaling.set(1, Math.max(0.05, rise), 1);
        for (const s of shards) s.visibility = Math.max(0, 1 - Math.max(0, k - 0.5) * 2);
      },
    });
  }

  private spawnBeam(from: Vector3, to: Vector3, diameter: number, hex: string, life: number) {
    const dist = Math.max(0.5, Vector3.Distance(from, to));
    const node = new TransformNode("fxBeam", this.scene);
    node.position.copyFrom(Vector3.Lerp(from, to, 0.5));
    node.lookAt(to);
    const beam = CreateCylinder("beamCyl", { height: dist, diameter, tessellation: 12 }, this.scene);
    beam.parent = node;
    beam.rotation.x = Math.PI / 2;
    beam.material = mat(this.scene, hex, { glow: 1, alpha: 0.65 });
    beam.isPickable = false;
    const core = CreateCylinder("beamCore", { height: dist, diameter: diameter * 0.45, tessellation: 10 }, this.scene);
    core.parent = node;
    core.rotation.x = Math.PI / 2;
    core.material = mat(this.scene, "#ffffff", { glow: 1, alpha: 0.85 });
    core.isPickable = false;
    this.anims.push({
      node, t: 0, life,
      update: (k) => {
        const w = 1 - k * 0.55;
        node.scaling.set(w, w, 1);
        beam.visibility = 1 - k;
        core.visibility = 1 - k;
      },
    });
  }

  private spawnVortexRings(x: number, y: number, z: number, r: number, hex: string, tiers: number, rise: boolean, life: number) {
    for (let i = 0; i < tiers; i++) {
      const node = new TransformNode(`fxVortex${i}`, this.scene);
      node.position.set(x, y + 0.35 + i * 0.55, z);
      const torus = CreateTorus(`vortexTorus${i}`, { diameter: 2, thickness: 0.1, tessellation: 28 }, this.scene);
      torus.parent = node;
      torus.rotation.set((i % 2 === 0 ? 1 : -1) * 0.18, 0, (i % 2 === 0 ? -1 : 1) * 0.15);
      torus.material = mat(this.scene, hex, { glow: 1, alpha: 0.75 });
      torus.isPickable = false;
      const startR = r * (0.45 + i * 0.22);
      const dir = i % 2 === 0 ? 1 : -1;
      this.anims.push({
        node, t: 0, life,
        update: (k, dt) => {
          node.rotation.y += dir * dt * (7 + i * 1.5);
          if (rise) node.position.y += dt * (4.2 + i * 1.1);
          const s = rise ? startR * (0.6 + k * 0.7) : startR * (1.2 - k * 0.65);
          node.scaling.set(s, 1, s);
          torus.visibility = 1 - k;
        },
      });
    }
  }

  /** Rich multi-layered 3D visuals for every mantle skill, exploration ability, ultimate, and class counter. */
  skillFx(ev: { skill: SkillFxKind; x: number; y: number; z: number; tx?: number; ty?: number; tz?: number; facing: number; r: number }) {
    const { skill, x, y, z, facing, r } = ev;
    const fx = Math.sin(facing), fz = Math.cos(facing);
    const tx = ev.tx ?? x + fx * r;
    const ty = ev.ty ?? y;
    const tz = ev.tz ?? z + fz * r;

    switch (skill) {
      case "undertow":
        this.spawnPillar(x, y, z, 1.3, 4.5, "#5cc8ff", 0.65, 9);
        this.spawnVortexRings(x, y, z, r * 0.45, "#7fe8ff", 3, false, 0.7);
        break;
      case "riptide":
        this.spawnPillar(tx, ty, tz, 2.5, 9.5, "#5cc8ff", 0.95, 11);
        this.spawnVortexRings(tx, ty, tz, r * 0.48, "#7fe8ff", 4, true, 0.95);
        this.spawnDome(tx, ty, tz, r * 0.65, "#5cc8ff", 0.78, 0.55);
        this.spawnBeam(new Vector3(x, y + 1, z), new Vector3(tx, ty + 1.2, tz), 1.4, "#7fe8ff", 0.55);
        break;
      case "surge":
        this.spawnBeam(new Vector3(x, y, z), new Vector3(tx, ty, tz), 0.75, "#5cc8ff", 0.44);
        this.spawnDome(tx, ty, tz, 3.2, "#7fe8ff", 0.45, 0.8);
        break;
      case "surface":
        this.spawnVortexRings(x, y + 0.2, z, 2.4, "#7fe8ff", 2, false, 0.5);
        this.spawnBeam(new Vector3(x - fx * 3, y + 0.5, z - fz * 3), new Vector3(x + fx * 3.5, y + 0.6, z + fz * 3.5), 0.55, "#7fe8ff", 0.35);
        break;
      case "chain":
        this.spawnDome(x, y, z, 2.2, "#9fe4ff", 0.35, 1.0);
        this.spawnDome(tx, ty, tz, 2.6, "#ffffff", 0.4, 1.0);
        break;
      case "static":
        this.spawnDome(x, y, z, r * 0.72, "#9fe4ff", 0.48, 0.75);
        this.spawnVortexRings(x, y, z, r * 0.35, "#ffd36b", 2, false, 0.55);
        break;
      case "tempest": {
        this.spawnPillar(x, y, z, 1.6, 22, "#9fe4ff", 0.8, 12);
        this.spawnDome(x, y, z, r * 0.7, "#7fe8ff", 0.7, 0.7);
        this.spawnVortexRings(x, y + 0.8, z, 5.5, "#ffd36b", 3, true, 0.85);
        const pts: number[] = [];
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          pts.push(x, y + 1.4, z, x + Math.cos(a) * r * 0.7, y + 0.4, z + Math.sin(a) * r * 0.7);
        }
        this.bolt(pts);
        break;
      }
      case "updraft":
        this.spawnPillar(x, y, z, 2.0, 11, "#dff6ff", 0.75, 10);
        this.spawnVortexRings(x, y, z, 3.4, "#9fe4ff", 4, true, 0.85);
        break;
      case "slam":
        this.spawnSpikes(x, y, z, r * 0.65, 7, "#ff9b3d", 1.15, 0.78);
        this.spawnDome(x, y, z, r * 0.85, "#ffb347", 0.45, 0.45);
        break;
      case "hurl":
        this.spawnDome(x, y, z, 2.0, "#ff9b3d", 0.32, 0.9);
        break;
      case "leap":
        this.spawnSpikes(x, y, z, 2.8, 5, "#d9a066", 0.85, 0.58);
        this.spawnVortexRings(x, y, z, 2.6, "#ffd36b", 2, true, 0.55);
        break;
      case "colossal":
        this.spawnSpikes(x, y, z, r * 0.65, 8, "#ff9b3d", 1.75, 0.95);
        this.spawnPillar(x, y, z, 2.0, 12, "#ffd36b", 0.85, 6);
        this.spawnDome(x, y, z, r * 0.9, "#ff7b29", 0.7, 0.65);
        break;
      case "riposte": {
        for (const tilt of [-0.55, 0.55]) {
          const node = new TransformNode("riposteArc", this.scene);
          node.position.set(x + fx * 1.4, y + 0.4, z + fz * 1.4);
          node.rotation.set(0, facing, tilt);
          const arc = CreateTorus("ripTorus", { diameter: 4.2, thickness: 0.22, tessellation: 28 }, this.scene);
          arc.parent = node;
          arc.scaling.set(1, 0.25, 1);
          arc.material = mat(this.scene, "#ffd36b", { glow: 1, alpha: 0.9 });
          arc.isPickable = false;
          this.slashes.push({ node, t: 0, life: 0.3, sweep: tilt * 3, scale: 1.4 });
        }
        this.spawnDome(tx, ty, tz, 3.2, "#ffd36b", 0.35, 0.7);
        break;
      }
      case "breakwater": {
        const wallNode = new TransformNode("bwWave", this.scene);
        wallNode.position.set(x + fx * 1.2, y + 0.8, z + fz * 1.2);
        wallNode.rotation.y = facing;
        const wall = CreateBox("bwWaveBox", { width: 3.4, height: 1.9, depth: 0.35 }, this.scene);
        wall.parent = wallNode;
        wall.material = mat(this.scene, "#7fe8ff", { glow: 1, alpha: 0.6 });
        wall.isPickable = false;
        this.anims.push({
          node: wallNode, t: 0, life: 0.42,
          update: (k) => {
            const dist = 1.2 + k * 4.5;
            wallNode.position.set(x + fx * dist, y + 0.8 + k * 0.4, z + fz * dist);
            wallNode.scaling.set(1 + k * 1.2, 1 + k * 0.3, 1);
            wall.visibility = (1 - k) * 0.85;
          },
        });
        this.spawnDome(tx, ty, tz, r * 0.7, "#7fe8ff", 0.48, 0.55);
        break;
      }
    }
  }

  /** Instant blink teleport warp rift, luminous travel corridor, and arrival burst. */
  teleport(from: [number, number, number], to: [number, number, number], mantle: string) {
    const hex = MANTLE_HEX[mantle] ?? "#7fe8ff";
    const a = new Vector3(from[0], from[1] + 1.0, from[2]);
    const b = new Vector3(to[0], to[1] + 1.0, to[2]);
    this.spawnPillar(from[0], from[1], from[2], 0.9, 3.6, hex, 0.35, 14);
    this.ring(from[0], from[1] + 0.1, from[2], 2.2, "telegraph");
    this.spawnBeam(a, b, 0.55, hex, 0.32);
    this.spawnDome(to[0], to[1] + 0.5, to[2], 2.4, hex, 0.4, 0.85);
    this.ring(to[0], to[1] + 0.1, to[2], 2.8, mantle === "tide" ? "tide" : mantle === "titan" ? "titan" : "shrine");
  }

  swing(ev: SwingEvent) {
    if (ev.classId === "archer") return;
    const hex = ev.charged ? (MANTLE_HEX[ev.mantle] ?? "#ffd36b") : ev.classId === "saber" ? "#dff6ff" : "#ffe6b3";
    const fx = Math.sin(ev.facing), fz = Math.cos(ev.facing);
    const node = new TransformNode(`swing-${ev.classId}`, this.scene);
    node.position.set(ev.x + fx * 1.15, ev.y, ev.z + fz * 1.15);
    node.rotation.y = ev.facing;

    if (ev.classId === "lancer") {
      if (ev.combo === 3) {
        const arc = CreateTorus("lanceSweep", { diameter: 3.4, thickness: 0.14, tessellation: 24 }, this.scene);
        arc.parent = node; arc.scaling.set(1, 0.35, 1); arc.material = mat(this.scene, hex, { glow: 1, alpha: 0.8 }); arc.isPickable = false;
        this.slashes.push({ node, t: 0, life: 0.24, sweep: 1.2, scale: 1.2 });
      } else {
        // Sharp forward lance thrust cone
        const cone = CreateCylinder("lanceThrust", { height: 2.5, diameterTop: 0.04, diameterBottom: 0.75, tessellation: 10 }, this.scene);
        cone.parent = node; cone.position.z = 0.85; cone.rotation.x = Math.PI / 2;
        cone.material = mat(this.scene, hex, { glow: 1, alpha: 0.7 }); cone.isPickable = false;
        this.slashes.push({ node, t: 0, life: 0.22, sweep: 0, scale: 1.15 });
      }
      return;
    }

    if (ev.classId === "vanguard" && ev.combo === 2) {
      // Shield bash burst
      const bash = CreateCylinder("shieldBash", { height: 0.12, diameter: 1.9, tessellation: 16 }, this.scene);
      bash.parent = node; bash.rotation.x = Math.PI / 2; bash.position.z = 0.25;
      bash.material = mat(this.scene, "#7fe8ff", { glow: 1, alpha: 0.65 }); bash.isPickable = false;
      this.slashes.push({ node, t: 0, life: 0.24, sweep: 0, scale: 1.25 });
      return;
    }

    // Saber / Vanguard sword crescent arc
    const arc = CreateTorus("slashArc", { diameter: ev.combo === 3 ? 3.2 : 2.6, thickness: ev.combo === 3 ? 0.18 : 0.12, tessellation: 24 }, this.scene);
    arc.parent = node;
    arc.scaling.set(1, 0.25, 1);
    arc.material = mat(this.scene, hex, { glow: 1, alpha: 0.85 });
    arc.isPickable = false;
    if (ev.combo === 3) { node.rotation.z = Math.PI / 2; }
    else { node.rotation.z = ev.combo === 2 ? -0.45 : 0.45; }
    this.slashes.push({ node, t: 0, life: 0.24, sweep: ev.combo === 2 ? -1.4 : 1.4, scale: ev.charged ? 1.35 : 1.1 });
  }

  flightFx(ev: FlightFxEvent) {
    const hex = MANTLE_HEX[ev.mantle] ?? "#dff6ff";
    const color = Color3.FromHexString(hex);
    const speed = Math.hypot(ev.vx, ev.vy, ev.vz);
    const dirX = speed > 0.5 ? ev.vx / speed : Math.sin(ev.facing);
    const dirY = speed > 0.5 ? ev.vy / speed : 0;
    const dirZ = speed > 0.5 ? ev.vz / speed : Math.cos(ev.facing);
    const sideX = Math.cos(ev.facing), sideZ = -Math.sin(ev.facing);

    switch (ev.kind) {
      case "takeoff": {
        this.ring(ev.x, ev.y, ev.z, 2.2, "impact");
        for (const s of [-0.55, 0.55]) {
          const line = CreateLines("takeoffGust", {
            points: [new Vector3(ev.x + sideX * s, ev.y - 0.2, ev.z + sideZ * s), new Vector3(ev.x + sideX * s * 1.4, ev.y + 1.8, ev.z + sideZ * s * 1.4)],
          }, this.scene);
          line.color = color;
          line.isPickable = false;
          this.lines.push({ mesh: line, t: 0, life: 0.28 });
        }
        break;
      }
      case "dodge": {
        this.ring(ev.x, ev.y, ev.z, 1.8, ev.mantle === "tide" ? "tide" : ev.mantle === "titan" ? "titan" : "impact");
        for (const s of [-0.45, 0.45]) {
          const ox = ev.x + sideX * s, oz = ev.z + sideZ * s;
          const line = CreateLines("dodgeStreak", {
            points: [new Vector3(ox, ev.y, oz), new Vector3(ox - dirX * 2.6, ev.y - dirY * 2.6, oz - dirZ * 2.6)],
          }, this.scene);
          line.color = color;
          line.isPickable = false;
          this.lines.push({ mesh: line, t: 0, life: 0.22 });
        }
        break;
      }
      case "streak": {
        const len = Math.min(3.6, 1.4 + speed * 0.05);
        for (const s of [-0.58, 0.58]) {
          const ox = ev.x + sideX * s, oz = ev.z + sideZ * s;
          const line = CreateLines("wingStreak", {
            points: [new Vector3(ox, ev.y, oz), new Vector3(ox - dirX * len, ev.y - dirY * len, oz - dirZ * len)],
          }, this.scene);
          line.color = color;
          line.alpha = 0.7;
          line.isPickable = false;
          this.lines.push({ mesh: line, t: 0, life: 0.16 });
        }
        break;
      }
      case "diveRing": {
        const node = new TransformNode("diveShock", this.scene);
        node.position.set(ev.x, ev.y, ev.z);
        node.lookAt(new Vector3(ev.x + dirX, ev.y + dirY, ev.z + dirZ));
        const torus = CreateTorus("diveTorus", { diameter: 2.0, thickness: 0.08, tessellation: 24 }, this.scene);
        torus.parent = node;
        torus.rotation.x = Math.PI / 2;
        torus.material = mat(this.scene, "#dff6ff", { glow: 1, alpha: 0.65 });
        torus.isPickable = false;
        this.slashes.push({ node, t: 0, life: 0.24, sweep: 0, scale: 1.5 });
        break;
      }
      case "cast": {
        this.ring(ev.x, ev.y, ev.z, 2.0, ev.mantle === "tide" ? "tide" : ev.mantle === "titan" ? "titan" : "shrine");
        break;
      }
    }
  }

  bolt(pts: number[]) {
    const path: Vector3[] = [];
    const corePath: Vector3[] = [];
    const outerPath: Vector3[] = [];
    for (let i = 0; i + 5 < pts.length; i += 3) {
      const a = new Vector3(pts[i], pts[i + 1], pts[i + 2]);
      const b = new Vector3(pts[i + 3], pts[i + 4], pts[i + 5]);
      for (let k = 0; k <= 6; k++) {
        const p = Vector3.Lerp(a, b, k / 6);
        if (k > 0 && k < 6) p.addInPlace(new Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8));
        path.push(p);
        for (let k = 0; k <= 7; k++) {
          const p = Vector3.Lerp(a, b, k / 7);
          const o = p.clone();
          if (k > 0 && k < 7) {
            p.addInPlace(new Vector3((Math.random() - 0.5) * 0.75, (Math.random() - 0.5) * 0.75, (Math.random() - 0.5) * 0.75));
            o.addInPlace(new Vector3((Math.random() - 0.5) * 1.35, (Math.random() - 0.5) * 1.35, (Math.random() - 0.5) * 1.35));
          }
          corePath.push(p);
          outerPath.push(o);
        }
      }
      if (path.length < 2) return;
      const mesh = CreateLines("bolt", { points: path }, this.scene);
      mesh.color = new Color3(0.75, 0.9, 1);
      mesh.isPickable = false;
      this.lines.push({ mesh, t: 0, life: 0.35 });
      if (corePath.length < 2) return;
      const core = CreateLines("boltCore", { points: corePath }, this.scene);
      core.color = new Color3(1, 1, 1);
      core.isPickable = false;
      this.lines.push({ mesh: core, t: 0, life: 0.42 });

      const outer = CreateLines("boltOuter", { points: outerPath }, this.scene);
      outer.color = new Color3(0.55, 0.88, 1);
      outer.isPickable = false;
      this.lines.push({ mesh: outer, t: 0, life: 0.48 });
    }

    update(dt: number) {
      this.rings = this.rings.filter((ring) => {
        ring.t += dt;
        const k = ring.t / ring.life;
        if (k >= 1) { ring.mesh.dispose(); return false; }
        const s = ring.inward ? ring.r * (1.6 - 0.6 * k) : ring.r * (0.2 + 0.8 * Math.sqrt(k));
        ring.mesh.scaling.set(s, 1, s);
        if (ring.lift) ring.mesh.position.y += ring.lift * dt;
        ring.mesh.visibility = ring.inward ? 0.5 + 0.5 * Math.abs(Math.sin(ring.t * 18)) : 1 - k;
        return true;
      });
      this.lines = this.lines.filter((line) => {
        line.t += dt;
        if (line.t >= line.life) { line.mesh.dispose(); return false; }
        line.mesh.alpha = 1 - line.t / line.life;
        return true;
      });
      this.markers = this.markers.filter((m) => {
        m.t += dt;
        if (m.t >= m.life) {
          for (const c of m.node.getChildMeshes(false)) c.dispose();
          m.node.dispose();
          return false;
        }
        if (m.spin) m.node.rotation.y += dt * 2.5;
        return true;
      });
      this.projectiles = this.projectiles.filter((p) => {
        p.t += dt;
        const k = Math.min(1, p.t / p.life);
        Vector3.LerpToRef(p.from, p.to, k, p.node.position);
        if (p.arc) p.node.position.y += Math.sin(k * Math.PI) * p.arc;
        if (p.spin) { p.node.rotation.x += dt * 10; p.node.rotation.z += dt * 7; }
        if (k >= 1) {
          p.onArrive?.();
          for (const c of p.node.getChildMeshes(false)) c.dispose();
          p.node.dispose();
          return false;
        }
        return true;
      });
      this.slashes = this.slashes.filter((s) => {
        s.t += dt;
        const k = s.t / s.life;
        if (k >= 1) {
          for (const c of s.node.getChildMeshes(false)) c.dispose();
          s.node.dispose();
          return false;
        }
        const sc = 0.7 + k * 0.45 * s.scale;
        s.node.scaling.set(sc, sc, sc);
        if (s.sweep) s.node.rotation.y += s.sweep * dt * 8;
        for (const c of s.node.getChildMeshes(false)) c.visibility = 1 - k;
        return true;
      });
      this.anims = this.anims.filter((a) => {
        a.t += dt;
        const k = a.t / a.life;
        if (k >= 1) {
          for (const c of a.node.getChildMeshes(false)) c.dispose();
          a.node.dispose();
          return false;
        }
        a.update(k, dt);
        return true;
      });
    }

    clear() {
      for (const r of this.rings) r.mesh.dispose();
      for (const l of this.lines) l.mesh.dispose();
      for (const m of this.markers) { for (const c of m.node.getChildMeshes(false)) c.dispose(); m.node.dispose(); }
      for (const p of this.projectiles) { for (const c of p.node.getChildMeshes(false)) c.dispose(); p.node.dispose(); }
      for (const s of this.slashes) { for (const c of s.node.getChildMeshes(false)) c.dispose(); s.node.dispose(); }
      for (const a of this.anims) { for (const c of a.node.getChildMeshes(false)) c.dispose(); a.node.dispose(); }
      this.rallyMesh?.dispose(); this.rallyMesh = null;
      this.rallyBeam?.dispose(); this.rallyBeam = null;
      this.rings = [];
      this.lines = [];
      this.markers = [];
      this.projectiles = [];
      this.slashes = [];
      this.anims = [];
    }
  }
