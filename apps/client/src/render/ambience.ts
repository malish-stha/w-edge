import type { Scene } from "@babylonjs/core/scene.js";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import "@babylonjs/core/Particles/particleSystemComponent.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { ENV_MODELS, RIM_Z, SEA_LEVEL, SHRINE, type World } from "@worlds-edge/shared";
import type { QualityName } from "./atmosphere.ts";

/**
 * Small touches of life with cheap particles: the wind beacon's fire (a
 * landmark you can see from the isles), motes rising at the shrine, flickering
 * torches, and spray and mist where the ocean pours over the World's Edge.
 */
export class Ambience {
  private systems: ParticleSystem[] = [];
  private rim: ParticleSystem[] = [];
  private texture: DynamicTexture;
  private rate: number;

  constructor(private scene: Scene, quality: QualityName) {
    this.rate = quality === "low" ? 0.4 : quality === "high" ? 1.3 : 1;
    // A soft round dot, shared by every system.
    this.texture = new DynamicTexture("ambience-dot", { width: 64, height: 64 }, scene, false);
    const ctx = this.texture.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.7)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.texture.hasAlpha = true;
    this.texture.update();
  }

  /** Rebuild for the overworld or a dungeon arena. */
  setWorld(world: World, overworld: boolean) {
    for (const s of [...this.systems, ...this.rim]) s.dispose(false);
    this.systems = [];
    this.rim = [];

    const beacon = world.boxes.find((b) => b.tag === "beacon");
    if (beacon) {
      const at = new Vector3((beacon.minX + beacon.maxX) / 2, beacon.maxY + 0.6, (beacon.minZ + beacon.maxZ) / 2);
      this.fire(at, 1.6, 90);
      this.smoke(at.add(new Vector3(0, 3, 0)));
    }
    if (overworld) this.motes(new Vector3(SHRINE.x, SHRINE.y + 0.9, SHRINE.z));

    const torches: Vector3[] = [];
    for (const area of world.areas) {
      for (const p of area.placements) {
        if (!p.model.endsWith("/torch_lit")) continue;
        const info = ENV_MODELS[p.model];
        if (info) torches.push(new Vector3(p.x, p.y + info.max[1] * p.sy - 0.1 * p.sy, p.z));
      }
    }
    if (torches.length) this.torchFlames(torches.filter((t) => !beacon || Math.hypot(t.x - (beacon.minX + beacon.maxX) / 2, t.z - (beacon.minZ + beacon.maxZ) / 2) > 4));
    if (overworld) this.rimSpray();
  }

  /** Keep the rim's spray near the camera, and only run it when the rim is in sight. */
  update(camera: Vector3) {
    const near = Math.abs(camera.z - RIM_Z) < 900;
    for (const s of this.rim) {
      if (near && !s.isStarted()) s.start();
      else if (!near && s.isStarted()) s.stop();
      (s.emitter as Vector3).set(camera.x, (s.emitter as Vector3).y, RIM_Z);
    }
  }

  private make(name: string, capacity: number, emitter: Vector3) {
    const s = new ParticleSystem(name, Math.max(8, Math.round(capacity * this.rate)), this.scene);
    s.particleTexture = this.texture;
    s.emitter = emitter;
    s.isLocal = false;
    this.systems.push(s);
    return s;
  }

  private fire(at: Vector3, size: number, count: number) {
    const s = this.make("beacon-fire", count, at);
    s.minEmitBox = new Vector3(-0.9, 0, -0.9);
    s.maxEmitBox = new Vector3(0.9, 0.4, 0.9);
    s.color1 = new Color4(1, 0.78, 0.3, 1);
    s.color2 = new Color4(1, 0.45, 0.12, 1);
    s.colorDead = new Color4(0.5, 0.1, 0, 0);
    s.minSize = size * 0.6; s.maxSize = size * 1.5;
    s.minLifeTime = 0.35; s.maxLifeTime = 0.9;
    s.emitRate = count * 1.6 * this.rate;
    s.blendMode = ParticleSystem.BLENDMODE_ADD;
    s.direction1 = new Vector3(-0.4, 3, -0.4);
    s.direction2 = new Vector3(0.4, 5, 0.4);
    s.minEmitPower = 0.8; s.maxEmitPower = 1.6;
    s.gravity = new Vector3(0, 2.5, 0);
    s.start();
  }

  private smoke(at: Vector3) {
    const s = this.make("beacon-smoke", 50, at);
    s.minEmitBox = new Vector3(-0.6, 0, -0.6);
    s.maxEmitBox = new Vector3(0.6, 0.5, 0.6);
    s.color1 = new Color4(0.75, 0.74, 0.72, 0.35);
    s.color2 = new Color4(0.6, 0.6, 0.6, 0.25);
    s.colorDead = new Color4(0.8, 0.82, 0.85, 0);
    s.minSize = 2.5; s.maxSize = 5;
    s.minScaleY = 1; s.maxScaleY = 1;
    s.minLifeTime = 3; s.maxLifeTime = 6;
    s.emitRate = 9 * this.rate;
    s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    s.direction1 = new Vector3(0.3, 2, 0.1);
    s.direction2 = new Vector3(1.2, 3, 0.6);
    s.minEmitPower = 0.6; s.maxEmitPower = 1.2;
    s.addSizeGradient(0, 2);
    s.addSizeGradient(1, 7);
    s.start();
  }

  private motes(at: Vector3) {
    const s = this.make("shrine-motes", 70, at);
    s.minEmitBox = new Vector3(-2.2, 0, -2.2);
    s.maxEmitBox = new Vector3(2.2, 1.5, 2.2);
    s.color1 = new Color4(0.55, 0.85, 1, 1);
    s.color2 = new Color4(0.8, 0.95, 1, 1);
    s.colorDead = new Color4(0.4, 0.7, 1, 0);
    s.minSize = 0.12; s.maxSize = 0.32;
    s.minLifeTime = 2.5; s.maxLifeTime = 4.5;
    s.emitRate = 16 * this.rate;
    s.blendMode = ParticleSystem.BLENDMODE_ADD;
    s.direction1 = new Vector3(-0.15, 1, -0.15);
    s.direction2 = new Vector3(0.15, 1.6, 0.15);
    s.minEmitPower = 0.5; s.maxEmitPower = 1;
    s.gravity = new Vector3(0, 0.15, 0);
    s.start();
  }

  /** One system for every torch: each flame particle starts at a random torch. */
  private torchFlames(torches: Vector3[]) {
    const s = this.make("torches", 18 * torches.length, torches[0].clone());
    s.startPositionFunction = (_m, pos) => {
      const t = torches[Math.floor(Math.random() * torches.length)];
      pos.set(t.x + (Math.random() - 0.5) * 0.25, t.y + Math.random() * 0.2, t.z + (Math.random() - 0.5) * 0.25);
    };
    s.color1 = new Color4(1, 0.8, 0.35, 1);
    s.color2 = new Color4(1, 0.5, 0.15, 1);
    s.colorDead = new Color4(0.4, 0.1, 0, 0);
    s.minSize = 0.25; s.maxSize = 0.55;
    s.minLifeTime = 0.25; s.maxLifeTime = 0.55;
    s.emitRate = 26 * torches.length * this.rate;
    s.blendMode = ParticleSystem.BLENDMODE_ADD;
    s.direction1 = new Vector3(-0.1, 1, -0.1);
    s.direction2 = new Vector3(0.1, 1.6, 0.1);
    s.minEmitPower = 0.5; s.maxEmitPower = 1;
    s.start();
  }

  /** Spray thrown up where the sea pours over the rim, and mist rolling below it. */
  private rimSpray() {
    const spray = this.make("rim-spray", 320, new Vector3(0, SEA_LEVEL + 0.8, RIM_Z + 3));
    spray.minEmitBox = new Vector3(-320, 0, -3);
    spray.maxEmitBox = new Vector3(320, 1.5, 3);
    spray.color1 = new Color4(1, 1, 1, 0.6);
    spray.color2 = new Color4(0.85, 0.94, 1, 0.45);
    spray.colorDead = new Color4(1, 1, 1, 0);
    spray.minSize = 3; spray.maxSize = 7;
    spray.minLifeTime = 2; spray.maxLifeTime = 3.5;
    spray.emitRate = 95 * this.rate;
    spray.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    spray.direction1 = new Vector3(-0.3, 1.6, -1.2);
    spray.direction2 = new Vector3(0.3, 2.6, -0.4);
    spray.minEmitPower = 2; spray.maxEmitPower = 4;
    spray.gravity = new Vector3(0, -4, 0);
    spray.addSizeGradient(0, 3);
    spray.addSizeGradient(1, 9);
    this.rim.push(spray);

    const mist = this.make("rim-mist", 120, new Vector3(0, -40, RIM_Z));
    mist.minEmitBox = new Vector3(-380, -40, -60);
    mist.maxEmitBox = new Vector3(380, 10, -5);
    mist.color1 = new Color4(1, 1, 1, 0.22);
    mist.color2 = new Color4(0.9, 0.95, 1, 0.16);
    mist.colorDead = new Color4(1, 1, 1, 0);
    mist.minSize = 25; mist.maxSize = 45;
    mist.minLifeTime = 6; mist.maxLifeTime = 10;
    mist.emitRate = 14 * this.rate;
    mist.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    mist.direction1 = new Vector3(-0.5, -0.3, -0.6);
    mist.direction2 = new Vector3(0.5, 0.4, -0.2);
    mist.minEmitPower = 1; mist.maxEmitPower = 2;
    this.rim.push(mist);
    // Both are started by update() once the rim is near.
    this.systems = this.systems.filter((s) => !this.rim.includes(s));
  }
}
