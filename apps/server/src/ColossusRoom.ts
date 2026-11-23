import { ServerError, type Client } from "colyseus";
import {
  ANCHORS, ANCHOR_PLATFORMS, BossPhase, COLOSSUS, ENEMY_SIZE, EnemyState,
  getColossusArena, levelForXp, partyScale, raycast,
} from "@worlds-edge/shared";
import type { StoredCharacter } from "./db.ts";
import type { Enemy, Player } from "./schema.ts";
import { GameRoom, getStore } from "./GameRoom.ts";
import { Parties } from "./parties.ts";
import type { HitOptions, HitResult } from "./enemies.ts";

const ARENA = getColossusArena();
const ANCHOR_IDS = ["anchor0", "anchor1", "anchor2"];
const HEART_ID = "heart";
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The Drowned Colossus, one private copy per party.
 *
 * 1. Break the anchors while its arm slams the platforms and Reef Wretches climb aboard.
 * 2. Survive the wave: fly over it, skim the sea beneath it, or shelter behind rock.
 * 3. Break the chest plate (guard), then strike the exposed heart while dodging sweeps.
 * 4. The heart tears free and circles the arena: finish it in flight.
 *
 * A full party wipe resets to the start of the current phase. The clear and its
 * reward are recorded together, once per character per run.
 */
export class ColossusRoom extends GameRoom {
  maxClients = 4;
  readonly world = ARENA;
  protected downSeconds = COLOSSUS.downSeconds;
  private allowed: number[] = [];
  private worldRoomId = "";
  private slamCooldown = 6;
  private sweepCooldown = 9;
  private addCooldown = 15;
  private wavesLeft = 0;
  private wavePause = 0;
  private waveStruck = new Set<string>();
  private heartStartHp = 0;
  private flightAngle = 0;
  private cleared = false;

  onCreate(options: { allowed?: number[]; worldRoomId?: string }) {
    this.allowed = (options?.allowed ?? []).filter(Number.isInteger);
    this.worldRoomId = options?.worldRoomId ?? "";
    this.setup([]);
    const scale = partyScale(this.allowed.length);
    for (const [i, a] of ANCHORS.entries()) {
      this.enemies.spawn({ kind: "anchor", x: a.x, z: a.z, y: a.y, leash: 0 }, false, ANCHOR_IDS[i]);
    }
    const h = COLOSSUS.heart;
    this.enemies.spawn({ kind: "heart", x: h.x, z: h.z, y: h.y - ENEMY_SIZE.heart.height / 2, leash: 0 }, false, HEART_ID);
    this.enemies.override = (id, e, attacker, health, guard, opts) => this.hitHeart(id, e, attacker, health, guard, opts);
    this.enemies.onKilled = (id) => { if (ANCHOR_IDS.includes(id)) this.anchorBroken(); };

    const boss = this.state.boss;
    boss.maxHp = Math.round(COLOSSUS.bossHp * scale);
    boss.hp = boss.maxHp;
    boss.maxArmour = Math.round(COLOSSUS.armour * scale);
    boss.armour = boss.maxArmour;
    this.scaleAnchors();
    this.startPhase(BossPhase.Anchors);

    this.onMessage("dungeon:leave", (client) => this.sendHome(client));
  }

  protected checkJoin(c: StoredCharacter) {
    if (!this.allowed.includes(c.id)) throw new ServerError(403, "This dungeon belongs to another party.");
  }

  protected spawnPoint() {
    const e = COLOSSUS.entry;
    return { x: e.x + (Math.random() - 0.5) * 8, y: e.y, z: e.z + (Math.random() - 0.5) * 4 };
  }

  /** Characters return to the gate, not to arena coordinates. */
  protected savedPosition() { return { x: COLOSSUS.gate.x, y: COLOSSUS.gate.y + 0.5, z: COLOSSUS.gate.z + 6 }; }

  onJoin(client: Client) {
    super.onJoin(client);
    const p = this.state.players.get(client.sessionId)!;
    // Arena checkpoint: the entry platform.
    p.safeX = COLOSSUS.entry.x; p.safeY = COLOSSUS.entry.y; p.safeZ = COLOSSUS.entry.z;
    this.notify(client.sessionId, this.cleared ? "The Colossus has fallen. Press E on the entry platform to return." : "The Drowned Colossus stirs. Break the anchors chaining it upright!");
  }

  async onDispose() {
    Parties.clearDungeon(this.roomId);
    await super.onDispose();
  }

  // --- Phases ----------------------------------------------------------------------------

  private startPhase(phase: number) {
    const boss = this.state.boss;
    boss.phase = phase;
    boss.slamT = -1; boss.sweepT = -1;
    switch (phase) {
      case BossPhase.Anchors:
        boss.anchorsLeft = ANCHOR_IDS.filter((id) => this.state.enemies.get(id)?.state !== EnemyState.Dead).length;
        boss.objective = `Break the anchors (${boss.anchorsLeft} left)`;
        break;
      case BossPhase.Wave:
        this.wavesLeft = COLOSSUS.wave.count;
        this.wavePause = 2;
        boss.wave = -1;
        boss.objective = "Survive the wave: fly over it, skim beneath it, or shelter behind rock";
        this.notifyAll("The Colossus rises! A wave is coming — go over it, skim the sea beneath it, or shelter behind rock.");
        break;
      case BossPhase.Heart:
        boss.wave = -1;
        boss.armour = boss.maxArmour;
        boss.exposed = 0;
        this.heartStartHp = boss.hp;
        this.placeHeart(COLOSSUS.heart.x, COLOSSUS.heart.y, COLOSSUS.heart.z);
        boss.objective = "Break the chest plate, then strike the heart";
        this.notifyAll("Break the Colossus's chest plate! Heavy hits and dives crack it fastest.");
        break;
      case BossPhase.Flight:
        boss.exposed = 0;
        boss.objective = "The heart tore free — chase it down in flight!";
        this.notifyAll("The final platform crumbles — the heart tears free! Chase it through the air!");
        break;
      case BossPhase.Cleared:
        boss.objective = "Defeated — press E on the entry platform to return";
        break;
    }
  }

  private anchorBroken() {
    const boss = this.state.boss;
    boss.anchorsLeft = Math.max(0, boss.anchorsLeft - 1);
    boss.objective = `Break the anchors (${boss.anchorsLeft} left)`;
    this.state.players.forEach((p) => { if (p.downTime <= 0) p.ultCharge = Math.min(100, p.ultCharge + 25); });
    if (boss.anchorsLeft > 0) this.notifyAll(`An anchor chain snaps! ${boss.anchorsLeft} left.`);
    else this.startPhase(BossPhase.Wave);
  }

  protected tick(dt: number) {
    const boss = this.state.boss;
    if (boss.phase === BossPhase.Cleared) return;
    if (this.state.players.size > 0) boss.elapsed += dt;
    this.checkWipe();

    switch (boss.phase) {
      case BossPhase.Anchors:
        this.slams(dt, 9);
        this.adds(dt);
        break;
      case BossPhase.Wave:
        this.waves(dt);
        break;
      case BossPhase.Heart:
        this.slams(dt, 11);
        this.sweeps(dt);
        if (boss.exposed > 0) {
          boss.exposed = Math.max(0, boss.exposed - dt);
          if (boss.exposed === 0) {
            boss.armour = Math.round(boss.maxArmour * 0.6);
            boss.objective = "The plate closed again — break it once more";
          }
        }
        break;
      case BossPhase.Flight: {
        // The heart circles the arena, rising and falling.
        this.flightAngle += dt * 0.3;
        const y = 30 + Math.sin(this.flightAngle * 2.3) * 8;
        this.placeHeart(Math.sin(this.flightAngle) * 30, y, Math.cos(this.flightAngle) * 30);
        break;
      }
    }
    const heart = this.state.enemies.get(HEART_ID);
    if (heart) { heart.hp = boss.hp; heart.maxHp = boss.maxHp; heart.guard = boss.armour; heart.maxGuard = boss.maxArmour; }
  }

  private placeHeart(x: number, y: number, z: number) {
    const heart = this.state.enemies.get(HEART_ID);
    if (!heart) return;
    heart.x = x; heart.y = y - ENEMY_SIZE.heart.height / 2; heart.z = z;
    heart.state = this.state.boss.exposed > 0 ? EnemyState.Exposed : EnemyState.Idle;
  }

  /** The arm slams whichever platform has the most players on it. */
  private slams(dt: number, every: number) {
    const boss = this.state.boss;
    const s = COLOSSUS.slam;
    if (boss.slamT < 0) {
      this.slamCooldown -= dt;
      if (this.slamCooldown > 0) return;
      this.slamCooldown = every;
      let best = ANCHOR_PLATFORMS[Math.floor(Math.random() * 3)], bestCount = 0;
      for (const plat of ANCHOR_PLATFORMS) {
        let count = 0;
        this.state.players.forEach((p) => { if (Math.hypot(p.x - plat.x, p.z - plat.z) < s.radius + 2) count++; });
        if (count > bestCount) { best = plat; bestCount = count; }
      }
      boss.slamX = best.x; boss.slamZ = best.z; boss.slamT = s.telegraph;
      this.fx({ t: "ring", x: r1(best.x), y: best.y, z: r1(best.z), r: s.radius, kind: "telegraph" });
      return;
    }
    boss.slamT -= dt;
    if (boss.slamT > 0) return;
    boss.slamT = -1;
    this.fx({ t: "ring", x: r1(boss.slamX), y: 8, z: r1(boss.slamZ), r: s.radius, kind: "impact" });
    this.state.players.forEach((p, sid) => {
      const dx = p.x - boss.slamX, dz = p.z - boss.slamZ;
      const d = Math.hypot(dx, dz);
      if (d < s.radius && p.y < 8 + 7 && p.y > 8 - 2) this.damagePlayer(sid, s.damage, dx / (d || 1), dz / (d || 1), 12);
    });
  }

  /** The arm sweeps around the Colossus: get high or get away. */
  private sweeps(dt: number) {
    const boss = this.state.boss;
    const s = COLOSSUS.sweep;
    if (boss.sweepT < 0) {
      this.sweepCooldown -= dt;
      if (this.sweepCooldown > 0) return;
      this.sweepCooldown = 13;
      boss.sweepT = s.telegraph;
      this.fx({ t: "ring", x: 0, y: 8, z: 0, r: s.radius, kind: "telegraph" });
      return;
    }
    boss.sweepT -= dt;
    if (boss.sweepT > 0) return;
    boss.sweepT = -1;
    this.state.players.forEach((p, sid) => {
      const d = Math.hypot(p.x, p.z);
      if (d < s.radius && p.y < s.ceiling) this.damagePlayer(sid, s.damage, p.x / (d || 1), p.z / (d || 1), 14);
    });
  }

  /** Reef Wretches climb onto a platform now and then. */
  private adds(dt: number) {
    this.addCooldown -= dt;
    if (this.addCooldown > 0) return;
    this.addCooldown = 22;
    let alive = 0;
    this.state.enemies.forEach((e) => { if (e.kind === "wretch" && e.state !== EnemyState.Dead) alive++; });
    if (alive >= 4) return;
    const plat = ANCHOR_PLATFORMS[Math.floor(Math.random() * 3)];
    for (const side of [-1, 1]) {
      this.enemies.spawn({ kind: "wretch", x: plat.x + side * 3, z: plat.z + 3, y: plat.y, leash: 7 });
    }
  }

  private waves(dt: number) {
    const boss = this.state.boss;
    const w = COLOSSUS.wave;
    if (boss.wave < 0) {
      this.wavePause -= dt;
      if (this.wavePause > 0) return;
      const a = Math.random() * Math.PI * 2;
      boss.waveDirX = Math.sin(a); boss.waveDirZ = Math.cos(a);
      boss.wave = 0;
      this.waveStruck.clear();
      return;
    }
    boss.wave = Math.min(1, boss.wave + dt / w.seconds);
    const front = -95 + 190 * boss.wave;
    this.state.players.forEach((p, sid) => {
      if (this.waveStruck.has(sid) || p.downTime > 0) return;
      const along = p.x * boss.waveDirX + p.z * boss.waveDirZ;
      if (Math.abs(along - front) > 2.5) return;
      if (p.y < w.bandLow || p.y > w.bandHigh) return; // over it, or skimming beneath it
      const shelter = raycast(ARENA, { x: p.x, y: p.y + 1, z: p.z }, { x: -boss.waveDirX, y: 0, z: -boss.waveDirZ }, 8);
      if (shelter < 8) return; // rock between them and the wave
      this.waveStruck.add(sid);
      this.damagePlayer(sid, w.damage, boss.waveDirX, boss.waveDirZ, w.push);
    });
    if (boss.wave >= 1) {
      boss.wave = -1;
      this.wavesLeft--;
      this.wavePause = 2.5;
      if (this.wavesLeft <= 0) this.startPhase(BossPhase.Heart);
    }
  }

  /** The heart: immune until phase 3, armoured until the plate breaks, then exposed. */
  private hitHeart(id: string, e: Enemy, _attacker: string, health: number, guard: number, opts: HitOptions): HitResult | null {
    if (e.kind !== "heart") return null;
    const boss = this.state.boss;
    const res: HitResult = { dealt: 0, killed: false, blocked: false, weak: false };
    const at = { x: r1(e.x), y: r1(e.y + ENEMY_SIZE.heart.height), z: r1(e.z) };
    if (boss.phase < BossPhase.Heart || boss.phase === BossPhase.Cleared) {
      res.blocked = true;
      this.fx({ t: "hit", ...at, n: 0, blocked: 1 });
      return res;
    }
    let broke = false;
    if (boss.phase === BossPhase.Heart && boss.exposed <= 0) {
      boss.armour = Math.max(0, boss.armour - guard * (opts.heavy ? 1.5 : 1));
      health *= 0.1;
      res.blocked = true;
      if (boss.armour === 0) {
        boss.exposed = COLOSSUS.exposedSeconds;
        boss.objective = "The heart is exposed — strike it now!";
        broke = true;
        this.notifyAll("The chest plate breaks! Strike the heart!");
      }
    } else if (boss.phase === BossPhase.Heart) {
      health *= 3;
      res.weak = true;
    }
    res.dealt = Math.round(health);
    boss.hp = Math.max(0, boss.hp - health);
    this.fx({ t: "hit", ...at, n: res.dealt, ...(res.weak ? { weak: 1 as const } : {}), ...(res.blocked ? { blocked: 1 as const } : {}), ...(broke ? { broke: 1 as const } : {}) });
    void id;

    if (boss.phase === BossPhase.Heart && boss.hp <= boss.maxHp * COLOSSUS.flightPhaseAt) this.startPhase(BossPhase.Flight);
    if (boss.hp <= 0) { res.killed = true; void this.clear(); }
    return res;
  }

  // --- Wipes and the clear -----------------------------------------------------------------

  private checkWipe() {
    if (this.state.players.size === 0) return;
    let allDown = true;
    this.state.players.forEach((p) => { if (p.downTime <= 0 && !p.away) allDown = false; });
    if (!allDown) return;
    const boss = this.state.boss;
    this.notifyAll("The party has fallen. Regroup on the entry platform — the fight resets to its last checkpoint.");
    // Everyone recovers at the entry platform shortly.
    this.state.players.forEach((p) => {
      p.safeX = COLOSSUS.entry.x; p.safeY = COLOSSUS.entry.y; p.safeZ = COLOSSUS.entry.z;
      p.downTime = Math.min(p.downTime, 2);
    });
    // Remove adds and reset the current phase.
    this.state.enemies.forEach((e, id) => { if (e.kind === "wretch") this.enemies.remove(id); });
    boss.slamT = -1; boss.sweepT = -1; this.slamCooldown = 6; this.sweepCooldown = 9;
    if (boss.phase === BossPhase.Anchors) {
      for (const id of ANCHOR_IDS) this.enemies.restore(id);
      this.scaleAnchors();
      this.startPhase(BossPhase.Anchors);
    } else if (boss.phase === BossPhase.Wave) {
      this.startPhase(BossPhase.Wave);
    } else {
      boss.hp = this.heartStartHp;
      this.startPhase(BossPhase.Heart);
    }
  }

  private scaleAnchors() {
    const hp = Math.round(COLOSSUS.anchorHp * partyScale(this.allowed.length));
    for (const id of ANCHOR_IDS) {
      const a = this.state.enemies.get(id);
      if (a && a.state !== EnemyState.Dead) { a.maxHp = hp; a.hp = hp; }
    }
  }

  private async clear() {
    if (this.cleared) return;
    this.cleared = true;
    const boss = this.state.boss;
    const heart = this.state.enemies.get(HEART_ID);
    if (heart) heart.state = EnemyState.Dead;
    this.state.enemies.forEach((e, id) => { if (e.kind === "wretch") this.enemies.remove(id); });
    this.startPhase(BossPhase.Cleared);
    const time = `${Math.floor(boss.elapsed / 60)}:${String(Math.floor(boss.elapsed % 60)).padStart(2, "0")}`;
    this.fx({ t: "kill", x: 0, y: 20, z: 4, xp: COLOSSUS.clearXp });
    const store = getStore();
    await Promise.all([...this.meta.entries()].map(async ([sid, m]) => {
      const p = this.state.players.get(sid);
      const xp = await store.grantClear(this.roomId, m.characterId, COLOSSUS.clearXp);
      if (p && xp !== null) {
        this.setXp(sid, p, xp);
        p.level = levelForXp(p.xp);
        this.clientOf(sid)?.send("cleared", { time, xp: COLOSSUS.clearXp });
      }
    }));
  }

  /** E on the entry platform (after the clear), or the menu: go back to the world. */
  protected onInteract(sid: string, p: Player) {
    if (!this.cleared) return;
    const e = COLOSSUS.entry;
    if (Math.hypot(p.x - e.x, p.z - e.z) < 12 && Math.abs(p.y - e.y) < 4) {
      const client = this.clientOf(sid);
      if (client) this.sendHome(client);
    }
  }

  private sendHome(client: Client) {
    const m = this.meta.get(client.sessionId);
    if (!m) return;
    Parties.markTransfer([m.characterId]);
    Parties.setDungeon([m.characterId], null);
    client.send("transfer", { roomId: this.worldRoomId, kind: "world" });
  }

  private notifyAll(text: string) {
    for (const sid of this.meta.keys()) this.notify(sid, text);
  }

  /** Test accounts only: set the boss's health fraction, or skip to a phase. */
  protected devBoss(_sid: string, msg: { hp?: number; phase?: number }) {
    const boss = this.state.boss;
    if (Number.isFinite(msg?.phase)) {
      if (msg.phase! >= BossPhase.Wave) for (const id of ANCHOR_IDS) { const a = this.state.enemies.get(id); if (a) a.state = EnemyState.Dead; }
      this.startPhase(msg.phase!);
    }
    if (Number.isFinite(msg?.hp)) boss.hp = Math.max(1, Math.min(1, msg.hp!) * boss.maxHp);
  }
}
