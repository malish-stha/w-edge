/**
 * The Drowned Colossus: a party dungeon below the rim. Its arena is a separate
 * world (built the same way as the overworld) that only the dungeon room and
 * clients inside it use.
 */
import { RIM_Z } from "./constants.ts";
import type { Box, World } from "./world.ts";
import { SKINS, type Skin } from "./skins.ts";
import { dressArena } from "./dressing.ts";

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

function box(cx: number, minY: number, cz: number, sx: number, maxY: number, sz: number, color: string, skin: Skin = SKINS.dungeonBlock): Box {
  return { minX: cx - sx / 2, maxX: cx + sx / 2, minY, maxY, minZ: cz - sz / 2, maxZ: cz + sz / 2, color, region: "arena", skin };
}

let cached: World | undefined;

export function getColossusArena(): World {
  if (cached) return cached;
  const rock = "#5f6a70", rockDark = "#4a5358", moss = "#6f8f6a", hull = "#6b5a4c", plate = "#8d969e";
  const boxes: Box[] = [];

  // The Colossus itself (solid, so a Lancer can dive onto its shoulders and head).
  for (const side of [-1, 1]) boxes.push(box(side * 4.5, -20, -1, 4, 6, 5, hull));
  boxes.push(box(0, 6, -1, 12, 9, 7, hull));
  boxes.push(box(0, 9, -1, 11, 21, 7, hull));
  boxes.push(box(0, 19, -1, 18, 23, 7, plate));
  boxes.push(box(0, 23, -0.5, 5, 28, 5, hull));
  // A broken hull ledge jutting out below the chest: dive onto it to strike the heart.
  boxes.push(box(0, 9, 4.5, 8, 11, 4, plate));

  // Anchor platforms, each with a sheltering rock.
  for (const p of ANCHOR_PLATFORMS) {
    boxes.push(box(p.x, -30, p.z, 16, 7.6, 16, rock, SKINS.dungeonWall));
    boxes.push(box(p.x, 7.6, p.z, 15, 8, 15, moss, SKINS.grass));
    boxes.push(box(p.x * 1.08, 8, p.z * 1.08, 6, 13, 3, rockDark, SKINS.dungeonDetail));
  }
  // Entry platform where parties arrive and regroup.
  boxes.push(box(0, -30, 84, 24, 7.6, 16, rock, SKINS.dungeonWall));
  boxes.push(box(0, 7.6, 84, 23, 8, 15, moss, SKINS.grass));
  // Stepping stones between the platforms.
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    boxes.push(box(Math.sin(a) * 58, -20, Math.cos(a) * 58, 5, 3 + (i % 3) * 2, 5, rockDark));
  }
  cached = {
    boxes,
    areas: dressArena(boxes),
    spawn: { ...COLOSSUS.entry },
    landmarks: [{ name: "Drowned Colossus", position: { x: 0, y: 0, z: 0 } }],
  };
  return cached;
}
