import {
  BossPhase, ENEMY_KINDS, ENEMY_SIZE, EnemyState, LEVEL_XP, MANTLE_SKILLS, MAX_LEVEL, Mode, RIM_Z, STAMINA_MAX, levelProgress,
} from "@worlds-edge/shared";
import type { BossView, EnemyView, PlayerView, Roster } from "./session.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MODE_LABELS: Record<number, string> = {
  [Mode.Ground]: "Walking",
  [Mode.Air]: "Airborne",
  [Mode.Flight]: "Flying",
  [Mode.Dive]: "Diving",
};

type Project = (x: number, y: number, z: number) => { x: number; y: number } | null;

interface Popup { el: HTMLDivElement; x: number; y: number; z: number; t: number; life: number }

export class Hud {
  private root = $("hud");
  private who = $("who");
  private status = $("status");
  private mode = $("mode");
  private speed = $("speed");
  private altitude = $("altitude");
  private staminaFill = $("stamina-fill");
  private compass = $("compass");
  private help = $("help");
  private debug = $("debug");
  private hpFill = $("hp-fill");
  private hpText = $("hp-text");
  private level = $("level");
  private xpFill = $("xp-fill");
  private xpText = $("xp-text");
  private ability = $("ability");
  private abilityName = $("ability-name");
  private abilityState = $("ability-state");
  private abilityCd = $("ability-cd");
  private prompt = $("prompt");
  private downed = $("downed");
  private vignette = $("vignette");
  private notices = $("notices");
  private labelLayer = $("labels");
  private labels = new Map<string, HTMLDivElement>();
  private enemyBars = new Map<string, HTMLDivElement>();
  private popups: Popup[] = [];

  show(title: string) {
    this.who.textContent = title;
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
    for (const el of this.labels.values()) el.remove();
    for (const el of this.enemyBars.values()) el.remove();
    for (const p of this.popups) p.el.remove();
    this.labels.clear();
    this.enemyBars.clear();
    this.popups = [];
    this.notices.replaceChildren();
  }

  toggleHelp() { this.help.hidden = !this.help.hidden; }
  toggleDebug() { this.debug.hidden = !this.debug.hidden; }
  get debugVisible() { return !this.debug.hidden; }

  setStatus(text: string) {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  setDebug(text: string) { this.debug.textContent = text; }

  update(self: PlayerView, online: boolean) {
    const hSpeed = Math.hypot(self.vx, self.vz);
    const speed = Math.hypot(self.vx, self.vy, self.vz);
    let label = MODE_LABELS[self.mode] ?? "";
    if (self.mode === Mode.Flight && hSpeed < 2 && Math.abs(self.vy) < 2) label = "Hovering";
    if (self.mode === Mode.Flight && hSpeed > 20) label = "Boosting";
    this.mode.textContent = label;
    this.speed.textContent = `${Math.round(speed)} m/s`;
    this.altitude.textContent = `${Math.round(self.y)} m`;
    this.staminaFill.style.width = `${(self.stamina / STAMINA_MAX) * 100}%`;
    this.staminaFill.classList.toggle("exhausted", self.exhausted === 1);

    const toRim = self.z - RIM_Z;
    this.compass.innerHTML = toRim > 0
      ? `World's Edge <b>${toRim >= 1000 ? (toRim / 1000).toFixed(1) + " km" : Math.round(toRim) + " m"}</b> — fly toward the bright horizon`
      : `<b>Beyond the rim</b> — the settlement lies below the falls`;

    // Health and experience.
    const hpRatio = self.maxHp ? self.hp / self.maxHp : 1;
    this.hpFill.style.width = `${hpRatio * 100}%`;
    this.hpFill.parentElement!.classList.toggle("low", hpRatio < 0.3);
    this.hpText.textContent = String(Math.ceil(self.hp));
    this.level.textContent = `Lv ${self.level}`;
    this.xpFill.style.width = `${levelProgress(self.xp) * 100}%`;
    this.xpText.textContent = self.level >= MAX_LEVEL ? "max" : `${self.xp}/${LEVEL_XP[self.level]}`;
    this.downed.hidden = self.downTime <= 0;

    // Mantle skill slot.
    const skill = MANTLE_SKILLS[self.mantle];
    this.abilityName.textContent = skill?.name ?? "Mantle skill";
    const locked = !self.mantleAwakened;
    this.ability.classList.toggle("locked", locked);
    this.abilityState.textContent = !online ? "Needs a server" : locked ? "Dormant — visit the shrine"
      : self.abilityCooldown >= 0.05 ? `${self.abilityCooldown.toFixed(1)} s` : "Ready";
    this.abilityCd.style.width = locked || !skill ? "0" : `${(1 - self.abilityCooldown / skill.cooldown) * 100}%`;

  }

  /** The context prompt near the middle of the screen (key + text), or null to hide it. */
  setPrompt(prompt: { key?: string; text: string } | null) {
    this.prompt.hidden = !prompt;
    if (!prompt) return;
    const html = `${prompt.key ? `<kbd>${prompt.key}</kbd>` : ""}${escapeHtml(prompt.text)}`;
    if (this.prompt.innerHTML !== html) this.prompt.innerHTML = html;
  }

  /** Teammates' frames: name, level, health, and revive progress when down. */
  updateParty(roster: Roster | null, players: PlayerView[], selfId: string) {
    const frames = $("party-frames");
    if (!roster) { if (frames.childElementCount) frames.replaceChildren(); return; }
    const rows = roster.members.filter((m) => m.sessionId !== selfId).map((m) => {
      const p = players.find((x) => x.id === m.sessionId);
      const down = !!p && p.downTime > 0;
      const hp = p ? p.hp / (p.maxHp || 1) : 0;
      return `<div class="party-frame${down ? " down" : ""}">
        <div class="row1"><span class="${m.leader ? "leader" : ""}">${escapeHtml(m.name)}</span><span>${p ? (down ? "down" : `Lv ${p.level}`) : "elsewhere"}</span></div>
        ${p ? `<div class="bar hp${hp < 0.3 ? " low" : ""}"><div style="width:${hp * 100}%"></div></div>` : ""}
        ${down && p!.reviveProgress > 0 ? `<div class="bar revive"><div style="width:${p!.reviveProgress * 100}%"></div></div>` : ""}
      </div>`;
    }).join("");
    if (frames.innerHTML !== rows) frames.innerHTML = rows;
  }

  updateBoss(boss: BossView | null) {
    const el = $("boss");
    el.hidden = !boss;
    this.compass.hidden = !!boss;
    if (!boss) return;
    $("boss-hp").style.width = `${(boss.hp / (boss.maxHp || 1)) * 100}%`;
    const armoured = boss.phase === BossPhase.Heart && boss.exposed <= 0;
    $("boss-armour").parentElement!.style.visibility = armoured ? "visible" : "hidden";
    $("boss-armour").style.width = `${(boss.armour / (boss.maxArmour || 1)) * 100}%`;
    const objective = boss.phase === BossPhase.Heart && boss.exposed > 0 ? `${boss.objective} (${Math.ceil(boss.exposed)} s)` : boss.objective;
    if ($("boss-objective").textContent !== objective) $("boss-objective").textContent = objective;
  }

  notice(text: string, kind: "" | "level" = "") {
    const el = document.createElement("div");
    el.className = `notice ${kind}`;
    el.textContent = text;
    this.notices.prepend(el);
    while (this.notices.children.length > 3) this.notices.lastElementChild!.remove();
    setTimeout(() => el.remove(), kind === "level" ? 5000 : 4000);
  }

  hurtFlash() {
    this.vignette.classList.add("on");
    requestAnimationFrame(() => requestAnimationFrame(() => this.vignette.classList.remove("on")));
  }

  /** A floating number or word that rises and fades at a world position. */
  popup(x: number, y: number, z: number, text: string, cls = "") {
    const el = document.createElement("div");
    el.className = `popup ${cls}`;
    el.textContent = text;
    this.labelLayer.appendChild(el);
    this.popups.push({ el, x: x + (Math.random() - 0.5) * 0.6, y, z, t: 0, life: 0.9 });
  }

  updatePopups(dt: number, project: Project) {
    this.popups = this.popups.filter((p) => {
      p.t += dt;
      if (p.t >= p.life) { p.el.remove(); return false; }
      const s = project(p.x, p.y + p.t * 1.6, p.z);
      if (!s) { p.el.style.display = "none"; return true; }
      p.el.style.display = "";
      p.el.style.left = `${s.x}px`;
      p.el.style.top = `${s.y}px`;
      p.el.style.opacity = String(1 - Math.max(0, p.t - 0.5) / (p.life - 0.5));
      return true;
    });
  }

  /** Health and guard bars over nearby enemies that are hurt, staggered or fighting. */
  updateEnemyBars(enemies: EnemyView[], camX: number, camY: number, camZ: number, project: Project) {
    const seen = new Set<string>();
    for (const e of enemies) {
      const near = Math.hypot(e.x - camX, e.y - camY, e.z - camZ) < 45;
      const engaged = e.hp < e.maxHp || e.guard < e.maxGuard || (e.state !== EnemyState.Idle && e.kind !== "dummy");
      if (!near || !engaged || e.state === EnemyState.Dead) continue;
      const s = project(e.x, e.y + ENEMY_SIZE[e.kind].height + 0.6, e.z);
      if (!s) continue;
      seen.add(e.id);
      let el = this.enemyBars.get(e.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "enemy-bar";
        el.innerHTML = `<small></small><div class="bar ehp"><div></div></div><div class="bar eguard"><div></div></div>`;
        this.labelLayer.appendChild(el);
        this.enemyBars.set(e.id, el);
      }
      const staggered = e.state === EnemyState.Stagger;
      const exposed = e.state === EnemyState.Exposed;
      el.querySelector("small")!.textContent = `${ENEMY_KINDS[e.kind]?.name ?? e.kind}${staggered ? " · staggered" : exposed ? " · back exposed" : ""}`;
      (el.querySelector(".ehp > div") as HTMLDivElement).style.width = `${(e.hp / e.maxHp) * 100}%`;
      (el.querySelector(".eguard > div") as HTMLDivElement).style.width = `${(staggered ? 1 : e.guard / e.maxGuard) * 100}%`;
      el.classList.toggle("staggered", staggered);
      el.style.left = `${s.x}px`;
      el.style.top = `${s.y}px`;
    }
    for (const [id, el] of this.enemyBars) if (!seen.has(id)) { el.remove(); this.enemyBars.delete(id); }
  }

  /** Name tags above other players. */
  updateLabels(players: PlayerView[], project: Project) {
    const seen = new Set<string>();
    for (const p of players) {
      if (p.isSelf) continue;
      seen.add(p.id);
      let el = this.labels.get(p.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "label";
        this.labelLayer.appendChild(el);
        this.labels.set(p.id, el);
      }
      const text = p.away ? `${p.name} (reconnecting)` : p.downTime > 0 ? `${p.name} (down)` : `${p.name} · Lv ${p.level}`;
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle("away", p.away);
      el.style.borderBottom = `2px solid ${p.outfit}`;
      const s = project(p.x, p.y + 2.5, p.z);
      if (s) {
        el.style.display = "";
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
      } else {
        el.style.display = "none";
      }
    }
    for (const [id, el] of this.labels) {
      if (!seen.has(id)) { el.remove(); this.labels.delete(id); }
    }
  }
}
