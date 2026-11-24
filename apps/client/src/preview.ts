/**
 * Development model sheet: shows every model built by scripts/preview-models.ts
 * for one pack in a grid, with the game's material conversion, so environment
 * pieces can be compared before they go into the layout.
 *   /preview.html?pack=kaykit-medieval-hexagon[&raw][&cols=8][&filter=hex_]
 */
import "@babylonjs/loaders/glTF/index.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { convertMaterial } from "./render/dressing.ts";

const params = new URLSearchParams(location.search);
const pack = params.get("pack") ?? "kaykit-medieval-hexagon";
const raw = params.has("raw");
const cols = Number(params.get("cols") ?? 8);
const filter = params.get("filter") ? new RegExp(params.get("filter")!, "i") : null;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.61, 0.77, 0.89, 1);
scene.ambientColor = new Color3(1, 1, 1);
const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), scene);
hemi.intensity = 0.75;
hemi.groundColor = new Color3(0.35, 0.38, 0.45);
const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.35), scene);
sun.intensity = 0.9;

const index = (await (await fetch(`/env-preview/${pack}/index.json`)).json() as Array<{ name: string; min: number[]; max: number[] }>)
  .filter((m) => !filter || filter.test(m.name));
const cell = raw ? Math.max(...index.map((m) => Math.max(m.max[0] - m.min[0], m.max[2] - m.min[2]))) * 1.15 : 2;
const rows = Math.ceil(index.length / cols);
const labels: Array<{ el: HTMLDivElement; at: Vector3 }> = [];

await Promise.all(index.map(async (m, i) => {
  const c = await LoadAssetContainerAsync(`/env-preview/${pack}/${m.name}.glb`, scene);
  c.addAllToScene();
  for (const mesh of c.meshes) if (mesh instanceof Mesh) mesh.material = convertMaterial(mesh.material, scene);
  const root = c.meshes[0];
  const size = Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]);
  const s = raw ? 1 : 1.6 / Math.max(0.001, size);
  const x = (i % cols) * cell - ((cols - 1) * cell) / 2;
  const z = -Math.floor(i / cols) * cell + ((rows - 1) * cell) / 2;
  root.scaling.scaleInPlace(s);
  root.position.set(x - ((m.min[0] + m.max[0]) / 2) * s, -m.min[1] * s, z - ((m.min[2] + m.max[2]) / 2) * s);
  const el = document.createElement("div");
  el.className = "label";
  el.textContent = `${m.name} ${(m.max[0] - m.min[0]).toFixed(2)}×${(m.max[1] - m.min[1]).toFixed(2)}×${(m.max[2] - m.min[2]).toFixed(2)}`;
  document.body.appendChild(el);
  labels.push({ el, at: new Vector3(x, 0, z - cell * 0.42) });
}));

const span = Math.max(cols, rows) * cell;
const camera = new ArcRotateCamera("cam", -Math.PI / 2, Number(params.get("beta") ?? 0.75), span * 0.95, Vector3.Zero(), scene);
camera.attachControl(canvas, true);
camera.wheelPrecision = 40 / cell;
camera.minZ = 0.05;
scene.activeCamera = camera;

engine.runRenderLoop(() => {
  scene.render();
  const vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const vm = scene.getTransformMatrix();
  for (const l of labels) {
    const p = Vector3.Project(l.at, Matrix.Identity(), vm, vp);
    l.el.style.left = `${(p.x / engine.getRenderWidth()) * canvas.clientWidth}px`;
    l.el.style.top = `${(p.y / engine.getRenderHeight()) * canvas.clientHeight}px`;
  }
});
addEventListener("resize", () => engine.resize());
(window as unknown as { ready: boolean }).ready = true;
