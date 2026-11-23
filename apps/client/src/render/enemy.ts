import "@babylonjs/loaders/glTF/index.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer.js";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { ENEMY_KINDS, ENEMY_SIZE, EnemyState, MONSTER_MODELS } from "@worlds-edge/shared";
import type { EnemyView } from "../session.ts";
import { mat } from "./character.ts";

const damp = (c: number, t: number, rate: number, dt: number) => c + (t - c) * (1 - Math.exp(-rate * dt));
function shortestAngle(from: number, to: number) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const sceneCache = new WeakMap<Scene, Map<string, Promise<AssetContainer | null>>>();

function loadMonsterContainer(scene: Scene, modelId: string): Promise<AssetContainer | null> {
  let cache = sceneCache.get(scene);
  if (!cache) {
    cache = new Map();
    sceneCache.set(scene, cache);
  }
  let p = cache.get(modelId);
  if (!p) {
    p = LoadAssetContainerAsync(`${import.meta.env.BASE_URL}monsters/${modelId}.glb`, scene).catch((err) => {
      console.warn(`Couldn't load monster ${modelId}:`, err);
      return null;
    });
    cache.set(modelId, p);
  }
  return p;
}

const IDLE_ANIMS = ["Idle", "idle_loop", "Flying_Idle", "clip"];
const MOVE_ANIMS = ["Run", "Walk", "walk_loop", "Fast_Flying", "fly_loop", "Idle", "idle_loop", "Flying_Idle", "clip"];
const TELEGRAPH_ANIMS = ["Roar", "roar", "Duck", "Idle", "idle_loop", "Flying_Idle", "clip"];
const ATTACK_ANIMS = ["Attack", "Punch", "Headbutt", "Bite_Front", "bite", "Run", "Walk"];
const STAGGER_ANIMS = ["HitReact", "HitRecieve", "Duck", "Idle", "idle_loop", "Flying_Idle"];
const DEAD_ANIMS = ["Death", "Dead"];

/**
 * Renders every enemy: GLB monster packs (for all monsters including wretch
 * and hullbreaker) and procedural props for training dummies, anchors, and
 * the Colossus's heart.
 */
export class EnemyRig {
  readonly root: TransformNode;
  private body: TransformNode;
  private parts: Record<string, TransformNode | Mesh> = {};
  private meshes: Mesh[] = [];
  private nodes: TransformNode[] = [];
  private animGroups: AnimationGroup[] = [];
  private currentAnim: AnimationGroup | null = null;
  private lastState: number = -1;
  private disposed = false;
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

    const modelId = ENEMY_KINDS[kind]?.model;
    if (modelId) {
      if (kind === "hullbreaker") {
        // Weak point on its back that glows when exposed or staggered.
        this.parts.coreLit = box("coreLit", this.body, 0.75, 0.75, 0.25, 0, 1.5, -0.95, mat(scene, "#ffb347", { glow: 1 }));
        (this.parts.coreLit as Mesh).setEnabled(false);
      }
      void this.attachModel(scene, modelId);
    } else if (kind === "anchor") {
      const iron = mat(scene, "#4a4f55"), rust = mat(scene, "#8a5a3a");
      box("base", this.body, 2.4, 0.6, 2.4, 0, 0.3, 0, iron);
      box("post", this.body, 1.1, 3.2, 1.1, 0, 2.2, 0, iron);
      box("cap", this.body, 1.6, 0.5, 1.6, 0, 3.9, 0, rust);
      for (const y of [1.6, 2.6]) box(`band${y}`, this.body, 1.3, 0.25, 1.3, 0, y, 0, rust);
    } else if (kind === "heart") {
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

  private async attachModel(scene: Scene, modelId: string) {
    const container = await loadMonsterContainer(scene, modelId);
    if (!container || this.disposed) return;

    const inst = container.instantiateModelsToScene((name) => `${this.root.name}:${name}`, false, { doNotInstantiate: false });
    const holder = new TransformNode(`model-${modelId}`, scene);
    holder.parent = this.body;

    const info = MONSTER_MODELS[modelId];
    const targetH = ENEMY_SIZE[this.kind]?.height ?? 1.4;
    if (info) {
      const rawH = Math.max(0.01, info.max[1] - info.min[1]);
      const scale = targetH / rawH;
      holder.scaling.set(scale, scale, scale);
      holder.position.y = -info.min[1] * scale;
    }

    for (const rootNode of inst.rootNodes) {
      rootNode.parent = holder;
      for (const m of rootNode.getChildMeshes(false)) m.isPickable = false;
      this.nodes.push(rootNode as TransformNode);
    }
    this.nodes.push(holder);
    this.animGroups = inst.animationGroups;
    for (const g of this.animGroups) g.stop();
    this.lastState = -1; // trigger initial animation
  }

  private playAnim(candidates: string[], loop: boolean) {
    if (!this.animGroups.length) return;
    let found: AnimationGroup | undefined;
    for (const name of candidates) {
      found = this.animGroups.find((g) => g.name.endsWith(name) || g.name.includes(`:${name}`) || g.name === name);
      if (found) break;
    }
    if (!found) found = this.animGroups[0];
    if (found === this.currentAnim) return;
    this.currentAnim?.stop();
    this.currentAnim = found;
    found.start(loop, 1.0);
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

    if (this.animGroups.length && e.state !== this.lastState) {
      this.lastState = e.state;
      switch (e.state) {
        case EnemyState.Idle: this.playAnim(IDLE_ANIMS, true); break;
        case EnemyState.Chase: this.playAnim(MOVE_ANIMS, true); break;
        case EnemyState.Telegraph: this.playAnim(TELEGRAPH_ANIMS, true); break;
        case EnemyState.Attack: this.playAnim(ATTACK_ANIMS, false); break;
        case EnemyState.Stagger:
        case EnemyState.Exposed: this.playAnim(STAGGER_ANIMS, true); break;
        case EnemyState.Dead: this.playAnim(DEAD_ANIMS, false); break;
      }
    }

    let lean = 0, wobble = 0;
    const ai = ENEMY_KINDS[this.kind]?.ai;
    if (this.kind === "hullbreaker" || ai === "hullbreaker") {
      const exposed = e.state === EnemyState.Exposed || e.state === EnemyState.Stagger;
      lean = e.state === EnemyState.Telegraph ? -0.15 : e.state === EnemyState.Attack ? 0.35 : exposed ? 0.3 : 0;
      if (this.parts.coreLit) (this.parts.coreLit as Mesh).setEnabled(exposed && Math.sin(this.t * 10) > -0.6);
      if (e.state === EnemyState.Telegraph) wobble = Math.sin(this.t * 30) * 0.03;
    } else if (ai === "wretch" || ai === "flyer" || ai === "sea") {
      lean = e.state === EnemyState.Telegraph ? -0.35 : e.state === EnemyState.Attack ? 0.25 : 0;
      if (e.state === EnemyState.Telegraph) wobble = Math.sin(this.t * 40) * 0.04;
    }

    if (this.kind === "heart") {
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
    this.disposed = true;
    for (const g of this.animGroups) g.dispose();
    for (const m of this.meshes) m.dispose();
    for (const n of this.nodes) if (!n.isDisposed()) n.dispose();
    this.root.dispose();
  }
}
