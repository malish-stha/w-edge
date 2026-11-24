/**
 * Development helper: convert every model of a downloaded pack (or those matching
 * a filter) into apps/client/public/env-preview/<pack>/ so the model sheet at
 * http://localhost:5173/preview.html?pack=<pack> can show them side by side.
 *
 *   npx tsx scripts/preview-models.ts kaykit-medieval-hexagon "hex_|mountain"
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune } from "@gltf-transform/functions";

const [pack, filter] = process.argv.slice(2);
if (!pack) throw new Error("usage: preview-models.ts <pack> [regex]");
const src = join(process.cwd(), ".asset-cache", pack);
const out = join(process.cwd(), "apps/client/public/env-preview", pack);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const re = filter ? new RegExp(filter, "i") : null;

const files = new Map<string, string>();
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(glb|gltf)$/i.test(e)) {
      const name = e.replace(/\.(glb|gltf)$/i, "");
      if (re && !re.test(name)) continue;
      if (!files.has(name) || p.endsWith(".glb")) files.set(name, p);
    }
  }
};
walk(src);
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });
const index: Array<{ name: string; min: number[]; max: number[] }> = [];
for (const [name, file] of [...files].sort()) {
  const doc = await io.read(file);
  await doc.transform(dedup(), prune());
  const b = getBounds(doc.getRoot().listScenes()[0]);
  writeFileSync(join(out, `${name}.glb`), await io.writeBinary(doc));
  index.push({ name, min: b.min, max: b.max });
}
writeFileSync(join(out, "index.json"), JSON.stringify(index));
console.log(`${index.length} models → apps/client/public/env-preview/${pack}`);
