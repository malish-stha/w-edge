import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { getWorld, type MoveState } from "@worlds-edge/shared";
import "./render/shaders.ts";
import { buildEnvironment, buildWorldMesh } from "./render/environment.ts";
import { CharacterRig } from "./render/character.ts";
import { FollowCamera } from "./render/camera.ts";
import { Input } from "./input.ts";
import { Hud } from "./hud.ts";
import { OfflineSession, OnlineSession, type Session } from "./session.ts";

// --- Settings ----------------------------------------------------------------

const params = new URLSearchParams(location.search);

type Quality = "low" | "medium" | "high";
const QUALITY: Record<Quality, { scale: number; maxScale: number; ocean: number; antialias: boolean }> = {
  // Hardware scaling > 1 renders fewer pixels and upscales: the biggest win on integrated GPUs.
  low: { scale: 1.5, maxScale: 2.5, ocean: 48, antialias: false },
  medium: { scale: 1, maxScale: 2, ocean: 96, antialias: false },
  high: { scale: 1 / Math.min(2, window.devicePixelRatio || 1), maxScale: 1.5, ocean: 128, antialias: true },
};
const qualityName = (["low", "medium", "high"] as const).find((q) => q === params.get("quality")) ?? "medium";
const quality = QUALITY[qualityName];

function serverUrl(): string | null {
  if (params.has("offline")) return null;
  const fromParam = params.get("server");
  if (fromParam) return fromParam;
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  if (import.meta.env.DEV) return `ws://${location.hostname}:2567`;
  return null;
}

function savedName(): string {
  try { return localStorage.getItem("we.name") ?? ""; } catch { return ""; }
}
function saveName(name: string) {
  try { localStorage.setItem("we.name", name); } catch { /* storage unavailable: fine */ }
}

// --- Engine and scene ------------------------------------------------------------

const canvas = document.getElementById("game") as HTMLCanvasElement;
const engine = new Engine(canvas, quality.antialias, {
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
}, false);
let scaling = quality.scale;
engine.setHardwareScalingLevel(scaling);

const scene = new Scene(engine);
scene.skipPointerMovePicking = true;
scene.skipFrustumClipping = false;

const light = new HemisphericLight("sun", new Vector3(0.3, 1, 0.4), scene);
light.groundColor = new Color3(0.45, 0.5, 0.6);
light.intensity = 1.0;

const world = getWorld();
const worldMesh = buildWorldMesh(scene, world);
const env = buildEnvironment(scene, worldMesh, quality.ocean);
const follow = new FollowCamera(scene, world);
scene.activeCamera = follow.camera;

const input = new Input(canvas);
const hud = new Hud();
const rigs = new Map<string, CharacterRig>();
let session: Session | null = null;

input.on("KeyH", () => hud.toggleHelp());
window.addEventListener("keydown", (e) => {
  if (e.code === "F3") { e.preventDefault(); hud.toggleDebug(); }
});
window.addEventListener("resize", () => engine.resize());

// --- Start screen -----------------------------------------------------------------

const nameInput = document.getElementById("name") as HTMLInputElement;
const playButton = document.getElementById("play") as HTMLButtonElement;
const startNote = document.getElementById("start-note") as HTMLParagraphElement;
const startScreen = document.getElementById("start") as HTMLDivElement;
nameInput.value = savedName();
const url = serverUrl();
startNote.textContent = url ? "" : "No game server configured: you'll fly solo.";

function goOffline(name: string, reason: string, from?: MoveState) {
  session?.dispose();
  session = new OfflineSession(name, reason, from);
}

async function start() {
  const name = nameInput.value.trim().slice(0, 20) || "Traveller";
  saveName(name);
  playButton.disabled = true;
  if (url) {
    startNote.textContent = "Connecting to First Harbour…";
    try {
      const online = await OnlineSession.connect(url, name);
      online.onDisconnect = (last, reason) => goOffline(name, `${reason}. Reload to rejoin.`, last);
      session = online;
    } catch (err) {
      console.warn("Could not reach the game server, starting solo.", err);
      goOffline(name, "server unreachable");
    }
  } else {
    goOffline(name, "no server configured");
  }
  startScreen.remove();
  hud.show();
  input.lock();
  canvas.focus();
}
playButton.addEventListener("click", start);
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
nameInput.focus();

// --- Frame loop -------------------------------------------------------------------------

let last = performance.now();
let fpsWindowStart = last;
let fpsFrames = 0;
const startTime = last;

function project(x: number, y: number, z: number) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const p = Vector3.Project(new Vector3(x, y, z), Matrix.IdentityReadOnly, scene.getTransformMatrix(), follow.camera.viewport.toGlobal(w, h));
  if (p.z < 0 || p.z > 1) return null;
  return { x: p.x, y: p.y };
}

/** Lower the render resolution when the frame rate drops, raise it when there's headroom. */
function adaptResolution(now: number) {
  fpsFrames++;
  if (now - fpsWindowStart < 2000) return;
  const fps = (fpsFrames * 1000) / (now - fpsWindowStart);
  fpsFrames = 0;
  fpsWindowStart = now;
  if (fps < 45 && scaling < quality.maxScale) scaling = Math.min(quality.maxScale, scaling + 0.25);
  else if (fps > 58 && scaling > quality.scale) scaling = Math.max(quality.scale, scaling - 0.25);
  else return;
  engine.setHardwareScalingLevel(scaling);
}

engine.runRenderLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (session) {
    session.frame(now, () => input.sample());
    const players = session.players();
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      let rig = rigs.get(p.id);
      if (!rig) { rig = new CharacterRig(scene, p.color); rigs.set(p.id, rig); }
      rig.update(p, dt, world);
    }
    for (const [id, rig] of rigs) if (!seen.has(id)) { rig.dispose(); rigs.delete(id); }

    const self = session.self();
    if (self) {
      const speed = Math.hypot(self.vx, self.vy, self.vz);
      follow.update(self.x, self.y, self.z, input.yaw, input.pitch, input.zoom, speed, dt);
      hud.update(self);
    }
    hud.setStatus(session.status());
    hud.updateLabels(players, project);
    if (hud.debugVisible && self) {
      hud.setDebug(
        `fps ${engine.getFps().toFixed(0)}  scale ${scaling.toFixed(2)}  quality ${qualityName}\n` +
        `meshes ${scene.getActiveMeshes().length}  players ${players.length}\n` +
        `pos ${self.x.toFixed(1)}, ${self.y.toFixed(1)}, ${self.z.toFixed(1)}`,
      );
    }
  } else {
    // Behind the start screen: a slow orbit over First Harbour.
    const t = (now - startTime) / 1000;
    follow.update(world.spawn.x + 60, 30, world.spawn.z, t * 0.05 + 2.2, -0.25, 60, 0, dt);
  }

  env.update(follow.camera.position, (now - startTime) / 1000);
  adaptResolution(now);
  scene.render();
});
