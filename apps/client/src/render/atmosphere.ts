import type { Scene } from "@babylonjs/core/scene.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";

export type QualityName = "low" | "medium" | "high";

const SHADOWS: Record<QualityName, { size: number; extent: number } | null> = {
  low: null,
  medium: { size: 1024, extent: 120 },
  high: { size: 2048, extent: 170 },
};

/**
 * The look of the frame: sun shadows around the camera and a light colour grade
 * (contrast, a touch more saturation, a soft vignette). Low quality skips both;
 * medium adds FXAA, high adds MSAA and a gentle bloom on bright sky and foam.
 */
export class Atmosphere {
  readonly shadows: ShadowGenerator | null = null;
  private extent = 0;
  private size = 0;
  private enabled = true;

  constructor(scene: Scene, camera: Camera, private sun: DirectionalLight, quality: QualityName) {
    const shadow = SHADOWS[quality];
    if (shadow) {
      this.extent = shadow.extent;
      this.size = shadow.size;
      sun.autoUpdateExtends = false;
      sun.autoCalcShadowZBounds = false;
      sun.shadowFrustumSize = shadow.extent;
      sun.shadowMinZ = 1;
      sun.shadowMaxZ = 700;
      const gen = new ShadowGenerator(shadow.size, sun);
      gen.usePercentageCloserFiltering = true;
      gen.filteringQuality = quality === "high" ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
      gen.bias = 0.0012;
      gen.normalBias = 0.03;
      // Soft, light shadows suit the painted look better than black ones.
      gen.darkness = 0.22;
      gen.transparencyShadow = false;
      this.shadows = gen;
    }

    if (quality !== "low") {
      const pipe = new DefaultRenderingPipeline("look", false, scene, [camera]);
      pipe.imageProcessingEnabled = true;
      const ip = pipe.imageProcessing;
      ip.contrast = 1.08;
      ip.exposure = 1.0;
      ip.colorCurvesEnabled = true;
      const curves = new ColorCurves();
      curves.globalSaturation = 4;
      curves.highlightsHue = 40;
      curves.highlightsDensity = 8;
      curves.highlightsSaturation = 10;
      ip.colorCurves = curves;
      ip.vignetteEnabled = true;
      ip.vignetteWeight = 1.4;
      ip.vignetteStretch = 0.4;
      ip.vignetteColor = new Color4(0.08, 0.12, 0.2, 0);
      if (quality === "high") {
        pipe.samples = 4;
        pipe.bloomEnabled = true;
        pipe.bloomThreshold = 0.86;
        pipe.bloomWeight = 0.22;
        pipe.bloomKernel = 48;
        pipe.bloomScale = 0.5;
      } else {
        pipe.fxaaEnabled = true;
      }
    }
  }

  /** Solid models that throw shadows and show them. */
  addCaster(mesh: AbstractMesh, receive = true) {
    if (!this.shadows) return;
    // An instance draws through its source mesh, which is where shadows are set.
    const source = (mesh as AbstractMesh & { sourceMesh?: AbstractMesh }).sourceMesh ?? mesh;
    this.shadows.addShadowCaster(source, false);
    source.receiveShadows = receive;
  }

  /** Models that only show shadows (flat ground tiles). */
  addReceiver(mesh: AbstractMesh) {
    if (this.shadows) mesh.receiveShadows = true;
  }

  removeCaster(mesh: AbstractMesh) {
    this.shadows?.removeShadowCaster(mesh, false);
  }

  /** Turn shadows off for good (the frame rate can't afford them). */
  disableShadows() {
    if (!this.shadows || !this.enabled) return;
    this.enabled = false;
    this.shadows.getShadowMap()!.refreshRate = 0;
    this.shadows.darkness = 1;
  }

  get shadowsOn() { return !!this.shadows && this.enabled; }

  /** Keep the shadow map centred on what the camera looks at, snapped to whole texels so edges don't shimmer. */
  update(target: Vector3) {
    if (!this.shadows || !this.enabled) return;
    const dir = this.sun.direction.normalizeToNew();
    const right = Vector3.Cross(Vector3.Up(), dir).normalize();
    const up = Vector3.Cross(dir, right).normalize();
    const texel = this.extent / this.size;
    const a = Math.round(Vector3.Dot(target, right) / texel) * texel;
    const b = Math.round(Vector3.Dot(target, up) / texel) * texel;
    const c = Vector3.Dot(target, dir);
    const centre = right.scale(a).add(up.scale(b)).add(dir.scale(c));
    this.sun.position.copyFrom(centre.subtract(dir.scale(350)));
  }
}
