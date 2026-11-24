import type { Scene } from "@babylonjs/core/scene.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { RIM_Z, SEA_LEVEL, raycast, type World } from "@worlds-edge/shared";

/** Third-person orbit camera that keeps a stable horizon and stays out of walls. */
export class FollowCamera {
  readonly camera: TargetCamera;
  private target = new Vector3();
  private distance = 8;
  private shake = 0;
  private shakeT = 0;

  /** Collision geometry for keeping the camera out of walls; swapped when changing rooms. */
  world: World;

  constructor(scene: Scene, world: World) {
    this.world = world;
    this.camera = new TargetCamera("cam", new Vector3(0, 10, -10), scene);
    this.camera.minZ = 0.2;
    this.camera.maxZ = 6000;
    this.camera.fov = 1.0;
  }

  /** The point the camera orbits, pushed ahead along the view by `ahead` × 100 m (to centre shadows on what's visible). */
  focusAhead(ahead: number): Vector3 {
    const fwd = this.target.subtract(this.camera.position);
    fwd.y = 0;
    const len = fwd.length();
    return len > 0.01 ? this.target.add(fwd.scale((ahead * 100) / len)) : this.target.clone();
  }

  /** Brief camera kick for heavy skills, slams, and ultimates. */
  punch(amount: number) {
    this.shake = Math.min(0.6, Math.max(this.shake, amount));
  }

  update(px: number, py: number, pz: number, yaw: number, pitch: number, zoom: number, speed: number, dt: number) {
    // Follow a point cleanly above the head & feather crest so the center crosshair doesn't occlude them.
    const k = 1 - Math.exp(-18 * dt);
    const ty = py + 2.35;
    this.target.x += (px - this.target.x) * k;
    this.target.y += (ty - this.target.y) * k;
    this.target.z += (pz - this.target.z) * k;
    if (Vector3.DistanceSquared(this.target, new Vector3(px, ty, pz)) > 400) this.target.set(px, ty, pz);

    // Pull back a little and widen FOV slightly at flight/dive speeds for velocity feel.
    const desired = zoom + Math.min(6, speed * 0.08);
    const targetFov = 1.0 + Math.min(0.16, Math.max(0, speed - 12) * 0.0045);
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-5 * dt));
    const cp = Math.cos(pitch);
    const dir = { x: -Math.sin(yaw) * cp, y: -Math.sin(pitch), z: -Math.cos(yaw) * cp };
    const origin = { x: this.target.x, y: this.target.y, z: this.target.z };
    const hit = raycast(this.world, origin, dir, desired);
    const allowed = Math.max(0.8, hit - 0.3);
    // Snap in when blocked, ease back out when clear.
    this.distance = allowed < this.distance ? allowed : this.distance + (allowed - this.distance) * (1 - Math.exp(-4 * dt));

    this.shakeT += dt * 42;
    this.shake *= Math.exp(-11 * dt);
    const sx = this.shake > 0.002 ? Math.sin(this.shakeT * 1.3) * this.shake : 0;
    const sy = this.shake > 0.002 ? Math.cos(this.shakeT * 1.9) * this.shake * 0.8 : 0;

    const pos = this.camera.position;
    pos.set(origin.x + dir.x * this.distance + sx, origin.y + dir.y * this.distance + sy, origin.z + dir.z * this.distance);
    if (pos.z > RIM_Z && pos.y < SEA_LEVEL + 0.5) pos.y = SEA_LEVEL + 0.5;
    this.camera.setTarget(this.target);
  }
}
