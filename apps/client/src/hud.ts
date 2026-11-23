import {
  BossPhase, CLASS_MECHANICS, ENEMY_KINDS, ENEMY_SIZE, EnemyState, LEVEL_XP,
  MANTLE_EXPLORE, MANTLE_SKILLS, MANTLE_SKILLS_2, MANTLE_ULTIMATES,
  MAX_LEVEL, Mode, ORIGIN_QUESTS, RIM_Z, SHRINE, STAMINA_MAX, UNLOCK_LEVELS,
  levelProgress, techniqueDisplay,
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
  private quest = $("quest");
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
  private ability2 = $("ability2");
  private ability2Name = $("ability2-name");
  private ability2State = $("ability2-state");
  private ability2Cd = $("ability2-cd");
  private ability3 = $("ability3");
  private ability3Name = $("ability3-name");
  private ability3State = $("ability3-state");
  private ability3Cd = $("ability3-cd");
  private ability4 = $("ability4");
  private ability4Name = $("ability4-name");
  private ability4State = $("ability4-state");
  private ability4Cd = $("ability4-cd");
  private classKey = $("class-key");
  private className = $("class-name");
  private classState = $("class-state");
  private techLabel = $("tech-label");
  private classCd = $("class-cd");
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

    // Mantle skill slots 1–3 and Ultimate 4.
    const locked = !self.mantleAwakened;
    const setSlot = (el: HTMLElement, nameEl: HTMLElement, stateEl: HTMLElement, cdEl: HTMLElement, title: string, cd: number, maxCd: number) => {
      nameEl.textContent = title;
      el.classList.toggle("locked", locked);
      stateEl.textContent = !online ? "Offline" : locked ? "Dormant" : cd >= 0.05 ? `${cd.toFixed(1)} s` : "Ready";
      cdEl.style.width = locked || !maxCd ? "0" : `${(1 - cd / maxCd) * 100}%`;
    };
    const s1 = MANTLE_SKILLS[self.mantle];
    setSlot(this.ability, this.abilityName, this.abilityState, this.abilityCd, s1?.name ?? "Mantle 1", self.abilityCooldown, s1?.cooldown ?? 8);
    const s2 = MANTLE_SKILLS_2[self.mantle];
    const s2Locked = locked || self.level < UNLOCK_LEVELS.secondSkill;
    this.ability2Name.textContent = s2?.name ?? "Mantle 2";
    this.ability2.classList.toggle("locked", s2Locked);
    this.ability2State.textContent = !online ? "Offline" : self.level < UNLOCK_LEVELS.secondSkill ? `Lv ${UNLOCK_LEVELS.secondSkill}` : locked ? "Dormant" : self.ability2Cooldown >= 0.05 ? `${self.ability2Cooldown.toFixed(1)} s` : "Ready";
    this.ability2Cd.style.width = s2Locked || !s2 ? "0" : `${(1 - self.ability2Cooldown / s2.cooldown) * 100}%`;
    const s3 = MANTLE_EXPLORE[self.mantle];
    setSlot(this.ability3, this.ability3Name, this.ability3State, this.ability3Cd, s3?.name ?? "Explore", self.exploreCooldown, s3?.cooldown ?? 6);
    const ult = MANTLE_ULTIMATES[self.mantle];
    this.ability4Name.textContent = ult?.name ?? "Ultimate";
    this.ability4.classList.toggle("locked", locked || self.ultCharge < 100);
    this.ability4.classList.toggle("ready", !locked && self.ultCharge >= 100);
    this.ability4State.textContent = !online ? "Offline" : locked ? "Dormant" : self.ultCharge >= 100 ? "READY" : `${Math.floor(self.ultCharge)}%`;
    this.ability4Cd.style.width = locked ? "0" : `${Math.min(100, self.ultCharge)}%`;

    // Class signature mechanic & technique slot.
    const mech = CLASS_MECHANICS[self.classId];
    this.classKey.textContent = mech?.control ?? "RMB";
    this.className.textContent = mech?.name ?? "Class skill";
    let cState = "Ready";
    if (!online) cState = "Needs a server";
    else if (self.guarding) cState = self.classId === "saber" ? "Parrying…" : "Guarding…";
    else if (self.classCharge > 0) cState = self.classId === "archer" ? `${self.classCharge} planted` : `${self.classCharge} stored`;
    else if (self.classCooldown >= 0.05) cState = `${self.classCooldown.toFixed(1)} s`;
    this.classState.textContent = cState;
    this.classCd.style.width = self.classCooldown > 0 ? `${Math.max(0, 1 - self.classCooldown / 2) * 100}%` : "100%";
    const { title } = techniqueDisplay(self.technique, self.classId, self.mantle);
    this.techLabel.textContent = self.level < UNLOCK_LEVELS.technique ? `[K] Techs unlock Lv ${UNLOCK_LEVELS.technique}` : `[K] ${title}`;

    // Origin quest tracker.
    const q = ORIGIN_QUESTS[self.origin];
    if (online && q) {
      this.quest.hidden = false;
      if (self.questStep === 0) {
        const d = Math.round(Math.hypot(self.x - q.target.x, self.z - q.target.z));
        this.quest.textContent = `${q.title}: ${q.step0Text} (${d} m)`;
      } else if (self.questStep === 1) {
        const d = Math.round(Math.hypot(self.x - SHRINE.x, self.z - SHRINE.z));
        this.quest.textContent = `${q.title}: ${q.step1Text} (${d} m)`;
      } else {
        this.quest.textContent = `Charm: ${q.reward}`;
      }
    } else {
      this.quest.hidden = true;
    }
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
