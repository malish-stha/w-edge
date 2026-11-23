import type { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { EnemyState } from "@worlds-edge/shared";
import type { EnemyView } from "../session.ts";
import { mat } from "./character.ts";

const damp = (c: number, t: number, rate: number, dt: number) => c + (t - c) * (1 - Math.exp(-rate * dt));
function shortestAngle(from: number, to: number) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Angular, chunky monsters. Danger reads from pose and shape, not just colour:
 * a wretch rears up before it lunges; the Hullbreaker drops its shield and its
 * glowing back core shows when it's open to attack.
 */
export class EnemyRig {
  readonly root: TransformNode;
  private body: TransformNode;
  private parts: Record<string, TransformNode | Mesh> = {};
  private meshes: Mesh[] = [];
  private nodes: TransformNode[] = [];
  private facing = 0;
  private t = 0;
  private lean = 0;
  private sink = 0;

  constructor(scene: Scene, readonly kind: string) {
    this.root = new TransformNode(`enemy-${kind}`, scene);
    this.body = this.node("body", this.root, 0, 0, 0);
    const box = (name: string, parent: TransformNode, w: number, h: number, d: number, x: number, y: number, z: number, m: StandardMaterial) => {
      const mesh = CreateBox(name, { width: w, height: h, depth: d }, scene);
      mesh.parent = parent; mesh.position.set(x, y, z); mesh.material = m; mesh.isPickable = false;
      this.meshes.push(mesh);
      return mesh;
    };

    if (kind === "wretch") {
      const shell = mat(scene, "#2f8f8a"), dark = mat(scene, "#1f5f5c"), eye = mat(scene, "#ffe066", { glow: 0.8 });
      box("shell", this.body, 1.3, 0.55, 1.1, 0, 0.55, 0, shell);
      box("ridge", this.body, 0.9, 0.25, 0.8, 0, 0.92, -0.05, dark);
      box("eyeL", this.body, 0.14, 0.14, 0.08, -0.25, 0.75, 0.56, eye);
      box("eyeR", this.body, 0.14, 0.14, 0.08, 0.25, 0.75, 0.56, eye);
      for (const side of [-1, 1]) {
        const claw = this.node(`claw${side}`, this.body, side * 0.55, 0.55, 0.45);
        box(`clawArm${side}`, claw, 0.22, 0.22, 0.6, 0, 0, 0.3, dark);
        box(`clawTip${side}`, claw, 0.34, 0.3, 0.3, 0, 0.05, 0.65, shell);
        this.parts[`claw${side}`] = claw;
        for (const k of [-1, 1]) box(`leg${side}${k}`, this.body, 0.12, 0.45, 0.12, side * 0.6, 0.22, k * 0.3, dark);
      }
    } else if (kind === "hullbreaker") {
      const hull = mat(scene, "#7a5a44"), rust = mat(scene, "#9b6a3f"), metal = mat(scene, "#8d969e");
      const seam = mat(scene, "#3a2f28");
      box("torso", this.body, 2.2, 1.9, 1.8, 0, 1.6, -0.2, hull);
      box("hump", this.body, 1.6, 0.8, 1.2, 0, 2.6, -0.5, rust);
      box("head", this.body, 0.8, 0.6, 0.7, 0, 2.2, 0.6, rust);
      for (const side of [-1, 1]) box(`leg${side}`, this.body, 0.6, 0.9, 0.7, side * 0.7, 0.45, -0.2, seam);
      // The shield: a ship's hull plate with visible seams (its armour).
      const shield = this.node("shield", this.body, 0, 1.5, 1.2);
      box("plate", shield, 2.8, 2.6, 0.3, 0, 0, 0, metal);
      for (const y of [-0.7, 0, 0.7]) box(`seam${y}`, shield, 2.82, 0.08, 0.32, 0, y, 0, seam);
      this.parts.shield = shield;
      // The weak point: a core on its back that glows when exposed.
      this.parts.core = box("core", this.body, 0.8, 0.8, 0.3, 0, 1.9, -1.15, mat(scene, "#3a2f28"));
      this.parts.coreLit = box("coreLit", this.body, 0.8, 0.8, 0.3, 0, 1.9, -1.16, mat(scene, "#ffb347", { glow: 1 }));
      (this.parts.coreLit as Mesh).setEnabled(false);
    } else if (kind === "anchor") {
      // A great iron mooring post the chains are fastened to.
      const iron = mat(scene, "#4a4f55"), rust = mat(scene, "#8a5a3a");
      box("base", this.body, 2.4, 0.6, 2.4, 0, 0.3, 0, iron);
      box("post", this.body, 1.1, 3.2, 1.1, 0, 2.2, 0, iron);
      box("cap", this.body, 1.6, 0.5, 1.6, 0, 3.9, 0, rust);
      for (const y of [1.6, 2.6]) box(`band${y}`, this.body, 1.3, 0.25, 1.3, 0, y, 0, rust);
    } else if (kind === "heart") {
      // The Colossus's heart: a pulsing core (the hitbox is larger than it looks).
      const core = mat(scene, "#ff6a3d", { glow: 1 }), shell = mat(scene, "#7a2f22", { glow: 0.4 });
      box("core", this.body, 1.8, 1.8, 1.8, 0, 4, 0, core).rotation.set(0.6, 0.6, 0);
      box("shellA", this.body, 2.4, 0.4, 2.4, 0, 4, 0, shell).rotation.set(0.3, 0.9, 0.2);
      box("shellB", this.body, 0.4, 2.4, 2.4, 0, 4, 0, shell).rotation.set(0.2, 0.4, 0.5);
      this.parts.core = this.meshes[0];
    } else {
      // Training dummy: post, crossbar and a straw sack.
      const wood = mat(scene, "#8b6a4a"), straw = mat(scene, "#d9c27a"), cloth = mat(scene, "#b8443a");
      const post = CreateCylinder("post", { height: 1.9, diameter: 0.14, tessellation: 6 }, scene);
      post.parent = this.body; post.position.y = 0.95; post.material = wood; this.meshes.push(post);
      box("bar", this.body, 1.2, 0.1, 0.1, 0, 1.4, 0, wood);
      box("sack", this.body, 0.6, 0.8, 0.45, 0, 1.15, 0, straw);
      box("head", this.body, 0.36, 0.36, 0.36, 0, 1.75, 0, straw);
      box("target", this.body, 0.3, 0.3, 0.05, 0, 1.2, 0.24, cloth);
    }
  }

  private node(name: string, parent: TransformNode, x: number, y: number, z: number) {
    const n = new TransformNode(name, this.root.getScene());
    n.parent = parent;
    n.position.set(x, y, z);
    this.nodes.push(n);
    return n;
  }

  update(e: EnemyView, dt: number) {
    this.t += dt;
    this.root.position.set(e.x, e.y - this.sink, e.z);
    this.facing += shortestAngle(this.facing, e.facing) * (1 - Math.exp(-10 * dt));
    this.root.rotation.y = this.facing;

    const dead = e.state === EnemyState.Dead;
    this.sink = dead ? Math.min(3, this.sink + dt * 2) : 0;
    this.root.setEnabled(!(dead && this.sink >= 3));

    let lean = 0, wobble = 0;
    if (this.kind === "wretch") {
      const clawUp = e.state === EnemyState.Telegraph ? -1.1 : e.state === EnemyState.Attack ? 0.3 : -0.1 + Math.sin(this.t * 3) * 0.08;
      lean = e.state === EnemyState.Telegraph ? -0.45 : e.state === EnemyState.Attack ? 0.25 : 0;
      for (const side of [-1, 1]) {
        const claw = this.parts[`claw${side}`] as TransformNode;
        claw.rotation.x = damp(claw.rotation.x, clawUp, 14, dt);
      }
      if (e.state === EnemyState.Telegraph) wobble = Math.sin(this.t * 40) * 0.04;
    } else if (this.kind === "hullbreaker") {
      const shield = this.parts.shield as TransformNode;
      const exposed = e.state === EnemyState.Exposed || e.state === EnemyState.Stagger;
      // Shield drops when exposed or staggered; raised high in the wind-up.
      const shieldDrop = exposed ? 1.2 : e.state === EnemyState.Telegraph ? -0.25 : 0;
      shield.rotation.x = damp(shield.rotation.x, shieldDrop, 6, dt);
      shield.position.y = damp(shield.position.y, exposed ? 0.7 : 1.5, 6, dt);
      lean = e.state === EnemyState.Telegraph ? -0.15 : e.state === EnemyState.Attack ? 0.35 : exposed ? 0.3 : 0;
      (this.parts.coreLit as Mesh).setEnabled(exposed && Math.sin(this.t * 10) > -0.6);
      if (e.state === EnemyState.Telegraph) wobble = Math.sin(this.t * 30) * 0.03;
    }
    if (this.kind === "heart") {
      // Pulses faster when exposed; spins while flying free.
      const pulse = 1 + Math.sin(this.t * (e.state === EnemyState.Exposed ? 9 : 3)) * 0.08;
      this.body.scaling.set(pulse, pulse, pulse);
      this.body.rotation.y += dt * 0.8;
    }
    if (e.state === EnemyState.Stagger) { lean = -0.25; wobble = Math.sin(this.t * 12) * 0.12; }
    this.lean = damp(this.lean, lean, 10, dt);
    this.body.rotation.x = this.lean;
    this.body.rotation.z = wobble;
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    for (const n of this.nodes) n.dispose();
    this.root.dispose();
  }
}
