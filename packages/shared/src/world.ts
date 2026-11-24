/**
 * The static world, generated deterministically so the server (collision) and the
 * client (rendering) build exactly the same thing from the same code.
 *
 * Collision is a set of axis-aligned boxes (cheap and deterministic). Nothing is
 * drawn as a box: terrain is laid out on a hex grid and drawn with KayKit hex
 * tiles (hex.ts), and buildings, walls, docks and props are models from the
 * asset packs, each with colliders that follow its shape (dressing.ts).
 */
import { RIM_Z, SEA_LEVEL } from "./constants.ts";
import {
  ISLES, KEEP_CLEAR, collidersFor, dressOverworld, fitToBlock, isleRadius, modelSize, place,
  type Collide, type DressedArea, type Placement,
} from "./dressing.ts";
import { buildHexField, hexCellAt, hexColliders, hexPlacements, type HexField, type HexFieldSpec } from "./hex.ts";
import { cave, ck, kd, kh, kkBuilding, pk, wk, type KkBuilding, type KkColour } from "./catalogue.ts";

export type Region = "harbour" | "isles" | "rim" | "settlement" | "arena";

export interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** Hex colour (only used if a box is ever drawn as a box). */
  color: string;
  region: Region;
  /** Landmark tag for the client (beacon, shrine, ...). */
  tag?: "beacon" | "shrine" | "training" | "dock" | "gate";
  /** Collision only: drawn by models (every box in the world is). */
  hidden?: boolean;
}

export interface Vec3 { x: number; y: number; z: number }

export interface Landmark { name: string; position: Vec3 }

export interface World {
  boxes: Box[];
  spawn: Vec3;
  landmarks: Landmark[];
  /** What to draw: terrain and set pieces (always shown) and props per area. */
  areas: DressedArea[];
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hidden = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, region: Region, tag?: Box["tag"]): Box =>
  ({ minX, minY, minZ, maxX, maxY, maxZ, color: "#000000", region, hidden: true, ...(tag ? { tag } : {}) });

const QUARTER = Math.PI / 2;
/** Terrain cells are 2·HEX_K metres across. */
const HEX_K = 4;

/** Collects one area's set pieces and their colliders. */
class Builder {
  placements: Placement[] = [];
  constructor(readonly boxes: Box[], readonly region: Region) {}
  add(p: Placement | null): Placement | null {
    if (!p) return null;
    this.placements.push(p);
    this.boxes.push(...collidersFor(p, this.region));
    return p;
  }
  model(model: string, x: number, groundY: number, z: number, rotY: number, scale: number, collide?: Collide) {
    return this.add(place(model, x, groundY, z, rotY, scale, collide));
  }
  field(field: HexField) {
    this.boxes.push(...hexColliders(field));
    this.placements.push(...hexPlacements(field));
  }
  area(id: string, name: string, pack: string, center: Vec3): DressedArea {
    return { id, name, pack, plannedPack: pack, center, loadRadius: Infinity, always: true, placements: this.placements };
  }
}

/** Wobbly outline: 1 at the base radius, ±~15% around it. */
function wobble(angle: number, seed: number) {
  return 1 + 0.07 * Math.sin(angle * 3 + seed) + 0.05 * Math.sin(angle * 5 + seed * 2.3) + 0.03 * Math.sin(angle * 9 + seed * 4.1);
}

function cellNoise(x: number, z: number, salt: number) {
  let h = Math.imul(Math.round(x * 10) * 374761393 + Math.round(z * 10) * 668265263 + salt, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A row of wall pieces from (x0, z0) to (x1, z1) along x or z, standing on groundY. */
function wallRun(b: Builder, model: string, x0: number, z0: number, x1: number, z1: number, groundY: number, pieceLength: number) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / pieceLength));
  const [mw] = modelSize(model);
  const scale = len / n / Math.max(0.01, mw);
  const rot = Math.abs(x1 - x0) >= Math.abs(z1 - z0) ? 0 : QUARTER;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    b.model(model, x0 + (x1 - x0) * t, groundY, z0 + (z1 - z0) * t, rot, scale, "shape");
  }
}

// --- First Harbour -----------------------------------------------------------------

const TOWN_Y = 3.2;
const SHELF_Y = 1.5;
const DECK_Y = SEA_LEVEL + 1.2;
const TERRACE_Y = 14;
const UPPER_Y = 24;
/** The beacon's walkable top (see ORIGIN_QUESTS). */
export const BEACON = { x: 0, z: -86 };

function harbourHeight(x: number, z: number): number | null {
  // The dock shelf along the south shore, a step below the streets.
  if (z > 86 && z < 126) {
    const half = 86 - 28 * Math.pow((z - 86) / 40, 2);
    return Math.abs(x) < half ? SHELF_Y : null;
  }
  const a = Math.atan2(z, x);
  const f = Math.pow(Math.abs(x) / 118, 2.4) + Math.pow(Math.abs(z) / 102, 2.4);
  if (f > wobble(a, 0.7)) return null;
  // The terrace below the beacon: two tiers.
  if (Math.abs(x) <= 30 && z <= -66) return Math.abs(x) <= 18 && z <= -76 ? UPPER_Y : TERRACE_Y;
  return TOWN_Y;
}

interface Zone { x0: number; x1: number; z0: number; z1: number }
const inZone = (x: number, z: number, r: number, zone: Zone) => x > zone.x0 - r && x < zone.x1 + r && z > zone.z0 - r && z < zone.z1 + r;
const TOWN_KEEP_OUT: Zone[] = [
  { x0: -84, x1: -36, z0: 8, z1: 52 }, // training yard
  { x0: -27, x1: 27, z0: -4, z1: 44 }, // plaza
  { x0: -8, x1: 8, z0: -66, z1: 0 }, // avenue to the terrace stairs
  { x0: -8, x1: 8, z0: 44, z1: 100 }, // avenue to the docks
  { x0: -36, x1: 36, z0: -110, z1: -58 }, // terrace
];

function buildHarbour(boxes: Box[]): DressedArea {
  const b = new Builder(boxes, "harbour");
  const r = rng(20261123);
  const field = buildHexField({
    k: HEX_K, ox: 0, oz: 0, x0: -130, x1: 130, z0: -115, z1: 130, bottom: SEA_LEVEL - 8, region: "harbour",
    height: harbourHeight,
  });
  b.field(field);
  const isTown = (x: number, z: number) => hexCellAt(field, x, z)?.top === TOWN_Y;

  // Steps from the streets down to the dock shelf.
  for (let i = 0; i < 3; i++) {
    const top = TOWN_Y - (i + 1) * ((TOWN_Y - SHELF_Y) / 3);
    boxes.push(hidden(-5, SHELF_Y - 1, 86.6 + i * 1.3, 5, top, 86.6 + (i + 1) * 1.3, "harbour"));
  }
  b.add(fitToBlock(kd("stairs_wide"), -5, SHELF_Y, 86.6, 5, TOWN_Y, 90.5, 0));

  // Training yard: a paved floor, low stone walls on three sides, targets and the shrine.
  boxes.push(hidden(-80, TOWN_Y, 12, -40, 3.4, 48, "harbour", "training"));
  for (let ix = 0; ix < 10; ix++) {
    for (let iz = 0; iz < 9; iz++) b.add(fitToBlock(kd("floor_tile_large"), -80 + ix * 4, TOWN_Y, 12 + iz * 4, -76 + ix * 4, 3.4, 16 + iz * 4, Math.floor(r() * 4) * QUARTER));
  }
  wallRun(b, kh("wall_straight"), -80.2, 12, -80.2, 48, 3.4, 4.5);
  wallRun(b, kh("wall_straight"), -80, 11.6, -40, 11.6, 3.4, 4.5);
  wallRun(b, kh("wall_straight"), -80, 48.4, -40, 48.4, 3.4, 4.5);
  for (const [x, z] of [[-80, 12], [-80, 48]]) b.model(kkBuilding("tower_base", "blue"), x, 3.4, z, 0, 4.2, "shape");
  for (let i = 0; i < 3; i++) b.model(kh("target"), -74 + i * 7, 3.4, 45.5, Math.PI, 5.5, "full");
  b.model(kh("weaponrack"), -77, 3.4, 20, QUARTER, 5, "full");
  b.model(kh("weaponrack"), -77, 3.4, 28, QUARTER, 5, "full");
  // The shrine: a carved pillar on a dais (the client adds its glow).
  boxes.push(hidden(-48, TOWN_Y, 27, -42, 4.2, 33, "harbour", "shrine"));
  b.add(fitToBlock(kd("floor_tile_large"), -48, 3.4, 27, -42, 4.2, 33));
  b.model(kd("pillar_decorated"), -45, 4.2, 30, 0, 1.55, "shape");

  // Plaza: paved, with a well in the middle and market stalls around it.
  boxes.push(hidden(-24, TOWN_Y, 0, 24, 3.3, 40, "harbour"));
  for (let ix = 0; ix < 12; ix++) {
    for (let iz = 0; iz < 10; iz++) b.add(fitToBlock(kd("floor_tile_large"), -24 + ix * 4, TOWN_Y, iz * 4, -20 + ix * 4, 3.3, 4 + iz * 4, Math.floor(r() * 4) * QUARTER));
  }
  b.model(kkBuilding("well", "blue"), 0, 3.3, 20, 0, 5, "shape");

  // Terrace stairs: 18 steps from the street (z = -48.8) up to the terrace face.
  const face = -65.8;
  const steps = 18, run = (-48.8 - face) / steps, rise = (TERRACE_Y - TOWN_Y) / steps;
  for (let i = 0; i < steps; i++) {
    boxes.push(hidden(-4, TOWN_Y, -48.8 - (i + 1) * run, 4, TOWN_Y + (i + 1) * rise, -48.8 - i * run, "harbour"));
  }
  // (The KayKit stairs climb toward -z as modelled.)
  b.add(fitToBlock(kd("stairs_wide"), -4.5, TOWN_Y, face, 4.5, TERRACE_Y, -48.8, 0));
  // A parapet along the terrace edge either side of the stairs, and towers at its corners.
  wallRun(b, kh("wall_straight"), -30, face + 0.6, -6, face + 0.6, TERRACE_Y, 4.5);
  wallRun(b, kh("wall_straight"), 6, face + 0.6, 30, face + 0.6, TERRACE_Y, 4.5);
  b.model(kkBuilding("tower_A", "blue"), -31, TERRACE_Y, face - 1, 0, 6, "shape");
  b.model(kkBuilding("tower_A", "blue"), 31, TERRACE_Y, face - 1, 0, 6, "shape");
  // East wing: the harbour chapel. West wing: the quarry (Stonekin quest).
  b.model(kkBuilding("church", "blue"), 24, TERRACE_Y, -84, 0, 7.5, "shape");
  for (const [x, z, s] of [[-26, -84, 6], [-20, -92, 5], [-27, -94, 4.5]] as const) b.model(kh("resource_stone"), x, TERRACE_Y, z, r() * 6, s, "full");
  b.model(kh("building_stage_A"), -25, TERRACE_Y, -72, 0, 5);

  // The wind beacon: a castle tower on the upper tier with a fire on top.
  const tower = 8.4;
  const base = b.model(ck("tower-square-base"), BEACON.x, UPPER_Y, BEACON.z, 0, tower, "shape");
  const midY = UPPER_Y + modelSize(ck("tower-square-base"), tower)[1];
  b.model(ck("tower-square-mid-windows"), BEACON.x, midY, BEACON.z, 0, tower, "shape");
  const topY = midY + modelSize(ck("tower-square-mid-windows"), tower)[1];
  b.model(ck("tower-square-top"), BEACON.x, topY, BEACON.z, 0, tower, "shape");
  boxes.push(hidden(BEACON.x - 3, topY - 0.5, BEACON.z - 3, BEACON.x + 3, topY, BEACON.z + 3, "harbour", "beacon"));
  b.model(kd("torch_lit"), BEACON.x, topY, BEACON.z, 0, 3.2);
  if (base) b.model(kh("flag_blue"), BEACON.x + 3.4, topY, BEACON.z + 3.4, 0, 4);

  // Town: buildings on a jittered grid, doors toward the plaza.
  const lots: Array<{ x: number; z: number; r: number }> = [];
  const pick = <T,>(list: readonly T[]) => list[Math.floor(r() * list.length)];
  for (let gx = -6; gx <= 6; gx++) {
    for (let gz = -6; gz <= 5; gz++) {
      const x = gx * 17 + (r() - 0.5) * 5;
      const z = gz * 17 + 4 + (r() - 0.5) * 5;
      const dPlaza = Math.hypot(x, z - 20);
      let type: KkBuilding;
      const roll = r();
      if (dPlaza < 46) type = roll < 0.35 ? "market" : roll < 0.6 ? "tavern" : roll < 0.75 ? "blacksmith" : "home_B";
      else if (x < -40 && z < 60) type = roll < 0.3 ? "barracks" : roll < 0.45 ? "archeryrange" : roll < 0.75 ? "home_A" : "home_B";
      else if (Math.hypot(x, z) > 88) type = roll < 0.3 ? "windmill" : roll < 0.5 ? "tower_B" : roll < 0.65 ? "lumbermill" : "home_A";
      else type = roll < 0.45 ? "home_A" : roll < 0.8 ? "home_B" : roll < 0.9 ? "tavern" : "blacksmith";
      const colour: KkColour = roll < 0.03 ? "green" : r() < 0.55 ? "blue" : r() < 0.6 ? "red" : "yellow";
      const model = kkBuilding(type, colour);
      const scale = type === "market" ? 7 : type === "windmill" || type === "tower_B" ? 8.5 : 8;
      const [w, , d] = modelSize(model, scale);
      if (!w) continue;
      const radius = Math.max(w, d) / 2 + 1.5;
      if (TOWN_KEEP_OUT.some((zone) => inZone(x, z, radius * 0.8, zone))) continue;
      if (KEEP_CLEAR.some((k) => Math.hypot(x - k.x, z - k.z) < k.r + radius * 0.6)) continue;
      // Whole footprint on flat street level, clear of other buildings.
      const hw = w / 2 + 1, hd = d / 2 + 1;
      if (![[0, 0], [-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]].every(([dx, dz]) => isTown(x + dx, z + dz))) continue;
      if (lots.some((l) => Math.hypot(l.x - x, l.z - z) < l.r + radius)) continue;
      // Face the plaza (or the nearest avenue for the outer streets), in quarter turns.
      const toward = Math.atan2(0 - x, 20 - z);
      const rot = Math.round(toward / QUARTER) * QUARTER;
      if (b.model(model, x, TOWN_Y, z, rot, scale, "shape")) lots.push({ x, z, r: radius });
    }
  }

  // Docks: four piers on the south shelf with boats tied up alongside.
  for (let i = 0; i < 4; i++) {
    const x = -54 + i * 36;
    boxes.push(hidden(x - 4, SEA_LEVEL - 0.1, 120, x + 4, DECK_Y, 160, "harbour", "dock"));
    // Plank sections on posts: the deck sits at 70% of the model's height, so the posts stand in the water.
    const deck = pk("structure-platform-dock");
    const scale = 8 / Math.max(0.1, modelSize(deck)[0]);
    const bottom = DECK_Y - modelSize(deck, scale)[1] * 0.7;
    for (let s = 0; s < 5; s++) b.model(deck, x, bottom, 124 + s * 8, s % 2 ? Math.PI : 0, scale);
    const boat = pick([wk("boat-sail-a"), wk("boat-sail-b"), wk("boat-fishing-small"), wk("ship-small")]);
    const [, bh] = modelSize(boat);
    b.model(boat, x + (i % 2 ? -9 : 9), SEA_LEVEL - 0.6, 145 + r() * 8, 0, (boat.endsWith("ship-small") ? 11 : 6) / Math.max(0.1, bh));
    b.model(kh("barrel"), x - 2.5, DECK_Y, 156, 0, 1.6);
    b.model(kh("crate_A_big"), x + 2.2, DECK_Y, 151, r(), 1.4);
  }
  // A lighthouse at the east end of the shelf, and watchtowers on the north shore.
  b.model(pk("tower-complete-large"), 64, SHELF_Y, 108, Math.PI, 17 / Math.max(0.1, modelSize(pk("tower-complete-large"))[1]), "shape");
  for (const [x, z] of [[-96, -40], [98, -36], [-62, -82], [66, -80]]) {
    const top = hexCellAt(field, x, z)?.top;
    if (top === TOWN_Y) b.model(kkBuilding("tower_B", "blue"), x, TOWN_Y, z, 0, 8, "shape");
  }

  return b.area("terrain:harbour", "First Harbour", "kaykit-medieval-hexagon", { x: 0, y: TOWN_Y, z: 0 });
}

// --- The Broken Isles ------------------------------------------------------------

/** Mountain peaks on some isles: [isle index, model, width (m), offset angle]. */
const PEAKS: Array<[number, string, number, number]> = [
  [1, kh("mountain_B_grass_trees"), 20, 2.2],
  [3, kh("mountain_C_grass"), 18, 4.0],
  [5, kh("mountain_A_grass_trees"), 18, 1.0],
  [8, kh("mountain_A"), 15, 5.5],
];

function buildIsles(boxes: Box[]): DressedArea[] {
  const out: DressedArea[] = [];
  for (const [index, isle] of ISLES.entries()) {
    const b = new Builder(boxes, "isles");
    const r = rng(9001 + index * 7919);
    const R = isleRadius(index);
    const top = isle.top + 0.8;
    const spec: HexFieldSpec = {
      k: HEX_K, ox: isle.x, oz: isle.z, x0: isle.x - R * 1.3, x1: isle.x + R * 1.3, z0: isle.z - R * 1.3, z1: isle.z + R * 1.3,
      bottom: SEA_LEVEL - 8, region: "isles",
      height: (x, z) => {
        const dx = x - isle.x, dz = z - isle.z;
        const d = Math.hypot(dx, dz);
        const edge = R * wobble(Math.atan2(dz, dx), index * 1.7 + 0.3);
        if (d > edge) return null;
        // Broken ledges around the rim: some edge columns drop a few metres.
        if (d > edge - HEX_K * 2.2) {
          const n = cellNoise(x, z, index);
          if (n < 0.28) return Math.max(SEA_LEVEL + 2, top - HEX_K * (1 + Math.floor(n * 7)));
        }
        return top;
      },
    };
    b.field(buildHexField(spec));

    // Broken shards: thin hex pillars standing in the sea around the isle.
    const shards = 2 + Math.floor(r() * 3);
    for (let i = 0; i < shards; i++) {
      const a = r() * Math.PI * 2;
      const dist = R + 10 + r() * 16;
      const sx = isle.x + Math.cos(a) * dist, sz = isle.z + Math.sin(a) * dist;
      const h = Math.round(isle.top * (0.3 + r() * 0.8));
      const cells = r() < 0.5 ? 1 : 3;
      b.field(buildHexField({
        k: HEX_K, ox: sx, oz: sz, x0: sx - 9, x1: sx + 9, z0: sz - 9, z1: sz + 9, bottom: SEA_LEVEL - 8, region: "isles",
        height: (x, z) => {
          const d = Math.hypot(x - sx, z - sz);
          if (d < 1) return h;
          return cells > 1 && d < HEX_K * 2.1 && cellNoise(x, z, i) < 0.6 ? h - HEX_K * (1 + Math.floor(cellNoise(x, z, 7) * 2)) : null;
        },
      }));
    }

    for (const [i, model, width, angle] of PEAKS) {
      if (i !== index) continue;
      const scale = width / Math.max(0.1, modelSize(model)[0]);
      const d = R * 0.58;
      b.model(model, isle.x + Math.cos(angle) * d, top, isle.z + Math.sin(angle) * d, angle, scale, "shape");
    }
    // A few clouds drifting above.
    for (let i = 0; i < 2; i++) {
      const cloud = r() < 0.5 ? kh("cloud_big") : kh("cloud_small");
      b.model(cloud, isle.x + (r() - 0.5) * 120, isle.top + 45 + r() * 50, isle.z + (r() - 0.5) * 120, r() * 6, 7 + r() * 6);
    }
    out.push(b.area(`terrain:isle-${index}`, `Isle ${index + 1}`, "kaykit-medieval-hexagon", { x: isle.x, y: top, z: isle.z }));
  }
  return out;
}

// --- The rim, the sea of cloud below it, and the settlement ---------------------------

const SETTLEMENT_Y = -90;

function buildRim(boxes: Box[]): DressedArea {
  const b = new Builder(boxes, "rim");
  const r = rng(777);
  // The rim itself: a long lip of rock the ocean pours over.
  boxes.push(hidden(-3000, -40, RIM_Z, 3000, SEA_LEVEL - 1.5, RIM_Z + 12, "rim"));
  // Rocks breaking the surface along the edge, so the falls read from far away.
  for (let x = -720; x <= 720; x += 34 + r() * 30) {
    const model = [kh("mountain_A"), kh("mountain_B"), kh("mountain_C")][Math.floor(r() * 3)];
    const width = 8 + r() * 14;
    const scale = width / Math.max(0.1, modelSize(model)[0]);
    b.model(model, x, SEA_LEVEL - 2 - r() * 3, RIM_Z + 4 + r() * 6, r() * 6, scale);
  }
  // A sea of cloud far below the edge.
  for (let i = 0; i < 90; i++) {
    const x = (r() * 2 - 1) * 1500;
    const z = RIM_Z - 120 - r() * 1500;
    const cloud = r() < 0.7 ? kh("cloud_big") : kh("cloud_small");
    b.model(cloud, x, -230 + r() * 50, z, r() * 6, 30 + r() * 30);
  }
  return b.area("terrain:rim", "World's Edge", "kaykit-medieval-hexagon", { x: 0, y: 0, z: RIM_Z });
}

function buildSettlement(boxes: Box[]): DressedArea {
  const b = new Builder(boxes, "settlement");
  const r = rng(4242);
  const cz = RIM_Z - 70;
  b.field(buildHexField({
    k: HEX_K, ox: 0, oz: cz, x0: -95, x1: 95, z0: cz - 60, z1: cz + 60, bottom: SETTLEMENT_Y - 40, region: "settlement",
    height: (x, z) => {
      const dx = x / 84, dz = (z - cz) / 50;
      return Math.hypot(dx, dz) < wobble(Math.atan2(dz, dx), 2.2) ? SETTLEMENT_Y : null;
    },
  }));
  // Houses around a small square.
  const houses: Array<[number, number, KkBuilding]> = [[-50, -40, "home_A"], [-30, -95, "home_B"], [40, -40, "tavern"], [55, -90, "home_B"], [-60, -80, "home_A"], [12, -102, "blacksmith"], [-22, -38, "market"]];
  for (const [hx, hz, type] of houses) {
    const rot = Math.round(Math.atan2(-hx, cz - (RIM_Z + hz)) / QUARTER) * QUARTER;
    b.model(kkBuilding(type, r() < 0.5 ? "green" : "blue"), hx, SETTLEMENT_Y, RIM_Z + hz, rot, 7.5, "shape");
  }
  b.model(kkBuilding("well", "green"), 6, SETTLEMENT_Y, cz + 4, 0, 4.5, "shape");
  // The gate to the Drowned Colossus: an arch beyond the square where parties ready up.
  const gz = RIM_Z - 86;
  for (const side of [-1, 1]) boxes.push(hidden(side * 4.5 - 0.8, SETTLEMENT_Y, gz - 0.8, side * 4.5 + 0.8, SETTLEMENT_Y + 10, gz + 0.8, "settlement", "gate"));
  boxes.push(hidden(-5.5, SETTLEMENT_Y + 10, gz - 1, 5.5, SETTLEMENT_Y + 11.5, gz + 1, "settlement", "gate"));
  b.model(cave("gate-rock"), 0, SETTLEMENT_Y, gz, 0, 13 / Math.max(0.1, modelSize(cave("gate-rock"))[0]));
  for (const side of [-1, 1]) {
    b.model(kd("torch_lit"), side * 7.5, SETTLEMENT_Y, gz + 2, 0, 2.2);
    b.model(kd("banner_patternA_blue"), side * 4.5, SETTLEMENT_Y + 4, gz + 1.2, 0, 1.6);
  }
  b.model(cave("gate-rock"), -70, SETTLEMENT_Y, cz - 10, QUARTER, 9 / Math.max(0.1, modelSize(cave("gate-rock"))[1]), "shape");
  return b.area("terrain:settlement", "Rim settlement", "kenney-modular-cave-kit", { x: 0, y: SETTLEMENT_Y, z: cz });
}

let cached: World | undefined;

export function getWorld(): World {
  if (cached) return cached;
  const boxes: Box[] = [];
  const areas: DressedArea[] = [
    buildHarbour(boxes),
    ...buildIsles(boxes),
    buildRim(boxes),
    buildSettlement(boxes),
  ];
  const dressing = dressOverworld(boxes);
  boxes.push(...dressing.colliders);
  cached = {
    boxes,
    areas: [...areas, ...dressing.areas],
    spawn: { x: -60, y: 3.4, z: 30 },
    landmarks: [
      { name: "Training yard", position: { x: -60, y: 3.4, z: 30 } },
      { name: "Wind beacon", position: { x: BEACON.x, y: 44, z: BEACON.z } },
      { name: "World's Edge", position: { x: 0, y: 0, z: RIM_Z } },
      { name: "Rim settlement", position: { x: 0, y: SETTLEMENT_Y, z: RIM_Z - 60 } },
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
