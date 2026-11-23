/**
 * Combat tuning shared by server (resolution) and client (HUD, effects).
 * Every hit has separate HEALTH damage and GUARD damage: guard measures how
 * close an enemy is to being staggered, so a heavy hitter can break a guard
 * without taking a huge share of health.
 */

export const PLAYER_MAX_HP = 100;
/** Seconds a downed player waits before recovering at their safe spot. */
export const DOWN_SECONDS = 4;
/** Out-of-combat health regeneration. */
export const HP_REGEN = 6;
export const HP_REGEN_DELAY = 5;

export interface AttackProfile {
  /** Reach in metres from the player's chest. */
  reach: number;
  /** Half-angle of the hit cone in radians (ranged attacks use a narrow ray). */
  halfAngle: number;
  ranged: boolean;
  maxTargets: number;
  health: [number, number, number];
  guard: [number, number, number];
}

export const ATTACKS: Record<string, AttackProfile> = {
  saber: { reach: 3.0, halfAngle: 1.05, ranged: false, maxTargets: 3, health: [12, 12, 22], guard: [10, 10, 22] },
  archer: { reach: 45, halfAngle: 0.05, ranged: true, maxTargets: 1, health: [10, 10, 18], guard: [4, 4, 10] },
  vanguard: { reach: 2.6, halfAngle: 0.8, ranged: false, maxTargets: 3, health: [8, 8, 14], guard: [20, 20, 38] },
  lancer: { reach: 3.6, halfAngle: 0.45, ranged: false, maxTargets: 2, health: [11, 11, 20], guard: [8, 8, 18] },
};

/** Lancer: Horizon Break. A steep dive cracks armour; a shallow pass pierces a line of enemies. */
export const HORIZON_BREAK = {
  impactRadius: 5.5,
  impactHealth: (speed: number) => 8 + speed * 0.7,
  impactGuard: (speed: number, steep: number) => speed * (0.6 + steep * 1.4),
  /** Flying faster than this through enemies hits them. */
  pierceSpeed: 24,
  pierceRadius: 2.4,
  pierceHealth: (speed: number) => 10 + speed * 0.3,
  pierceGuard: 10,
  /** Each enemy can be pierced once per this many seconds. */
  pierceCooldown: 1,
};

export interface MantleSkill { name: string; cooldown: number; blurb: string }

/** Key 1 once the mantle is awakened at the shrine. */
export const MANTLE_SKILLS: Record<string, MantleSkill> = {
  tide: { name: "Undertow", cooldown: 8, blurb: "Drag nearby enemies together in front of you and interrupt their attacks." },
  storm: { name: "Chain Lightning", cooldown: 6, blurb: "Strike the nearest enemy; lightning jumps to two more." },
  titan: { name: "Titan Slam", cooldown: 8, blurb: "Slam the ground: heavy stagger to everything around you." },
};

export const SHRINE = { x: -45, y: 3.4, z: 30, radius: 6 };

// --- Enemies -----------------------------------------------------------------

export const EnemyState = {
  Idle: 0,
  Chase: 1,
  /** Winding up an attack: the warning players react to. */
  Telegraph: 2,
  Attack: 3,
  /** Guard broken: takes extra damage, can't act. */
  Stagger: 4,
  /** Hullbreaker after a charge: back exposed. */
  Exposed: 5,
  Dead: 6,
} as const;

export interface EnemyKind {
  name: string;
  hp: number;
  guard: number;
  xp: number;
  speed: number;
  aggroRange: number;
  respawnSeconds: number;
}

export const ENEMY_KINDS: Record<string, EnemyKind> = {
  wretch: { name: "Reef Wretch", hp: 45, guard: 20, xp: 12, speed: 5, aggroRange: 18, respawnSeconds: 20 },
  hullbreaker: { name: "Hullbreaker", hp: 220, guard: 90, xp: 60, speed: 3, aggroRange: 22, respawnSeconds: 45 },
  /** Training-yard target: never attacks, resets when left alone. */
  dummy: { name: "Training dummy", hp: 400, guard: 60, xp: 0, speed: 0, aggroRange: 0, respawnSeconds: 0 },
};

/** Rough body sizes for hit tests and effects. */
export const ENEMY_SIZE: Record<string, { radius: number; height: number }> = {
  wretch: { radius: 0.8, height: 1.1 },
  hullbreaker: { radius: 1.6, height: 2.8 },
  dummy: { radius: 0.6, height: 1.9 },
};

// --- Effects the server broadcasts (one batch per tick) ------------------------

export type Fx =
  /** Damage to an enemy. `weak`: hit a weak point; `blocked`: hit a shield; `broke`: guard broken. */
  | { t: "hit"; x: number; y: number; z: number; n: number; weak?: 1; blocked?: 1; broke?: 1 }
  /** Damage to a player. */
  | { t: "hurt"; id: string; n: number }
  | { t: "shot"; from: [number, number, number]; to: [number, number, number] }
  | { t: "ring"; x: number; y: number; z: number; r: number; kind: "impact" | "tide" | "titan" | "shrine" | "telegraph" }
  | { t: "bolt"; pts: number[] }
  | { t: "down"; id: string }
  | { t: "kill"; x: number; y: number; z: number; xp: number }
  | { t: "level"; id: string; level: number };

// --- Progression ---------------------------------------------------------------

/** Total XP needed to reach each level (index = level - 1). Proposed playtest values. */
export const LEVEL_XP = [0, 40, 120, 260, 450];
export const MAX_LEVEL = LEVEL_XP.length;

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < LEVEL_XP.length; i++) if (xp >= LEVEL_XP[i]) level = i + 1;
  return level;
}

/** Progress through the current level, 0..1 (1 at max level). */
export function levelProgress(xp: number): number {
  const level = levelForXp(xp);
  if (level >= MAX_LEVEL) return 1;
  const from = LEVEL_XP[level - 1], to = LEVEL_XP[level];
  return (xp - from) / (to - from);
}
