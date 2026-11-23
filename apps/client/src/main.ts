import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import {
  BossPhase, COLOSSUS, MANTLES, Mode, ORIGIN_QUESTS, SHRINE, UNLOCK_LEVELS,
  defaultTechniqueFor, getWorld, pathsForMantle, randomDraft, techniqueDisplay, techniquesForClass,
  type CharacterDraft, type CharacterSummary, type Fx, type World,
} from "@worlds-edge/shared";
import { ColossusRig } from "./render/colossus.ts";
import { Dressing } from "./render/dressing.ts";
import { FOG_COLOR } from "./render/shaders.ts";
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
import {
  DungeonRedirect, OfflineSession, OnlineSession,
  type Place, type PlayerView, type Roster, type Session,
} from "./session.ts";

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
// Same fog as the world shader, for everything drawn with standard materials (props, characters).
scene.fogMode = Scene.FOGMODE_EXP2;
scene.fogDensity = 1 / 1400;
scene.fogColor = new Color3(...FOG_COLOR);

const light = new HemisphericLight("sun", new Vector3(0.3, 1, 0.4), scene);
light.groundColor = new Color3(0.45, 0.5, 0.6);

/** The static geometry currently shown: the overworld, or a dungeon arena. */
let world: World = getWorld();
let worldMesh = buildWorldMesh(scene, world);
const env = buildEnvironment(scene, quality.ocean);
const dressing = new Dressing(scene);
dressing.setWorld(world);
const follow = new FollowCamera(scene, world);
scene.activeCamera = follow.camera;

function setWorld(next: World) {
  if (next === world) return;
  worldMesh.dispose(false, true);
  world = next;
  worldMesh = buildWorldMesh(scene, next);
  follow.world = next;
  dressing.setWorld(next);
}

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
let colossusRig: ColossusRig | null = null;
const effects = new Effects(scene);
/** Latest positions by player id, for placing effects that name a player. */
const playerPos = new Map<string, { x: number; y: number; z: number }>();

/** The character being played and where to return after a dungeon. */
let current: { character: CharacterSummary; worldRoomId: string } | null = null;
let roster: Roster | null = null;
let pendingInvite: string | null = null;
let pendingReady: string | null = null;
let partyPanelOpen = false;
let techPanelOpen = false;

function clearRigs() {
  for (const rig of rigs.values()) rig.dispose();
  for (const rig of enemyRigs.values()) rig.dispose();
  rigs.clear();
  enemyRigs.clear();
  colossusRig?.dispose();
  colossusRig = null;
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
      case "parry": {
        const p = playerPos.get(f.id);
        if (p) hud.popup(p.x, p.y + 2.2, p.z, f.stored > 1 ? `STORED ×${f.stored}` : "PARRY!", "weak");
        break;
      }
      case "pin": effects.pin(f.x, f.y, f.z, f.kind); break;
      case "crossfire": effects.crossfire(f.pts, f.mantle); break;
      case "breakwater":
        effects.ring(f.x, f.y, f.z, f.r, f.mantle === "tide" ? "tide" : f.mantle === "titan" ? "titan" : "impact");
        break;
      case "vault": {
        const p = playerPos.get(f.id);
        if (p) hud.popup(p.x, p.y + 2.2, p.z, "VAULT!", "xp");
        break;
      }
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

/** Join the overworld (or a specific room), following the server back into a live dungeon if needed. */
async function connect(c: CharacterSummary, target?: { roomId: string; place: Place }): Promise<OnlineSession> {
  try {
    return await OnlineSession.connect(url!, api!.sessionToken!, c.id, target);
  } catch (err) {
    if (err instanceof DungeonRedirect) {
      hud.notice("Your party is still in the Drowned Colossus — rejoining.");
      return OnlineSession.connect(url!, api!.sessionToken!, c.id, { roomId: err.roomId, place: "colossus" });
    }
    throw err;
  }
}

async function play(c: CharacterSummary) {
  menus.loading(`Entering First Harbour as ${c.name}…`);
  try {
    const online = await connect(c);
    current = { character: c, worldRoomId: online.place === "world" ? online.roomId : "" };
    enterWorld(online, `${c.name} · ${describe(c)}`);
  } catch (err) {
    const message = (err as Error).message || "Couldn't join the world.";
    await showCharacters(message).catch(() => showSignIn(undefined, message));
  }
}

async function playSolo() {
  const draft = randomDraft();
  current = null;
  enterWorld(new OfflineSession("Traveller", draftLook(draft), url ? "not signed in" : "no server configured"), "Solo flight");
}

/** Wire a session's server events to the HUD, menus and transfers. */
function attach(s: Session) {
  s.onFx = handleFx;
  s.onNotice = (text) => hud.notice(text);
  s.onParty = (r) => { roster = r; if (partyPanelOpen) renderPartyPanel(); };
  s.onInvite = (from) => {
    pendingInvite = from;
    hud.notice(`${from} invites you to their party. Press Y to join or N to decline.`);
  };
  s.onReadyCheck = (leader) => {
    pendingReady = leader;
    hud.notice(`${leader} is ready to face the Drowned Colossus. Press Y when you're ready.`);
  };
  s.onTransfer = (roomId, kind) => void transfer(roomId, kind);
  s.onCleared = (time, xp) => hud.notice(`The Drowned Colossus falls! ${time} · +${xp} XP`, "level");
  if (s instanceof OnlineSession) {
    roster = s.roster;
    const c = current?.character;
    s.onDisconnect = (last, reason) => {
      clearRigs();
      setWorld(getWorld());
      session = new OfflineSession(c?.name ?? "Traveller", c ? draftLook(c) : draftLook(randomDraft()), `${reason}. Use the menu to rejoin.`, s.place === "world" ? last : undefined);
      hud.notice(`Connection lost: ${reason}. You're flying solo until you rejoin from the menu.`);
    };
  }
}

function enterWorld(s: Session, title: string) {
  session = s;
  attach(s);
  setWorld(s.world);
  phase = "playing";
  setPreview(null);
  menus.hide();
  hud.show(title);
  input.lock();
  canvas.focus();
  // Pointer lock can be refused (no recent click); the menu then offers a button to start.
  setTimeout(() => { if (phase === "playing" && !input.locked && !partyPanelOpen) menu.hidden = false; }, 300);
}

/** Move between the overworld and a dungeon: leave this room, join the next. */
async function transfer(roomId: string, kind: "world" | "colossus") {
  if (!current || !(session instanceof OnlineSession)) return;
  const fade = document.getElementById("fade")!;
  fade.classList.add("on");
  const from = session;
  if (from.place === "world") current.worldRoomId = from.roomId;
  pendingReady = null;
  session = null;
  clearRigs();
  await from.dispose();
  try {
    const target = kind === "colossus" ? { roomId, place: "colossus" as const } : { roomId: roomId || current.worldRoomId, place: "world" as const };
    const next = await connect(current.character, target);
    if (next.place === "world") current.worldRoomId = next.roomId;
    session = next;
    attach(next);
    setWorld(next.world);
    if (next.place === "colossus") hud.notice("You arrive before the Drowned Colossus. Break the anchors chaining it upright!");
  } catch (err) {
    hud.notice(`Couldn't get there: ${(err as Error).message}. Rejoining the world.`);
    const back = await connect(current.character).catch(() => null);
    if (back) { session = back; attach(back); setWorld(back.world); }
    else await leaveWorld().then(() => showCharacters("Lost the connection.")).catch(() => boot());
  } finally {
    fade.classList.remove("on");
  }
}

async function leaveWorld() {
  phase = "title";
  menu.hidden = true;
  closePartyPanel(false);
  closeTechPanel(false);
  hud.hide();
  const s = session;
  session = null;
  roster = null;
  pendingInvite = null;
  pendingReady = null;
  clearRigs();
  setWorld(getWorld());
  if (document.pointerLockElement) document.exitPointerLock();
  await s?.dispose();
}

// --- Party panel (P) and quick replies (Y / N) -----------------------------------------

const partyPanel = document.getElementById("party-panel") as HTMLDivElement;
/** Players already invited from the panel (kept across refreshes). */
const invited = new Set<string>();
let partyPanelRendered = 0;

function renderPartyPanel() {
  partyPanelRendered = performance.now();
  const s = session;
  const members = document.getElementById("party-members")!;
  const nearby = document.getElementById("party-nearby")!;
  const selfId = s instanceof OnlineSession ? s.sessionId : "";
  members.replaceChildren(...(roster?.members ?? []).map((m) => {
    const li = document.createElement("li");
    li.className = "character";
    li.innerHTML = `<span class="who"><strong class="${m.leader ? "leader" : ""}"></strong><small>${m.sessionId === selfId ? "You" : m.roomId ? "Online" : "Away"}</small></span>`;
    li.querySelector("strong")!.textContent = m.name;
    return li;
  }));
  document.getElementById("party-empty")!.hidden = !!roster;
  (document.getElementById("party-leave") as HTMLButtonElement).hidden = !roster;

  const inParty = new Set((roster?.members ?? []).map((m) => m.sessionId));
  const others = (s?.players() ?? []).filter((p) => !p.isSelf && !inParty.has(p.id));
  const me = s?.self();
  others.sort((a, b) => (me ? Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z) : 0));
  nearby.replaceChildren(...others.slice(0, 12).map((p) => {
    const li = document.createElement("li");
    li.className = "character";
    const dist = me ? Math.round(Math.hypot(p.x - me.x, p.z - me.z)) : 0;
    li.innerHTML = `<span class="who"><strong></strong><small>Level ${p.level} · ${dist} m away</small></span>`;
    li.querySelector("strong")!.textContent = p.name;
    const invite = document.createElement("button");
    invite.className = "secondary";
    invite.textContent = invited.has(p.id) ? "Invited" : "Invite";
    invite.disabled = invited.has(p.id);
    invite.onclick = () => { (session as OnlineSession).send("party:invite", { sessionId: p.id }); invited.add(p.id); invite.disabled = true; invite.textContent = "Invited"; };
    li.append(invite);
    return li;
  }));
  if (!others.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = s instanceof OnlineSession ? "No one else is here right now." : "Parties need the game server.";
    nearby.append(li);
  }
}

const techPanel = document.getElementById("tech-panel") as HTMLDivElement;

function renderTechPanel() {
  const self = session?.self();
  if (!self) return;
  const list = document.getElementById("tech-list")!;
  const pathList = document.getElementById("path-list")!;
  const intro = document.getElementById("tech-intro")!;
  intro.textContent = `Customise your ${self.classId} signature technique and ${MANTLES.find((m) => m.id === self.mantle)?.name ?? self.mantle} mantle upgrade path.`;
  const techLocked = self.level < UNLOCK_LEVELS.technique;
  const pathLocked = self.level < UNLOCK_LEVELS.upgradePath;
  list.replaceChildren(...techniquesForClass(self.classId).map((t) => {
    const li = document.createElement("li");
    li.className = "character";
    const { title } = techniqueDisplay(t.id, self.classId, self.mantle);
    const active = self.technique === t.id;
    li.innerHTML = `<span class="who"><strong></strong><small></small></span>`;
    li.querySelector("strong")!.textContent = title;
    li.querySelector("small")!.textContent = `${t.effect} Rewards: ${t.rewards}`;
    const btn = document.createElement("button");
    btn.className = active && !techLocked ? "primary" : "secondary";
    btn.textContent = techLocked ? `Lv ${UNLOCK_LEVELS.technique}` : active ? "Equipped" : "Equip";
    btn.disabled = techLocked || active || !(session instanceof OnlineSession);
    btn.onclick = () => {
      if (session instanceof OnlineSession) {
        session.send("technique:set", { id: t.id });
        hud.notice(`Equipped ${title}.`);
        closeTechPanel();
      }
    };
    li.append(btn);
    return li;
  }));
  pathList.replaceChildren(...pathsForMantle(self.mantle).map((p) => {
    const li = document.createElement("li");
    li.className = "character";
    const active = self.mantlePath === p.id;
    li.innerHTML = `<span class="who"><strong></strong><small></small></span>`;
    li.querySelector("strong")!.textContent = p.name;
    li.querySelector("small")!.textContent = p.effect;
    const btn = document.createElement("button");
    btn.className = active && !pathLocked ? "primary" : "secondary";
    btn.textContent = pathLocked ? `Lv ${UNLOCK_LEVELS.upgradePath}` : active ? "Active" : "Select";
    btn.disabled = pathLocked || active || !(session instanceof OnlineSession);
    btn.onclick = () => {
      if (session instanceof OnlineSession) {
        session.send("mantle-path:set", { id: p.id });
        hud.notice(`Selected ${p.name}.`);
        closeTechPanel();
      }
    };
    li.append(btn);
    return li;
  }));
}

function openTechPanel() {
  if (phase !== "playing") return;
  techPanelOpen = true;
  partyPanelOpen = false;
  partyPanel.hidden = true;
  menu.hidden = true;
  renderTechPanel();
  techPanel.hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

function closeTechPanel(relock = true) {
  techPanelOpen = false;
  techPanel.hidden = true;
  if (relock && phase === "playing") { input.lock(); canvas.focus(); }
}

input.on("KeyK", () => (techPanelOpen ? closeTechPanel() : openTechPanel()));
document.getElementById("tech-close")!.addEventListener("click", () => closeTechPanel());
document.getElementById("menu-tech")!.addEventListener("click", () => openTechPanel());

function openPartyPanel() {
  if (phase !== "playing") return;
  partyPanelOpen = true;
  techPanelOpen = false;
  techPanel.hidden = true;
  menu.hidden = true;
  renderPartyPanel();
  partyPanel.hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

function closePartyPanel(relock = true) {
  partyPanelOpen = false;
  partyPanel.hidden = true;
  if (relock && phase === "playing") { input.lock(); canvas.focus(); }
}

input.on("KeyP", () => (partyPanelOpen ? closePartyPanel() : openPartyPanel()));
input.on("KeyY", () => {
  if (!(session instanceof OnlineSession)) return;
  if (pendingInvite) { session.send("party:accept"); pendingInvite = null; }
  else if (pendingReady) { session.send("party:ready"); hud.notice("You're ready."); pendingReady = null; }
});
input.on("KeyN", () => {
  if (!(session instanceof OnlineSession) || !pendingInvite) return;
  session.send("party:decline");
  hud.notice(`You declined ${pendingInvite}'s invitation.`);
  pendingInvite = null;
});
document.getElementById("party-close")!.addEventListener("click", () => closePartyPanel());
document.getElementById("party-leave")!.addEventListener("click", () => {
  if (session instanceof OnlineSession) session.send("party:leave");
});
document.getElementById("menu-party")!.addEventListener("click", () => openPartyPanel());
document.getElementById("menu-dungeon")!.addEventListener("click", () => {
  if (session instanceof OnlineSession && session.place === "colossus") session.send("dungeon:leave");
  menu.hidden = true;
});

async function signOut() {
  await leaveWorld();
  api?.setToken(null);
  googleSignOut();
  await boot();
}

// In-game menu: appears whenever the mouse is released (Esc).
document.addEventListener("pointerlockchange", () => {
  if (phase !== "playing") return;
  menu.hidden = input.locked || partyPanelOpen || techPanelOpen;
  (document.getElementById("menu-dungeon") as HTMLButtonElement).hidden = !(session instanceof OnlineSession && session.place === "colossus");
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

/** What pressing E would do right now, shown as a prompt. */
function contextPrompt(s: Session, self: PlayerView, players: PlayerView[]): { key?: string; text: string } | null {
  if (s.kind !== "online") return null;
  if (self.downTime > 0) return { text: self.reviveProgress > 0 ? `Being revived… ${Math.round(self.reviveProgress * 100)}%` : "Down — hold on for a revive" };
  // A downed player nearby.
  const downed = players.find((p) => !p.isSelf && p.downTime > 0 && Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z) <= COLOSSUS.reviveRange);
  if (downed) return { key: "Hold E", text: downed.reviveProgress > 0 ? `Reviving ${downed.name}… ${Math.round(downed.reviveProgress * 100)}%` : `Revive ${downed.name}` };
  if (pendingInvite) return { key: "Y", text: `Join ${pendingInvite}'s party (N to decline)` };
  if (pendingReady) return { key: "Y", text: `Ready to face the Drowned Colossus` };

  if (s.place === "world") {
    const q = ORIGIN_QUESTS[self.origin];
    if (q && self.questStep === 0 && Math.hypot(self.x - q.target.x, self.z - q.target.z) < q.target.radius && Math.abs(self.y - q.target.y) < 6) {
      return { key: "E", text: q.step0Text };
    }
    const atShrine = Math.hypot(self.x - SHRINE.x, self.z - SHRINE.z) < SHRINE.radius && Math.abs(self.y - SHRINE.y) < 4;
    if (atShrine && (!self.mantleAwakened || self.questStep === 1)) {
      const mName = MANTLES.find((m) => m.id === self.mantle)?.name ?? "your";
      return { key: "E", text: self.questStep === 1 && self.mantleAwakened ? `Complete ${q?.title ?? "origin quest"}` : `Awaken the ${mName} mantle` };
    }
    const g = COLOSSUS.gate;
    if (Math.hypot(self.x - g.x, self.z - g.z) < g.radius && Math.abs(self.y - g.y) < 6) {
      if (self.level < COLOSSUS.minLevel) return { text: `The Drowned Colossus — reach level ${COLOSSUS.minLevel} to enter` };
      const leader = roster?.members.find((m) => m.leader);
      if (roster && leader?.sessionId !== self.id) return { text: `Waiting for ${leader?.name ?? "your leader"} to lead the party in` };
      return { key: "E", text: roster ? "Lead your party into the Drowned Colossus" : "Enter the Drowned Colossus (alone)" };
    }
  } else if (s.place === "colossus" && s.boss()?.phase === BossPhase.Cleared) {
    const e = COLOSSUS.entry;
    if (Math.hypot(self.x - e.x, self.z - e.z) < 12 && Math.abs(self.y - e.y) < 4) return { key: "E", text: "Return to the world" };
  }
  return null;
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

  // Keep the open party panel current (people come and go, distances change).
  if (partyPanelOpen && now - partyPanelRendered > 1000) renderPartyPanel();

  const boss = s.boss();
  if (boss && !colossusRig) colossusRig = new ColossusRig(scene);
  colossusRig?.update(boss!, enemies, dt);
  hud.updateBoss(boss);

  const self = s.self();
  if (self) {
    const speed = Math.hypot(self.vx, self.vy, self.vz);
    follow.update(self.x, self.y, self.z, input.yaw, input.pitch, input.zoom, speed, dt);
    hud.update(self, s.kind === "online");
    hud.setPrompt(contextPrompt(s, self, players));
    hud.updateParty(roster, players, self.id);
  }
  hud.setStatus(s.status());
  hud.updateLabels(players, project);
  const cam = follow.camera.position;
  hud.updateEnemyBars(enemies, cam.x, cam.y, cam.z, project);
  hud.updatePopups(dt, project);
  if (hud.debugVisible && self) {
    hud.setDebug(
      `fps ${engine.getFps().toFixed(0)}  scale ${scaling.toFixed(2)}  quality ${qualityName}\n` +
      `meshes ${scene.getActiveMeshes().length}  players ${players.length}  dressed areas ${dressing.loadedAreas}\n` +
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
    mantle: "", attackTime: 0, attackCombo: 0, downTime: 0, hp: 1, maxHp: 1, level: 1, xp: 0, mantleAwakened: false,
    abilityCooldown: 0, ability2Cooldown: 0, exploreCooldown: 0, ultCharge: 0, giant: false,
    technique: defaultTechniqueFor(p.look.classId), mantlePath: "", questStep: 2,
    guarding: false, classCharge: 0, classCooldown: 0,
    party: "", reviveProgress: 0,
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

  env.update(follow.camera.position, (now - startTime) / 1000, worldMesh);
  dressing.update(follow.camera.position);
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
    send: (type: string, payload?: unknown) => (session as OnlineSession | null)?.send?.(type, payload),
    boss: () => session?.boss() ?? null,
    place: () => session?.place ?? null,
    roster: () => roster,
    players: () => session?.players() ?? [],
    template: (model: string) => {
      const m = scene.getMeshByName(model);
      if (!m) return null;
      const b = m.getBoundingInfo().boundingBox;
      return { min: b.minimum.asArray().map((v) => +v.toFixed(2)), max: b.maximum.asArray().map((v) => +v.toFixed(2)), pos: m.position.asArray(), rot: m.rotationQuaternion?.asArray() ?? m.rotation.asArray(), scale: m.scaling.asArray(), parent: m.parent?.name ?? null };
    },
    hide: (prefix: string) => { for (const m of scene.meshes) if (m.name.startsWith(prefix)) m.setEnabled(false); },
    active: () => scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length).map((m) => m.name),
    /** Dressing meshes: name, enabled, instance count, world bounds (for checking the environment). */
    dressing: () => scene.meshes.filter((m) => m.name.includes(":")).map((m) => {
      const b = m.getBoundingInfo().boundingBox;
      return { name: m.name, enabled: m.isEnabled(), count: (m as unknown as { thinInstanceCount: number }).thinInstanceCount, min: b.minimumWorld.asArray().map(Math.round), max: b.maximumWorld.asArray().map(Math.round) };
    }),
  };
}

void boot();
