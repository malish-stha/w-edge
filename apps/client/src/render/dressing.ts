import "@babylonjs/loaders/glTF/index.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { DressedArea, World } from "@worlds-edge/shared";

/** Areas stop drawing this far beyond their load radius (they're deep in fog by then). */
const HIDE_MARGIN = 350;

/** Small per-instance colour shifts, so repeated tiles, trees and rocks don't look stamped. */
const VARIATION: Array<[RegExp, number, number]> = [
  // [models, brightness spread, hue spread (yellow ↔ blue-green)]
  [/hex_grass$/, 0.07, 0.06],
  [/hex_grass_bottom|mountain|rock|stone|cliff/, 0.09, 0.03],
  [/tree|palm|bush|grass|plant|flower|mushroom|crop/, 0.12, 0.08],
];

/** Things that ride the swell (each to its own rhythm). */
const FLOATS = /boat|ship-(small|large|cargo|pirate)|buoy/;
const CLOUDS = /\/cloud_/;

function hash01(x: number, z: number, salt: number) {
  let h = Math.imul(Math.round(x * 7) ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(Math.round(z * 7) + salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

interface AreaEntry { area: DressedArea; meshes: Mesh[]; state: "idle" | "loading" | "ready" }
interface Floating { mesh: Mesh; base: Float32Array; live: Float32Array; phase: Float32Array; centre: Vector3 }

/**
 * Draws the world: every area's models (terrain tiles, buildings, props), one
 * pack per island. Models load when the camera first comes near an area (terrain
 * and landmarks at once), are converted to the same cheap lit material as the
 * characters, merged into one mesh per model, and drawn as thin instances, so a
 * whole forest of one tree type is a single draw call.
 */
export class Dressing {
  private templates = new Map<string, Promise<Mesh | null>>();
  private areas: AreaEntry[] = [];
  private generation = 0;
  private floats: Floating[] = [];
  private clouds: Mesh[] = [];
  /** Called for every mesh the dressing creates (shadows hook in here). */
  onMesh: ((mesh: Mesh, model: string) => void) | null = null;

  constructor(private scene: Scene) {}

  /** Switch to another world's areas (overworld or dungeon arena). */
  setWorld(world: World) {
    this.generation++;
    for (const a of this.areas) for (const m of a.meshes) m.dispose();
    this.floats = [];
    this.clouds = [];
    this.areas = world.areas.map((area) => ({ area, meshes: [], state: "idle" as const }));
  }

  update(camera: Vector3, time = 0) {
    for (const a of this.areas) {
      const d = Math.hypot(camera.x - a.area.center.x, camera.z - a.area.center.z);
      // Terrain and buildings load straight away and always draw (islands on the horizon).
      if (a.state === "idle" && (a.area.always || d < a.area.loadRadius)) {
        a.state = "loading";
        void this.load(a);
      }
      const visible = a.area.always || d < a.area.loadRadius + HIDE_MARGIN;
      for (const m of a.meshes) if (m.isEnabled() !== visible) m.setEnabled(visible);
    }
    this.animate(camera, time);
  }

  /** Clouds drift slowly; boats and buoys near the camera ride the swell. */
  private animate(camera: Vector3, time: number) {
    for (const [i, c] of this.clouds.entries()) {
      c.position.x = Math.sin(time * 0.012 + i * 1.7) * 60;
      c.position.z = Math.cos(time * 0.009 + i) * 25;
    }
    const m = this.tmp[0], tilt = this.tmp[1], out = this.tmp[2];
    for (const f of this.floats) {
      if (!f.mesh.isEnabled() || Vector3.Distance(f.centre, camera) > 900) continue;
      for (let i = 0; i < f.phase.length; i++) {
        const o = i * 16, ph = f.phase[i];
        Matrix.FromArrayToRef(f.base, o, m);
        const x = m.m[12], y = m.m[13], z = m.m[14];
        m.setTranslationFromFloats(0, 0, 0);
        Matrix.RotationYawPitchRollToRef(0, Math.sin(time * 0.8 + ph * 1.7) * 0.03, Math.sin(time * 1.1 + ph) * 0.045, tilt);
        m.multiplyToRef(tilt, out);
        out.setTranslationFromFloats(x, y + Math.sin(time * 1.3 + ph * 2.3) * 0.2, z);
        out.copyToArray(f.live, o);
      }
      f.mesh.thinInstanceBufferUpdated("matrix");
    }
  }

  private tmp = [new Matrix(), new Matrix(), new Matrix()];

  /** A standalone copy of a model (for animated set pieces such as the Colossus's arms). */
  async instance(model: string): Promise<Mesh | null> {
    const template = await this.template(model);
    if (!template) return null;
    const mesh = template.clone(`${model}#`, null, true)!;
    mesh.setEnabled(true);
    mesh.isPickable = false;
    this.onMesh?.(mesh, model);
    return mesh;
  }

  /** Number of areas with their props showing (for the debug overlay). */
  get loadedAreas() { return this.areas.filter((a) => a.state === "ready").length; }

  private async load(entry: AreaEntry) {
    const generation = this.generation;
    const byModel = new Map<string, DressedArea["placements"]>();
    for (const p of entry.area.placements) {
      const list = byModel.get(p.model) ?? [];
      list.push(p);
      byModel.set(p.model, list);
    }
    await Promise.all([...byModel].map(async ([model, placements]) => {
      const template = await this.template(model);
      if (!template || generation !== this.generation) return;
      // Each area needs its own geometry: thin-instance buffers live on the geometry, so
      // clones sharing it would all draw the last area's instances.
      const mesh = template.clone(`${entry.area.id}:${model}`, null, true)!;
      mesh.makeGeometryUnique();
      const matrices = new Float32Array(placements.length * 16);
      const m = new Matrix();
      for (const [i, p] of placements.entries()) {
        Matrix.ComposeToRef(
          new Vector3(p.sx, p.sy, p.sz),
          Quaternion.RotationAxis(Vector3.Up(), p.rotY),
          new Vector3(p.x, p.y, p.z),
          m,
        );
        m.copyToArray(matrices, i * 16);
      }
      const floats = FLOATS.test(model);
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, !floats);
      const vary = VARIATION.find(([re]) => re.test(model));
      if (vary) {
        const [, spread, hue] = vary;
        const colours = new Float32Array(placements.length * 4);
        for (const [i, p] of placements.entries()) {
          const b = 1 + (hash01(p.x, p.z, 1) - 0.5) * 2 * spread;
          const h = (hash01(p.x, p.z, 2) - 0.5) * 2 * hue;
          colours.set([b * (1 + h * 0.6), b, b * (1 - h), 1], i * 4);
        }
        mesh.thinInstanceSetBuffer("color", colours, 4, true);
      }
      mesh.thinInstanceRefreshBoundingInfo(false);
      mesh.setEnabled(true);
      mesh.isPickable = false;
      if (floats) {
        const c = placements.reduce((acc, p) => acc.addInPlaceFromFloats(p.x, p.y, p.z), new Vector3()).scaleInPlace(1 / placements.length);
        this.floats.push({ mesh, base: matrices.slice(), live: matrices, phase: Float32Array.from(placements, (p) => hash01(p.x, p.z, 3) * 6.28), centre: c });
      }
      if (CLOUDS.test(model)) this.clouds.push(mesh);
      else mesh.freezeWorldMatrix();
      this.onMesh?.(mesh, model);
      entry.meshes.push(mesh);
    }));
    entry.state = "ready";
  }

  /** Load one model and boil it down to a single hidden template mesh. */
  private template(model: string): Promise<Mesh | null> {
    let p = this.templates.get(model);
    if (!p) {
      p = this.loadTemplate(model).catch((err) => {
        console.warn(`Couldn't load ${model}:`, err);
        return null;
      });
      this.templates.set(model, p);
    }
    return p;
  }

  private async loadTemplate(model: string): Promise<Mesh | null> {
    const container = await LoadAssetContainerAsync(`${import.meta.env.BASE_URL}env/${model}.glb`, this.scene);
    container.addAllToScene();
    const parts = container.meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
    const look = lookFor(model);
    for (const part of parts) part.material = convertMaterial(part.material, this.scene, look);
    // Bake the glTF root (handedness, scale) into the vertices and merge into one mesh.
    const merged = parts.length ? Mesh.MergeMeshes(parts, true, true, undefined, false, true) : null;
    for (const node of container.transformNodes) node.dispose();
    for (const m of container.meshes) if (m !== merged && !m.isDisposed()) m.dispose();
    for (const mat of container.materials) mat.dispose(false, false);
    if (!merged) return null;
    // The glTF root turns right-handed models into Babylon's left-handed space by
    // mirroring x. Undo that, so the model matches its glTF coordinates exactly —
    // the shared layout and colliders are computed in those. Then put the winding
    // back the way Babylon draws front faces (both mirrors flipped it once).
    merged.bakeTransformIntoVertices(Matrix.Scaling(-1, 1, 1));
    merged.flipFaces();
    merged.name = model;
    merged.setEnabled(false);
    merged.isPickable = false;
    return merged;
  }
}

/** Per-model adjustments to the converted material. */
export interface Look {
  /** Multiplies the model's colours (lighten dungeon stone for sunlit streets). */
  tint?: [number, number, number];
  /** Self-lit share of the colour: 1 = unlit (clouds), default 0.1. */
  glow?: number;
}

const LOOKS: Array<[RegExp, Look]> = [
  [/\/cloud_/, { glow: 0.82, tint: [1.08, 1.08, 1.1] }],
  [/kaykit-dungeon\/(floor_tile|stairs)/, { tint: [1.75, 1.66, 1.5] }],
  // The shrine: pale, faintly glowing stone.
  [/pillar_decorated/, { tint: [1.9, 2.05, 2.3], glow: 0.3 }],
  [/kaykit-dungeon\/(wall|pillar|column)/, { tint: [1.35, 1.3, 1.24] }],
  [/torch_lit/, { glow: 0.45 }],
];

export function lookFor(model: string): Look {
  return LOOKS.find(([re]) => re.test(model))?.[1] ?? {};
}

const converted = new Map<Material, Material>();

/** glTF PBR → the same cheap, fog-aware StandardMaterial look the characters use. */
export function convertMaterial(material: Material | null, scene: Scene, look: Look = {}): Material | null {
  if (!material) return null;
  const done = converted.get(material);
  if (done) return done;
  if (material instanceof MultiMaterial) {
    const multi = new MultiMaterial(material.name, scene);
    multi.subMaterials = material.subMaterials.map((m) => convertMaterial(m, scene, look));
    converted.set(material, multi);
    return multi;
  }
  const pbr = material as PBRMaterial;
  const std = new StandardMaterial(`env:${material.name}`, scene);
  // Kenney's flat-colour kits store display (sRGB) colours in the factor: use them as they are.
  const albedo = pbr.albedoColor ? pbr.albedoColor.clone() : new Color3(0.8, 0.8, 0.8);
  const tint = look.tint ? new Color3(...look.tint) : Color3.White();
  const base = pbr.albedoTexture ? tint : albedo.multiply(tint);
  const glow = look.glow ?? 0.1;
  if (pbr.albedoTexture) std.diffuseTexture = pbr.albedoTexture;
  std.diffuseColor = base.scale(1 - glow * 0.6);
  std.emissiveColor = base.scale(glow);
  std.specularColor = Color3.Black();
  // Models face the right way after the handedness fix, so back faces can be culled.
  std.backFaceCulling = true;
  std.freeze();
  converted.set(material, std);
  return std;
}
