import { MONSTER_MODELS } from "./monster-models.ts";

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

/** Key 2: second mantle combat skill. */
export const MANTLE_SKILLS_2: Record<string, MantleSkill> = {
  tide: { name: "Focused Surge", cooldown: 7, blurb: "Fire a high-pressure current forward that cracks guard and pushes enemies." },
  storm: { name: "Static Burst", cooldown: 7, blurb: "Pulse storm energy to apply Static Marks that detonate on hit." },
  titan: { name: "Boulder Hurl", cooldown: 7, blurb: "Hurl heavy debris toward your target for strong guard damage." },
};

/** Key 3: mantle exploration & movement ability. */
export const MANTLE_EXPLORE: Record<string, MantleSkill> = {
  tide: { name: "Surface Ride", cooldown: 6, blurb: "Surge across the water or air, restoring stamina." },
  storm: { name: "Updraft", cooldown: 6, blurb: "Call a rising wind column beneath you and nearby allies." },
  titan: { name: "Peak Leap", cooldown: 6, blurb: "Leap high across cliffs and peaks, smashing on takeoff." },
};

/** Key 4: mantle ultimate (requires 100 ultimate charge). */
export const MANTLE_ULTIMATES: Record<string, { name: string; blurb: string }> = {
  tide: { name: "Riptide", blurb: "Raise a massive wave that drags enemies in, heals allies, and launches them forward." },
  storm: { name: "Tempest Crown", blurb: "Detonate all static marks; for 8 s all allied hits arc lightning." },
  titan: { name: "Colossal Form", blurb: "Grow to giant size for 8 s; strikes deal heavy stagger and massive guard damage." },
};

export interface MantlePathDef {
  id: string;
  mantle: "storm" | "tide" | "titan";
  name: string;
  effect: string;
}

export const MANTLE_PATHS: MantlePathDef[] = [
  { id: "arc", mantle: "storm", name: "Arc Conductor", effect: "Chain Lightning jumps to 5 foes and Tempest Crown lasts 12 s." },
  { id: "overcharge", mantle: "storm", name: "Overcharge", effect: "Static Burst applies 2 marks and static detonations deal double damage." },
  { id: "maelstrom", mantle: "tide", name: "Wide Maelstrom", effect: "Undertow and Riptide pull +50% wider and Undertow mends nearby allies." },
  { id: "breaker", mantle: "tide", name: "Focused Breaker", effect: "Focused Surge and Undertow deal +60% guard damage and boost allies." },
  { id: "juggernaut", mantle: "titan", name: "Juggernaut", effect: "Titan Slam and Colossal Form deal +50% stagger and last 11 s." },
  { id: "catapult", mantle: "titan", name: "Seismic Hurl", effect: "Boulder Hurl explodes in a 7 m blast and Peak Leap slams nearby foes." },
];

export function pathsForMantle(mantle: string): MantlePathDef[] {
  return MANTLE_PATHS.filter((p) => p.mantle === mantle);
}

export function defaultMantlePathFor(mantle: string): string {
  return pathsForMantle(mantle)[0]?.id ?? "";
}

export interface ClassMechanic {
  name: string;
  control: string;
  blurb: string;
}

export const CLASS_MECHANICS: Record<string, ClassMechanic> = {
  saber: { name: "Return Stroke", control: "RMB", blurb: "Parry an incoming attack to capture a fragment, then press RMB again to release it." },
  archer: { name: "Crossfire", control: "RMB", blurb: "Plant arrows in terrain with RMB, reposition, then fire (LMB) to strike from two angles." },
  vanguard: { name: "Breakwater", control: "RMB", blurb: "Hold RMB to guard and plant your shield; catch a hit and release to launch allies & disrupt foes." },
  lancer: { name: "Horizon Break", control: "Dive / RMB", blurb: "Steep dives crack armour; fast passes pierce lines. RMB vaults off nearby foes or shields." },
};

export interface TechniqueDef {
  id: string;
  classId: "saber" | "archer" | "lancer" | "vanguard";
  name: string;
  effect: string;
  rewards: string;
  mantleNames: Record<"storm" | "tide" | "titan", string>;
}

export const TECHNIQUES: TechniqueDef[] = [
  // Saber
  {
    id: "riposte-dash", classId: "saber", name: "Riposte Dash",
    effect: "Release the captured fragment as a dash through the target.",
    rewards: "Staying close and countering immediately.",
    mantleNames: { storm: "Arc Riposte", tide: "Riptide Lunge", titan: "Breaker Dash" },
  },
  {
    id: "held-edge", classId: "saber", name: "Held Edge",
    effect: "Store up to two fragments and release them together as one heavy strike.",
    rewards: "Patience and saving damage for an exposed phase.",
    mantleNames: { storm: "Twin Charge", tide: "Swell Edge", titan: "Crushing Edge" },
  },
  {
    id: "cover-parry", classId: "saber", name: "Cover Parry",
    effect: "Parry an attack aimed at a nearby ally.",
    rewards: "Staying near teammates and reading attacks on them.",
    mantleNames: { storm: "Grounding Guard", tide: "Eddy Parry", titan: "Aegis Intercept" },
  },
  // Archer
  {
    id: "twin-line", classId: "archer", name: "Twin Line",
    effect: "Link two planted arrows so the trigger shot crosses between them.",
    rewards: "Moving around the arena to find shooting angles.",
    mantleNames: { storm: "Static Link", tide: "Current Line", titan: "Anchor Line" },
  },
  {
    id: "net", classId: "archer", name: "Net",
    effect: "Link up to three planted arrows into a trap.",
    rewards: "Predicting where enemies will move.",
    mantleNames: { storm: "Storm Net", tide: "Whirlpool Snare", titan: "Pinning Net" },
  },
  {
    id: "relay", classId: "archer", name: "Relay",
    effect: "A teammate's heavy attack triggers a planted arrow.",
    rewards: "Timing shots around the party.",
    mantleNames: { storm: "Thunder Relay", tide: "Surge Relay", titan: "Quake Relay" },
  },
  // Lancer
  {
    id: "long-dive", classId: "lancer", name: "Long Dive",
    effect: "Steeper dives keep building momentum for a bigger armour-cracking impact.",
    rewards: "Climbing high before committing.",
    mantleNames: { storm: "Skyfall Bolt", tide: "Plunge Surge", titan: "Meteor Dive" },
  },
  {
    id: "skimmer", classId: "lancer", name: "Skimmer",
    effect: "Shallow passes keep part of their momentum, so passes can chain.",
    rewards: "Staying low and constantly moving.",
    mantleNames: { storm: "Spark Skim", tide: "Wave Skim", titan: "Ram Skim" },
  },
  {
    id: "vault", classId: "lancer", name: "Vault",
    effect: "Convert momentum into a vault off an enemy or an ally's shield, then strike again.",
    rewards: "Using teammates' setups.",
    mantleNames: { storm: "Gale Vault", tide: "Crest Vault", titan: "Sky Vault" },
  },
  // Vanguard
  {
    id: "bulwark", classId: "vanguard", name: "Bulwark",
    effect: "The planted shield lasts longer and covers more allies.",
    rewards: "Holding a position for the party.",
    mantleNames: { storm: "Storm Bastion", tide: "Tide Wall", titan: "Iron Bulwark" },
  },
  {
    id: "recoil", classId: "vanguard", name: "Recoil",
    effect: "Release stored force as a forward shockwave that damages guard.",
    rewards: "Aggressive timing.",
    mantleNames: { storm: "Thunder Recoil", tide: "Breaker Surge", titan: "Seismic Recoil" },
  },
  {
    id: "launch-pad", classId: "vanguard", name: "Launch Pad",
    effect: "Released force launches allies further and gives them a brief boost.",
    rewards: "Setting up a teammate's dive.",
    mantleNames: { storm: "Updraft Pad", tide: "Geyser Launch", titan: "Catapult Guard" },
  },
];

export function techniquesForClass(classId: string): TechniqueDef[] {
  return TECHNIQUES.filter((t) => t.classId === classId);
}

export function defaultTechniqueFor(classId: string): string {
  return techniquesForClass(classId)[0]?.id ?? "";
}

export function techniqueDisplay(id: string, classId: string, mantle: string): { def: TechniqueDef | undefined; title: string } {
  const list = techniquesForClass(classId);
  const def = list.find((t) => t.id === id) ?? list[0];
  if (!def) return { def: undefined, title: "Signature technique" };
  const m = mantle as "storm" | "tide" | "titan";
  const mantleName = def.mantleNames[m];
  return { def, title: mantleName ? `${mantleName} (${def.name})` : def.name };
}

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

export type EnemyAi = "wretch" | "hullbreaker" | "flyer" | "sea";

export interface EnemyKind {
  name: string;
  hp: number;
  guard: number;
  xp: number;
  speed: number;
  aggroRange: number;
  respawnSeconds: number;
  /** Which GLB in /monsters/<model>.glb renders this kind (absent = procedural rig). */
  model?: string;
  ai?: EnemyAi;
}

export const ENEMY_KINDS: Record<string, EnemyKind> = {
  wretch: { name: "Reef Wretch", hp: 45, guard: 20, xp: 12, speed: 5, aggroRange: 18, respawnSeconds: 20, model: "glub", ai: "wretch" },
  hullbreaker: { name: "Hullbreaker", hp: 220, guard: 90, xp: 60, speed: 3, aggroRange: 22, respawnSeconds: 45, model: "ember-golem", ai: "hullbreaker" },
  /** Training-yard target: never attacks, resets when left alone. */
  dummy: { name: "Training dummy", hp: 400, guard: 60, xp: 0, speed: 0, aggroRange: 0, respawnSeconds: 0 },
  /** Drowned Colossus: the chain anchors (phase 1) and the heart (phases 3–4). Run by the dungeon. */
  anchor: { name: "Anchor", hp: 110, guard: 0, xp: 0, speed: 0, aggroRange: 0, respawnSeconds: 0 },
  heart: { name: "Drowned Colossus", hp: 1200, guard: 380, xp: 0, speed: 0, aggroRange: 0, respawnSeconds: 0 },
};

/** Rough body sizes for hit tests and effects. */
export const ENEMY_SIZE: Record<string, { radius: number; height: number }> = {
  wretch: { radius: 0.8, height: 1.1 },
  hullbreaker: { radius: 1.6, height: 2.8 },
  dummy: { radius: 0.6, height: 1.9 },
  anchor: { radius: 1.2, height: 3.5 },
  heart: { radius: 4.2, height: 8 },
};

const FLYERS = new Set([
  "ashwing-drake", "dragon", "dragon-evolved", "armabee", "armabee-evolved",
  "bat", "birb", "birb-2", "pigeon", "pigeon-2", "ghost", "ghost-skull",
  "alpaking", "alpaking-evolved", "hywirl",
]);
const SEA = new Set([
  "anglerfish", "dolphin", "fish", "fish-1", "fish-2", "fish-3",
  "jellyfish", "manta-ray", "shark", "shark-2", "whale",
]);
const BRUTES = new Set([
  "yeti", "yeti-2", "rhino", "hippo", "dino", "orc", "orc-2", "orc-skull",
  "demon", "demon-2", "blue-demon", "goleling-evolved", "mushroom-king",
  "mushnub-evolved", "glub-evolved", "tribal", "tribal-2",
]);

function displayName(id: string): string {
  return id.replace(/-\d+$/, "").split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

for (const id of Object.keys(MONSTER_MODELS)) {
  if (id === "glub" || id === "ember-golem") continue; // mapped to wretch & hullbreaker
  if (FLYERS.has(id)) {
    const boss = id === "ashwing-drake" || id === "dragon-evolved";
    ENEMY_KINDS[id] = {
      name: displayName(id),
      hp: boss ? 240 : 65,
      guard: boss ? 95 : 25,
      xp: boss ? 70 : 18,
      speed: boss ? 7.5 : 6.5,
      aggroRange: boss ? 26 : 20,
      respawnSeconds: boss ? 45 : 25,
      model: id,
      ai: "flyer",
    };
    ENEMY_SIZE[id] = boss ? { radius: 1.8, height: 3.0 } : { radius: 0.9, height: 1.4 };
  } else if (SEA.has(id)) {
    const big = id === "whale" || id === "shark" || id === "shark-2" || id === "manta-ray";
    ENEMY_KINDS[id] = {
      name: displayName(id),
      hp: big ? 160 : 50,
      guard: big ? 60 : 20,
      xp: big ? 40 : 14,
      speed: big ? 6 : 5,
      aggroRange: 20,
      respawnSeconds: 25,
      model: id,
      ai: "sea",
    };
    ENEMY_SIZE[id] = big ? { radius: 1.5, height: 2.2 } : { radius: 0.8, height: 1.2 };
  } else if (BRUTES.has(id)) {
    ENEMY_KINDS[id] = {
      name: displayName(id),
      hp: 160,
      guard: 65,
      xp: 45,
      speed: 3.6,
      aggroRange: 20,
      respawnSeconds: 35,
      model: id,
      ai: "hullbreaker",
    };
    ENEMY_SIZE[id] = { radius: 1.3, height: 2.3 };
  } else {
    ENEMY_KINDS[id] = {
      name: displayName(id),
      hp: 55,
      guard: 22,
      xp: 15,
      speed: 5.2,
      aggroRange: 18,
      respawnSeconds: 20,
      model: id,
      ai: "wretch",
    };
    ENEMY_SIZE[id] = { radius: 0.85, height: 1.35 };
  }
}

// --- Effects the server broadcasts (one batch per tick) ------------------------

export type Fx =
  /** Damage to an enemy. `weak`: hit a weak point; `blocked`: hit a shield; `broke`: guard broken. */
  | { t: "hit"; x: number; y: number; z: number; n: number; weak?: 1; blocked?: 1; broke?: 1 }
  /** Damage to a player. */
  | { t: "hurt"; id: string; n: number }
  | { t: "shot"; from: [number, number, number]; to: [number, number, number] }
  | { t: "ring"; x: number; y: number; z: number; r: number; kind: "impact" | "tide" | "titan" | "shrine" | "telegraph" | "revive" }
  | { t: "bolt"; pts: number[] }
  | { t: "down"; id: string }
  | { t: "kill"; x: number; y: number; z: number; xp: number }
  | { t: "level"; id: string; level: number }
  | { t: "parry"; id: string; stored: number }
  | { t: "pin"; x: number; y: number; z: number; kind: "arrow" | "shield" }
  | { t: "crossfire"; pts: number[]; mantle: string }
  | { t: "breakwater"; x: number; y: number; z: number; r: number; mantle: string }
  | { t: "vault"; id: string };

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
