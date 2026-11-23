import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Buttons, IMPACT_MIN_SPEED, Mode, STEP_SECONDS, STAMINA_MAX, KILL_Y, RIM_Z,
  createMoveState, createStepEvents, getWorld, stepMovement, type MoveInput, type MoveState,
} from "./index.ts";

const world = getWorld();
const idle: MoveInput = { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };

function run(s: MoveState, input: Partial<MoveInput>, steps: number) {
  for (let i = 0; i < steps; i++) stepMovement(s, { ...idle, ...input }, STEP_SECONDS, world);
}

function settled(): MoveState {
  const s = createMoveState(world.spawn);
  run(s, {}, 30);
  return s;
}

test("player spawns and settles on the training yard floor", () => {
  const s = settled();
  assert.equal(s.mode, Mode.Ground);
  assert.ok(Math.abs(s.y - 3.4) < 0.01, `y=${s.y}`);
});

test("walking forward moves along the camera yaw", () => {
  const s = settled();
  const z0 = s.z;
  run(s, { moveZ: 100, yaw: 0 }, 15);
  assert.ok(s.z > z0 + 2, `z moved from ${z0} to ${s.z}`);
  assert.ok(Math.abs(s.x - world.spawn.x) < 0.01);
});

test("jump, then jump again in midair takes off; hover holds height", () => {
  const s = settled();
  run(s, { buttons: Buttons.JumpPressed | Buttons.JumpHeld }, 1);
  assert.equal(s.mode, Mode.Air);
  run(s, { buttons: Buttons.JumpHeld }, 8);
  run(s, { buttons: Buttons.JumpPressed | Buttons.JumpHeld }, 1);
  assert.equal(s.mode, Mode.Flight);
  run(s, { buttons: Buttons.JumpHeld }, 30);
  run(s, {}, 15); // let the climb coast to a stop
  const y = s.y;
  run(s, {}, 60);
  assert.equal(s.mode, Mode.Flight);
  assert.ok(Math.abs(s.y - y) < 0.6, `hover drifted from ${y} to ${s.y}`);
});

function airborne(height = 40): MoveState {
  const s = settled();
  run(s, { buttons: Buttons.JumpPressed }, 1);
  run(s, {}, 5);
  run(s, { buttons: Buttons.JumpPressed }, 1);
  run(s, { buttons: Buttons.JumpHeld }, Math.ceil(height / 9 / STEP_SECONDS));
  return s;
}

test("boosting drains stamina; at zero stamina flight continues", () => {
  const s = airborne();
  let steps = 0;
  while (s.exhausted === 0 && steps++ < 30 * 10) run(s, { moveZ: 100, buttons: Buttons.Boost }, 1);
  assert.equal(s.exhausted, 1);
  assert.ok(steps > 30 * 4, "100 stamina should last over 4 seconds of boosting");
  assert.equal(s.mode, Mode.Flight);
  // Still holding boost while exhausted: back to normal flight speed, stamina recovering.
  run(s, { moveZ: 100, buttons: Buttons.Boost }, 27);
  assert.equal(s.exhausted, 1);
  assert.ok(s.stamina > 0);
  assert.ok(Math.hypot(s.vx, s.vz) <= 15.01, `should be at normal flight speed, got ${Math.hypot(s.vx, s.vz)}`);
  run(s, { moveZ: 100 }, 30);
  assert.equal(s.exhausted, 0);
});

test("boost while looking down dives and builds speed past normal flight", () => {
  const s = airborne(60);
  run(s, { moveZ: 100, pitch: -0.9, buttons: Buttons.Boost }, 30);
  assert.equal(s.mode, Mode.Dive);
  assert.ok(Math.hypot(s.vx, s.vy, s.vz) > 30, "dive should be faster than boost");
});

test("descending onto the ground lands", () => {
  const s = airborne(10);
  run(s, { buttons: Buttons.Descend }, 120);
  assert.equal(s.mode, Mode.Ground);
});

test("walking up the terrace stairs climbs them", () => {
  const s = createMoveState({ x: 0, y: 3.4, z: -40 });
  run(s, {}, 20);
  run(s, { moveZ: -100, yaw: 0 }, 30 * 5);
  assert.ok(s.y > 13.9, `expected to reach the terrace, y=${s.y}`);
});

test("walls stop movement", () => {
  const s = settled();
  // Training-yard west wall is at x=-80.
  run(s, { moveX: -100, yaw: 0 }, 30 * 5);
  assert.ok(s.x > -80, `went through the wall: x=${s.x}`);
});

test("falling into the sea returns to the last safe spot", () => {
  const s = createMoveState({ x: 300, y: 20, z: 300 });
  s.safeX = world.spawn.x; s.safeY = world.spawn.y; s.safeZ = world.spawn.z;
  run(s, {}, 90);
  assert.ok(Math.abs(s.x - world.spawn.x) < 1 && Math.abs(s.z - world.spawn.z) < 1);
});

test("fliers skim the sea instead of falling in", () => {
  const s = createMoveState({ x: 300, y: 5, z: 300 });
  s.mode = Mode.Flight;
  run(s, { buttons: Buttons.Descend, moveZ: 100 }, 60);
  assert.equal(s.mode, Mode.Flight);
  assert.ok(s.y >= 0.39);
});

test("beyond the rim there is no sea: you fall to the settlement", () => {
  const s = createMoveState({ x: 0, y: 5, z: RIM_Z - 60 });
  run(s, {}, 30 * 6);
  assert.equal(s.mode, Mode.Ground);
  assert.ok(s.y < -80 && s.y > KILL_Y, `y=${s.y}`);
});

test("attacks chain into a three-hit combo, then restart", () => {
  const s = settled();
  const ev = createStepEvents();
  const hits: number[] = [];
  for (let i = 0; i < 30 * 3; i++) {
    stepMovement(s, { ...idle, buttons: Buttons.AttackPressed }, STEP_SECONDS, world, ev);
    if (ev.attack) hits.push(ev.attack);
  }
  assert.deepEqual(hits.slice(0, 4), [1, 2, 3, 1]);
  // After a pause the combo starts over.
  run(s, {}, 60);
  stepMovement(s, { ...idle, buttons: Buttons.AttackPressed }, STEP_SECONDS, world, ev);
  assert.equal(ev.attack, 1);
});

test("a fast dive into the ground reports an impact", () => {
  const s = airborne(60);
  const ev = createStepEvents();
  let impact = 0, steep = 0;
  for (let i = 0; i < 30 * 6 && !impact; i++) {
    stepMovement(s, { ...idle, moveZ: 100, pitch: -1.2, buttons: Buttons.Boost }, STEP_SECONDS, world, ev);
    if (ev.impactSpeed) { impact = ev.impactSpeed; steep = ev.impactSteep; }
  }
  assert.ok(impact >= IMPACT_MIN_SPEED, `impact speed ${impact}`);
  assert.ok(steep > 0.7, `steepness ${steep}`);
});

test("downed players can't act and recover at their safe spot", () => {
  const s = settled();
  run(s, { moveZ: 100 }, 30);
  s.downTime = 1;
  const x = s.x, z = s.z;
  run(s, { moveZ: 100, buttons: Buttons.AttackPressed }, 15);
  assert.ok(Math.hypot(s.x - x, s.z - z) < 0.6, "should not move while down");
  run(s, {}, 30);
  assert.equal(s.downTime, 0);
  assert.ok(Math.hypot(s.x - s.safeX, s.z - s.safeZ) < 0.01);
});

test("simulation is deterministic", () => {
  const a = settled();
  const b = settled();
  const script: Partial<MoveInput>[] = [
    { buttons: Buttons.JumpPressed }, {}, {}, { buttons: Buttons.JumpPressed },
    { moveZ: 100, yaw: 1.2, buttons: Buttons.Boost | Buttons.JumpHeld },
    { moveZ: 100, yaw: 1.3, pitch: -0.8, buttons: Buttons.Boost },
    { moveX: 100, buttons: Buttons.DodgePressed },
  ];
  for (let i = 0; i < 300; i++) {
    const inp = { ...idle, ...script[i % script.length] };
    stepMovement(a, inp, STEP_SECONDS, world);
    stepMovement(b, inp, STEP_SECONDS, world);
  }
  assert.deepEqual(a, b);
  assert.ok(a.stamina <= STAMINA_MAX);
});

test("boost and dive unlock at level 2", () => {
  const s = airborne(50);
  s.level = 1;
  run(s, { moveZ: 100, pitch: -0.9, buttons: Buttons.Boost }, 20);
  assert.equal(s.mode, Mode.Flight);
  assert.equal(s.stamina, STAMINA_MAX);
  s.level = 2;
  run(s, { moveZ: 100, pitch: -0.9, buttons: Buttons.Boost }, 20);
  assert.equal(s.mode, Mode.Dive);
  assert.ok(s.stamina < STAMINA_MAX);
});
