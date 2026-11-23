import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * Field names here must match `MoveState` / `MoveInput` in @worlds-edge/shared,
 * because the same `stepMovement` function mutates these instances directly.
 */
export const Player = schema({
  // Identity and look (set once on join).
  name: t.string(),
  classId: t.string(),
  origin: t.string(),
  mantle: t.string(),
  skin: t.string(),
  hair: t.string(),
  outfit: t.string(),
  /** 1 while the player's connection has dropped and the server is holding their place. */
  away: t.uint8(),
  // Movement state (mirrors MoveState).
  x: t.float32(), y: t.float32(), z: t.float32(),
  vx: t.float32(), vy: t.float32(), vz: t.float32(),
  mode: t.uint8(),
  stamina: t.float32(),
  exhausted: t.uint8(),
  facing: t.float32(),
  dodgeTime: t.float32(),
  dodgeCooldown: t.float32(),
  dodgeX: t.float32(), dodgeZ: t.float32(),
  teleportCooldown: t.float32(),
  safeX: t.float32(), safeY: t.float32(), safeZ: t.float32(),
  attackTime: t.float32(),
  attackCooldown: t.float32(),
  attackCombo: t.uint8(),
  comboWindow: t.float32(),
  downTime: t.float32(),
  // Combat and progression (server-owned).
  hp: t.float32(),
  maxHp: t.uint8(),
  level: t.uint8(),
  xp: t.uint16(),
  mantleAwakened: t.uint8(),
  abilityCooldown: t.float32(),
  ability2Cooldown: t.float32(),
  exploreCooldown: t.float32(),
  ultCharge: t.float32(),
  giant: t.uint8(),
  technique: t.string(),
  mantlePath: t.string(),
  questStep: t.uint8(),
  guarding: t.uint8(),
  classCharge: t.uint8(),
  classCooldown: t.float32(),
  /** Party id ("" when solo). */
  party: t.string(),
  /** 0..1 while a teammate is reviving this (downed) player. */
  reviveProgress: t.float32(),
}, "Player");
export type Player = SchemaType<typeof Player>;

export const Enemy = schema({
  kind: t.string(),
  x: t.float32(), y: t.float32(), z: t.float32(),
  facing: t.float32(),
  hp: t.float32(),
  maxHp: t.uint16(),
  guard: t.float32(),
  maxGuard: t.uint16(),
  /** EnemyState */
  state: t.uint8(),
}, "Enemy");
export type Enemy = SchemaType<typeof Enemy>;

/** The Drowned Colossus encounter (unused in the overworld). */
export const Boss = schema({
  /** BossPhase */
  phase: t.uint8(),
  hp: t.float32(),
  maxHp: t.uint16(),
  armour: t.float32(),
  maxArmour: t.uint16(),
  /** Seconds the heart stays exposed (0 = armoured). */
  exposed: t.float32(),
  anchorsLeft: t.uint8(),
  /** Wave progress 0..1 while a wave crosses the arena, else -1. */
  wave: t.float32(),
  waveDirX: t.float32(), waveDirZ: t.float32(),
  /** Arm slam: target and seconds until it lands (-1 when idle). */
  slamX: t.float32(), slamZ: t.float32(), slamT: t.float32(),
  /** Arm sweep around the Colossus: seconds until it lands (-1 when idle). */
  sweepT: t.float32(),
  objective: t.string(),
  /** Seconds since the encounter started (for the result screen). */
  elapsed: t.float32(),
}, "Boss");
export type Boss = SchemaType<typeof Boss>;

export const WorldState = schema({
  players: t.map(Player),
  enemies: t.map(Enemy),
  boss: Boss,
}, "WorldState");
export type WorldState = SchemaType<typeof WorldState>;

/** One fixed step of client input. Flat primitives only, as the input codec requires. */
export const MoveInput = schema({
  moveX: t.int8(),
  moveZ: t.int8(),
  yaw: t.float32(),
  pitch: t.float32(),
  buttons: t.uint16(),
}, "MoveInput");
export type MoveInput = SchemaType<typeof MoveInput>;
