import type { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder.js";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mode, groundHeightAt, type World } from "@worlds-edge/shared";
import type { PlayerView } from "../session.ts";

const materials = new Map<string, StandardMaterial>();
function mat(scene: Scene, hex: string, alpha = 1): StandardMaterial {
  const key = `${hex}/${alpha}`;
  let m = materials.get(key);
  if (!m) {
    m = new StandardMaterial(`m${key}`, scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor = Color3.Black();
    m.emissiveColor = Color3.FromHexString(hex).scale(0.25);
    if (alpha < 1) { m.alpha = alpha; m.disableDepthWrite = true; }
    m.freeze();
    materials.set(key, m);
  }
  return m;
}

function shortestAngle(from: number, to: number) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/**
 * A low-poly Lancer built from boxes: readable silhouette (spear, cape) and
 * distinct take-off, hover, flight, dive and landing poses.
 */
export class CharacterRig {
  readonly root: TransformNode;
  private body: TransformNode;
  private legL: TransformNode; private legR: TransformNode;
  private armL: TransformNode; private armR: TransformNode;
  private cape: Mesh;
  private shadow: Mesh;
  private meshes: Mesh[] = [];
  private facing = 0;
  private pitch = 0;
  private walkPhase = 0;
  private time = 0;

  constructor(scene: Scene, color: string) {
    const skin = mat(scene, "#e9b48a");
    const cloth = mat(scene, color);
    const dark = mat(scene, "#2b2f3a");
    const metal = mat(scene, "#d9dde3");
    const capeMat = mat(scene, Color3.FromHexString(color).scale(0.7).toHexString());
    capeMat.backFaceCulling = false;

    this.root = new TransformNode("player", scene);
    // Body pivots around the chest so flight poses tilt naturally.
    this.body = new TransformNode("body", scene);
    this.body.parent = this.root;
    this.body.position.y = 1.0;

    const part = (mesh: Mesh, parent: TransformNode, x: number, y: number, z: number, m: StandardMaterial) => {
      mesh.parent = parent;
      mesh.position.set(x, y, z);
      mesh.material = m;
      mesh.isPickable = false;
      this.meshes.push(mesh);
      return mesh;
    };

    part(CreateBox("torso", { width: 0.62, height: 0.72, depth: 0.36 }, scene), this.body, 0, 0.12, 0, cloth);
    part(CreateBox("belt", { width: 0.64, height: 0.1, depth: 0.38 }, scene), this.body, 0, -0.2, 0, dark);
    part(CreateBox("head", { size: 0.44 }, scene), this.body, 0, 0.72, 0, skin);
    part(CreateBox("hair", { width: 0.48, height: 0.18, depth: 0.48 }, scene), this.body, 0, 0.9, -0.02, dark);
    part(CreateBox("eyeL", { width: 0.07, height: 0.07, depth: 0.02 }, scene), this.body, -0.1, 0.74, 0.22, dark);
    part(CreateBox("eyeR", { width: 0.07, height: 0.07, depth: 0.02 }, scene), this.body, 0.1, 0.74, 0.22, dark);

    const limb = (name: string, x: number, y: number, len: number, w: number, m: StandardMaterial) => {
      const pivot = new TransformNode(name, scene);
      pivot.parent = this.body;
      pivot.position.set(x, y, 0);
      part(CreateBox(`${name}Mesh`, { width: w, height: len, depth: w }, scene), pivot, 0, -len / 2, 0, m);
      return pivot;
    };
    this.legL = limb("legL", -0.16, -0.22, 0.8, 0.22, dark);
    this.legR = limb("legR", 0.16, -0.22, 0.8, 0.22, dark);
    this.armL = limb("armL", -0.41, 0.4, 0.66, 0.18, cloth);
    this.armR = limb("armR", 0.41, 0.4, 0.66, 0.18, cloth);

    // Spear in the right hand: the Lancer's silhouette.
    const spear = new TransformNode("spear", scene);
    spear.parent = this.armR;
    // Held upright like a staff; it leads head-first when the body pitches into a dive.
    spear.position.set(0, -0.62, 0.08);
    spear.rotation.x = 0.12;
    part(CreateCylinder("shaft", { height: 2.4, diameter: 0.06, tessellation: 6 }, scene), spear, 0, 0.3, 0, mat(scene, "#8b6a4a"));
    part(CreateCylinder("tip", { height: 0.4, diameterTop: 0, diameterBottom: 0.16, tessellation: 4 }, scene), spear, 0, 1.7, 0, metal);

    this.cape = part(CreatePlane("cape", { width: 0.6, height: 1.0 }, scene), this.body, 0, -0.05, -0.2, capeMat);
    this.cape.setPivotPoint(new Vector3(0, 0.5, 0)); // swing from the shoulders

    this.shadow = CreateDisc("shadow", { radius: 0.5, tessellation: 12 }, scene);
    this.shadow.rotation.x = Math.PI / 2;
    this.shadow.material = mat(scene, "#000000", 0.25);
    this.shadow.isPickable = false;
  }

  update(p: PlayerView, dt: number, world: World) {
    this.time += dt;
    const hSpeed = Math.hypot(p.vx, p.vz);
    const speed = Math.hypot(p.vx, p.vy, p.vz);

    this.root.position.set(p.x, p.y, p.z);
    this.facing += shortestAngle(this.facing, p.facing) * (1 - Math.exp(-12 * dt));
    this.root.rotation.y = this.facing;

    // Target pose per movement state.
    let bodyPitch = 0, legSwing = 0, legBack = 0, armSwing = 0, armOut = 0, armForward = 0, capeLift = 0.1, bob = 0;
    switch (p.mode) {
      case Mode.Ground: {
        this.walkPhase += hSpeed * dt * 1.6;
        const amount = Math.min(1, hSpeed / 7);
        legSwing = Math.sin(this.walkPhase) * 0.7 * amount;
        armSwing = -legSwing * 0.8;
        bodyPitch = 0.08 * amount;
        bob = Math.abs(Math.sin(this.walkPhase)) * 0.06 * amount;
        capeLift = 0.1 + amount * 0.3;
        break;
      }
      case Mode.Air:
        legBack = 0.3; armOut = 0.6; capeLift = 0.5;
        break;
      case Mode.Flight: {
        // Upright hover when slow, stretched out when fast.
        const k = Math.min(1, hSpeed / 15);
        bodyPitch = k * 1.15 + Math.min(0.35, Math.max(0, (hSpeed - 15) / 50));
        legBack = 0.15 + k * 0.25;
        armOut = 0.35 * (1 - k) + 0.1;
        armForward = -k * 0.4;
        capeLift = 0.4 + k * 0.9;
        bob = (1 - k) * Math.sin(this.time * 2.2) * 0.08;
        legSwing = (1 - k) * Math.sin(this.time * 2.2) * 0.12;
        break;
      }
      case Mode.Dive: {
        // Head-first along the velocity, spear leading.
        const down = Math.atan2(-p.vy, Math.max(0.01, hSpeed));
        bodyPitch = Math.PI / 2 + down * 0.9;
        legBack = 0.1;
        armForward = 0; // arms tucked: the upright spear now points along the dive
        capeLift = 1.4;
        break;
      }
    }
    const r = 10;
    this.pitch = damp(this.pitch, bodyPitch, r, dt);
    this.body.rotation.x = this.pitch;
    this.body.position.y = 1.0 + bob;
    this.legL.rotation.x = damp(this.legL.rotation.x, legSwing + legBack, r, dt);
    this.legR.rotation.x = damp(this.legR.rotation.x, -legSwing + legBack, r, dt);
    this.armL.rotation.x = damp(this.armL.rotation.x, armSwing - armForward * 0.5, r, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, -armSwing - armForward, r, dt);
    this.armL.rotation.z = damp(this.armL.rotation.z, -armOut, r, dt);
    this.armR.rotation.z = damp(this.armR.rotation.z, armOut, r, dt);
    const flutter = Math.sin(this.time * (6 + speed * 0.3)) * 0.06 * Math.min(1, speed / 10);
    this.cape.rotation.x = damp(this.cape.rotation.x, capeLift + flutter, 8, dt);

    // Blob shadow on whatever is below.
    const ground = groundHeightAt(world, p.x, p.z, p.y + 0.1);
    if (Number.isFinite(ground) && p.y - ground < 40) {
      const h = p.y - ground;
      this.shadow.setEnabled(true);
      this.shadow.position.set(p.x, ground + 0.03, p.z);
      const s = Math.max(0.4, 1 - h / 40);
      this.shadow.scaling.set(s, s, s);
    } else {
      this.shadow.setEnabled(false);
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    this.shadow.dispose();
    this.root.dispose();
  }
}
