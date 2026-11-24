/**
 * Turn the downloaded packs (.asset-cache, see fetch-assets.ts) into what the game
 * uses: one slim GLB per model the world references, in
 * apps/client/public/env/<pack>/<model>.glb, plus a table in
 * packages/shared/src/env-models.ts with each model's bounds and a coarse
 * height profile (the shared layout sizes props and builds colliders from it).
 *
 *   npx tsx scripts/build-env.ts
 *
 * glTF/GLB sources are copied through glTF-Transform (dedupe, prune, weld);
 * OBJ sources are converted with obj2gltf first. The Kenney Nature Kit's
 * turquoise palette is recoloured here to sit with the KayKit terrain.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeIO, getBounds, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, quantize, weld } from "@gltf-transform/functions";
import { execSync } from "node:child_process";
import { allDressingModels } from "../packages/shared/src/dressing.ts";

const ROOT = process.cwd();
const CACHE = join(ROOT, ".asset-cache");
const OUT = join(ROOT, "apps/client/public/env");
const TABLE = join(ROOT, "packages/shared/src/env-models.ts");
/** Height-profile resolution (cells per side). */
const PROFILE = 4;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Nature Kit material → colour that matches the KayKit hex terrain (sRGB hex). */
const PALETTE: Record<string, Record<string, string>> = {
  "kenney-nature-kit": {
    grass: "#7fb24a", leafsGreen: "#5f9e3c", leafsDark: "#3f7a37", leafsFall: "#e8913c",
    dirt: "#9c6e4a", woodBark: "#8a5b3c", woodBarkDark: "#6b4530", wood: "#b07a4c", woodDark: "#7a5134",
    woodInner: "#e8cfa4", woodBirch: "#efe6d2", stone: "#b7b6ae", stoneDark: "#8c8b85",
  },
};

const baseName = (file: string) => file.toLowerCase().replace(/\.(glb|gltf|obj)$/, "").replace(/\.gltf$/, "");

/** Find <name>.glb / .gltf / .obj anywhere under a pack folder (preferring GLB). */
function findSource(pack: string, name: string): string | null {
  const dir = join(CACHE, pack);
  if (!existsSync(dir)) return null;
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (depth < 8) walk(p, depth + 1); }
      else if (/\.(glb|gltf|obj)$/i.test(e) && baseName(e) === name.toLowerCase()) found.push(p);
    }
  };
  walk(dir, 0);
  const rank = (p: string) => (p.endsWith(".glb") ? 0 : p.endsWith(".gltf") ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

async function load(source: string) {
  if (!source.toLowerCase().endsWith(".obj")) return io.read(source);
  const { default: obj2gltf } = await import("obj2gltf");
  const glb = await obj2gltf(source, { binary: true });
  return io.readBinary(new Uint8Array(glb));
}

/** "#rrggbb" → 0..1 channels. Kenney's flat-colour kits store display colours, and the client shows them as they are. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [16, 8, 0].map((s) => ((n >> s) & 255) / 255) as [number, number, number];
}

function recolour(doc: Document, pack: string) {
  const map = PALETTE[pack];
  if (!map) return;
  for (const m of doc.getRoot().listMaterials()) {
    const hex = map[m.getName()];
    if (!hex) continue;
    const a = m.getBaseColorFactor()[3];
    m.setBaseColorFactor([...hexToRgb(hex), a]);
  }
}

/**
 * KayKit models colour themselves by sampling swatches of one gradient atlas
 * (8 columns × 4 rows). Its grass swatch is a yellowish olive that turns muddy
 * at our scale, so grass samples the atlas's fresh green instead; and the hex
 * tiles' sides (which are grass-coloured all the way down) sample the warm grey
 * stone swatch, light at the top and darkening downward, so islands get rocky cliffs.
 */
const ATLAS = { cols: 8, rows: 4 };
const swatch = (col: number, row: number, t: number): [number, number] =>
  [(col + 0.5) / ATLAS.cols, (row + 0.04 + Math.min(1, Math.max(0, t)) * 0.92) / ATLAS.rows];
const OLIVE = { col: 0, row: 2 }, GREEN = { col: 4, row: 1 }, STONE = { col: 6, row: 1 };

function retexture(doc: Document, pack: string, name: string) {
  if (pack !== "kaykit-medieval-hexagon") return;
  const column = name === "hex_grass_bottom";
  const tile = name.startsWith("hex_grass") && !column;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uv = prim.getAttribute("TEXCOORD_0"), pos = prim.getAttribute("POSITION"), nrm = prim.getAttribute("NORMAL");
      if (!uv || !pos) continue;
      const out = uv.clone();
      for (let i = 0; i < uv.getCount(); i++) {
        const [u, v] = uv.getElement(i, [0, 0]);
        const inOlive = Math.floor(u * ATLAS.cols) === OLIVE.col && Math.floor(v * ATLAS.rows) === OLIVE.row;
        if (!inOlive) continue;
        const within = v * ATLAS.rows - OLIVE.row; // 0 at the swatch's top, 1 at its bottom
        const y = pos.getElement(i, [0, 0, 0])[1];
        const up = nrm ? nrm.getElement(i, [0, 0, 0])[1] > 0.7 : false;
        let next: [number, number];
        if (column) next = swatch(STONE.col, STONE.row, 0.12 + (-y) * 0.8); // tile space y: 0 (top) .. -1 (bottom)
        else if (tile && !up) next = y > -0.14 ? swatch(GREEN.col, GREEN.row, 0.85) : swatch(STONE.col, STONE.row, (-y - 0.14) * 0.14);
        else if (tile) next = swatch(GREEN.col, GREEN.row, 0.5 + within * 0.2);
        else next = swatch(GREEN.col, GREEN.row, within);
        out.setElement(i, next);
      }
      prim.setAttribute("TEXCOORD_0", out);
    }
  }
}

type Mat4 = number[];
const apply = (m: Mat4, x: number, y: number, z: number): [number, number, number] => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/**
 * Highest point of the model over a PROFILE×PROFILE grid of its footprint, as a
 * fraction of its height (row-major: z rows, x columns). Used for colliders that
 * follow roofs and towers instead of one big box.
 */
function heightProfile(doc: Document, min: number[], max: number[]): number[] {
  const n = PROFILE;
  const cells = new Array(n * n).fill(-Infinity);
  const w = Math.max(1e-6, max[0] - min[0]), d = Math.max(1e-6, max[2] - min[2]), h = Math.max(1e-6, max[1] - min[1]);
  const mark = (p: [number, number, number]) => {
    const cx = Math.min(n - 1, Math.max(0, Math.floor(((p[0] - min[0]) / w) * n)));
    const cz = Math.min(n - 1, Math.max(0, Math.floor(((p[2] - min[2]) / d) * n)));
    const k = cz * n + cx;
    if (p[1] > cells[k]) cells[k] = p[1];
  };
  const cell = Math.min(w, d) / n;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix() as unknown as Mat4;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      const v = (i: number) => {
        const e = pos.getElement(idx ? idx.getScalar(i) : i, [0, 0, 0]);
        return apply(m, e[0], e[1], e[2]);
      };
      for (let t = 0; t + 2 < count; t += 3) {
        const a = v(t), b = v(t + 1), c = v(t + 2);
        const len = Math.max(Math.hypot(a[0] - b[0], a[2] - b[2]), Math.hypot(b[0] - c[0], b[2] - c[2]), Math.hypot(c[0] - a[0], c[2] - a[2]));
        const steps = Math.min(40, Math.max(1, Math.ceil(len / (cell / 3))));
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; j <= steps - i; j++) {
            const u = i / steps, vv = j / steps, ww = 1 - u - vv;
            mark([a[0] * ww + b[0] * u + c[0] * vv, a[1] * ww + b[1] * u + c[1] * vv, a[2] * ww + b[2] * u + c[2] * vv]);
          }
        }
      }
    }
  }
  return cells.map((y) => (y === -Infinity ? 0 : Math.max(0, Math.round(((y - min[1]) / h) * 100) / 100)));
}

const ids = allDressingModels();
const table: Record<string, { min: number[]; max: number[]; cols: number[] }> = {};
const missingPacks = new Set<string>();
let bytes = 0;

// Clear previous output (pack folders only; CREDITS.md stays).
if (existsSync(OUT)) for (const e of readdirSync(OUT)) if (statSync(join(OUT, e)).isDirectory()) rmSync(join(OUT, e), { recursive: true, force: true });
for (const id of ids) {
  const [pack, name] = id.split("/");
  const source = findSource(pack, name);
  if (!source) {
    if (existsSync(join(CACHE, pack))) console.log(`  ? ${id}: not found in the pack`);
    else missingPacks.add(pack);
    continue;
  }
  // A failed download can leave an HTML error page where a model should be: skip it.
  if (readFileSync(source).subarray(0, 64).toString("latin1").toLowerCase().includes("<!doctype html")) {
    console.log(`  ✖ ${id}: the downloaded file is a web page, not a model (re-run fetch-assets)`);
    continue;
  }
  let doc;
  try {
    doc = await load(source);
    recolour(doc, pack);
    retexture(doc, pack, name);
    await doc.transform(dedup(), prune(), weld());
  } catch (err) {
    console.log(`  ✖ ${id}: ${(err as Error).message}`);
    continue;
  }
  const b = getBounds(doc.getRoot().listScenes()[0]);
  const cols = heightProfile(doc, b.min, b.max);
  // Smaller vertex data (Babylon reads KHR_mesh_quantization natively).
  await doc.transform(quantize());
  const out = join(OUT, pack, `${name}.glb`);
  mkdirSync(dirname(out), { recursive: true });
  const glb = await io.writeBinary(doc);
  writeFileSync(out, glb);
  bytes += glb.byteLength;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  table[id] = { min: b.min.map(r), max: b.max.map(r), cols };
}

const lines = Object.entries(table).map(([id, b]) => `  ${JSON.stringify(id)}: { min: [${b.min.join(", ")}], max: [${b.max.join(", ")}], cols: [${b.cols.join(", ")}] },`);
writeFileSync(TABLE, `// Generated by \`npm run build-env\` — model bounds (glTF units) and a ${PROFILE}×${PROFILE} height profile
// (fraction of the model's height, z rows × x columns) for every converted model.
export interface EnvModel { min: [number, number, number]; max: [number, number, number]; cols: number[] }
export const ENV_PROFILE = ${PROFILE};
export const ENV_MODELS: Record<string, EnvModel> = {
${lines.join("\n")}
};
`);

console.log(`Built ${Object.keys(table).length}/${ids.length} models (${(bytes / 1024).toFixed(0)} KB) into apps/client/public/env`);
execSync("npx tsx scripts/prune-env.ts", { stdio: "inherit" });
if (missingPacks.size) console.log(`Packs not downloaded yet (their islands use stand-ins): ${[...missingPacks].join(", ")}`);
