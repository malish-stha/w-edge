import type { Scene } from "@babylonjs/core/scene.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { RIM_Z, SEA_LEVEL, raycast, type World } from "@worlds-edge/shared";

/** Third-person orbit camera that keeps a stable horizon and stays out of walls. */
export class FollowCamera {
  readonly camera: TargetCamera;
  private target = new Vector3();
  private distance = 8;

  /** Collision geometry for keeping the camera out of walls; swapped when changing rooms. */
  world: World;

  constructor(scene: Scene, world: World) {
    this.world = world;
    this.camera = new TargetCamera("cam", new Vector3(0, 10, -10), scene);
    this.camera.minZ = 0.2;
    this.camera.maxZ = 6000;
    this.camera.fov = 1.0;
  }

  update(px: number, py: number, pz: number, yaw: number, pitch: number, zoom: number, speed: number, dt: number) {
    // Follow a point above the shoulders, smoothed slightly so landings don't jolt.
    const k = 1 - Math.exp(-18 * dt);
    this.target.x += (px - this.target.x) * k;
    this.target.y += (py + 1.6 - this.target.y) * k;
    this.target.z += (pz - this.target.z) * k;
    if (Vector3.DistanceSquared(this.target, new Vector3(px, py + 1.6, pz)) > 400) this.target.set(px, py + 1.6, pz);

    // Pull back a little at speed for a sense of velocity.
    const desired = zoom + Math.min(6, speed * 0.08);
    const cp = Math.cos(pitch);
    const dir = { x: -Math.sin(yaw) * cp, y: -Math.sin(pitch), z: -Math.cos(yaw) * cp };
    const origin = { x: this.target.x, y: this.target.y, z: this.target.z };
    const hit = raycast(this.world, origin, dir, desired);
    const allowed = Math.max(0.8, hit - 0.3);
    // Snap in when blocked, ease back out when clear.
    this.distance = allowed < this.distance ? allowed : this.distance + (allowed - this.distance) * (1 - Math.exp(-4 * dt));

    const pos = this.camera.position;
    pos.set(origin.x + dir.x * this.distance, origin.y + dir.y * this.distance, origin.z + dir.z * this.distance);
    if (pos.z > RIM_Z && pos.y < SEA_LEVEL + 0.5) pos.y = SEA_LEVEL + 0.5;
    this.camera.setTarget(this.target);
  }
}
