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

interface MatOptions { alpha?: number; glow?: number; twoSided?: boolean }

/** Shared, frozen materials: characters with the same colours reuse them. */
const materials = new Map<string, StandardMaterial>();
export function mat(scene: Scene, hex: string, { alpha = 1, glow = 0.25, twoSided = false }: MatOptions = {}): StandardMaterial {
  const key = `${hex}/${alpha}/${glow}/${twoSided}`;
  let m = materials.get(key);
  if (!m) {
    m = new StandardMaterial(`m${key}`, scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor = Color3.Black();
    m.emissiveColor = Color3.FromHexString(hex).scale(glow);
    m.backFaceCulling = !twoSided;
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

export interface CharacterLook {
  classId: string;
  origin: string;
  skin: string;
  hair: string;
  outfit: string;
}

export function lookKey(l: CharacterLook) {
  return `${l.classId}|${l.origin}|${l.skin}|${l.hair}|${l.outfit}`;
}

export interface SwingEvent {
  classId: string;
  combo: number;
  x: number; y: number; z: number;
  facing: number;
  mantle: string;
  charged: boolean;
}

/**
 * Low-poly character with articulated weapons: Saber slashes with torso twist
 * & glowing edge, Archer draws bowstring & nocks an arrow in-hand, Lancer
 * thrusts the spear forward & projects a dive cone, Vanguard guards with an
 * angled shield & energy barrier.
 */
export class CharacterRig {
  readonly root: TransformNode;
  readonly key: string;
  private body: TransformNode;
  private legL: TransformNode; private legR: TransformNode;
  private armL: TransformNode; private armR: TransformNode;
  private cape: Mesh;
  private streamers: Mesh[] = [];
  private shadow: Mesh;
  private meshes: Mesh[] = [];
  private nodes: TransformNode[] = [];
  private facing = 0;
  private pitch = 0;
  private bodyYaw = 0;
  private walkPhase = 0;
  private time = 0;
  private lastAttackTime = 0;
  private lastCombo = 0;
  private classId: string;

  // Class weapon rigs
  private sword?: TransformNode;
  private swordGlow?: Mesh;
  private spear?: TransformNode;
  private lanceCone?: Mesh;
  private bow?: TransformNode;
  private bowLimbU?: Mesh;
  private bowLimbL?: Mesh;
  private bowStringU?: Mesh;
  private bowStringL?: Mesh;
  private nockedArrow?: TransformNode;
  private shield?: TransformNode;
  private shieldBarrier?: Mesh;
  private shieldChargeGlow?: Mesh;

  constructor(scene: Scene, look: CharacterLook) {
    this.key = lookKey(look);
    this.classId = look.classId;
    const skin = mat(scene, look.skin);
    const cloth = mat(scene, look.outfit);
    const hair = mat(scene, look.hair);
    const dark = mat(scene, "#2b2f3a");
    const metal = mat(scene, "#d9dde3");
    const capeMat = mat(scene, Color3.FromHexString(look.outfit).scale(0.7).toHexString(), { twoSided: true });

    this.root = new TransformNode("player", scene);
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
    part(CreateBox("hair", { width: 0.48, height: 0.18, depth: 0.48 }, scene), this.body, 0, 0.9, -0.02, hair);
    part(CreateBox("hairBack", { width: 0.48, height: 0.3, depth: 0.1 }, scene), this.body, 0, 0.72, -0.21, hair);
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

    const node = (name: string, parent: TransformNode, x: number, y: number, z: number) => {
      const n = new TransformNode(name, scene);
      n.parent = parent;
      n.position.set(x, y, z);
      this.nodes.push(n);
      return n;
    };
    const wood = mat(scene, "#8b6a4a");
    const box = (name: string, parent: TransformNode, w: number, h: number, d: number, x: number, y: number, z: number, m: StandardMaterial) =>
      part(CreateBox(name, { width: w, height: h, depth: d }, scene), parent, x, y, z, m);

    // --- Weapon by class --------------------------------------------------------------
    switch (look.classId) {
      case "saber": {
        const sword = node("sword", this.armR, 0, -0.62, 0.05);
        sword.rotation.x = 0.25;
        box("blade", sword, 0.06, 1.15, 0.14, 0, 0.7, 0, metal);
        this.swordGlow = box("bladeGlow", sword, 0.1, 1.2, 0.19, 0, 0.72, 0, mat(scene, "#ffd36b", { glow: 1, alpha: 0.55 }));
        this.swordGlow.setEnabled(false);
        box("guard", sword, 0.32, 0.05, 0.09, 0, 0.1, 0, mat(scene, "#c9a227"));
        box("hilt", sword, 0.05, 0.22, 0.05, 0, -0.02, 0, dark);
        this.sword = sword;
        break;
      }
      case "archer": {
        // Bow held in left hand; limbs flex & two-segment bowstring pulls back with a nocked arrow.
        const bow = node("bow", this.armL, 0.04, -0.62, 0.06);
        box("grip", bow, 0.06, 0.28, 0.07, 0, 0, 0, wood);
        this.bowLimbU = box("limbU", bow, 0.05, 0.62, 0.055, 0, 0.4, -0.06, wood);
        this.bowLimbU.rotation.x = -0.28;
        this.bowLimbL = box("limbL", bow, 0.05, 0.62, 0.055, 0, -0.4, -0.06, wood);
        this.bowLimbL.rotation.x = 0.28;

        const strMat = mat(scene, "#f4f4f4", { glow: 0.35 });
        this.bowStringU = box("stringU", bow, 0.015, 0.65, 0.015, 0, 0.32, -0.17, strMat);
        this.bowStringL = box("stringL", bow, 0.015, 0.65, 0.015, 0, -0.32, -0.17, strMat);

        // Nocked 3D arrow (shaft + broadhead + fletching) visible during draw.
        const arrow = node("nockedArrow", bow, 0, 0, 0.05);
        box("arrowShaft", arrow, 0.025, 0.025, 0.85, 0, 0, 0.25, wood);
        const head = part(CreateCylinder("arrowHead", { height: 0.14, diameterTop: 0, diameterBottom: 0.07, tessellation: 4 }, scene), arrow, 0, 0, 0.72, mat(scene, "#ffd36b", { glow: 0.7 }));
        head.rotation.x = Math.PI / 2;
        box("arrowFletch", arrow, 0.08, 0.08, 0.12, 0, 0, -0.15, mat(scene, "#ff6b57", { glow: 0.3 }));
        arrow.setEnabled(false);
        this.nockedArrow = arrow;
        this.bow = bow;

        box("quiver", this.body, 0.16, 0.55, 0.16, 0.2, 0.15, -0.3, mat(scene, "#6b4a32"));
        box("fletch", this.body, 0.14, 0.12, 0.14, 0.2, 0.47, -0.3, mat(scene, "#f2f4f8"));
        break;
      }
      case "vanguard": {
        const shield = node("shield", this.armL, -0.14, -0.38, 0.04);
        box("plate", shield, 0.07, 0.86, 0.64, 0, 0, 0, cloth);
        box("rim", shield, 0.08, 0.9, 0.12, 0, 0, 0.29, metal);
        box("rim2", shield, 0.08, 0.9, 0.12, 0, 0, -0.29, metal);
        box("boss", shield, 0.1, 0.22, 0.22, -0.04, 0.05, 0, metal);
        this.shieldBarrier = box("barrier", shield, 0.05, 1.5, 1.8, -0.22, 0.05, 0, mat(scene, "#7fe8ff", { alpha: 0.32, glow: 0.85, twoSided: true }));
        this.shieldBarrier.setEnabled(false);
        this.shieldChargeGlow = box("chargeGlow", shield, 0.12, 0.95, 0.7, -0.05, 0, 0, mat(scene, "#ffd36b", { alpha: 0.45, glow: 1 }));
        this.shieldChargeGlow.setEnabled(false);
        this.shield = shield;

        const sword = node("shortSword", this.armR, 0, -0.62, 0.05);
        sword.rotation.x = 1.9;
        box("blade", sword, 0.05, 0.65, 0.1, 0, 0.44, 0, metal);
        box("guard", sword, 0.24, 0.05, 0.08, 0, 0.1, 0, dark);
        this.sword = sword;
        break;
      }
      default: {
        // Lancer: spear held beside shoulder; thrusts dead-ahead on attack and gets wind-cone in dive/pierce.
        const spear = node("spear", this.armR, 0, -0.62, 0.08);
        spear.rotation.x = 0.14;
        part(CreateCylinder("shaft", { height: 2.5, diameter: 0.06, tessellation: 6 }, scene), spear, 0, 0.35, 0, wood);
        part(CreateCylinder("tip", { height: 0.45, diameterTop: 0, diameterBottom: 0.17, tessellation: 4 }, scene), spear, 0, 1.8, 0, metal);
        this.lanceCone = part(
          CreateCylinder("lanceCone", { height: 1.5, diameterTop: 0.02, diameterBottom: 0.9, tessellation: 12 }, scene),
          spear, 0, 1.35, 0, mat(scene, "#9fe4ff", { alpha: 0.35, glow: 0.9, twoSided: true }),
        );
        this.lanceCone.setEnabled(false);
        this.spear = spear;
      }
    }

    // --- Origin accessories ----------------------------------------------------------
    switch (look.origin) {
      case "skyborn": {
        const feather = mat(scene, "#f2f4f8");
        for (const [i, x] of [-0.1, 0, 0.1].entries()) {
          const f = box(`feather${i}`, this.body, 0.05, 0.42 - Math.abs(x), 0.1, x, 1.06, -0.12, feather);
          f.rotation.x = -0.5;
          f.rotation.z = -x * 2;
        }
        const ribbon = part(CreatePlane("ribbon", { width: 0.1, height: 1.1 }, scene), this.body, 0.18, -0.25, -0.22, mat(scene, "#9fd8ff", { twoSided: true }));
        ribbon.setPivotPoint(new Vector3(0, 0.55, 0));
        this.streamers.push(ribbon);
        break;
      }
      case "stonekin": {
        const crystal = mat(scene, "#9ee6e0", { glow: 0.55 });
        for (const side of [-1, 1]) {
          const c = box(`crystal${side}`, this.body, 0.16, 0.24, 0.16, side * 0.32, 0.56, 0, crystal);
          c.rotation.set(0.5, 0.7, side * 0.5);
          const s = box(`crystalS${side}`, this.body, 0.1, 0.16, 0.1, side * 0.4, 0.5, -0.1, crystal);
          s.rotation.set(-0.4, 0.3, side * 0.9);
        }
        box("brow", this.body, 0.46, 0.06, 0.06, 0, 0.82, 0.21, mat(scene, "#8a7f74"));
        break;
      }
      default: {
        const scarf = mat(scene, "#d9c27a");
        box("scarf", this.body, 0.52, 0.13, 0.42, 0, 0.47, 0, scarf);
        const tail = part(CreatePlane("scarfTail", { width: 0.14, height: 0.6 }, scene), this.body, -0.14, 0.2, -0.22, mat(scene, "#d9c27a", { twoSided: true }));
        tail.setPivotPoint(new Vector3(0, 0.3, 0));
        this.streamers.push(tail);
      }
    }

    this.cape = part(CreatePlane("cape", { width: 0.6, height: 1.0 }, scene), this.body, 0, -0.05, -0.2, capeMat);
    this.cape.setPivotPoint(new Vector3(0, 0.5, 0));

    this.shadow = CreateDisc("shadow", { radius: 0.5, tessellation: 12 }, scene);
    this.shadow.rotation.x = Math.PI / 2;
    this.shadow.material = mat(scene, "#000000", { alpha: 0.25, glow: 0 });
    this.shadow.isPickable = false;
  }

  update(p: PlayerView, dt: number, world: World, onSwing?: (ev: SwingEvent) => void) {
    this.time += dt;
    const hSpeed = Math.hypot(p.vx, p.vz);
    const speed = Math.hypot(p.vx, p.vy, p.vz);

    this.root.position.set(p.x, p.y, p.z);
    const targetScale = p.giant ? 1.85 : 1;
    const sc = damp(this.root.scaling.x, targetScale, 8, dt);
    this.root.scaling.set(sc, sc, sc);
    this.facing += shortestAngle(this.facing, p.facing) * (1 - Math.exp(-12 * dt));
    this.root.rotation.y = this.facing;

    // Detect newly started attack swing for crisp weapon-arc VFX.
    if (p.attackTime > 0 && (this.lastAttackTime <= 0 || p.attackTime > this.lastAttackTime + 0.05 || p.attackCombo !== this.lastCombo)) {
      onSwing?.({
        classId: this.classId,
        combo: p.attackCombo || 1,
        x: p.x, y: p.y + 1.15 * sc, z: p.z,
        facing: p.facing,
        mantle: p.mantle,
        charged: p.classCharge > 0 || p.giant,
      });
    }
    this.lastAttackTime = p.attackTime;
    this.lastCombo = p.attackCombo;

    let bodyPitch = 0, bodyYaw = 0, legSwing = 0, legBack = 0, armSwing = 0, armOut = 0, armForward = 0, capeLift = 0.1, bob = 0;
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
        const down = Math.atan2(-p.vy, Math.max(0.01, hSpeed));
        bodyPitch = Math.PI / 2 + down * 0.9;
        legBack = 0.1;
        capeLift = 1.4;
        break;
      }
    }

    let armLX = armSwing - armForward * 0.5, armRX = -armSwing - armForward;
    let armLZ = -armOut, armRZ = armOut;
    let armRate = 12;
    let bodyY = 1.0 + bob;

    // Weapon pose defaults
    let swordRotX = this.classId === "vanguard" ? 1.9 : 0.25;
    let swordRotZ = 0;
    let spearRotX = 0.14;
    let spearY = -0.62;
    let bowRotX = 0;
    let bowRotZ = 0.15;
    let bowPull = 0;
    let showArrow = false;
    let shieldRotY = 0;

    if (p.attackTime > 0 && p.downTime <= 0) {
      const a = Math.max(0, Math.min(1, 1 - p.attackTime / 0.22));
      armRate = 32;
      switch (this.classId) {
        case "saber": {
          if (p.attackCombo === 3) {
            // Heavy overhead cleave
            bodyYaw = -0.25 + a * 0.4;
            armRX = -2.85 + a * 2.4;
            armLX = -2.2 + a * 1.8;
            armRZ = 0.2;
            swordRotX = 0.3 + a * 1.35;
          } else {
            // Alternating horizontal/diagonal sword cuts
            const dir = p.attackCombo === 2 ? -1 : 1;
            bodyYaw = dir * (0.45 - a * 0.95);
            armRX = -1.65 + a * 0.4;
            armRZ = dir * (1.05 - a * 2.1);
            swordRotX = 1.35;
            swordRotZ = dir * 0.45;
          }
          break;
        }
        case "lancer": {
          if (p.attackCombo === 3) {
            // Wide sweeping polearm finish
            bodyYaw = 0.65 - a * 1.3;
            armRX = -1.5;
            armRZ = 0.95 - a * 2.1;
            spearRotX = Math.PI * 0.96;
            spearY = -0.8;
          } else {
            // Crisp two-step forward spear thrust along +Z
            const plunge = Math.sin(a * Math.PI);
            bodyYaw = -0.35 + plunge * 0.55;
            armRX = -Math.PI / 2;
            armRZ = 0.08;
            armLX = 0.35;
            spearRotX = Math.PI * 0.98;
            spearY = -0.62 - plunge * 0.72;
          }
          break;
        }
        case "archer": {
          // Side-on archery stance: left arm holds bow forward, right hand nocks & draws string back then looses.
          bodyYaw = -0.55;
          armLX = -Math.PI / 2;
          armLZ = 0.1;
          bowRotX = Math.PI / 2;
          bowRotZ = 0;
          if (a < 0.55) {
            bowPull = a / 0.55;
            showArrow = true;
            armRX = -1.52;
            armRZ = -0.28 - bowPull * 0.22;
          } else {
            bowPull = Math.max(0, 1 - (a - 0.55) * 4);
            showArrow = false;
            armRX = -1.52;
            armRZ = -0.52;
          }
          break;
        }
        case "vanguard": {
          if (p.attackCombo === 2) {
            // Shield bash forward
            bodyYaw = -0.35 + a * 0.65;
            armLX = -1.58;
            armLZ = 0.45;
            shieldRotY = 1.35;
            armRX = 0.25;
          } else {
            // Short-sword slash (1 & 3)
            const heavy = p.attackCombo === 3;
            bodyYaw = 0.4 - a * 0.85;
            armRX = -2.2 + a * 1.65;
            armRZ = 0.75 - a * 1.4;
            swordRotX = heavy ? 1.5 : 1.7;
            armLX = -1.1;
            shieldRotY = 0.6;
          }
          break;
        }
      }
    } else if (p.guarding && p.downTime <= 0) {
      if (this.classId === "vanguard") {
        armLX = -1.3; armLZ = 0.85; shieldRotY = 1.48; bodyYaw = -0.2;
      } else if (this.classId === "saber") {
        armRX = -1.35; armRZ = -0.75; swordRotX = 0.5; swordRotZ = 0.85; bodyYaw = 0.25;
      }
    } else if (this.classId === "archer" && p.classCooldown > 0.1 && p.downTime <= 0) {
      bodyYaw = -0.45; armLX = -Math.PI / 2; armLZ = 0.1; bowRotX = Math.PI / 2; bowRotZ = 0;
    } else if (this.classId === "archer" && p.mode === Mode.Ground && hSpeed < 2) {
      // Relaxed bow-in-hand ready stance when standing
      armLX = -0.35; armLZ = -0.15; bowRotX = 0.35;
    }

    if (p.downTime > 0) {
      bodyPitch = -1.45; bodyY = 0.35;
      legSwing = 0; legBack = 0; armLX = -0.2; armRX = -0.2; armLZ = -1.2; armRZ = 1.2;
    }

    // Apply body & limb transforms
    const r = 10;
    this.pitch = damp(this.pitch, bodyPitch, r, dt);
    this.bodyYaw = damp(this.bodyYaw, bodyYaw, 18, dt);
    this.body.rotation.x = this.pitch;
    this.body.rotation.y = this.bodyYaw;
    this.body.position.y = damp(this.body.position.y, bodyY, 12, dt);
    this.legL.rotation.x = damp(this.legL.rotation.x, legSwing + legBack, r, dt);
    this.legR.rotation.x = damp(this.legR.rotation.x, -legSwing + legBack, r, dt);
    this.armL.rotation.x = damp(this.armL.rotation.x, armLX, armRate, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, armRX, armRate, dt);
    this.armL.rotation.z = damp(this.armL.rotation.z, armLZ, armRate, dt);
    this.armR.rotation.z = damp(this.armR.rotation.z, armRZ, armRate, dt);

    // Apply weapon articulation
    if (this.sword) {
      this.sword.rotation.x = damp(this.sword.rotation.x, swordRotX, armRate, dt);
      this.sword.rotation.z = damp(this.sword.rotation.z, swordRotZ, armRate, dt);
      if (this.swordGlow) this.swordGlow.setEnabled(p.classCharge > 0 || p.guarding || (p.attackTime > 0 && p.downTime <= 0));
    }
    if (this.spear) {
      this.spear.rotation.x = damp(this.spear.rotation.x, spearRotX, armRate, dt);
      this.spear.position.y = damp(this.spear.position.y, spearY, armRate, dt);
      if (this.lanceCone) {
        const fast = (p.mode === Mode.Dive || (p.mode === Mode.Flight && speed >= 22)) && p.downTime <= 0;
        this.lanceCone.setEnabled(fast || (p.attackTime > 0 && p.attackCombo !== 3));
      }
    }
    if (this.bow) {
      this.bow.rotation.x = damp(this.bow.rotation.x, bowRotX, armRate, dt);
      this.bow.rotation.z = damp(this.bow.rotation.z, bowRotZ, armRate, dt);
      if (this.bowLimbU && this.bowLimbL) {
        this.bowLimbU.rotation.x = -0.28 - bowPull * 0.22;
        this.bowLimbL.rotation.x = 0.28 + bowPull * 0.22;
      }
      if (this.bowStringU && this.bowStringL) {
        const pullZ = -0.17 - bowPull * 0.36;
        const tilt = bowPull * 0.56;
        this.bowStringU.position.z = ( -0.17 + pullZ ) * 0.5;
        this.bowStringU.rotation.x = -tilt;
        this.bowStringL.position.z = ( -0.17 + pullZ ) * 0.5;
        this.bowStringL.rotation.x = tilt;
      }
      if (this.nockedArrow) {
        this.nockedArrow.setEnabled(showArrow);
        this.nockedArrow.position.z = 0.05 - bowPull * 0.36;
      }
    }
    if (this.shield) {
      this.shield.rotation.y = damp(this.shield.rotation.y, shieldRotY, armRate, dt);
      this.shieldBarrier?.setEnabled(p.guarding && p.downTime <= 0);
      this.shieldChargeGlow?.setEnabled(p.classCharge > 0 && p.downTime <= 0);
    }

    const flutter = Math.sin(this.time * (6 + speed * 0.3)) * 0.06 * Math.min(1, speed / 10);
    this.cape.rotation.x = damp(this.cape.rotation.x, capeLift + flutter, 8, dt);
    for (const [i, s] of this.streamers.entries()) {
      const wave = Math.sin(this.time * (8 + speed * 0.4) + i * 1.7) * 0.15 * Math.min(1, speed / 6);
      s.rotation.x = damp(s.rotation.x, capeLift * 1.2 + wave, 8, dt);
    }

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
    for (const n of this.nodes) n.dispose();
    this.shadow.dispose();
    this.root.dispose();
  }
}
