import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mode, getWorld, randomDraft, type CharacterDraft, type CharacterSummary, type Fx } from "@worlds-edge/shared";
import "./render/shaders.ts";
import { buildEnvironment, buildWorldMesh } from "./render/environment.ts";
import { CharacterRig, lookKey, type CharacterLook } from "./render/character.ts";
import { EnemyRig } from "./render/enemy.ts";
import { Effects } from "./render/effects.ts";
import { FollowCamera } from "./render/camera.ts";
import { Input } from "./input.ts";
import { Hud } from "./hud.ts";
import { Api, ApiError } from "./api.ts";
import { googleSignOut, renderGoogleButton } from "./google.ts";
import { Menus, describe } from "./menus.ts";
import { OfflineSession, OnlineSession, type PlayerView, type Session } from "./session.ts";

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

const light = new HemisphericLight("sun", new Vector3(0.3, 1, 0.4), scene);
light.groundColor = new Color3(0.45, 0.5, 0.6);

const world = getWorld();
const worldMesh = buildWorldMesh(scene, world);
const env = buildEnvironment(scene, worldMesh, quality.ocean);
const follow = new FollowCamera(scene, world);
scene.activeCamera = follow.camera;

const input = new Input(canvas);
input.forceActive = params.has("test");
const hud = new Hud();
const menus = new Menus();
const menu = document.getElementById("menu") as HTMLDivElement;
const url = serverUrl();
const api = url ? new Api(url) : null;

input.on("KeyH", () => hud.toggleHelp());
window.addEventListener("keydown", (e) => {
  if (e.code === "F3") { e.preventDefault(); hud.toggleDebug(); }
});
window.addEventListener("resize", () => engine.resize());

// --- App state ------------------------------------------------------------------------

type Phase = "title" | "create" | "playing";
let phase: Phase = "title";
let session: Session | null = null;
const rigs = new Map<string, CharacterRig>();
let preview: { rig: CharacterRig; look: CharacterLook; since: number } | null = null;
const PREVIEW_SPOT = { x: -66, y: 3.4, z: 24 };

const enemyRigs = new Map<string, EnemyRig>();
const effects = new Effects(scene);
/** Latest positions by player id, for placing effects that name a player. */
const playerPos = new Map<string, { x: number; y: number; z: number }>();

function clearRigs() {
  for (const rig of rigs.values()) rig.dispose();
  for (const rig of enemyRigs.values()) rig.dispose();
  rigs.clear();
  enemyRigs.clear();
  effects.clear();
  playerPos.clear();
}

/** Turn the server's effect batch into visuals and HUD feedback. */
function handleFx(list: Fx[]) {
  const selfId = session?.self()?.id;
  for (const f of list) {
    switch (f.t) {
      case "hit":
        hud.popup(f.x, f.y, f.z, f.weak ? `${f.n} WEAK POINT` : f.blocked ? `${f.n} blocked` : String(f.n), f.weak ? "weak" : f.blocked ? "blocked" : "");
        if (f.broke) hud.popup(f.x, f.y + 0.5, f.z, "GUARD BREAK", "broke");
        break;
      case "hurt": {
        const p = playerPos.get(f.id);
        if (p) hud.popup(p.x, p.y + 2, p.z, `-${f.n}`, "hurt");
        if (f.id === selfId) hud.hurtFlash();
        break;
      }
      case "shot": effects.shot(f.from, f.to); break;
      case "ring": effects.ring(f.x, f.y, f.z, f.r, f.kind); break;
      case "bolt": effects.bolt(f.pts); break;
      case "kill": hud.popup(f.x, f.y, f.z, f.xp ? `+${f.xp} XP` : "", "xp"); break;
      case "level":
        if (f.id === selfId) hud.notice(`Level ${f.level}!`, "level");
        else { const p = playerPos.get(f.id); if (p) hud.popup(p.x, p.y + 2.4, p.z, "Level up!", "xp"); }
        break;
      case "down": break;
    }
  }
}

function setPreview(look: CharacterLook | null) {
  if (preview && look && lookKey(preview.look) === lookKey(look)) return;
  preview?.rig.dispose();
  preview = look ? { rig: new CharacterRig(scene, look), look: { ...look }, since: performance.now() } : null;
}

const draftLook = (d: Omit<CharacterDraft, "name">): CharacterLook & { mantle: string } => ({
  classId: d.classId, origin: d.origin, skin: d.appearance.skin, hair: d.appearance.hair, outfit: d.appearance.outfit, mantle: d.mantle,
});

// --- Screens --------------------------------------------------------------------------------

async function boot() {
  if (!api || !url) { showSignIn(); return; }
  menus.loading("Connecting to First Harbour…");
  let config: Awaited<ReturnType<Api["config"]>>;
  try {
    config = await api.config();
  } catch {
    menus.message("The game server isn't reachable right now.", [
      { label: "Try again", primary: true, run: () => void boot() },
      { label: "Fly solo", run: () => void playSolo() },
    ]);
    return;
  }
  if (api.sessionToken) {
    try { await showCharacters(); return; }
    catch (err) { if (!(err instanceof ApiError && err.status === 401)) console.warn(err); }
  }
  showSignIn(config);
}

function showSignIn(config?: { googleClientId: string | null; devLogin: boolean }, error?: string) {
  phase = "title";
  setPreview(null);
  const slot = menus.signIn({
    googleSlot: !!config?.googleClientId,
    devLogin: !!config?.devLogin,
    error: error ?? (api ? undefined : "No game server is configured, so you can only fly solo."),
    onDev: async (player) => { await api!.signInDev(player); await showCharacters(); },
    onSolo: () => void playSolo(),
  });
  if (slot && config?.googleClientId) {
    renderGoogleButton(slot, config.googleClientId, async (credential) => {
      menus.loading("Signing in…");
      try { await api!.signInWithGoogle(credential); await showCharacters(); }
      catch (err) { showSignIn(config, (err as Error).message); }
    }).catch((err) => { slot.textContent = (err as Error).message; });
  }
}

async function showCharacters(error?: string) {
  phase = "title";
  setPreview(null);
  const { characters, max } = await api!.characters();
  if (characters.length === 0) { showCreate(false); return; }
  menus.characters({
    list: characters,
    max,
    error,
    onPlay: (c) => play(c),
    onDelete: async (c) => { await api!.deleteCharacter(c.id); await showCharacters(); },
    onCreate: () => showCreate(true),
    onSignOut: () => void signOut(),
  });
}

function showCreate(canGoBack: boolean) {
  phase = "create";
  menus.create({
    canGoBack,
    onChange: (d) => setPreview(draftLook(d)),
    onSubmit: async (d) => { const c = await api!.createCharacter(d); await play(c); },
    onBack: () => void showCharacters(),
  });
}

async function play(c: CharacterSummary) {
  menus.loading(`Entering First Harbour as ${c.name}…`);
  try {
    const online = await OnlineSession.connect(url!, api!.sessionToken!, c.id);
    online.onDisconnect = (last, reason) => {
      clearRigs();
      session = new OfflineSession(c.name, draftLook(c), `${reason}. Use the menu to rejoin.`, last);
      hud.notice(`Connection lost: ${reason}. You're flying solo until you rejoin from the menu.`);
    };
    enterWorld(online, `${c.name} · ${describe(c)}`);
  } catch (err) {
    const message = (err as Error).message || "Couldn't join the world.";
    await showCharacters(message).catch(() => showSignIn(undefined, message));
  }
}

async function playSolo() {
  const draft = randomDraft();
  enterWorld(new OfflineSession("Traveller", draftLook(draft), url ? "not signed in" : "no server configured"), "Solo flight");
}

function enterWorld(s: Session, title: string) {
  session = s;
  s.onFx = handleFx;
  s.onNotice = (text) => hud.notice(text);
  phase = "playing";
  setPreview(null);
  menus.hide();
  hud.show(title);
  input.lock();
  canvas.focus();
  // Pointer lock can be refused (no recent click); the menu then offers a button to start.
  setTimeout(() => { if (phase === "playing" && !input.locked) menu.hidden = false; }, 300);
}

async function leaveWorld() {
  phase = "title";
  menu.hidden = true;
  hud.hide();
  const s = session;
  session = null;
  clearRigs();
  if (document.pointerLockElement) document.exitPointerLock();
  await s?.dispose();
}

async function signOut() {
  await leaveWorld();
  api?.setToken(null);
  googleSignOut();
  await boot();
}

// In-game menu: appears whenever the mouse is released (Esc).
document.addEventListener("pointerlockchange", () => {
  if (phase !== "playing") return;
  menu.hidden = input.locked;
});
document.getElementById("menu-resume")!.addEventListener("click", () => { input.lock(); canvas.focus(); });
document.getElementById("menu-characters")!.addEventListener("click", async () => {
  await leaveWorld();
  if (api?.sessionToken) await showCharacters().catch(() => boot());
  else await boot();
});
document.getElementById("menu-signout")!.addEventListener("click", () => void signOut());

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

function frameWorld(now: number, dt: number) {
  const s = session!;
  s.frame(now, () => input.sample());
  const players = s.players();
  const seen = new Set<string>();
  for (const p of players) {
    seen.add(p.id);
    let rig = rigs.get(p.id);
    if (rig && rig.key !== lookKey(p)) { rig.dispose(); rig = undefined; }
    if (!rig) { rig = new CharacterRig(scene, p); rigs.set(p.id, rig); }
    rig.update(p, dt, world);
  }
  for (const [id, rig] of rigs) if (!seen.has(id)) { rig.dispose(); rigs.delete(id); }
  for (const p of players) playerPos.set(p.id, { x: p.x, y: p.y, z: p.z });

  const enemies = s.enemies();
  const seenEnemies = new Set<string>();
  for (const e of enemies) {
    seenEnemies.add(e.id);
    let rig = enemyRigs.get(e.id);
    if (!rig) { rig = new EnemyRig(scene, e.kind); enemyRigs.set(e.id, rig); }
    rig.update(e, dt);
  }
  for (const [id, rig] of enemyRigs) if (!seenEnemies.has(id)) { rig.dispose(); enemyRigs.delete(id); }
  effects.update(dt);

  const self = s.self();
  if (self) {
    const speed = Math.hypot(self.vx, self.vy, self.vz);
    follow.update(self.x, self.y, self.z, input.yaw, input.pitch, input.zoom, speed, dt);
    hud.update(self, s.kind === "online");
  }
  hud.setStatus(s.status());
  hud.updateLabels(players, project);
  const cam = follow.camera.position;
  hud.updateEnemyBars(enemies, cam.x, cam.y, cam.z, project);
  hud.updatePopups(dt, project);
  if (hud.debugVisible && self) {
    hud.setDebug(
      `fps ${engine.getFps().toFixed(0)}  scale ${scaling.toFixed(2)}  quality ${qualityName}\n` +
      `meshes ${scene.getActiveMeshes().length}  players ${players.length}\n` +
      `pos ${self.x.toFixed(1)}, ${self.y.toFixed(1)}, ${self.z.toFixed(1)}`,
    );
  }
}

/** Creation preview: turns slowly, alternating an idle stance and a flight pose. */
function framePreview(now: number, dt: number) {
  const p = preview!;
  const t = (now - p.since) / 1000;
  const flying = Math.floor(t / 3.5) % 2 === 1;
  const facing = Math.PI + Math.sin(t * 0.5) * 0.9;
  const view: PlayerView = {
    id: "preview", name: "", isSelf: true, away: false, ...p.look,
    x: PREVIEW_SPOT.x, y: PREVIEW_SPOT.y + (flying ? 1.2 : 0), z: PREVIEW_SPOT.z,
    vx: flying ? Math.sin(facing) * 9 : 0, vy: 0, vz: flying ? Math.cos(facing) * 9 : 0,
    facing, mode: flying ? Mode.Flight : Mode.Ground, stamina: 100, exhausted: 0,
    mantle: "", attackTime: 0, attackCombo: 0, downTime: 0, hp: 1, maxHp: 1, level: 1, xp: 0, mantleAwakened: false, abilityCooldown: 0,
  };
  p.rig.update(view, dt, world);
  // Camera in front of the character, shifted so it sits right of the creation panel.
  const yaw = 0.25;
  const wide = canvas.clientWidth > 700;
  const shift = wide ? 1.3 : 0;
  const cx = PREVIEW_SPOT.x - Math.cos(yaw) * shift;
  const cz = PREVIEW_SPOT.z + Math.sin(yaw) * shift;
  follow.update(cx, PREVIEW_SPOT.y - 0.5, cz, yaw, -0.12, wide ? 5 : 6.5, 0, dt);
}

engine.runRenderLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (phase === "playing" && session) frameWorld(now, dt);
  else if (preview) framePreview(now, dt);
  else {
    // Title: a slow orbit over First Harbour.
    const t = (now - startTime) / 1000;
    follow.update(world.spawn.x + 60, 30, world.spawn.z, t * 0.05 + 2.2, -0.25, 60, 0, dt);
  }

  env.update(follow.camera.position, (now - startTime) / 1000);
  adaptResolution(now);
  scene.render();
});

// Automated tests (?test): a small handle for driving the game without a mouse.
if (params.has("test")) {
  (window as unknown as Record<string, unknown>).__we = {
    teleport: (x: number, y: number, z: number) => (session as OnlineSession | null)?.devTeleport?.(x, y, z),
    self: () => session?.self(),
    enemies: () => session?.enemies(),
    look: (yaw: number, pitch: number) => { input.yaw = yaw; input.pitch = pitch; },
  };
}

void boot();
