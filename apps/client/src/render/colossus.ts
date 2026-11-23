import type { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { ANCHORS, BossPhase, COLOSSUS } from "@worlds-edge/shared";
import type { BossView, EnemyView } from "../session.ts";
import { mat } from "./character.ts";

const damp = (c: number, t: number, rate: number, dt: number) => c + (t - c) * (1 - Math.exp(-rate * dt));

/**
 * The moving parts of the Drowned Colossus. Its body is static arena geometry;
 * this adds the arms (slam and sweep), the chest plate that swings open when
 * broken, glowing eyes, the anchor chains and the wave.
 */
export class ColossusRig {
  private nodes: TransformNode[] = [];
  private meshes: Mesh[] = [];
  private arms: TransformNode[] = [];
  private plate: TransformNode;
  private eyes: Mesh[] = [];
  private chains: LinesMesh[] = [];
  private wave: TransformNode;
  private t = 0;

  constructor(scene: Scene) {
    const hull = mat(scene, "#6b5a4c"), plateMat = mat(scene, "#8d969e"), seam = mat(scene, "#3a2f28");
    const box = (name: string, parent: TransformNode, w: number, h: number, d: number, x: number, y: number, z: number, m = hull) => {
      const b = CreateBox(name, { width: w, height: h, depth: d }, scene);
      b.parent = parent; b.position.set(x, y, z); b.material = m; b.isPickable = false;
      this.meshes.push(b);
      return b;
    };
    const node = (name: string, x: number, y: number, z: number, parent?: TransformNode) => {
      const n = new TransformNode(name, scene);
      if (parent) n.parent = parent;
      n.position.set(x, y, z);
      this.nodes.push(n);
      return n;
    };

    // Arms hang from the shoulders; each pivots at the shoulder.
    for (const side of [-1, 1]) {
      const shoulder = node(`shoulder${side}`, side * 10, 21, -1);
      box(`upper${side}`, shoulder, 3.4, 9, 3.4, 0, -4.5, 0);
      box(`fore${side}`, shoulder, 3, 8, 3, 0, -12.5, 0.5, mat(scene, "#7a6656"));
      box(`fist${side}`, shoulder, 4.2, 3.6, 4.2, 0, -18, 0.8, seam);
      this.arms.push(shoulder);
    }
    // Chest plate in front of the heart, hinged at its bottom edge on the ledge: it falls open outward.
    this.plate = node("plate", 0, 11, 4.9);
    box("plateFace", this.plate, 8.5, 9, 0.6, 0, 4.5, 0, plateMat);
    for (const y of [2, 4.5, 7]) box(`plateSeam${y}`, this.plate, 8.6, 0.25, 0.65, 0, y, 0, seam);
    // Eyes on the front of the head.
    const head = node("head", 0, 26, 2.05);
    for (const side of [-1, 1]) this.eyes.push(box(`eye${side}`, head, 0.9, 0.5, 0.2, side * 1.1, 0, 0, mat(scene, "#7fe8ff", { glow: 1 })));
    // Chains from each anchor to the Colossus's waist.
    for (const [i, a] of ANCHORS.entries()) {
      const end = new Vector3(Math.sign(a.x) * 5 || 0, 12, a.z > 0 ? 2.5 : -4);
      const line = CreateLines(`chain${i}`, { points: [new Vector3(a.x, a.y + 2.5, a.z), end] }, scene);
      line.color = new Color3(0.25, 0.22, 0.2);
      line.isPickable = false;
      this.chains.push(line);
    }
    // The wave: a layered wall of water across the arena, between the safe heights.
    this.wave = node("wave", 0, 0, 0);
    const w = COLOSSUS.wave;
    const h = w.bandHigh - w.bandLow;
    const midY = (w.bandLow + w.bandHigh) / 2;
    const deep = box("waveDeep", this.wave, 220, h * 0.58, 3.6, 0, w.bandLow + h * 0.29, 0, mat(scene, "#1f6a96", { alpha: 0.78, glow: 0.2 }));
    const water = box("waveWater", this.wave, 220, h * 0.52, 2.8, 0, midY + h * 0.24, 0.2, mat(scene, "#4aa8d8", { alpha: 0.62, glow: 0.45 }));
    deep.visibility = 1;
    water.visibility = 1;
    box("waveFoam", this.wave, 220, 0.9, 3.4, 0, w.bandHigh + 0.15, 0.35, mat(scene, "#f2fbff", { alpha: 0.88, glow: 0.75 }));
    box("waveSpray", this.wave, 220, 0.45, 2.2, 0, w.bandHigh + 0.65, 0.7, mat(scene, "#ffffff", { alpha: 0.55, glow: 0.9 }));
    this.wave.setEnabled(false);
  }

  update(boss: BossView, enemies: EnemyView[], dt: number) {
    this.t += dt;
    // Arms: raise toward the slam target, crash down when it lands; whirl during a sweep.
    const slamming = boss.slamT >= 0;
    const sweeping = boss.sweepT >= 0;
    for (const [i, arm] of this.arms.entries()) {
      const side = i === 0 ? -1 : 1;
      let rx = Math.sin(this.t * 0.8 + i) * 0.05, ry = 0, rz = side * 0.08;
      if (slamming) {
        const nearSide = Math.sign(boss.slamX || 1) === side || Math.abs(boss.slamX) < 5;
        if (nearSide) {
          ry = Math.atan2(boss.slamX - arm.position.x, boss.slamZ - arm.position.z);
          const windUp = Math.min(1, (COLOSSUS.slam.telegraph - boss.slamT) / COLOSSUS.slam.telegraph);
          rx = boss.slamT < 0.25 ? -1.2 : -2.6 * windUp; // raise high, then slam
        }
      } else if (sweeping) {
        const windUp = Math.min(1, (COLOSSUS.sweep.telegraph - boss.sweepT) / COLOSSUS.sweep.telegraph);
        rz = side * (0.4 + windUp * 1.0);
        ry = side * windUp * 1.2;
      }
      arm.rotation.x = damp(arm.rotation.x, rx, slamming && boss.slamT < 0.25 ? 20 : 4, dt);
      arm.rotation.y = damp(arm.rotation.y, ry, 4, dt);
      arm.rotation.z = damp(arm.rotation.z, rz, 4, dt);
    }

    // The plate swings open while the heart is exposed; it's gone once the heart tears free.
    const open = boss.exposed > 0 ? 1.5 : 0;
    this.plate.rotation.x = damp(this.plate.rotation.x, open, 6, dt);
    this.plate.setEnabled(boss.phase < BossPhase.Flight);

    // Eyes dim once defeated.
    for (const eye of this.eyes) eye.setEnabled(boss.phase !== BossPhase.Cleared);

    // Chains vanish as their anchors break.
    for (const [i, line] of this.chains.entries()) {
      const anchor = enemies.find((e) => e.id === `anchor${i}`);
      line.setEnabled(!!anchor && anchor.state !== 6);
    }

    // The wave crosses the arena along its direction.
    const active = boss.wave >= 0;
    this.wave.setEnabled(active);
    if (active) {
      const front = -95 + 190 * boss.wave;
      this.wave.position.set(boss.waveDirX * front, 0, boss.waveDirZ * front);
      this.wave.rotation.y = Math.atan2(boss.waveDirX, boss.waveDirZ);
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    for (const l of this.chains) l.dispose();
    for (const n of this.nodes) n.dispose();
  }
}
