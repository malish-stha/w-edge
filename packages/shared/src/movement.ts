/**
 * Player movement: walking, jumping, take-off, flight, hover, climb, descend,
 * boost, dive, dodge, landing, sea skimming and safe-spot recovery.
 *
 * This is the ONE implementation of movement. The server runs it to decide what
 * really happened; the client runs it to predict its own player instantly and to
 * replay unacknowledged inputs after a correction. Keep it deterministic: no
 * Date/Math.random, no reading anything that isn't in `state`, `input` or the world.
 */
import * as C from "./constants.ts";
import type { Box, World } from "./world.ts";

export const Mode = { Ground: 0, Air: 1, Flight: 2, Dive: 3 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export const Buttons = {
  JumpHeld: 1,
  JumpPressed: 2,
  Descend: 4,
  Boost: 8,
  DodgePressed: 16,
  AttackPressed: 32,
  Ability1Pressed: 64,
  InteractPressed: 128,
  /** E held down (reviving a teammate). */
  InteractHeld: 256,
} as const;

/** What happened during one step that the server must resolve (hits, skills, interactions). */
export interface StepEvents {
  /** 1–3 when a basic attack started this step (position in the combo), else 0. */
  attack: number;
  ability1: boolean;
  interact: boolean;
  /** Speed of a dive or fast flight that slammed into the ground this step, else 0. */
  impactSpeed: number;
  /** 0 (flat) to 1 (vertical) for that impact. */
  impactSteep: number;
}

export function createStepEvents(): StepEvents {
  return { attack: 0, ability1: false, interact: false, impactSpeed: 0, impactSteep: 0 };
}

function clearEvents(e: StepEvents) {
  e.attack = 0; e.ability1 = false; e.interact = false; e.impactSpeed = 0; e.impactSteep = 0;
}

/** Shared scratch for callers that don't care about events (client prediction). */
const ignoredEvents = createStepEvents();

/** One fixed step of player input. Field names match the server's input schema. */
export interface MoveInput {
  /** Strafe, -100 (left) to 100 (right). */
  moveX: number;
  /** Forward/back, -100 (back) to 100 (forward). */
  moveZ: number;
  /** Camera yaw in radians. */
  yaw: number;
  /** Camera pitch in radians, positive looks up. */
  pitch: number;
  /** Bitmask of {@link Buttons}. */
  buttons: number;
}

/** Everything movement reads or writes. Field names match the server's player schema. */
export interface MoveState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  mode: number;
  stamina: number;
  /** 1 after stamina runs dry, until it recovers to STAMINA_RECOVER. Boost and dive are locked meanwhile. */
  exhausted: number;
  /** Body facing in radians (yaw). */
  facing: number;
  dodgeTime: number;
  dodgeCooldown: number;
  dodgeX: number;
  dodgeZ: number;
  safeX: number; safeY: number; safeZ: number;
  /** Seconds left in the current attack's active window (drives the swing animation). */
  attackTime: number;
  /** Seconds until another attack can start. */
  attackCooldown: number;
  /** Position in the 3-hit combo of the last attack (1–3). */
  attackCombo: number;
  /** Seconds left to continue the combo. */
  comboWindow: number;
  /** Seconds until a downed player recovers at their safe spot (0 = up). Set by the server. */
  downTime: number;
}

export function createMoveState(spawn: { x: number; y: number; z: number }): MoveState {
  return {
    x: spawn.x, y: spawn.y, z: spawn.z,
    vx: 0, vy: 0, vz: 0,
    mode: Mode.Air,
    stamina: C.STAMINA_MAX,
    exhausted: 0,
    facing: Math.PI,
    dodgeTime: 0, dodgeCooldown: 0, dodgeX: 0, dodgeZ: 0,
    safeX: spawn.x, safeY: spawn.y, safeZ: spawn.z,
    attackTime: 0, attackCooldown: 0, attackCombo: 0, comboWindow: 0,
    downTime: 0,
  };
}

const ATTACK_ACTIVE = 0.22;
const ATTACK_RECOVERY = [0.32, 0.32, 0.55];
const COMBO_WINDOW = 0.75;
const ATTACK_LUNGE = 5;
/** Slamming into the ground faster than this counts as an impact (the Lancer's dive strike). */
export const IMPACT_MIN_SPEED = 22;

const EPS = 1e-4;
/** Longest distance moved in one collision sub-step, so fast dives can't tunnel through thin walls. */
const MAX_SUBSTEP_DIST = 0.4;

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

/** Move a 2D vector toward a target by at most maxDelta (length), in place on the returned tuple. */
function approach2(x: number, z: number, tx: number, tz: number, maxDelta: number): [number, number] {
  const dx = tx - x;
  const dz = tz - z;
  const len = Math.hypot(dx, dz);
  if (len <= maxDelta || len < 1e-9) return [tx, tz];
  const k = maxDelta / len;
  return [x + dx * k, z + dz * k];
}

/** Camera-relative wish direction on the horizontal plane, length 0..1. */
export function wishDirection(input: MoveInput): [number, number] {
  const ix = Math.max(-100, Math.min(100, input.moveX)) / 100;
  const iz = Math.max(-100, Math.min(100, input.moveZ)) / 100;
  const s = Math.sin(input.yaw);
  const c = Math.cos(input.yaw);
  // forward = (sin yaw, cos yaw), right = (cos yaw, -sin yaw)
  let wx = s * iz + c * ix;
  let wz = c * iz - s * ix;
  const len = Math.hypot(wx, wz);
  if (len > 1) { wx /= len; wz /= len; }
  return [wx, wz];
}

function overlaps(b: Box, x: number, y: number, z: number): boolean {
  return (
    x + C.PLAYER_HALF_WIDTH > b.minX && x - C.PLAYER_HALF_WIDTH < b.maxX &&
    y + C.PLAYER_HEIGHT > b.minY && y < b.maxY &&
    z + C.PLAYER_HALF_WIDTH > b.minZ && z - C.PLAYER_HALF_WIDTH < b.maxZ
  );
}

function blockedAt(boxes: Box[], x: number, y: number, z: number): boolean {
  for (const b of boxes) if (overlaps(b, x, y, z)) return true;
  return false;
}

interface Hits { ground: boolean; ceiling: boolean; wall: boolean }

/**
 * Sweep the player's box through the world one axis at a time (x, z, then y),
 * stopping at solid boxes. Walking players step up low ledges automatically.
 */
function moveAndCollide(s: MoveState, dx: number, dy: number, dz: number, world: World, canStep: boolean): Hits {
  const hits: Hits = { ground: false, ceiling: false, wall: false };

  // Broad phase: only boxes near the swept volume.
  const hw = C.PLAYER_HALF_WIDTH + 1;
  const loX = Math.min(s.x, s.x + dx) - hw, hiX = Math.max(s.x, s.x + dx) + hw;
  const loY = Math.min(s.y, s.y + dy) - 1, hiY = Math.max(s.y, s.y + dy) + C.PLAYER_HEIGHT + C.STEP_HEIGHT + 1;
  const loZ = Math.min(s.z, s.z + dz) - hw, hiZ = Math.max(s.z, s.z + dz) + hw;
  const near: Box[] = [];
  for (const b of world.boxes) {
    if (b.maxX < loX || b.minX > hiX || b.maxY < loY || b.minY > hiY || b.maxZ < loZ || b.minZ > hiZ) continue;
    near.push(b);
  }

  const dist = Math.hypot(dx, dy, dz);
  const steps = Math.max(1, Math.ceil(dist / MAX_SUBSTEP_DIST));
  const sx = dx / steps, sy = dy / steps, sz = dz / steps;

  for (let i = 0; i < steps; i++) {
    // Horizontal axes.
    for (const axis of ["x", "z"] as const) {
      const d = axis === "x" ? sx : sz;
      if (d === 0) continue;
      const before = s[axis];
      s[axis] = before + d;
      for (const b of near) {
        if (!overlaps(b, s.x, s.y, s.z)) continue;
        const rise = b.maxY - s.y;
        if (canStep && rise > 0 && rise <= C.STEP_HEIGHT && !blockedAt(near, s.x, b.maxY + EPS, s.z)) {
          s.y = b.maxY + EPS;
          continue;
        }
        hits.wall = true;
        if (d > 0) s[axis] = (axis === "x" ? b.minX : b.minZ) - C.PLAYER_HALF_WIDTH - EPS;
        else s[axis] = (axis === "x" ? b.maxX : b.maxZ) + C.PLAYER_HALF_WIDTH + EPS;
        if (axis === "x") s.vx = 0; else s.vz = 0;
      }
    }
    // Vertical axis.
    if (sy !== 0) {
      s.y += sy;
      for (const b of near) {
        if (!overlaps(b, s.x, s.y, s.z)) continue;
        if (sy < 0) { s.y = b.maxY + EPS; hits.ground = true; }
        else { s.y = b.minY - C.PLAYER_HEIGHT - EPS; hits.ceiling = true; }
        s.vy = 0;
      }
    }
  }
  return hits;
}

function respawn(s: MoveState) {
  s.x = s.safeX; s.y = s.safeY + 0.5; s.z = s.safeZ;
  s.vx = 0; s.vy = 0; s.vz = 0;
  s.mode = Mode.Air;
  s.dodgeTime = 0;
}

/**
 * Advance one player by one fixed step. Mutates `s`. Things the server has to
 * resolve (attacks, skills, impacts) are reported in `events`.
 */
export function stepMovement(s: MoveState, input: MoveInput, dt: number, world: World, events: StepEvents = ignoredEvents): void {
  clearEvents(events);

  // Downed: no control; fall, then recover at the safe spot.
  if (s.downTime > 0) {
    s.downTime = Math.max(0, s.downTime - dt);
    if (s.downTime === 0) { respawn(s); return; }
    input = { moveX: 0, moveZ: 0, yaw: input.yaw, pitch: 0, buttons: 0 };
    if (s.mode === Mode.Flight || s.mode === Mode.Dive) s.mode = Mode.Air;
  }

  const b = input.buttons;
  const jumpHeld = (b & Buttons.JumpHeld) !== 0;
  const jumpPressed = (b & Buttons.JumpPressed) !== 0;
  const descend = (b & Buttons.Descend) !== 0;
  const boostHeld = (b & Buttons.Boost) !== 0;
  const dodgePressed = (b & Buttons.DodgePressed) !== 0;
  const [wx, wz] = wishDirection(input);
  const hasWish = wx !== 0 || wz !== 0;
  let drain = 0;

  s.dodgeCooldown = Math.max(0, s.dodgeCooldown - dt);

  // Dodge: a short burst in the movement direction (or facing), costing stamina.
  if (dodgePressed && s.dodgeCooldown <= 0 && s.stamina >= C.DODGE_COST) {
    let dx = wx, dz = wz;
    if (!hasWish) { dx = Math.sin(s.facing); dz = Math.cos(s.facing); }
    const len = Math.hypot(dx, dz) || 1;
    s.dodgeX = dx / len; s.dodgeZ = dz / len;
    s.dodgeTime = C.DODGE_TIME;
    s.dodgeCooldown = C.DODGE_COOLDOWN;
    s.stamina -= C.DODGE_COST;
  }

  // Basic attack: a three-hit combo with a small lunge toward where the camera looks.
  s.attackTime = Math.max(0, s.attackTime - dt);
  s.attackCooldown = Math.max(0, s.attackCooldown - dt);
  s.comboWindow = Math.max(0, s.comboWindow - dt);
  if ((b & Buttons.AttackPressed) !== 0 && s.attackCooldown <= 0) {
    s.attackCombo = s.comboWindow > 0 ? (s.attackCombo % 3) + 1 : 1;
    s.attackTime = ATTACK_ACTIVE;
    s.attackCooldown = ATTACK_RECOVERY[s.attackCombo - 1];
    s.comboWindow = s.attackCooldown + COMBO_WINDOW;
    s.facing = input.yaw;
    if (s.mode !== Mode.Dive) {
      s.vx += Math.sin(input.yaw) * ATTACK_LUNGE;
      s.vz += Math.cos(input.yaw) * ATTACK_LUNGE;
    }
    events.attack = s.attackCombo;
  }
  if ((b & Buttons.Ability1Pressed) !== 0) events.ability1 = true;
  if ((b & Buttons.InteractPressed) !== 0) events.interact = true;

  const canBoost = boostHeld && s.exhausted === 0 && s.stamina > 0;

  switch (s.mode) {
    case Mode.Ground: {
      const speed = boostHeld ? C.RUN_SPEED : C.WALK_SPEED;
      [s.vx, s.vz] = approach2(s.vx, s.vz, wx * speed, wz * speed, C.GROUND_ACCEL * dt);
      s.vy -= C.GRAVITY * dt;
      if (jumpPressed) { s.vy = C.JUMP_VELOCITY; s.mode = Mode.Air; }
      break;
    }
    case Mode.Air: {
      if (hasWish) {
        [s.vx, s.vz] = approach2(s.vx, s.vz, wx * C.WALK_SPEED, wz * C.WALK_SPEED, C.AIR_ACCEL * dt);
      }
      s.vy = Math.max(s.vy - C.GRAVITY * dt, -C.MAX_FALL_SPEED);
      // Space again in midair takes off.
      if (jumpPressed) { s.mode = Mode.Flight; s.vy = Math.max(s.vy, 2); }
      break;
    }
    case Mode.Flight:
    case Mode.Dive: {
      if (canBoost && input.pitch < C.DIVE_PITCH) s.mode = Mode.Dive;
      else if (s.mode === Mode.Dive) s.mode = Mode.Flight; // keeps its momentum, which decays below

      if (s.mode === Mode.Dive) {
        const cp = Math.cos(input.pitch);
        const dirX = Math.sin(input.yaw) * cp;
        const dirY = Math.sin(input.pitch);
        const dirZ = Math.cos(input.yaw) * cp;
        const current = Math.hypot(s.vx, s.vy, s.vz);
        const speed = Math.min(C.DIVE_MAX_SPEED, current + (C.DIVE_ACCEL + C.GRAVITY * -dirY) * dt);
        // Steering eases the direction toward the camera; speed is applied in full.
        const steer = Math.min(1, 8 * dt);
        let hx = dirX, hy = dirY, hz = dirZ;
        if (current > 1e-6) {
          hx = s.vx / current + (dirX - s.vx / current) * steer;
          hy = s.vy / current + (dirY - s.vy / current) * steer;
          hz = s.vz / current + (dirZ - s.vz / current) * steer;
          const hl = Math.hypot(hx, hy, hz) || 1;
          hx /= hl; hy /= hl; hz /= hl;
        }
        s.vx = hx * speed; s.vy = hy * speed; s.vz = hz * speed;
        drain += C.DIVE_DRAIN;
      } else {
        const target = canBoost && hasWish ? C.BOOST_SPEED : C.FLIGHT_SPEED;
        const targetVy = jumpHeld ? C.CLIMB_SPEED : descend ? -C.DESCEND_SPEED : 0;
        const accel = hasWish || jumpHeld || descend ? C.FLIGHT_ACCEL : C.HOVER_DRAG * C.FLIGHT_SPEED;
        [s.vx, s.vz] = approach2(s.vx, s.vz, wx * target, wz * target, accel * dt);
        s.vy = approach(s.vy, targetVy, accel * dt);
        if (canBoost && hasWish) drain += C.BOOST_DRAIN;
      }
      break;
    }
  }

  // Stamina: drains while boosting or diving, recovers otherwise.
  if (drain > 0) s.stamina = Math.max(0, s.stamina - drain * dt);
  else s.stamina = Math.min(C.STAMINA_MAX, s.stamina + C.STAMINA_REGEN * dt);
  if (s.stamina <= 0) s.exhausted = 1;
  else if (s.exhausted === 1 && s.stamina >= C.STAMINA_RECOVER) s.exhausted = 0;

  // Dodge burst overrides horizontal velocity while active.
  let mvx = s.vx, mvz = s.vz;
  if (s.dodgeTime > 0) {
    mvx = s.dodgeX * C.DODGE_SPEED;
    mvz = s.dodgeZ * C.DODGE_SPEED;
    s.dodgeTime = Math.max(0, s.dodgeTime - dt);
  }

  const speedBefore = Math.hypot(s.vx, s.vy, s.vz);
  const vyBefore = s.vy;
  const hits = moveAndCollide(s, mvx * dt, s.vy * dt, mvz * dt, world, s.mode === Mode.Ground);

  if (hits.ground) {
    if (s.mode === Mode.Air) s.mode = Mode.Ground;
    else if (s.mode === Mode.Flight || s.mode === Mode.Dive) {
      if (speedBefore >= IMPACT_MIN_SPEED && vyBefore < 0) {
        events.impactSpeed = speedBefore;
        events.impactSteep = Math.min(1, -vyBefore / speedBefore);
      }
      // A slow or deliberate (descend held) approach lands; a fast one skims the surface.
      if (descend || speedBefore < C.LAND_SPEED) s.mode = Mode.Ground;
      else s.mode = Mode.Flight;
    }
  } else if (s.mode === Mode.Ground) {
    s.mode = Mode.Air; // walked off a ledge
  }

  // The sea: fliers skim it, anyone else who falls in goes back to safety.
  if (s.z > C.RIM_Z && s.y < C.SEA_LEVEL + C.SKIM_HEIGHT) {
    if (s.mode === Mode.Flight || s.mode === Mode.Dive) {
      s.y = C.SEA_LEVEL + C.SKIM_HEIGHT;
      if (s.vy < 0) s.vy = 0;
      if (s.mode === Mode.Dive) s.mode = Mode.Flight;
    } else if (s.y < C.SEA_LEVEL - 0.5) {
      respawn(s);
      return;
    }
  }
  if (s.y < C.KILL_Y) { respawn(s); return; }

  // Facing follows horizontal motion; in a dive it follows the camera.
  if (s.mode === Mode.Dive || s.attackTime > 0) s.facing = input.yaw;
  else if (Math.hypot(mvx, mvz) > 0.5) s.facing = Math.atan2(mvx, mvz);

  // Remember a safe spot to return to (only when it moved meaningfully, to save bandwidth).
  if (s.mode === Mode.Ground && Math.hypot(s.x - s.safeX, s.y - s.safeY, s.z - s.safeZ) > 3) {
    s.safeX = s.x; s.safeY = s.y; s.safeZ = s.z;
  }
}
