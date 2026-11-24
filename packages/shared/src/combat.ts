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

/**
 * The bestiary of the Broken Isles: which monster model plays which creature,
 * how tough it is (tier 1 = starter isle … 4 = the far isles), and how it fights.
 * Each isle has its own residents (see ISLE_SPAWNS in the server), so the danger
 * rises the further you fly from First Harbour.
 */
export interface Beast {
  model: string;
  name: string;
  ai: EnemyAi;
  tier: 1 | 2 | 3 | 4;
  /** Body height in metres (defaults by AI). */
  height?: number;
}

export const BESTIARY: Record<string, Beast> = {
  // Wretch isle (tier 1)
  slime: { model: "slime", name: "Tidepool Slime", ai: "wretch", tier: 1, height: 0.9 },
  "green-blob": { model: "green-blob", name: "Kelp Blob", ai: "wretch", tier: 1, height: 1.2 },
  // Pinecrest and the castaway camp (tier 2)
  mushnub: { model: "mushnub", name: "Pine Mushnub", ai: "wretch", tier: 2, height: 1.5 },
  "green-spiky-blob": { model: "green-spiky-blob", name: "Burr Blob", ai: "wretch", tier: 2, height: 1.6 },
  armabee: { model: "armabee", name: "Thornbee", ai: "flyer", tier: 2 },
  cactoro: { model: "cactoro", name: "Driftspine", ai: "wretch", tier: 2, height: 1.6 },
  hywirl: { model: "hywirl", name: "Whirlwing", ai: "flyer", tier: 2 },
  "manta-ray": { model: "manta-ray", name: "Gale Ray", ai: "sea", tier: 2, height: 1.3 },
  jellyfish: { model: "jellyfish", name: "Drift Jelly", ai: "sea", tier: 2, height: 1.4 },
  // Ember spire, the farmstead and Darkwood (tier 3)
  "blue-demon": { model: "blue-demon", name: "Cinder Fiend", ai: "wretch", tier: 3, height: 1.9 },
  demon: { model: "demon", name: "Ember Imp", ai: "flyer", tier: 3 },
  orc: { model: "orc", name: "Field Raider", ai: "wretch", tier: 3, height: 1.8 },
  goleling: { model: "goleling", name: "Hay Goleling", ai: "flyer", tier: 3 },
  ghost: { model: "ghost", name: "Darkwood Wisp", ai: "flyer", tier: 3 },
  ninja: { model: "ninja", name: "Shade", ai: "wretch", tier: 3, height: 1.7 },
  shark: { model: "shark", name: "Reef Shark", ai: "sea", tier: 3, height: 2 },
  dragon: { model: "dragon", name: "Wind Drake", ai: "flyer", tier: 3, height: 2 },
  // Smuggler's cove, Palm reach and Wreck spire (tier 4)
  "orc-skull": { model: "orc-skull", name: "Barrow Knight", ai: "hullbreaker", tier: 4, height: 2.4 },
  "ninja-2": { model: "ninja-2", name: "Cove Cutthroat", ai: "wretch", tier: 4, height: 2 },
  "orc-2": { model: "orc-2", name: "Smuggler", ai: "wretch", tier: 4, height: 2 },
  tribal: { model: "tribal", name: "Gullrider", ai: "flyer", tier: 4 },
  "cactoro-2": { model: "cactoro-2", name: "Spinebloom", ai: "wretch", tier: 4, height: 2.1 },
  frog: { model: "frog", name: "Mire Toad", ai: "wretch", tier: 4, height: 1.7 },
  dino: { model: "dino", name: "Reef Saurian", ai: "hullbreaker", tier: 4, height: 2.4 },
  squidle: { model: "squidle", name: "Wreck Squidle", ai: "flyer", tier: 4 },
  "fish-4": { model: "fish-4", name: "Deep Lurker", ai: "wretch", tier: 4, height: 2 },
  "mushroom-king": { model: "mushroom-king", name: "Barnacle King", ai: "hullbreaker", tier: 4, height: 2.6 },
};

/** Health, guard, XP and speed by tier, for each way of fighting. */
const TIER_STATS: Record<EnemyAi, Array<Pick<EnemyKind, "hp" | "guard" | "xp" | "speed" | "aggroRange">>> = {
  wretch: [
    { hp: 40, guard: 18, xp: 10, speed: 4.6, aggroRange: 14 },
    { hp: 70, guard: 28, xp: 20, speed: 5, aggroRange: 17 },
    { hp: 100, guard: 40, xp: 30, speed: 5.3, aggroRange: 18 },
    { hp: 135, guard: 52, xp: 40, speed: 5.6, aggroRange: 19 },
  ],
  flyer: [
    { hp: 40, guard: 16, xp: 12, speed: 6, aggroRange: 16 },
    { hp: 60, guard: 24, xp: 22, speed: 6.5, aggroRange: 20 },
    { hp: 85, guard: 32, xp: 30, speed: 7, aggroRange: 22 },
    { hp: 115, guard: 44, xp: 42, speed: 7.4, aggroRange: 24 },
  ],
  sea: [
    { hp: 40, guard: 16, xp: 10, speed: 5, aggroRange: 16 },
    { hp: 60, guard: 22, xp: 18, speed: 5.5, aggroRange: 18 },
    { hp: 140, guard: 55, xp: 38, speed: 6, aggroRange: 20 },
    { hp: 180, guard: 70, xp: 50, speed: 6.4, aggroRange: 22 },
  ],
  hullbreaker: [
    { hp: 160, guard: 60, xp: 40, speed: 3, aggroRange: 18 },
    { hp: 190, guard: 72, xp: 50, speed: 3.2, aggroRange: 20 },
    { hp: 220, guard: 85, xp: 60, speed: 3.4, aggroRange: 22 },
    { hp: 260, guard: 100, xp: 75, speed: 3.6, aggroRange: 22 },
  ],
};

const DEFAULT_HEIGHT: Record<EnemyAi, number> = { wretch: 1.35, flyer: 1.5, sea: 1.2, hullbreaker: 2.3 };

for (const [id, beast] of Object.entries(BESTIARY)) {
  if (!MONSTER_MODELS[beast.model]) continue;
  const stats = TIER_STATS[beast.ai][beast.tier - 1];
  ENEMY_KINDS[id] = {
    name: beast.name, ...stats,
    respawnSeconds: beast.ai === "hullbreaker" ? 40 : 22,
    model: beast.model, ai: beast.ai,
  };
  const height = beast.height ?? DEFAULT_HEIGHT[beast.ai];
  ENEMY_SIZE[id] = { radius: Math.max(0.6, height * 0.55), height };
}

// --- Effects the server broadcasts (one batch per tick) ------------------------

export type SkillFxKind =
  | "undertow" | "chain" | "slam"
  | "surge" | "static" | "hurl"
  | "surface" | "updraft" | "leap"
  | "riptide" | "tempest" | "colossal"
  | "riposte" | "breakwater";

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
  | { t: "vault"; id: string }
  | { t: "boulder"; from: [number, number, number]; to: [number, number, number]; r: number }
  | { t: "teleport"; id: string; from: [number, number, number]; to: [number, number, number]; mantle: string }
  | { t: "skill"; id: string; skill: SkillFxKind; x: number; y: number; z: number; tx?: number; ty?: number; tz?: number; facing: number; r: number };

export type PingKind = "ping" | "weak" | "revive" | "target" | "rally";

export interface PingMessage {
  id: string;
  from: string;
  kind: PingKind;
  x: number;
  y: number;
  z: number;
  targetId?: string;
}

// --- Progression ---------------------------------------------------------------

/** Total XP needed to reach each level (index = level - 1). Proposed playtest values. */
export const LEVEL_XP = [0, 40, 120, 260, 450];
export const MAX_LEVEL = LEVEL_XP.length;

export const UNLOCK_LEVELS = {
  boostDive: 2,
  technique: 3,
  secondSkill: 4,
  upgradePath: 5,
  colossus: 5,
} as const;

export interface OriginQuest {
  title: string;
  step0Text: string;
  step1Text: string;
  reward: string;
  xp: number;
  target: { x: number; y: number; z: number; radius: number };
}

export const ORIGIN_QUESTS: Record<string, OriginQuest> = {
  harbourfolk: {
    title: "Chart the Harbour",
    step0Text: "Recover the flight chart at the eastern dock",
    step1Text: "Bring the chart to the training-yard shrine",
    reward: "Harbour Pennant",
    xp: 45,
    target: { x: 54, y: 1.2, z: 154, radius: 7 },
  },
  skyborn: {
    title: "Repair the Wind Beacon",
    step0Text: "Reach the wind beacon on the upper terrace",
    step1Text: "Return to the training-yard shrine",
    reward: "Glider Charm",
    xp: 45,
    target: { x: 0, y: 44, z: -86, radius: 8 },
  },
  stonekin: {
    title: "Guild Memorial",
    step0Text: "Retrieve the guild memorial on the quarry terrace",
    step1Text: "Return the memorial to the training-yard shrine",
    reward: "Carved Stone Brooch",
    xp: 45,
    target: { x: -22, y: 14, z: -76, radius: 7 },
  },
};

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
