/**
 * The static world, generated deterministically so the server (collision) and the
 * client (rendering) build exactly the same geometry from the same code.
 *
 * Everything solid is an axis-aligned box. That keeps collision cheap and
 * deterministic, and matches the chunky, stepped art direction.
 */
import { RIM_Z, SEA_LEVEL } from "./constants.ts";
import { ISLES, dressOverworld, type DressedArea } from "./dressing.ts";
import { SKINS, type Skin } from "./skins.ts";

export type Region = "harbour" | "isles" | "rim" | "settlement" | "arena";

export interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** Hex colour, used only by the client. */
  color: string;
  region: Region;
  /** Landmark tag for the client (beacon, shrine, ...). */
  tag?: "beacon" | "shrine" | "training" | "dock" | "gate";
  /** Collision only (a prop's collider): not drawn. */
  hidden?: boolean;
  /** Drawn with pack models instead of a plain box (see skins.ts). */
  skin?: Skin;
}

export interface Vec3 { x: number; y: number; z: number }

export interface Landmark { name: string; position: Vec3 }

export interface World {
  boxes: Box[];
  spawn: Vec3;
  landmarks: Landmark[];
  /** Asset-pack dressing per area (one pack per island). */
  areas: DressedArea[];
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(
  cx: number, minY: number, cz: number,
  sx: number, maxY: number, sz: number,
  color: string, region: Region, tag?: Box["tag"],
): Box {
  return {
    minX: cx - sx / 2, maxX: cx + sx / 2,
    minY, maxY,
    minZ: cz - sz / 2, maxZ: cz + sz / 2,
    color, region, tag,
  };
}

/** Give a block its pack-model skin. */
const sk = (b: Box, skin: Skin): Box => ({ ...b, skin });

// District palettes: each district gets a distinct skyline colour set.
const HARBOUR_WALLS = ["#e8d9b5", "#dcc79a", "#f0e4c8", "#cdb98c"];
const HARBOUR_ROOFS = ["#c8553d", "#d9774b", "#b8473a", "#e09a4f"];
const MARKET_ROOFS = ["#3d7fc8", "#4b97d9", "#2f6db0"];
const TERRACE_ROOFS = ["#6bb38a", "#4e9a72", "#82c49c"];
const STONE = "#9a8f84";
const CLIFF = "#8a7a6a";
const CLIFF_DARK = "#6f6255";
const GRASS = "#8fbf6a";
const PLAZA = "#d8ccb4";
const WOOD = "#8b6a4a";

function buildHarbour(out: Box[], r: () => number) {
  // Main island: a faceted cliff block rising out of the sea, with a lower shelf.
  out.push(sk(box(0, -30, 0, 220, 3, 200, CLIFF, "harbour"), SKINS.cliff));
  out.push(sk(box(0, -30, 105, 160, 1.5, 30, CLIFF_DARK, "harbour"), SKINS.cliff));
  // Grass top layer.
  out.push(sk(box(0, 3, -10, 200, 3.2, 170, GRASS, "harbour"), SKINS.castleGround));

  // Central plaza.
  out.push(sk(box(0, 3.2, 20, 50, 3.4, 40, PLAZA, "harbour"), SKINS.stonePath));

  // Training yard (west) with low walls and a shrine.
  out.push(sk(box(-60, 3.2, 30, 40, 3.4, 36, "#c9b48f", "harbour", "training"), SKINS.stonePath));
  out.push(sk(box(-80, 3.4, 30, 1, 4.6, 36, STONE, "harbour"), SKINS.castleWallNarrow));
  out.push(sk(box(-60, 3.4, 48, 40, 4.6, 1, STONE, "harbour"), SKINS.castleWallNarrow));
  out.push(sk(box(-60, 3.4, 12, 40, 4.6, 1, STONE, "harbour"), SKINS.castleWallNarrow));
  out.push(sk(box(-45, 3.4, 30, 4, 5.4, 4, "#d6e4ff", "harbour", "shrine"), SKINS.shrineBase));
  out.push(sk(box(-45, 5.4, 30, 2, 8.4, 2, "#8fb0ff", "harbour", "shrine"), SKINS.shrineBase));

  // Docks (south), sitting just above the sea.
  for (let i = 0; i < 4; i++) {
    const x = -54 + i * 36;
    out.push(sk(box(x, SEA_LEVEL - 0.1, 140, 8, SEA_LEVEL + 1.2, 40, WOOD, "harbour", "dock"), SKINS.dock));
  }

  // City blocks: stepped buildings on a grid, avoiding plaza and training yard.
  for (let gx = -4; gx <= 4; gx++) {
    for (let gz = -4; gz <= 3; gz++) {
      const cx = gx * 22;
      const cz = gz * 20 - 4;
      if (Math.abs(cx) < 36 && cz > -4 && cz < 44) continue; // plaza
      if (cx < -36 && cz > 6 && cz < 54) continue; // training yard
      if (Math.abs(cx) < 44 && cz < -40) continue; // upper terrace and its stairs
      if (r() < 0.18) continue; // small squares and gardens
      const market = gx > 1 && gz > -1;
      const terrace = gz < -2;
      const roofs = market ? MARKET_ROOFS : terrace ? TERRACE_ROOFS : HARBOUR_ROOFS;
      const w = 10 + r() * 6;
      const d = 9 + r() * 6;
      const h = (terrace ? 10 : 6) + r() * (terrace ? 12 : 8);
      const wall = HARBOUR_WALLS[Math.floor(r() * HARBOUR_WALLS.length)];
      const roof = roofs[Math.floor(r() * roofs.length)];
      out.push(sk(box(cx, 3.2, cz, w, 3.2 + h, d, wall, "harbour"), SKINS.castleBuilding));
      // Stepped roof: two shrinking layers players can land on.
      out.push(sk(box(cx, 3.2 + h, cz, w * 0.8, 3.2 + h + 1.4, d * 0.8, roof, "harbour"), SKINS.castleRoof));
      if (r() < 0.6) out.push(sk(box(cx, 4.6 + h, cz, w * 0.45, 4.6 + h + 1.6, d * 0.45, roof, "harbour"), SKINS.castleRoof));
    }
  }

  // Upper terrace and beacon tower (north), the first-flight launch point.
  out.push(sk(box(0, 3.2, -80, 60, 14, 30, STONE, "harbour"), SKINS.castleWall));
  out.push(sk(box(0, 14, -84, 40, 24, 20, "#b0a395", "harbour"), SKINS.castleWall));
  out.push(sk(box(0, 24, -86, 16, 40, 12, "#c4b8aa", "harbour"), SKINS.castleBuilding));
  out.push(sk(box(0, 40, -86, 8, 44, 8, "#ffd36b", "harbour", "beacon"), SKINS.castleRoof));
  // Stairs up the terrace (walkable thanks to step-up).
  // 18 steps of 0.6 m climb from the street (3.2) to the terrace top (14), ending at its face (z = -65).
  for (let i = 0; i < 18; i++) {
    out.push(sk(box(0, 3.2, -48.8 - (i + 0.5) * 0.9, 8, 3.2 + (i + 1) * 0.6, 0.9, STONE, "harbour"), SKINS.castleStep));
  }
}

/** Ruins on each isle use that isle's pack where it has a fitting piece. */
const ISLE_RUINS: Partial<Record<number, Skin>> = { 6: SKINS.pirateRuin };

function buildIsles(out: Box[], r: () => number) {
  // The Broken Isles: pillars and shelves at different heights between the
  // harbour and the rim.
  for (const [index, isle] of ISLES.entries()) {
    const s = isle.size;
    out.push(sk(box(isle.x, -40, isle.z, s, isle.top, s, CLIFF, "isles"), SKINS.cliff));
    out.push(sk(box(isle.x, isle.top, isle.z, s * 0.92, isle.top + 0.8, s * 0.92, GRASS, "isles"), SKINS.grass));
    // Broken shards around each isle.
    const shards = 2 + Math.floor(r() * 3);
    for (let i = 0; i < shards; i++) {
      const a = r() * Math.PI * 2;
      const dist = s * (0.8 + r() * 0.6);
      const ss = 5 + r() * 8;
      const top = isle.top * (0.3 + r() * 0.9);
      out.push(sk(box(isle.x + Math.cos(a) * dist, -30, isle.z + Math.sin(a) * dist, ss, top, ss, CLIFF_DARK, "isles"), SKINS.cliffStone));
    }
    // A ruin on top.
    if (r() < 0.7) {
      out.push(sk(box(isle.x + (r() - 0.5) * s * 0.4, isle.top + 0.8, isle.z + (r() - 0.5) * s * 0.4, 6, isle.top + 5 + r() * 6, 6, STONE, "isles"), ISLE_RUINS[index] ?? SKINS.rockPillar));
    }
  }
}

function buildRimAndSettlement(out: Box[]) {
  // The rim itself: a long lip of rock the ocean pours over.
  out.push(sk(box(0, -40, RIM_Z + 6, 6000, SEA_LEVEL - 1.5, 12, "#5f6f7a", "rim"), { ...SKINS.cliffStone, tile: 30 }));
  // Hidden settlement below the waterfall.
  const sy = -90;
  out.push(sk(box(0, sy - 30, RIM_Z - 70, 160, sy, 90, "#6f7f88", "settlement"), SKINS.cliffStone));
  out.push(sk(box(0, sy, RIM_Z - 60, 30, sy + 0.4, 30, "#c9d7dd", "settlement"), SKINS.caveFloor));
  const houses = [[-50, -40], [-30, -95], [40, -40], [55, -90], [-60, -80], [10, -100]];
  for (const [hx, hz] of houses) {
    out.push(sk(box(hx, sy, RIM_Z + hz, 12, sy + 7, 10, "#e3e8ea", "settlement"), SKINS.caveWall));
    out.push(sk(box(hx, sy + 7, RIM_Z + hz, 9, sy + 9, 7, "#3f8f9f", "settlement"), SKINS.caveRoof));
  }
  // The gate to the Drowned Colossus: an arch beyond the plaza where parties ready up.
  const gz = RIM_Z - 86;
  for (const side of [-1, 1]) out.push(sk(box(side * 4.5, sy, gz, 1.6, sy + 10, 1.6, "#4f6f7f", "settlement", "gate"), SKINS.caveArch));
  out.push(sk(box(0, sy + 10, gz, 11, sy + 11.5, 2, "#4f6f7f", "settlement", "gate"), SKINS.caveArch));
}

let cached: World | undefined;

export function getWorld(): World {
  if (cached) return cached;
  const r = rng(20261123);
  const boxes: Box[] = [];
  buildHarbour(boxes, r);
  buildIsles(boxes, r);
  buildRimAndSettlement(boxes);
  const dressing = dressOverworld(boxes);
  boxes.push(...dressing.colliders);
  cached = {
    boxes,
    areas: dressing.areas,
    spawn: { x: -60, y: 3.4, z: 30 },
    landmarks: [
      { name: "Training yard", position: { x: -60, y: 3.4, z: 30 } },
      { name: "Wind beacon", position: { x: 0, y: 44, z: -86 } },
      { name: "World's Edge", position: { x: 0, y: 0, z: RIM_Z } },
      { name: "Rim settlement", position: { x: 0, y: -90, z: RIM_Z - 60 } },
    ],
  };
  return cached;
}

/** Highest solid surface at or below `fromY` under (x, z), or -Infinity. */
export function groundHeightAt(world: World, x: number, z: number, fromY: number): number {
  let best = -Infinity;
  for (const b of world.boxes) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (b.maxY <= fromY + 0.01 && b.maxY > best) best = b.maxY;
  }
  if (z > RIM_Z && SEA_LEVEL > best && SEA_LEVEL <= fromY) best = SEA_LEVEL;
  return best;
}

/** Distance along a ray to the first box hit, or `maxDist` if nothing is hit. */
export function raycast(world: World, origin: Vec3, dir: Vec3, maxDist: number): number {
  let best = maxDist;
  for (const b of world.boxes) {
    let tmin = 0;
    let tmax = best;
    let hit = true;
    for (const [o, d, lo, hi] of [
      [origin.x, dir.x, b.minX, b.maxX],
      [origin.y, dir.y, b.minY, b.maxY],
      [origin.z, dir.z, b.minZ, b.maxZ],
    ] as const) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) { hit = false; break; }
      } else {
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { hit = false; break; }
      }
    }
    if (hit && tmin < best) best = tmin;
  }
  return best;
}
