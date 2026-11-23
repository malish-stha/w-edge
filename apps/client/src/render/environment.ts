import type { Scene } from "@babylonjs/core/scene.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder.js";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { RIM_Z, SEA_LEVEL, type World } from "@worlds-edge/shared";
import { FOG_COLOR } from "./shaders.ts";

const FOG = Color3.FromArray(FOG_COLOR as unknown as number[]);
const SUN_DIR = new Vector3(0.4, 0.55, 0.75).normalize();

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Baked face brightness: sunlit top, two lit sides, two shaded sides, dark bottom.
const FACES: { shade: number; corners: number[][] }[] = [
  { shade: 1.0, corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] }, // top
  { shade: 0.5, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // bottom
  { shade: 0.88, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // +z
  { shade: 0.7, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }, // -z
  { shade: 0.8, corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] }, // +x
  { shade: 0.64, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // -x
];

/** The whole static world as one merged mesh with baked flat shading. */
export function buildWorldMesh(scene: Scene, world: World): Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let seed = 1;
  const jitter = () => {
    seed = (seed * 16807) % 2147483647;
    return 0.95 + (seed / 2147483647) * 0.1;
  };

  for (const b of world.boxes) {
    // Colliders and skinned blocks are drawn with pack models (render/dressing.ts), never as boxes.
    if (b.hidden || b.skin) continue;
    const [r, g, bl] = hexToRgb(b.color);
    const vary = jitter(); // painted colour variation per block
    const glow = b.tag === "beacon" || b.tag === "shrine" || b.tag === "gate" ? 1.25 : 1;
    const xs = [b.minX, b.maxX], ys = [b.minY, b.maxY], zs = [b.minZ, b.maxZ];
    for (const face of FACES) {
      const base = positions.length / 3;
      for (const [cx, cy, cz] of face.corners) {
        positions.push(xs[cx], ys[cy], zs[cz]);
        const k = face.shade * vary * glow;
        colors.push(Math.min(1, r * k), Math.min(1, g * k), Math.min(1, bl * k), 1);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const mesh = new Mesh("world", scene);
  const data = new VertexData();
  data.positions = positions;
  data.colors = colors;
  data.indices = indices;
  data.applyToMesh(mesh, false);

  const mat = new ShaderMaterial("worldMat", scene, { vertex: "world", fragment: "world" }, {
    attributes: ["position", "color"],
    uniforms: ["worldViewProjection", "cameraPos", "fogColor", "fogDensity"],
  });
  mat.backFaceCulling = false;
  mat.setColor3("fogColor", FOG);
  mat.setFloat("fogDensity", 1 / 1400);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  mesh.doNotSyncBoundingInfo = true;
  return mesh;
}

export interface Environment {
  /** `world` is the current static world mesh (overworld or dungeon arena). */
  update(cameraPos: Vector3, timeSeconds: number, world: Mesh): void;
}

/** Sky dome, ocean that follows the camera, and the waterfall curtain at the rim. */
export function buildEnvironment(scene: Scene, oceanSubdivisions: number): Environment {
  scene.clearColor = new Color4(FOG.r, FOG.g, FOG.b, 1);

  // Sky.
  const sky = CreateSphere("sky", { diameter: 9000, segments: 12, sideOrientation: Mesh.BACKSIDE }, scene);
  const skyMat = new ShaderMaterial("skyMat", scene, { vertex: "sky", fragment: "sky" }, {
    attributes: ["position"], uniforms: ["worldViewProjection", "fogColor", "sunDir"],
  });
  skyMat.setColor3("fogColor", FOG);
  skyMat.setVector3("sunDir", SUN_DIR);
  skyMat.disableDepthWrite = true;
  sky.material = skyMat;
  sky.infiniteDistance = true;
  sky.isPickable = false;
  sky.renderingGroupId = 0;

  // Ocean: a grid that moves with the camera in whole cells so the waves don't swim.
  const size = 4000;
  const ocean = CreateGround("ocean", { width: size, height: size, subdivisions: oceanSubdivisions }, scene);
  const cell = size / oceanSubdivisions;
  const oceanMat = new ShaderMaterial("oceanMat", scene, { vertex: "ocean", fragment: "ocean" }, {
    attributes: ["position"],
    uniforms: ["world", "viewProjection", "time", "cameraPos", "rimZ", "fogColor", "fogDensity"],
  });
  oceanMat.setFloat("rimZ", RIM_Z);
  oceanMat.setColor3("fogColor", FOG);
  oceanMat.setFloat("fogDensity", 1 / 1400);
  oceanMat.backFaceCulling = false;
  ocean.material = oceanMat;
  ocean.position.y = SEA_LEVEL;
  ocean.isPickable = false;
  ocean.alwaysSelectAsActiveMesh = true;

  // Waterfall curtain where the ocean spills over the World's Edge.
  const fall = CreatePlane("waterfall", { width: 6000, height: 300, sideOrientation: Mesh.DOUBLESIDE }, scene);
  fall.position.set(0, SEA_LEVEL - 150, RIM_Z);
  const fallMat = new ShaderMaterial("fallMat", scene, { vertex: "waterfall", fragment: "waterfall" }, {
    attributes: ["position", "uv"],
    uniforms: ["world", "viewProjection", "time", "cameraPos", "fogColor", "fogDensity"],
    needAlphaBlending: true,
  });
  fallMat.setColor3("fogColor", FOG);
  fallMat.setFloat("fogDensity", 1 / 1400);
  fallMat.backFaceCulling = false;
  fall.material = fallMat;
  fall.isPickable = false;
  fall.freezeWorldMatrix();

  return {
    update(cameraPos, t, world) {
      ocean.position.x = Math.round(cameraPos.x / cell) * cell;
      ocean.position.z = Math.round(cameraPos.z / cell) * cell;
      oceanMat.setFloat("time", t);
      oceanMat.setVector3("cameraPos", cameraPos);
      fallMat.setFloat("time", t);
      fallMat.setVector3("cameraPos", cameraPos);
      (world.material as ShaderMaterial).setVector3("cameraPos", cameraPos);
    },
  };
}
