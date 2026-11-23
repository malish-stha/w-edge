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

export const WorldState = schema({
  players: t.map(Player),
  enemies: t.map(Enemy),
}, "WorldState");
export type WorldState = SchemaType<typeof WorldState>;

/** One fixed step of client input. Flat primitives only, as the input codec requires. */
export const MoveInput = schema({
  moveX: t.int8(),
  moveZ: t.int8(),
  yaw: t.float32(),
  pitch: t.float32(),
  buttons: t.uint8(),
}, "MoveInput");
export type MoveInput = SchemaType<typeof MoveInput>;
