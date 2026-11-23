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

/**
 * Draws each area's asset-pack props (one pack per island). Models load when the
 * camera first comes near an area, are converted to the same cheap lit material
 * as characters, merged into one mesh per model, and drawn as thin instances, so
 * a whole forest of one tree type is a single draw call.
 */
export class Dressing {
  private templates = new Map<string, Promise<Mesh | null>>();
  private areas: Array<{ area: DressedArea; meshes: Mesh[]; state: "idle" | "loading" | "ready" }> = [];
  private generation = 0;

  constructor(private scene: Scene) {}

  /** Switch to another world's areas (overworld or dungeon arena). */
  setWorld(world: World) {
    this.generation++;
    for (const a of this.areas) for (const m of a.meshes) m.dispose();
    this.areas = world.areas.map((area) => ({ area, meshes: [], state: "idle" as const }));
  }

  update(camera: Vector3) {
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
  }

  /** Number of areas with their props showing (for the debug overlay). */
  get loadedAreas() { return this.areas.filter((a) => a.state === "ready").length; }

  private async load(entry: { area: DressedArea; meshes: Mesh[]; state: string }) {
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
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
      mesh.thinInstanceRefreshBoundingInfo(false);
      mesh.setEnabled(true);
      mesh.isPickable = false;
      mesh.freezeWorldMatrix();
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
    for (const part of parts) part.material = convert(part.material, this.scene);
    // Bake the glTF root (handedness, scale) into the vertices and merge into one mesh.
    // (Baking the handedness mirror reverses triangle winding; materials are two-sided
    // with two-sided lighting, so faces and shading come out right either way.)
    const merged = parts.length ? Mesh.MergeMeshes(parts, true, true, undefined, false, true) : null;
    for (const node of container.transformNodes) node.dispose();
    for (const m of container.meshes) if (m !== merged && !m.isDisposed()) m.dispose();
    for (const mat of container.materials) mat.dispose(false, false);
    if (!merged) return null;
    merged.name = model;
    merged.setEnabled(false);
    merged.isPickable = false;
    return merged;
  }
}

const converted = new Map<Material, Material>();

/** glTF PBR → the same cheap, fog-aware StandardMaterial look the characters use. */
function convert(material: Material | null, scene: Scene): Material | null {
  if (!material) return null;
  const done = converted.get(material);
  if (done) return done;
  if (material instanceof MultiMaterial) {
    const multi = new MultiMaterial(material.name, scene);
    multi.subMaterials = material.subMaterials.map((m) => convert(m, scene));
    converted.set(material, multi);
    return multi;
  }
  const pbr = material as PBRMaterial;
  const std = new StandardMaterial(`env:${material.name}`, scene);
  // Kenney's flat-colour kits store display (sRGB) colours in the factor: use them as they are.
  const albedo = pbr.albedoColor ? pbr.albedoColor.clone() : new Color3(0.8, 0.8, 0.8);
  if (pbr.albedoTexture) {
    std.diffuseTexture = pbr.albedoTexture;
    std.diffuseColor = Color3.White();
  } else {
    std.diffuseColor = albedo;
  }
  std.emissiveColor = (pbr.albedoTexture ? Color3.White() : albedo).scale(0.18);
  std.specularColor = Color3.Black();
  std.backFaceCulling = false;
  std.twoSidedLighting = true;
  std.freeze();
  converted.set(material, std);
  return std;
}
