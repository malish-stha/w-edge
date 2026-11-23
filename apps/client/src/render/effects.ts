import type { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.js";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Fx, PingKind } from "@worlds-edge/shared";
import { mat, type SwingEvent } from "./character.ts";

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

/**
 * World-space effects: flying 3D arrows & boulders, weapon slash arcs & lance
 * thrust streaks, planted Crossfire arrows, pings, and mantle shockwaves.
 */
export class Effects {
  private rings: Ring[] = [];
  private lines: Line[] = [];
  private markers: Marker[] = [];
  private projectiles: Projectile[] = [];
  private slashes: SlashArc[] = [];
  private rallyMesh: Mesh | null = null;
  private rallyBeam: LinesMesh | null = null;

  constructor(private scene: Scene) {}

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
    });
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
        this.slashes.push({ node, t: 0, life: 0.2, sweep: 1.2, scale: 1.2 });
      } else {
        // Sharp forward lance thrust cone
        const cone = CreateCylinder("lanceThrust", { height: 2.5, diameterTop: 0.04, diameterBottom: 0.75, tessellation: 10 }, this.scene);
        cone.parent = node; cone.position.z = 0.85; cone.rotation.x = Math.PI / 2;
        cone.material = mat(this.scene, hex, { glow: 1, alpha: 0.7 }); cone.isPickable = false;
        this.slashes.push({ node, t: 0, life: 0.16, sweep: 0, scale: 1.15 });
      }
      return;
    }

    if (ev.classId === "vanguard" && ev.combo === 2) {
      // Shield bash burst
      const bash = CreateCylinder("shieldBash", { height: 0.12, diameter: 1.9, tessellation: 16 }, this.scene);
      bash.parent = node; bash.rotation.x = Math.PI / 2; bash.position.z = 0.25;
      bash.material = mat(this.scene, "#7fe8ff", { glow: 1, alpha: 0.65 }); bash.isPickable = false;
      this.slashes.push({ node, t: 0, life: 0.18, sweep: 0, scale: 1.25 });
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
    this.slashes.push({ node, t: 0, life: 0.18, sweep: ev.combo === 2 ? -1.4 : 1.4, scale: ev.charged ? 1.35 : 1.1 });
  }

  bolt(pts: number[]) {
    const path: Vector3[] = [];
    for (let i = 0; i + 5 < pts.length; i += 3) {
      const a = new Vector3(pts[i], pts[i + 1], pts[i + 2]);
      const b = new Vector3(pts[i + 3], pts[i + 4], pts[i + 5]);
      for (let k = 0; k <= 6; k++) {
        const p = Vector3.Lerp(a, b, k / 6);
        if (k > 0 && k < 6) p.addInPlace(new Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8));
        path.push(p);
      }
    }
    if (path.length < 2) return;
    const mesh = CreateLines("bolt", { points: path }, this.scene);
    mesh.color = new Color3(0.75, 0.9, 1);
    mesh.isPickable = false;
    this.lines.push({ mesh, t: 0, life: 0.35 });
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
  }

  clear() {
    for (const r of this.rings) r.mesh.dispose();
    for (const l of this.lines) l.mesh.dispose();
    for (const m of this.markers) { for (const c of m.node.getChildMeshes(false)) c.dispose(); m.node.dispose(); }
    for (const p of this.projectiles) { for (const c of p.node.getChildMeshes(false)) c.dispose(); p.node.dispose(); }
    for (const s of this.slashes) { for (const c of s.node.getChildMeshes(false)) c.dispose(); s.node.dispose(); }
    this.rallyMesh?.dispose(); this.rallyMesh = null;
    this.rallyBeam?.dispose(); this.rallyBeam = null;
    this.rings = [];
    this.lines = [];
    this.markers = [];
    this.projectiles = [];
    this.slashes = [];
  }
}
