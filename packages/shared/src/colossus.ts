/**
 * The Drowned Colossus: a party dungeon below the rim. Its arena is a separate
 * world (built the same way as the overworld) that only the dungeon room and
 * clients inside it use.
 */
import { RIM_Z } from "./constants.ts";
import type { Box, World } from "./world.ts";
import { collidersFor, dressArena, fitToBlock, place, type Placement } from "./dressing.ts";
import { buildHexField, hexColliders, hexPlacements } from "./hex.ts";
import { kd, kh } from "./catalogue.ts";

export const BossPhase = {
  /** Break the three anchor chains. */
  Anchors: 0,
  /** Survive the wave: go over it, skim under it, or shelter behind rock. */
  Wave: 1,
  /** Break the chest plate, then strike the exposed heart. */
  Heart: 2,
  /** The heart tears free: finish it in flight. */
  Flight: 3,
  Cleared: 4,
} as const;

export const COLOSSUS = {
  /** Where parties gather and ready up: an arch at the far side of the rim settlement. */
  gate: { x: 0, y: -90, z: RIM_Z - 84, radius: 9 },
  minLevel: 5,
  /** Downed players wait this long for a revive before recovering at their checkpoint. */
  downSeconds: 15,
  reviveSeconds: 2,
  reviveRange: 2.8,
  /** Health and armour at a full party of four; smaller parties scale down. */
  bossHp: 1200,
  armour: 380,
  anchorHp: 110,
  exposedSeconds: 10,
  /** The final, airborne phase starts at this fraction of health. */
  flightPhaseAt: 0.25,
  clearXp: 200,
  heart: { x: 0, y: 15, z: 3.6 },
  /** Players start (and recover after a wipe) here. */
  entry: { x: 0, y: 8.5, z: 84 },
  wave: { bandLow: 2.5, bandHigh: 15, seconds: 7, count: 2, damage: 25, push: 18 },
  slam: { radius: 9, telegraph: 2.5, damage: 30 },
  sweep: { radius: 28, ceiling: 18, telegraph: 2.2, damage: 20 },
} as const;

/** Health multiplier by party size: solo 0.55, four players 1.0. */
export function partyScale(size: number) {
  return 0.4 + 0.15 * Math.max(1, Math.min(4, size));
}

/** Models the client's Colossus rig is built from (kept by the asset build). */
export const COLOSSUS_RIG_MODELS = [kh("mountain_A"), kh("mountain_B"), kh("mountain_C"), kd("wall_cracked")];

const PLATFORM_RADIUS = 42;

/** Centres of the three anchor platforms (tops at y = 8). */
export const ANCHOR_PLATFORMS = [0, 1, 2].map((i) => {
  const a = (i * Math.PI * 2) / 3;
  return { x: Math.sin(a) * PLATFORM_RADIUS, y: 8, z: Math.cos(a) * PLATFORM_RADIUS };
});

/** Anchor posts sit on each platform's inner edge, chained to the Colossus. */
export const ANCHORS = ANCHOR_PLATFORMS.map((p) => {
  const k = (PLATFORM_RADIUS - 5) / PLATFORM_RADIUS;
  return { x: p.x * k, y: p.y, z: p.z * k };
});

/** A solid block of the arena, drawn with a stretched pack model (rock, plate). */
function block(boxes: Box[], placements: Placement[], model: string, cx: number, minY: number, cz: number, sx: number, maxY: number, sz: number) {
  const b: Box = { minX: cx - sx / 2, maxX: cx + sx / 2, minY, maxY, minZ: cz - sz / 2, maxZ: cz + sz / 2, color: "#000000", region: "arena", hidden: true };
  boxes.push(b);
  const p = fitToBlock(model, b.minX, minY, b.minZ, b.maxX, maxY, b.maxZ);
  if (p) placements.push(p);
}

/** A platform of hex columns (KayKit tiles) with its top at `top`. */
function platform(boxes: Box[], placements: Placement[], cx: number, cz: number, rx: number, rz: number, top: number, k: number) {
  const field = buildHexField({
    k, ox: cx, oz: cz, x0: cx - rx - k * 2, x1: cx + rx + k * 2, z0: cz - rz - k * 2, z1: cz + rz + k * 2, bottom: -12, region: "arena",
    height: (x, z) => (Math.hypot((x - cx) / rx, (z - cz) / rz) <= 1 ? top : null),
  });
  boxes.push(...hexColliders(field));
  placements.push(...hexPlacements(field));
}

let cached: World | undefined;

export function getColossusArena(): World {
  if (cached) return cached;
  const boxes: Box[] = [];
  const placements: Placement[] = [];

  // The Colossus itself: a giant of stone (solid, so a Lancer can dive onto its shoulders and head).
  for (const side of [-1, 1]) block(boxes, placements, kh("mountain_C"), side * 4.5, -20, -1, 4, 6, 5);
  block(boxes, placements, kh("mountain_A"), 0, 6, -1, 12, 9, 7);
  block(boxes, placements, kh("mountain_B"), 0, 9, -1, 11, 21, 7);
  block(boxes, placements, kh("mountain_A"), 0, 19, -1, 18, 23, 7);
  block(boxes, placements, kh("mountain_C"), 0, 23, -0.5, 5, 28, 5);
  // A broken ledge jutting out below the chest: dive onto it to strike the heart.
  block(boxes, placements, kh("rock_single_E"), 0, 9, 4.5, 8, 11, 4);

  // Anchor platforms, each with a sheltering rock.
  for (const p of ANCHOR_PLATFORMS) {
    platform(boxes, placements, p.x, p.z, 9.5, 9.5, p.y, 3);
    block(boxes, placements, kh("mountain_B"), p.x * 1.08, p.y, p.z * 1.08, 6, 13, 3);
  }
  // Entry platform where parties arrive and regroup.
  platform(boxes, placements, COLOSSUS.entry.x, COLOSSUS.entry.z, 13, 9, 8, 3);
  // Stepping stones between the platforms.
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    platform(boxes, placements, Math.sin(a) * 58, Math.cos(a) * 58, 1, 1, 3 + (i % 3) * 2, 2.5);
  }
  // Ruined pillars standing in the water around the arena.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const p = place(i % 3 ? kd("pillar") : kd("column"), Math.sin(a) * 75, -2, Math.cos(a) * 75, a, 2.2 + (i % 4) * 0.4);
    if (p) placements.push(p);
  }
  const terrain = {
    id: "terrain:arena", name: "Drowned Colossus", pack: "kaykit-medieval-hexagon", plannedPack: "kaykit-medieval-hexagon",
    center: { x: 0, y: 8, z: 0 }, loadRadius: Infinity, always: true, placements,
  };
  for (const p of placements) boxes.push(...collidersFor(p, "arena"));
  cached = {
    boxes,
    areas: [terrain, dressArena(boxes)],
    spawn: { ...COLOSSUS.entry },
    landmarks: [{ name: "Drowned Colossus", position: { x: 0, y: 0, z: 0 } }],
  };
  return cached;
}
