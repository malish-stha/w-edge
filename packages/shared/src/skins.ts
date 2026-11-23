/**
 * Every solid block in the world is drawn with a model from the asset packs
 * instead of a plain box. The block itself stays as (invisible) collision; its
 * skin is either one model stretched to fill it exactly, or a model repeated as
 * tiles over its outer shell (big cliffs and floors), so what players see is
 * what they can stand on.
 */
export interface Skin {
  /** "<pack>/<model>" */
  model: string;
  /** Tile size in metres; omit to stretch one model over the whole block. */
  tile?: number;
  /** Model for the top layer of tiles (e.g. grass over cliff). */
  top?: string;
  /**
   * A wall piece for the sides below the top layer (e.g. a rocky cliff face). It
   * sits on a cell's +z edge in its own space and is turned to face outward.
   */
  face?: string;
}

const nk = (n: string) => `kenney-nature-kit/${n}`;
const ck = (n: string) => `kenney-castle-kit/${n}`;
const pk = (n: string) => `kenney-pirate-kit/${n}`;
const cave = (n: string) => `kenney-modular-cave-kit/${n}`;
const dk = (n: string) => `kenney-modular-dungeon-kit/${n}`;

export const SKINS = {
  // Terrain (Nature Kit).
  cliff: { model: nk("cliff_block_rock"), tile: 12, face: nk("cliff_large_rock") },
  cliffStone: { model: nk("cliff_block_stone"), tile: 8, face: nk("cliff_large_stone") },
  grass: { model: nk("ground_grass"), tile: 8 },
  stonePath: { model: nk("path_stone"), tile: 4 },
  rockPillar: { model: nk("stone_tallB") },
  // First Harbour (Castle Kit).
  castleGround: { model: ck("ground"), tile: 8 },
  castleWall: { model: ck("wall"), tile: 6 },
  castleWallNarrow: { model: ck("wall-narrow"), tile: 4 },
  castleBuilding: { model: ck("tower-square-mid-windows"), tile: 6 },
  castleRoof: { model: ck("tower-square-top") },
  castleStep: { model: ck("wall") },
  beacon: { model: ck("tower-top") },
  shrineBase: { model: ck("tower-hexagon-base") },
  shrineTop: { model: ck("tower-hexagon-top") },
  // Docks and the cove (Pirate Kit).
  dock: { model: pk("structure-platform-dock"), tile: 4 },
  pirateRuin: { model: pk("tower-base") },
  // Rim settlement (Modular Cave Kit).
  caveFloor: { model: cave("template-floor"), tile: 6 },
  caveWall: { model: cave("template-wall"), tile: 5 },
  caveRoof: { model: cave("template-wall-top") },
  caveArch: { model: cave("template-wall-detail-a") },
  // Colossus arena (Modular Dungeon Kit).
  dungeonWall: { model: dk("template-wall"), tile: 8, top: dk("template-floor-big") },
  dungeonFloor: { model: dk("template-floor-big"), tile: 6 },
  dungeonBlock: { model: dk("template-wall") },
  dungeonDetail: { model: dk("template-wall-detail-a") },
} satisfies Record<string, Skin>;

/** A model placed in the world, with a (possibly non-uniform) scale. */
export interface SkinPlacement {
  model: string;
  x: number; y: number; z: number;
  rotY: number;
  sx: number; sy: number; sz: number;
}

interface BoxLike { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
type Bounds = Record<string, { min: [number, number, number]; max: [number, number, number] }>;

/** Stretch a model's bounding box onto a cell. Flat models (ground tiles) lie on the cell's top. */
function fit(models: Bounds, model: string, x0: number, y0: number, z0: number, w: number, h: number, d: number): SkinPlacement | null {
  const info = models[model];
  if (!info) return null;
  const size = [0, 1, 2].map((k) => info.max[k] - info.min[k]);
  const sx = w / Math.max(0.001, size[0]);
  const sz = d / Math.max(0.001, size[2]);
  if (size[1] < 0.1) {
    // A ground tile: lay it on top (slightly raised to avoid flicker).
    return { model, x: x0 - info.min[0] * sx, y: y0 + h + 0.02 - info.min[1], z: z0 - info.min[2] * sz, rotY: 0, sx, sy: 1, sz };
  }
  const sy = h / size[1];
  return { model, x: x0 - info.min[0] * sx, y: y0 - info.min[1] * sy, z: z0 - info.min[2] * sz, rotY: 0, sx, sy, sz };
}

/**
 * The models that draw one block. Tiled skins cover only the outer shell, and
 * skip cells hidden under the sea (`hiddenBelow`).
 */
export function skinPlacements(models: Bounds, b: BoxLike, skin: Skin, hiddenBelow = -Infinity): SkinPlacement[] {
  const w = b.maxX - b.minX, h = b.maxY - b.minY, d = b.maxZ - b.minZ;
  if (!skin.tile) {
    const p = fit(models, skin.model, b.minX, b.minY, b.minZ, w, h, d);
    return p ? [p] : [];
  }
  const info = models[skin.model];
  if (!info) return [];
  const flat = info.max[1] - info.min[1] < 0.1;
  const nx = Math.max(1, Math.round(w / skin.tile)), nz = Math.max(1, Math.round(d / skin.tile));
  const ny = flat ? 1 : Math.max(1, Math.round(h / skin.tile));
  const cw = w / nx, ch = h / ny, cd = d / nz;
  const out: SkinPlacement[] = [];
  const face = skin.face ? models[skin.face] : undefined;
  for (let iy = 0; iy < ny; iy++) {
    const cellTop = b.minY + (iy + 1) * ch;
    if (cellTop < hiddenBelow) continue;
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const top = iy === ny - 1;
        const shell = flat || top || ix === 0 || iz === 0 || ix === nx - 1 || iz === nz - 1;
        if (!shell) continue;
        const x0 = b.minX + ix * cw, y0 = b.minY + iy * ch, z0 = b.minZ + iz * cd;
        if (!top && face && skin.face) {
          // Side cells below the top: rock faces turned outward on each exposed side.
          if (iz === nz - 1) out.push(facePiece(skin.face, face, x0 + cw / 2, y0, b.maxZ, cw, ch, 0));
          if (iz === 0) out.push(facePiece(skin.face, face, x0 + cw / 2, y0, b.minZ, cw, ch, Math.PI));
          if (ix === nx - 1) out.push(facePiece(skin.face, face, b.maxX, y0, z0 + cd / 2, cd, ch, Math.PI / 2));
          if (ix === 0) out.push(facePiece(skin.face, face, b.minX, y0, z0 + cd / 2, cd, ch, -Math.PI / 2));
          continue;
        }
        const model = top && skin.top ? skin.top : skin.model;
        const p = fit(models, model, x0, y0, z0, cw, ch, cd);
        if (p) out.push(p);
      }
    }
  }
  return out;
}

/**
 * A wall piece whose outer surface lies on a block's side. `ex, ez` is the middle
 * of that side (at the cell's bottom height `y0`), `width` its width, `rotY` turns
 * the piece's +z outward.
 */
function facePiece(model: string, info: { min: [number, number, number]; max: [number, number, number] }, ex: number, y0: number, ez: number, width: number, height: number, rotY: number): SkinPlacement {
  const sx = width / Math.max(0.001, info.max[0] - info.min[0]);
  const sy = height / Math.max(0.001, info.max[1] - info.min[1]);
  const sz = sx; // keep the relief in proportion to the face width
  // The piece's outer surface is at local z = max[2]; put it on the block's side.
  const out = info.max[2] * sz;
  const cx = (info.max[0] + info.min[0]) / 2 * sx;
  return {
    model,
    x: ex - Math.sin(rotY) * out - Math.cos(rotY) * cx,
    y: y0 - info.min[1] * sy,
    z: ez - Math.cos(rotY) * out + Math.sin(rotY) * cx,
    rotY, sx, sy, sz,
  };
}

/** Every model a skin may use (the asset build converts these). */
export function allSkinModels(): string[] {
  const ids = new Set<string>();
  for (const s of Object.values(SKINS) as Skin[]) { ids.add(s.model); if (s.top) ids.add(s.top); if (s.face) ids.add(s.face); }
  return [...ids];
}
