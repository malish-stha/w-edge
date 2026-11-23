import type { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.js";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Fx } from "@worlds-edge/shared";
import { mat } from "./character.ts";

type RingKind = Extract<Fx, { t: "ring" }>["kind"];
const RING_COLORS: Record<RingKind, string> = {
  impact: "#ffffff", tide: "#5cc8ff", titan: "#ff9b3d", shrine: "#ffd36b", telegraph: "#ff5a4a",
};

interface Ring { mesh: Mesh; t: number; life: number; r: number; inward: boolean }
interface Line { mesh: LinesMesh; t: number; life: number }

/**
 * World-space effects. Allied effects are short and translucent; enemy
 * telegraphs are rings that CONTRACT (everything else expands), so they read
 * by motion as well as colour.
 */
export class Effects {
  private rings: Ring[] = [];
  private lines: Line[] = [];

  constructor(private scene: Scene) {}

  ring(x: number, y: number, z: number, r: number, kind: RingKind) {
    const mesh = CreateTorus("ring", { diameter: 2, thickness: kind === "telegraph" ? 0.12 : 0.08, tessellation: 40 }, this.scene);
    mesh.material = mat(this.scene, RING_COLORS[kind], { glow: 1 });
    mesh.position.set(x, y + 0.15, z);
    mesh.isPickable = false;
    const inward = kind === "telegraph";
    const life = inward ? 0.7 : kind === "shrine" ? 1.4 : 0.55;
    this.rings.push({ mesh, t: 0, life, r, inward });
  }

  shot(from: [number, number, number], to: [number, number, number]) {
    const mesh = CreateLines("shot", { points: [new Vector3(...from), new Vector3(...to)] }, this.scene);
    mesh.color = new Color3(1, 0.95, 0.8);
    mesh.isPickable = false;
    this.lines.push({ mesh, t: 0, life: 0.25 });
  }

  bolt(pts: number[]) {
    // Jagged lightning between the struck points.
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
      ring.mesh.visibility = ring.inward ? 0.5 + 0.5 * Math.abs(Math.sin(ring.t * 18)) : 1 - k;
      return true;
    });
    this.lines = this.lines.filter((line) => {
      line.t += dt;
      if (line.t >= line.life) { line.mesh.dispose(); return false; }
      line.mesh.alpha = 1 - line.t / line.life;
      return true;
    });
  }

  clear() {
    for (const r of this.rings) r.mesh.dispose();
    for (const l of this.lines) l.mesh.dispose();
    this.rings = [];
    this.lines = [];
  }
}
