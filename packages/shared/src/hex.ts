/**
 * Hex terrain: islands, the harbour and the settlement shelf are laid out on a
 * hex grid and drawn with KayKit Medieval Hexagon tiles (a grass-topped tile on
 * every cell, and a stretched dirt column under cells at an edge). Collision is
 * built from the same cells, so what you see is what you stand on.
 *
 * Cells are "pointy" along z, like the KayKit tiles: rows run along x, and every
 * other row is shifted half a cell. For collision each cell becomes a brick of
 * width 2k and depth √3·k; bricks of neighbouring rows interlock exactly, and
 * runs of equal height in a row merge into one box.
 */
import type { Placement } from "./dressing.ts";
import type { Box, Region } from "./world.ts";

export const HEX_GRASS = "kaykit-medieval-hexagon/hex_grass";
export const HEX_SIDE = "kaykit-medieval-hexagon/hex_grass_bottom";
const SQRT3 = Math.sqrt(3);

export interface HexCell {
  i: number; j: number;
  x: number; z: number;
  /** Walkable surface height. */
  top: number;
  /** Top tile model (default: grass). */
  tile?: string;
}

export interface HexFieldSpec {
  /** Metres per tile unit: cells are 2k wide. */
  k: number;
  /** Grid origin (a cell centre). */
  ox: number; oz: number;
  /** Area scanned for cells. */
  x0: number; x1: number; z0: number; z1: number;
  /** Bottom of the columns (hidden under the sea or in the void). */
  bottom: number;
  region: Region;
  /** Cell top at a cell centre, or null for no cell. */
  height(x: number, z: number): number | null;
  /** Top tile for a cell (default grass). */
  tile?(x: number, z: number, top: number): string | undefined;
}

export interface HexField {
  spec: HexFieldSpec;
  cells: Map<string, HexCell>;
}

const key = (i: number, j: number) => `${i},${j}`;

export function hexCentre(spec: Pick<HexFieldSpec, "k" | "ox" | "oz">, i: number, j: number) {
  return { x: spec.ox + (i + (j & 1) * 0.5) * 2 * spec.k, z: spec.oz + j * SQRT3 * spec.k };
}

/** The six neighbours of a cell (odd rows are shifted +half a cell). */
export function hexNeighbours(i: number, j: number): Array<[number, number]> {
  const o = j & 1;
  return [
    [i - 1, j], [i + 1, j],
    [i - 1 + o, j - 1], [i + o, j - 1],
    [i - 1 + o, j + 1], [i + o, j + 1],
  ];
}

export function buildHexField(spec: HexFieldSpec): HexField {
  const cells = new Map<string, HexCell>();
  const w = 2 * spec.k, dz = SQRT3 * spec.k;
  const j0 = Math.floor((spec.z0 - spec.oz) / dz) - 1, j1 = Math.ceil((spec.z1 - spec.oz) / dz) + 1;
  const i0 = Math.floor((spec.x0 - spec.ox) / w) - 1, i1 = Math.ceil((spec.x1 - spec.ox) / w) + 1;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const { x, z } = hexCentre(spec, i, j);
      const top = spec.height(x, z);
      if (top === null) continue;
      cells.set(key(i, j), { i, j, x, z, top, tile: spec.tile?.(x, z, top) });
    }
  }
  return { spec, cells };
}

/** Collision: one brick per cell, merged into runs of equal height along each row. */
export function hexColliders(field: HexField): Box[] {
  const { k, bottom, region } = field.spec;
  const half = (SQRT3 * k) / 2;
  const rows = new Map<number, HexCell[]>();
  for (const c of field.cells.values()) {
    const row = rows.get(c.j) ?? [];
    row.push(c);
    rows.set(c.j, row);
  }
  const out: Box[] = [];
  for (const row of rows.values()) {
    row.sort((a, b) => a.i - b.i);
    let start = 0;
    for (let n = 1; n <= row.length; n++) {
      const run = row[start];
      const next = row[n];
      if (next && next.i === row[n - 1].i + 1 && next.top === run.top) continue;
      const last = row[n - 1];
      out.push({
        minX: run.x - k, maxX: last.x + k,
        minZ: run.z - half, maxZ: run.z + half,
        minY: bottom, maxY: run.top,
        color: "#000000", region, hidden: true,
      });
      start = n;
    }
  }
  return out;
}

/** Deterministic 0..1 noise for a cell (tile rotation and variation). */
function cellRand(i: number, j: number, salt = 0) {
  let h = Math.imul(i * 374761393 + j * 668265263 + salt * 2246822519, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Visuals: a top tile on every cell and, where a cell stands above a neighbour
 * (or at the edge), the dirt column stretched down to what's below.
 */
export function hexPlacements(field: HexField, topModel = HEX_GRASS, sideModel = HEX_SIDE): Placement[] {
  const { k, bottom } = field.spec;
  const out: Placement[] = [];
  for (const c of field.cells.values()) {
    const rot = Math.floor(cellRand(c.i, c.j) * 6) * (Math.PI / 3);
    out.push({ model: c.tile ?? topModel, x: c.x, y: c.top, z: c.z, rotY: rot, sx: k, sy: k, sz: k });
    let below = Infinity;
    for (const [ni, nj] of hexNeighbours(c.i, c.j)) {
      const n = field.cells.get(key(ni, nj));
      below = Math.min(below, n ? n.top - k : bottom);
    }
    const colTop = c.top - k;
    const colBottom = Math.max(bottom, Math.min(below, colTop));
    if (colTop - colBottom > 0.05) {
      out.push({ model: sideModel, x: c.x, y: colTop, z: c.z, rotY: rot, sx: k, sy: colTop - colBottom, sz: k });
    }
  }
  return out;
}

/** Height of the cell under (x, z), if any. */
export function hexCellAt(field: HexField, x: number, z: number): HexCell | null {
  const { k, ox, oz } = field.spec;
  const dz = SQRT3 * k;
  const j = Math.round((z - oz) / dz);
  let best: HexCell | null = null, bestD = Infinity;
  for (const jj of [j - 1, j, j + 1]) {
    const i = Math.round((x - ox) / (2 * k) - (jj & 1) * 0.5);
    for (const ii of [i - 1, i, i + 1]) {
      const c = field.cells.get(key(ii, jj));
      if (!c) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  return best && bestD <= k * 1.16 ? best : null;
}
