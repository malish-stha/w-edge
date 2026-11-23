import type { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder.js";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder.js";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mode, groundHeightAt, type SkillFxKind, type World } from "@worlds-edge/shared";
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

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

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

export interface FlightFxEvent {
  kind: "takeoff" | "dodge" | "streak" | "diveRing" | "cast";
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  facing: number;
  mantle: string;
}

/**
 * Low-poly character with articulated weapons and expressive flight kinematics:
 * independent head look-ahead, turn banking, takeoff/hover/climb/soar/boost/dive
 * stances, aerial barrel-roll dodges, and aerial combat/cast poses while flying.
 */
export class CharacterRig {
  readonly root: TransformNode;
  readonly key: string;
  private body: TransformNode;
  private head: TransformNode;
  private legL: TransformNode; private legR: TransformNode;
  private armL: TransformNode; private armR: TransformNode;
  private cape: Mesh;
  private streamers: Mesh[] = [];
  private shadow: Mesh;
  private meshes: Mesh[] = [];
  private nodes: TransformNode[] = [];
  private facing = 0;
  private prevFacing = 0;
  private pitch = 0;
  private bodyYaw = 0;
  private roll = 0;
  private walkPhase = 0;
  private time = 0;
  private lastAttackTime = 0;
  private lastCombo = 0;
  private swingAnim = 0;
  private swingDur = 0.44;
  private activeCombo = 1;
  private combatHold = 0;
  private lastMode: number = Mode.Ground;
  private lastDodgeTime = 0;
  private lastCds: [number, number, number] = [0, 0, 0];
  private takeoffTime = 0;
  private blinkTime = 0;
  private lastTeleportCd = 0;
  private castTime = 0;
  private activeSkill: SkillFxKind | null = null;
  private skillTime = 0;
  private skillDur = 0.55;
  private tempestTime = 0;
  private giantAura: Mesh;
  private tempestCrown: Mesh;
  private streakAccum = 0;
  private diveRingAccum = 0;
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

    this.head = new TransformNode("headPivot", scene);
    this.head.parent = this.body;
    this.head.position.set(0, 0.48, 0);
    this.nodes.push(this.head);

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
    part(CreateBox("head", { size: 0.44 }, scene), this.head, 0, 0.24, 0, skin);
    part(CreateBox("hair", { width: 0.48, height: 0.18, depth: 0.48 }, scene), this.head, 0, 0.42, -0.02, hair);
    part(CreateBox("hairBack", { width: 0.48, height: 0.3, depth: 0.1 }, scene), this.head, 0, 0.24, -0.21, hair);
    part(CreateBox("eyeL", { width: 0.07, height: 0.07, depth: 0.02 }, scene), this.head, -0.1, 0.26, 0.22, dark);
    part(CreateBox("eyeR", { width: 0.07, height: 0.07, depth: 0.02 }, scene), this.head, 0.1, 0.26, 0.22, dark);

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
        sword.rotation.x = 2.25;
        box("blade", sword, 0.06, 1.15, 0.14, 0, 0.7, 0, metal);
        this.swordGlow = box("bladeGlow", sword, 0.1, 1.2, 0.19, 0, 0.72, 0, mat(scene, "#ffd36b", { glow: 1, alpha: 0.55 }));
        this.swordGlow.setEnabled(false);
        box("guard", sword, 0.32, 0.05, 0.09, 0, 0.1, 0, mat(scene, "#c9a227"));
        box("hilt", sword, 0.05, 0.22, 0.05, 0, -0.02, 0, dark);
        this.sword = sword;
        break;
      }
      case "archer": {
        // Longbow held in left hand; limbs flex, two-segment string pulls to cheek anchor, arrow nocks & looses.
        const bow = node("bow", this.armL, 0.04, -0.62, 0.06);
        const tipMat = mat(scene, "#ffd36b", { glow: 0.5 });
        box("grip", bow, 0.075, 0.3, 0.08, 0, 0, 0, mat(scene, "#b07d4f"));
        this.bowLimbU = box("limbU", bow, 0.06, 0.74, 0.065, 0, 0.45, -0.06, mat(scene, "#c4925e"));
        this.bowLimbU.rotation.x = -0.24;
        box("tipU", this.bowLimbU, 0.07, 0.1, 0.07, 0, 0.36, 0, tipMat);
        this.bowLimbL = box("limbL", bow, 0.06, 0.74, 0.065, 0, -0.45, -0.06, mat(scene, "#c4925e"));
        this.bowLimbL.rotation.x = 0.24;
        box("tipL", this.bowLimbL, 0.07, 0.1, 0.07, 0, -0.36, 0, tipMat);

        const strMat = mat(scene, "#ffffff", { glow: 0.7 });
        this.bowStringU = box("stringU", bow, 0.022, 0.76, 0.022, 0, 0.38, -0.16, strMat);
        this.bowStringL = box("stringL", bow, 0.022, 0.76, 0.022, 0, -0.38, -0.16, strMat);

        // Nocked 3D arrow (long shaft + bright broadhead + fletching) visible during nock & draw.
        const arrow = node("nockedArrow", bow, 0, 0, 0.05);
        box("arrowShaft", arrow, 0.032, 0.032, 1.15, 0, 0, 0.38, mat(scene, "#e3c598", { glow: 0.3 }));
        const head = part(CreateCylinder("arrowHead", { height: 0.18, diameterTop: 0, diameterBottom: 0.1, tessellation: 4 }, scene), arrow, 0, 0, 0.98, mat(scene, "#ffd36b", { glow: 0.95 }));
        head.rotation.x = Math.PI / 2;
        box("arrowFletch", arrow, 0.11, 0.11, 0.16, 0, 0, -0.18, mat(scene, "#ff6b57", { glow: 0.6 }));
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
          const f = box(`feather${i}`, this.head, 0.05, 0.42 - Math.abs(x), 0.1, x, 0.58, -0.12, feather);
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
        box("brow", this.head, 0.46, 0.06, 0.06, 0, 0.34, 0.21, mat(scene, "#8a7f74"));
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

    this.giantAura = CreateTorus("giantAura", { diameter: 2.0, thickness: 0.12, tessellation: 24 }, scene);
    this.giantAura.parent = this.root;
    this.giantAura.position.y = 0.14;
    this.giantAura.material = mat(scene, "#ff9b3d", { glow: 1, alpha: 0.75 });
    this.giantAura.isPickable = false;
    this.giantAura.setEnabled(false);

    this.tempestCrown = CreateTorus("tempestCrown", { diameter: 0.95, thickness: 0.08, tessellation: 16 }, scene);
    this.tempestCrown.parent = this.head;
    this.tempestCrown.position.y = 0.75;
    this.tempestCrown.material = mat(scene, "#9fe4ff", { glow: 1, alpha: 0.85 });
    this.tempestCrown.isPickable = false;
    this.tempestCrown.setEnabled(false);
  }

  /** Play a bespoke full-body animation for a special skill or ultimate. */
  triggerSkill(skill: SkillFxKind) {
    this.activeSkill = skill;
    this.skillDur = skill === "riptide" || skill === "tempest" || skill === "colossal" ? 0.68 : 0.52;
    this.skillTime = this.skillDur;
    if (skill === "tempest") this.tempestTime = 8.0;
  }

  update(p: PlayerView, dt: number, world: World, onSwing?: (ev: SwingEvent) => void, onFlight?: (ev: FlightFxEvent) => void) {
    this.time += dt;
    const safeDt = Math.max(0.001, dt);
    const hSpeed = Math.hypot(p.vx, p.vz);
    const speed = Math.hypot(p.vx, p.vy, p.vz);

    this.root.position.set(p.x, p.y, p.z);
    const targetScale = p.giant ? 1.85 : 1;
    const sc = damp(this.root.scaling.x, targetScale, 8, dt);
    this.root.scaling.set(sc, sc, sc);
    this.facing += shortestAngle(this.facing, p.facing) * (1 - Math.exp(-12 * dt));
    this.root.rotation.y = this.facing;
    const turnRate = shortestAngle(this.prevFacing, p.facing) / safeDt;
    this.prevFacing = p.facing;

    const isFlying = p.mode === Mode.Flight || p.mode === Mode.Dive;
    const wasFlying = this.lastMode === Mode.Flight || this.lastMode === Mode.Dive;
    if (isFlying && !wasFlying) {
      this.takeoffTime = 0.42;
      onFlight?.({ kind: "takeoff", x: p.x, y: p.y + 0.35 * sc, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, facing: p.facing, mantle: p.mantle });
    }
    this.takeoffTime = Math.max(0, this.takeoffTime - dt);

    if (p.dodgeTime > 0 && this.lastDodgeTime <= 0) {
      onFlight?.({ kind: "dodge", x: p.x, y: p.y + 1.0 * sc, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, facing: p.facing, mantle: p.mantle });
    }
    this.lastDodgeTime = p.dodgeTime;

    if (p.teleportCooldown > this.lastTeleportCd + 0.5) {
      this.blinkTime = 0.28;
    }
    this.lastTeleportCd = p.teleportCooldown;
    this.blinkTime = Math.max(0, this.blinkTime - dt);

    const cds: [number, number, number] = [p.abilityCooldown, p.ability2Cooldown, p.exploreCooldown];
    if (cds.some((c, i) => c > this.lastCds[i] + 0.4)) {
      this.castTime = 0.36;
      onFlight?.({ kind: "cast", x: p.x, y: p.y + 1.1 * sc, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, facing: p.facing, mantle: p.mantle });
    }
    this.lastCds = cds;
    this.castTime = Math.max(0, this.castTime - dt);
    this.skillTime = Math.max(0, this.skillTime - dt);
    if (this.skillTime <= 0) this.activeSkill = null;
    this.tempestTime = Math.max(0, this.tempestTime - dt);
    this.lastMode = p.mode;

    // Emit crisp wingtip streaks & dive pressure rings at speed.
    if (isFlying && p.downTime <= 0 && (speed >= 17 || p.mode === Mode.Dive)) {
      this.streakAccum += dt;
      if (this.streakAccum >= (p.mode === Mode.Dive ? 0.032 : 0.048)) {
        this.streakAccum = 0;
        onFlight?.({ kind: "streak", x: p.x, y: p.y + 1.0 * sc, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, facing: this.facing, mantle: p.mantle });
      }
      if (p.mode === Mode.Dive) {
        this.diveRingAccum += dt;
        if (this.diveRingAccum >= 0.2) {
          this.diveRingAccum = 0;
          onFlight?.({ kind: "diveRing", x: p.x, y: p.y + 1.0 * sc, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, facing: this.facing, mantle: p.mantle });
        }
      }
    } else {
      this.streakAccum = 0;
      this.diveRingAccum = 0;
    }

    // Detect newly started attack swing for crisp weapon-arc VFX and full swing curve.
    if (p.attackTime > 0 && (this.lastAttackTime <= 0 || p.attackTime > this.lastAttackTime + 0.05 || p.attackCombo !== this.lastCombo)) {
      this.swingDur = this.classId === "archer" ? 0.62 : 0.46;
      this.swingAnim = this.swingDur;
      this.activeCombo = p.attackCombo || 1;
      this.combatHold = 0.85;
      onSwing?.({
        classId: this.classId,
        combo: this.activeCombo,
        x: p.x, y: p.y + 1.15 * sc, z: p.z,
        facing: p.facing,
        mantle: p.mantle,
        charged: p.classCharge > 0 || p.giant,
      });
    }
    this.swingAnim = Math.max(0, this.swingAnim - dt);
    this.combatHold = Math.max(0, this.combatHold - dt);
    this.lastAttackTime = p.attackTime;
    this.lastCombo = p.attackCombo;

    let bodyPitch = 0, bodyYaw = 0, bodyRoll = 0;
    let legSwing = 0, legBack = 0, legStagger = 0;
    let armSwing = 0, armOut = 0, armForward = 0, capeLift = 0.1, bob = 0;
    switch (p.mode) {
      case Mode.Ground: {
        this.walkPhase += hSpeed * dt * 1.6;
        const amount = Math.min(1, hSpeed / 7);
        legSwing = Math.sin(this.walkPhase) * 0.7 * amount;
        armSwing = -legSwing * 0.8;
        bodyPitch = 0.08 * amount;
        bodyRoll = Math.max(-0.18, Math.min(0.18, -turnRate * 0.04 * amount));
        bob = Math.abs(Math.sin(this.walkPhase)) * 0.06 * amount;
        capeLift = 0.1 + amount * 0.3;
        break;
      }
      case Mode.Air: {
        const rising = Math.max(0, Math.min(1, p.vy / 9));
        const falling = Math.max(0, Math.min(1, -p.vy / 18));
        bodyPitch = -0.1 * rising + 0.16 * falling;
        legStagger = 0.42 * rising + 0.25 * falling;
        legBack = 0.22 * falling;
        armOut = 0.38 + falling * 0.48;
        armForward = 0.55 * rising + 0.2 * falling;
        capeLift = 0.45 + falling * 0.65;
        break;
      }
      case Mode.Flight: {
        const k = Math.min(1, hSpeed / 15);
        const boostK = Math.max(0, Math.min(1, (hSpeed - 17) / 14));
        const climbK = Math.max(0, Math.min(1, p.vy / 9));
        const descK = Math.max(0, Math.min(1, -p.vy / 11));
        const wingBeat = Math.sin(this.time * 8.5);
        const hoverFloat = Math.sin(this.time * 2.5);

        bodyPitch = 0.14 + k * 0.96 + boostK * 0.22 - climbK * 0.52 - descK * 0.28;
        bodyRoll = Math.max(-0.58, Math.min(0.58, -turnRate * 0.24));
        legBack = 0.16 + k * 0.24 - descK * 0.25;
        legStagger = 0.16 + k * 0.14 + climbK * 0.12;
        legSwing = (1 - k) * hoverFloat * 0.14 + k * Math.sin(this.time * (3.5 + hSpeed * 0.22)) * 0.07;

        armOut = 0.44 * (1 - k) + 0.28 * k - boostK * 0.14 + descK * 0.5 + climbK * (0.28 + wingBeat * 0.24);
        armForward = -(k * 0.58 + boostK * 0.34) + climbK * (0.22 - wingBeat * 0.42) + descK * 0.3;
        armSwing = (1 - k) * hoverFloat * 0.12;

        capeLift = 0.45 + k * 0.78 + boostK * 0.22 + descK * 0.3;
        bob = (1 - k) * hoverFloat * 0.1;

        if (this.takeoffTime > 0) {
          const tk = 1 - this.takeoffTime / 0.42;
          const arc = Math.sin(tk * Math.PI);
          bodyPitch -= 0.24 * arc;
          armOut += 0.6 * arc;
          armForward -= 0.45 * arc;
          legStagger += 0.45 * arc;
          capeLift += 0.35 * arc;
        }
        break;
      }
      case Mode.Dive: {
        const down = Math.atan2(-p.vy, Math.max(0.01, hSpeed));
        bodyPitch = Math.PI / 2 + down * 0.88;
        bodyRoll = Math.max(-0.65, Math.min(0.65, -turnRate * 0.28));
        legBack = 0.24;
        legStagger = 0.14;
        armForward = -0.95;
        armOut = 0.14;
        capeLift = 1.48;
        break;
      }
    }

    let armLX = armSwing - armForward * 0.65, armRX = -armSwing - armForward;
    if (p.mode === Mode.Dive && this.classId === "lancer" && p.attackTime <= 0) armRX = -0.14;
    let armLZ = -armOut, armRZ = armOut;
    let armRate = isFlying ? 10 : 12;
    let bodyY = 1.0 + bob;

    // Weapon pose defaults
    let swordRotX = this.classId === "vanguard" ? 2.1 : 2.25;
    let swordRotZ = 0;
    let spearRotX = 0.26;
    let spearY = -0.44;
    let bowRotX = -0.32;
    let bowRotZ = 0.38;
    let bowPull = 0;
    let showArrow = false;
    let shieldRotY = 0.35;

    // Aerial combat/casting lifts the torso into forward flight poise so attacks aim ahead, not into the ground.
    const airAiming = this.classId === "archer" && p.classCooldown > 0.1;
    const isAttacking = this.swingAnim > 0 || p.attackTime > 0;
    const inCombat = isAttacking || p.guarding || airAiming || this.combatHold > 0;
    const airCombat = isFlying && p.downTime <= 0 && (inCombat || this.castTime > 0);
    if (airCombat) {
      const combatPitch = (this.classId === "archer" && inCombat) ? 0.08 : p.guarding ? 0.28 : 0.36;
      bodyPitch = Math.min(bodyPitch, combatPitch);
      legBack = Math.max(legBack, 0.38);
      legStagger = Math.max(legStagger, 0.36);
      capeLift = Math.max(capeLift, 0.78);
    }

    if (this.swingAnim > 0 && p.downTime <= 0) {
      const s = Math.max(0, Math.min(1, 1 - this.swingAnim / this.swingDur));
      const combo = this.activeCombo;
      armRate = 30;
      switch (this.classId) {
        case "archer": {
          // True archery: left shoulder aimed straight at target (+bodyYaw = 1.35), bow dead ahead, right hand touches string & draws straight back to jaw.
          bodyYaw = 1.35;
          armLX = -0.12;
          armLZ = -1.48;
          bowRotX = Math.PI / 2;
          bowRotZ = Math.PI / 2 - 0.16;
          if (!isFlying) { legSwing = -0.22; bob += 0.02; }
          if (s < 0.2) {
            // Right hand reaches across chest right onto the bowstring/nock
            const t = smooth(s / 0.2);
            bowPull = 0;
            showArrow = true;
            armRX = -1.45;
            armRZ = -1.05 - t * 0.45;
          } else if (s < 0.72) {
            // Taut draw: right hand pulls string & nock straight back along arrow line to jaw anchor
            const t = smooth((s - 0.2) / 0.52);
            bowPull = t;
            showArrow = true;
            armRX = -1.45 + t * 0.48;
            armRZ = -1.5 + t * 0.34;
            armRate = 38;
          } else {
            // Arrow loosed: string twangs and draw hand snaps into follow-through
            const t = (s - 0.72) / 0.28;
            bowPull = Math.max(0, (1 - t * 3.5) * Math.cos(t * 26) * 0.42);
            showArrow = false;
            armRX = -0.97 + smooth(Math.min(1, t * 2)) * 0.35;
            armRZ = -1.16 + smooth(Math.min(1, t * 2)) * 0.42;
          }
          break;
        }
        case "saber": {
          if (combo === 3) {
            // Heavy overhead cleave: raise high overhead -> slam blade forward-down -> hold low follow-through
            const up = s < 0.26 ? smooth(s / 0.26) : 1;
            const cut = s < 0.26 ? 0 : smooth((s - 0.26) / 0.34);
            bodyYaw = -0.3 * up + 0.55 * cut;
            bodyPitch += 0.24 * cut;
            armRX = -0.9 - 2.0 * up + 2.55 * cut;
            armLX = -0.6 - 1.7 * up + 1.8 * cut;
            armRZ = 0.25 - 0.55 * cut;
            armLZ = -0.2;
            swordRotX = 2.0 + 0.9 * cut;
          } else {
            // Forehand (1) & backhand (2) diagonal cuts with blade extending forward in the slash plane
            const dir = combo === 2 ? -1 : 1;
            const coil = s < 0.22 ? smooth(s / 0.22) : 1;
            const cut = s < 0.22 ? 0 : smooth((s - 0.22) / 0.36);
            bodyYaw = dir * (0.58 * coil - 1.32 * cut);
            armRX = -1.35 - 0.25 * coil + 0.35 * cut;
            armRZ = dir * (1.18 * coil - 2.25 * cut);
            armLX = -0.55;
            armLZ = -0.45;
            swordRotX = 2.75;
            swordRotZ = dir * 0.45;
            if (isFlying) bodyRoll += dir * 0.38 * Math.sin(cut * Math.PI);
          }
          break;
        }
        case "lancer": {
          if (combo === 3) {
            // Wide horizontal polearm sweep
            const coil = s < 0.24 ? smooth(s / 0.24) : 1;
            const sweep = s < 0.24 ? 0 : smooth((s - 0.24) / 0.36);
            bodyYaw = 0.78 * coil - 1.72 * sweep;
            armRX = -1.45;
            armRZ = 1.25 * coil - 2.3 * sweep;
            armLX = 0.35;
            spearRotX = Math.PI * 0.96;
            spearY = -0.82;
            if (isFlying) bodyRoll += 0.42 * Math.sin(sweep * Math.PI);
          } else {
            // Two-step chambered spear thrust at chest height: pull back -> lunge & extend dead-ahead -> recover
            const coil = s < 0.24 ? smooth(s / 0.24) : 1;
            const thrust = s < 0.24 ? 0 : s < 0.56 ? smooth((s - 0.24) / 0.32) : 1 - 0.35 * smooth((s - 0.56) / 0.44);
            bodyYaw = -0.72 * coil + 0.95 * thrust;
            bodyPitch += 0.16 * thrust;
            armRX = -0.72 - 1.05 * thrust;
            armRZ = 0.06;
            armLX = -1.15 * coil + 1.45 * thrust;
            armLZ = 0.42 * (1 - thrust);
            spearRotX = Math.PI * (0.9 + 0.04 * thrust);
            spearY = -0.25 - 1.1 * thrust;
          }
          break;
        }
        case "vanguard": {
          if (combo === 2) {
            // Heavy shield bash: draw left shoulder back -> punch flat shield face straight forward
            const coil = s < 0.24 ? smooth(s / 0.24) : 1;
            const bash = s < 0.24 ? 0 : s < 0.58 ? smooth((s - 0.24) / 0.34) : 1 - 0.3 * smooth((s - 0.58) / 0.42);
            bodyYaw = 0.35 * coil - 0.7 * bash;
            bodyPitch += 0.18 * bash;
            armLX = -0.8 - 0.85 * bash;
            armLZ = 0.25 + 0.45 * bash;
            shieldRotY = 0.7 + 0.78 * bash;
            armRX = 0.35 * bash;
            if (isFlying) bodyRoll -= 0.32 * Math.sin(bash * Math.PI);
          } else {
            // Shield-braced sword cleave
            const dir = combo === 3 ? -1 : 1;
            const coil = s < 0.22 ? smooth(s / 0.22) : 1;
            const cut = s < 0.22 ? 0 : smooth((s - 0.22) / 0.36);
            bodyYaw = dir * (0.5 * coil - 1.05 * cut);
            armRX = -2.25 * coil + 1.7 * cut;
            armRZ = dir * (0.85 * coil - 1.65 * cut);
            swordRotX = 2.65;
            armLX = -1.1;
            armLZ = 0.35;
            shieldRotY = 0.85;
          }
          break;
        }
      }
    } else if (p.guarding && p.downTime <= 0) {
      if (this.classId === "vanguard") {
        armLX = -1.3; armLZ = 0.85; shieldRotY = 1.48; bodyYaw = -0.2;
      } else if (this.classId === "saber") {
        armRX = -1.35; armRZ = -0.75; swordRotX = 2.0; swordRotZ = 0.85; bodyYaw = 0.25;
      }
    } else if ((airAiming || (this.classId === "archer" && this.combatHold > 0)) && p.downTime <= 0) {
      // Hold poised archery stance between arrows / while planting Crossfire
      bodyYaw = 1.35;
      armLX = -0.12; armLZ = -1.48;
      bowRotX = Math.PI / 2; bowRotZ = Math.PI / 2 - 0.16;
      armRX = -1.3; armRZ = -1.1;
      if (!isFlying) legSwing = -0.2;
    } else if (this.combatHold > 0 && p.downTime <= 0) {
      // Keep melee ready stance smoothly between combo strikes instead of snapping arms to hips
      if (this.classId === "saber") {
        bodyYaw = -0.25; armRX = -0.95; armRZ = 0.3; armLX = -0.5; armLZ = -0.35; swordRotX = 2.45;
      } else if (this.classId === "lancer") {
        bodyYaw = -0.42; armRX = -0.78; armLX = -1.12; armLZ = 0.36; spearRotX = Math.PI * 0.92; spearY = -0.46;
      } else if (this.classId === "vanguard") {
        armLX = -0.75; armLZ = 0.42; shieldRotY = 0.9; armRX = -0.75; swordRotX = 2.35;
      }
    } else if (this.skillTime > 0 && this.activeSkill && p.downTime <= 0) {
      // Dedicated full-body animations for every mantle skill, exploration skill, ultimate & signature counter.
      const k = Math.max(0, Math.min(1, 1 - this.skillTime / this.skillDur));
      armRate = 28;
      switch (this.activeSkill) {
        case "slam":
        case "breakwater": {
          const lift = k < 0.32 ? smooth(k / 0.32) : 1;
          const down = k < 0.32 ? 0 : smooth((k - 0.32) / 0.34);
          bodyY += 0.52 * lift * (1 - down) - 0.14 * down;
          bodyPitch += -0.25 * lift + 0.72 * down;
          armLX = -2.6 * lift + 2.15 * down;
          armRX = -2.6 * lift + 2.15 * down;
          armLZ = -0.35 + 0.45 * down;
          armRZ = 0.35 - 0.45 * down;
          if (this.activeSkill === "breakwater" && this.shield) { shieldRotY = 1.48; armLX = -1.55; armLZ = 0.4; }
          capeLift += 0.55 * Math.sin(k * Math.PI);
          break;
        }
        case "hurl": {
          const back = k < 0.3 ? smooth(k / 0.3) : 1;
          const whip = k < 0.3 ? 0 : smooth((k - 0.3) / 0.35);
          bodyYaw = 0.8 * back - 1.55 * whip;
          bodyPitch += -0.2 * back + 0.42 * whip;
          armRX = -2.8 * back + 2.4 * whip;
          armRZ = 0.55 * back - 0.3 * whip;
          armLX = -0.85;
          break;
        }
        case "undertow":
        case "riptide": {
          const open = k < 0.36 ? smooth(k / 0.36) : 1;
          const pull = k < 0.36 ? 0 : smooth((k - 0.36) / 0.38);
          if (this.activeSkill === "riptide") bodyY += 0.72 * Math.sin(k * Math.PI);
          bodyYaw = 0.35 * open - 0.7 * pull;
          bodyPitch += -0.18 * open + 0.28 * pull;
          armLX = -1.15;
          armRX = -1.15;
          armLZ = -1.45 * open + 1.65 * pull;
          armRZ = 1.45 * open - 1.65 * pull;
          capeLift += 0.75 * Math.sin(k * Math.PI);
          break;
        }
        case "surge": {
          const charge = k < 0.26 ? smooth(k / 0.26) : 1;
          const blast = k < 0.26 ? 0 : smooth((k - 0.26) / 0.3);
          bodyYaw = 0.45 * charge - 0.55 * blast;
          bodyPitch += 0.22 * blast;
          armLX = 0.45 * charge - 2.0 * blast;
          armRX = 0.45 * charge - 2.0 * blast;
          armLZ = 0.15 * blast;
          armRZ = -0.15 * blast;
          break;
        }
        case "chain": {
          const arc = Math.sin(k * Math.PI);
          bodyYaw = -0.55 * arc;
          bodyPitch += 0.12 * arc;
          armRX = -1.62 * arc;
          armLX = 0.45 * arc;
          armRZ = 0.2;
          break;
        }
        case "static":
        case "tempest": {
          const pulse = Math.sin(k * Math.PI);
          bodyY += (this.activeSkill === "tempest" ? 0.95 : 0.48) * pulse;
          bodyPitch -= 0.34 * pulse;
          armLX = -2.45 * pulse;
          armRX = -2.45 * pulse;
          armLZ = -0.95 * pulse;
          armRZ = 0.95 * pulse;
          capeLift += 0.9 * pulse;
          break;
        }
        case "updraft": {
          const rise = Math.sin(k * Math.PI);
          bodyYaw = k * Math.PI * 2;
          bodyY += 0.45 * rise;
          armLX = -1.9 * rise;
          armRX = -1.9 * rise;
          armLZ = -1.25 * rise;
          armRZ = 1.25 * rise;
          capeLift += 0.8 * rise;
          break;
        }
        case "surface": {
          const glide = Math.sin(k * Math.PI);
          bodyPitch = Math.max(bodyPitch, 0.58 * glide);
          bodyRoll += 0.28 * glide;
          armLX = -1.15 * glide;
          armRX = 0.55 * glide;
          legSwing = -0.35 * glide;
          break;
        }
        case "leap": {
          const crouch = k < 0.24 ? smooth(k / 0.24) : 1;
          const jump = k < 0.24 ? 0 : smooth((k - 0.24) / 0.4);
          bodyY += -0.32 * crouch * (1 - jump) + 0.55 * jump;
          bodyPitch += 0.45 * crouch * (1 - jump) - 0.15 * jump;
          armLX = 0.4 * crouch - 2.9 * jump;
          armRX = 0.4 * crouch - 2.9 * jump;
          break;
        }
        case "colossal": {
          const roar = Math.sin(k * Math.PI);
          bodyY += 0.35 * roar;
          bodyPitch -= 0.38 * roar;
          armLX = -1.15 * roar;
          armRX = -1.15 * roar;
          armLZ = -1.35 * roar;
          armRZ = 1.35 * roar;
          capeLift += 0.85 * roar;
          break;
        }
        case "riposte": {
          bodyYaw = k * Math.PI * 2;
          armRX = -1.52;
          armRZ = -0.75;
          armLX = -0.4;
          armLZ = -0.8;
          swordRotX = 2.8;
          if (this.swordGlow) this.swordGlow.setEnabled(true);
          break;
        }
      }
    } else if (this.castTime > 0 && p.downTime <= 0) {
      // Mantle ability cast flare (works on ground and mid-flight)
      const c = Math.sin((1 - this.castTime / 0.36) * Math.PI);
      armRate = 24;
      bodyPitch -= 0.2 * c;
      armLX = -1.25 * c;
      armRX = -1.25 * c;
      armLZ = -0.75 * c;
      armRZ = 0.75 * c;
      capeLift += 0.35 * c;
    } else if (this.classId === "archer" && p.mode === Mode.Ground && hSpeed < 2) {
      // Relaxed bow-in-hand ready stance when standing, tilted diagonally clear of the ground.
      armLX = -0.68; armLZ = -0.22; bowRotX = -0.35; bowRotZ = 0.42;
    }

    // Dodge animation: aerial barrel roll in flight/air, crisp dash tilt on ground.
    if (p.dodgeTime > 0 && p.downTime <= 0) {
      const dProg = 1 - Math.max(0, Math.min(1, p.dodgeTime / 0.22));
      const dir = turnRate < -0.2 ? -1 : 1;
      if (isFlying || p.mode === Mode.Air) {
        bodyRoll = dir * dProg * Math.PI * 2;
        armLZ = Math.min(armLZ, -0.35);
        armRZ = Math.max(armRZ, 0.35);
      } else {
        bodyPitch += 0.32;
        bodyRoll += dir * 0.28;
      }
    }

    // Keep active melee thrust/guard level in aerial combat (Archer keeps upright level hover aim at 0.08).
    if (isFlying && p.downTime <= 0 && (isAttacking || p.guarding)) {
      const levelFix = Math.max(0, bodyPitch * 0.85);
      if (this.classId === "lancer") armRX -= levelFix;
      else if (this.classId === "vanguard") {
        armLX -= levelFix * 0.75;
        if (isAttacking && this.activeCombo !== 2) armRX -= levelFix * 0.55;
      } else if (this.classId === "saber") armRX -= levelFix * 0.55;
    }

    if (this.blinkTime > 0 && p.downTime <= 0) {
      const bk = Math.sin((this.blinkTime / 0.28) * Math.PI);
      bodyPitch += 0.36 * bk;
      armLX = Math.max(armLX, 0.55 * bk);
      armRX = Math.max(armRX, 0.55 * bk);
      capeLift += 0.65 * bk;
    }

    if (p.downTime > 0) {
      bodyPitch = -1.45; bodyY = 0.35; bodyRoll = 0;
      legSwing = 0; legBack = 0; legStagger = 0; armLX = -0.2; armRX = -0.2; armLZ = -1.2; armRZ = 1.2;
    }

    // Apply body, head look-ahead & limb transforms
    const r = 10;
    this.pitch = damp(this.pitch, bodyPitch, r, dt);
    this.bodyYaw = damp(this.bodyYaw, bodyYaw, 18, dt);
    const rollRate = p.dodgeTime > 0 ? 40 : 10;
    this.roll = damp(this.roll, bodyRoll, rollRate, dt);
    this.body.rotation.x = this.pitch;
    this.body.rotation.y = this.bodyYaw;
    this.body.rotation.z = this.roll;
    this.body.position.y = damp(this.body.position.y, bodyY, 12, dt);

    // Head sights straight down the arrow/weapon at the target even when the torso twists side-on, and looks ahead in flight.
    const headPitch = p.downTime > 0 ? 0.35 : Math.max(-0.98, Math.min(0.28, -this.pitch * 0.72));
    this.head.rotation.x = damp(this.head.rotation.x, headPitch, 14, dt);
    const yawTrack = this.classId === "archer" ? 0.88 : 0.72;
    this.head.rotation.y = damp(this.head.rotation.y, -this.bodyYaw * yawTrack - Math.max(-0.35, Math.min(0.35, this.roll * 0.4)), 18, dt);

    this.legL.rotation.x = damp(this.legL.rotation.x, legSwing + legBack - legStagger * 0.55, r, dt);
    this.legR.rotation.x = damp(this.legR.rotation.x, -legSwing + legBack + legStagger * 0.55, r, dt);
    this.armL.rotation.x = damp(this.armL.rotation.x, armLX, armRate, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, armRX, armRate, dt);
    this.armL.rotation.z = damp(this.armL.rotation.z, armLZ, armRate, dt);
    this.armR.rotation.z = damp(this.armR.rotation.z, armRZ, armRate, dt);

    // Apply weapon articulation
    if (this.sword) {
      this.sword.rotation.x = damp(this.sword.rotation.x, swordRotX, armRate, dt);
      this.sword.rotation.z = damp(this.sword.rotation.z, swordRotZ, armRate, dt);
      if (this.swordGlow) this.swordGlow.setEnabled(p.classCharge > 0 || p.guarding || (isAttacking && p.downTime <= 0));
    }
    if (this.spear) {
      this.spear.rotation.x = damp(this.spear.rotation.x, spearRotX, armRate, dt);
      this.spear.position.y = damp(this.spear.position.y, spearY, armRate, dt);
      if (this.lanceCone) {
        const fast = (p.mode === Mode.Dive || (p.mode === Mode.Flight && speed >= 22)) && p.downTime <= 0;
        this.lanceCone.setEnabled(fast || (this.swingAnim > 0.14 && this.activeCombo !== 3));
      }
    }
    if (this.bow) {
      this.bow.rotation.x = damp(this.bow.rotation.x, bowRotX, armRate, dt);
      this.bow.rotation.z = damp(this.bow.rotation.z, bowRotZ, armRate, dt);
      if (this.bowLimbU && this.bowLimbL) {
        this.bowLimbU.rotation.x = -0.24 - bowPull * 0.28;
        this.bowLimbL.rotation.x = 0.24 + bowPull * 0.28;
      }
      if (this.bowStringU && this.bowStringL) {
        const tipY = 0.76 - bowPull * 0.08;
        const tipZ = -0.16 - bowPull * 0.14;
        const nockZ = -0.16 - bowPull * 0.44;
        const dz = tipZ - nockZ;
        const halfLen = Math.hypot(tipY, dz) / 0.76;
        const tilt = Math.atan2(dz, tipY);
        this.bowStringU.position.set(0, tipY * 0.5, (tipZ + nockZ) * 0.5);
        this.bowStringU.scaling.y = halfLen;
        this.bowStringU.rotation.x = -tilt;
        this.bowStringL.position.set(0, -tipY * 0.5, (tipZ + nockZ) * 0.5);
        this.bowStringL.scaling.y = halfLen;
        this.bowStringL.rotation.x = tilt;
      }
      if (this.nockedArrow) {
        this.nockedArrow.setEnabled(showArrow);
        this.nockedArrow.position.z = 0.05 - bowPull * 0.44;
      }
    }
    if (this.shield) {
      this.shield.rotation.y = damp(this.shield.rotation.y, shieldRotY, armRate, dt);
      this.shieldBarrier?.setEnabled(p.guarding && p.downTime <= 0);
      this.shieldChargeGlow?.setEnabled(p.classCharge > 0 && p.downTime <= 0);
    }

    // Subtract body pitch so cape and streamers trail naturally behind the torso instead of sticking straight up in horizontal flight.
    const relCape = Math.max(0.08, capeLift - Math.max(0, this.pitch * 0.88));
    const flutter = Math.sin(this.time * (6 + speed * 0.3)) * (0.06 + (isFlying ? 0.05 : 0)) * Math.min(1, speed / 10);
    const windBank = -this.roll * 0.5 + Math.cos(this.time * (4 + speed * 0.2)) * 0.04 * Math.min(1, speed / 12);
    this.cape.rotation.x = damp(this.cape.rotation.x, relCape + flutter, 8, dt);
    this.cape.rotation.z = damp(this.cape.rotation.z, windBank, 8, dt);
    for (const [i, s] of this.streamers.entries()) {
      const wave = Math.sin(this.time * (8 + speed * 0.4) + i * 1.7) * 0.16 * Math.min(1, speed / 6);
      s.rotation.x = damp(s.rotation.x, Math.max(0.1, relCape * 1.15) + wave, 8, dt);
      s.rotation.z = damp(s.rotation.z, windBank * 1.2, 8, dt);
    }

    this.giantAura.setEnabled(p.giant && p.downTime <= 0);
    if (p.giant) {
      this.giantAura.rotation.y += dt * 3.2;
      const gPulse = 1 + Math.sin(this.time * 8) * 0.08;
      this.giantAura.scaling.set(gPulse, 1, gPulse);
    }
    this.tempestCrown.setEnabled(this.tempestTime > 0 && p.downTime <= 0);
    if (this.tempestTime > 0) {
      this.tempestCrown.rotation.y -= dt * 4.5;
      this.tempestCrown.position.y = 0.72 + Math.sin(this.time * 6) * 0.06;
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
    this.giantAura.dispose();
    this.tempestCrown.dispose();
    this.shadow.dispose();
    this.root.dispose();
  }
}
