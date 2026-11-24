/**
 * Second half of `npm run build-env`: lay out the world with the freshly built
 * model table and delete every converted GLB nothing places, so the client
 * ships only what it draws. (The table keeps every entry: the layout's random
 * choices depend on which models exist, so it must not change here.)
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { COLOSSUS_RIG_MODELS, getColossusArena } from "../packages/shared/src/colossus.ts";
import { getWorld } from "../packages/shared/src/world.ts";

const OUT = join(process.cwd(), "apps/client/public/env");
const used = new Set([...getWorld().areas, ...getColossusArena().areas].flatMap((a) => a.placements.map((p) => p.model)));
for (const m of COLOSSUS_RIG_MODELS) used.add(m);
let kept = 0, removed = 0, bytes = 0;
for (const pack of readdirSync(OUT)) {
  const dir = join(OUT, pack);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".glb")) continue;
    if (used.has(`${pack}/${file.slice(0, -4)}`)) { kept++; bytes += statSync(join(dir, file)).size; }
    else { rmSync(join(dir, file)); removed++; }
  }
  if (!readdirSync(dir).length) rmSync(dir, { recursive: true });
}
console.log(`Kept ${kept} models the world places (${(bytes / 1024).toFixed(0)} KB); removed ${removed} unused.`);
