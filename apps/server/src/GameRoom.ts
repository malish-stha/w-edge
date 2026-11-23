import { Room, ServerError, type AuthContext, type Client } from "colyseus";
import {
  Buttons, COLOSSUS, DOWN_SECONDS, HP_REGEN, HP_REGEN_DELAY, MAX_LEVEL, Mode, PATCH_RATE, PLAYER_MAX_HP, TICK_RATE, UNLOCK_LEVELS,
  createMoveState, createStepEvents, defaultMantlePathFor, defaultTechniqueFor, levelForXp, pathsForMantle, stepMovement, techniquesForClass,
  type Fx, type PingKind, type PingMessage, type World,
} from "@worlds-edge/shared";
import { authConfig, verifySession } from "./auth.ts";
import { Combat } from "./combat.ts";
import type { Store, StoredCharacter } from "./db.ts";
import { Enemies, type Host, type Spawn } from "./enemies.ts";
import { Parties } from "./parties.ts";
import { onlineCharacters } from "./presence.ts";
import { MoveInput, Player, WorldState } from "./schema.ts";

const AUTOSAVE_MS = 20_000;
const RECONNECT_SECONDS = 20;

let store: Store;
export function useStore(s: Store) { store = s; }
export function getStore() { return store; }

export interface JoinAuth { accountId: number; character: StoredCharacter }

/** Server-only facts about a connected player. */
export interface Meta { characterId: number; lastHurt: number }

/**
 * Everything the overworld and the dungeon share: sign-in on join, the input
 * loop (one input == one fixed step of the shared movement code), combat,
 * damage, XP, revives, parties and saving.
 */
export abstract class GameRoom extends Room<{ state: WorldState; input: MoveInput }> implements Host {
  inputs = this.defineInput(MoveInput, { bufferMaxSize: 32 });
  abstract readonly world: World;
  protected meta = new Map<string, Meta>();
  protected enemies!: Enemies;
  protected combat!: Combat;
  /** How long a downed player waits before recovering on their own. */
  protected downSeconds = DOWN_SECONDS;
  private pendingFx: Fx[] = [];
  /** When each downed player was last being revived (server seconds). */
  private lastRevived = new Map<string, number>();
  private unsubscribeParty?: () => void;

  /** Check the session token and that the character belongs to the account. */
  async onAuth(_client: Client, options: { characterId?: unknown }, context: AuthContext): Promise<JoinAuth> {
    const accountId = await verifySession(context.token);
    if (!accountId) throw new ServerError(401, "Please sign in again.");
    const characterId = Number(options?.characterId);
    if (!Number.isInteger(characterId)) throw new ServerError(400, "Choose a character.");
    const character = await store.getCharacter(characterId, accountId);
    if (!character) throw new ServerError(404, "Character not found.");
    this.checkJoin(character);
    if (onlineCharacters.has(characterId)) throw new ServerError(409, "That character is already in the world.");
    return { accountId, character };
  }

  /** Room-specific join rules (throw a ServerError to refuse). */
  protected checkJoin(_character: StoredCharacter) { }
  /** E pressed (not held). */
  protected onInteract(_sid: string, _p: Player) { }
  /** Per-tick encounter logic. */
  protected tick(_dt: number) { }
  /** Where a character's position is saved from. */
  protected savedPosition(p: Player) { return { x: p.safeX, y: p.safeY, z: p.safeZ }; }
  /** Where a joining character appears. */
  protected spawnPoint(c: StoredCharacter) {
    return c.position ?? { x: this.world.spawn.x + (Math.random() - 0.5) * 8, y: this.world.spawn.y, z: this.world.spawn.z + (Math.random() - 0.5) * 8 };
  }

  protected setup(spawns: Spawn[]) {
    this.state = new WorldState();
    // Schema fields start undefined: give the encounter real defaults.
    Object.assign(this.state.boss, {
      phase: 0, hp: 0, maxHp: 0, armour: 0, maxArmour: 0, exposed: 0, anchorsLeft: 0,
      wave: -1, waveDirX: 0, waveDirZ: 1, slamX: 0, slamZ: 0, slamT: -1, sweepT: -1, objective: "", elapsed: 0,
    });
    this.patchRate = 1000 / PATCH_RATE;
    this.enemies = new Enemies(this, spawns);
    this.combat = new Combat(this, this.enemies);
    const ev = createStepEvents();

    this.setFixedTimestep((ctx) => {
      this.state.players.forEach((player, sid) => {
        for (const input of this.inputs.get(sid)) {
          const wasDown = player.downTime > 0;
          stepMovement(player, input, ctx.dt, this.world, ev);
          if (wasDown && player.downTime === 0) { player.hp = player.maxHp; player.reviveProgress = 0; }
          this.combat.step(sid, player, ctx.dt);
          this.combat.resolve(sid, player, ev, input.yaw, input.pitch);
          if (ev.ability1 && !this.combat.ability(sid, player) && !player.mantleAwakened) {
            this.notify(sid, "Your mantle is still dormant. Awaken it at the training-yard shrine (E).");
          }
          if (ev.ability2 && !this.combat.ability2(sid, player, input.yaw, input.pitch) && !player.mantleAwakened) {
            this.notify(sid, "Your mantle is still dormant. Awaken it at the training-yard shrine (E).");
          }
          if (ev.ability3 && !this.combat.explore(sid, player, input.yaw) && !player.mantleAwakened) {
            this.notify(sid, "Your mantle is still dormant. Awaken it at the training-yard shrine (E).");
          }
          if (ev.ability4) {
            const res = this.combat.ultimate(sid, player);
            if (res === "dormant") this.notify(sid, "Your mantle is still dormant. Awaken it at the training-yard shrine (E).");
            else if (res === "charge") this.notify(sid, `Ultimate needs 100% charge (${Math.floor(player.ultCharge)}%).`);
          }
          if (ev.interact) this.onInteract(sid, player);
          if ((input.buttons & Buttons.InteractHeld) !== 0) this.revive(sid, player, ctx.dt);
        }
        player.abilityCooldown = Math.max(0, player.abilityCooldown - ctx.dt);
        player.ability2Cooldown = Math.max(0, player.ability2Cooldown - ctx.dt);
        player.exploreCooldown = Math.max(0, player.exploreCooldown - ctx.dt);
        const meta = this.meta.get(sid);
        if (meta && player.downTime === 0 && player.hp < player.maxHp && this.now() - meta.lastHurt > HP_REGEN_DELAY) {
          player.hp = Math.min(player.maxHp, player.hp + HP_REGEN * ctx.dt);
        }
      });
      // A revive only progresses while someone keeps holding E next to the downed player
      // (a short grace period absorbs network jitter between their inputs).
      const now = this.now();
      this.state.players.forEach((p, sid) => {
        if (p.reviveProgress > 0 && now - (this.lastRevived.get(sid) ?? 0) > 0.3) p.reviveProgress = 0;
      });
      this.tick(ctx.dt);
      this.enemies.update(ctx.dt);
      if (this.pendingFx.length) {
        this.broadcast("fx", this.pendingFx);
        this.pendingFx = [];
      }
    }, TICK_RATE);

    this.clock.setInterval(() => { void this.saveAll(); }, AUTOSAVE_MS);
    this.registerPartyMessages();
    this.registerDevMessages();
  }

  // --- Host interface used by enemies and combat ---------------------------------

  now() { return this.clock.currentTime / 1000; }
  fx(e: Fx) { this.pendingFx.push(e); }

  damagePlayer(sid: string, amount: number, knockX: number, knockZ: number, power: number) {
    const p = this.state.players.get(sid);
    const meta = this.meta.get(sid);
    if (!p || !meta || p.downTime > 0) return;
    if (this.combat.interceptDamage(sid, p)) return;
    meta.lastHurt = this.now();
    p.hp = Math.max(0, p.hp - amount);
    p.vx += knockX * power; p.vz += knockZ * power; p.vy = Math.max(p.vy, 5);
    if (p.mode === Mode.Ground) p.mode = Mode.Air;
    this.fx({ t: "hurt", id: sid, n: amount });
    if (p.hp === 0) {
      p.downTime = this.downSeconds;
      p.vx = 0; p.vz = 0;
      this.fx({ t: "down", id: sid });
      this.notify(sid, `You're down. A teammate can revive you (hold E), or you'll recover in ${this.downSeconds} seconds.`);
    }
  }

  awardXp(sid: string, amount: number) {
    const p = this.state.players.get(sid);
    if (!p || amount <= 0) return;
    this.setXp(sid, p, Math.min(65535, p.xp + amount));
  }

  protected setXp(sid: string, p: Player, xp: number) {
    const before = p.level;
    p.xp = xp;
    p.level = levelForXp(p.xp);
    if (p.level > before) {
      const m = this.meta.get(sid);
      if (m) Parties.updateLevel(m.characterId, p.level);
      this.fx({ t: "level", id: sid, level: p.level });
      const unlocks: string[] = [];
      if (before < UNLOCK_LEVELS.boostDive && p.level >= UNLOCK_LEVELS.boostDive) unlocks.push("Boost & Dive (Shift)");
      if (before < UNLOCK_LEVELS.technique && p.level >= UNLOCK_LEVELS.technique) unlocks.push("Signature Techniques (K)");
      if (before < UNLOCK_LEVELS.secondSkill && p.level >= UNLOCK_LEVELS.secondSkill) unlocks.push("Second Mantle Skill (2)");
      if (before < UNLOCK_LEVELS.upgradePath && p.level >= UNLOCK_LEVELS.upgradePath) unlocks.push("Mantle Upgrade Paths (K) & Drowned Colossus gate");
      this.notify(sid, unlocks.length
        ? `Level ${p.level}${p.level >= MAX_LEVEL ? " (max)" : ""}! Unlocked: ${unlocks.join(", ")}.`
        : `Level ${p.level}!`);
      void this.save(sid);
    }
  }

  notify(sid: string, text: string) {
    this.clientOf(sid)?.send("notice", text);
  }

  protected clientOf(sid: string) {
    return this.clients.find((c) => c.sessionId === sid);
  }

  protected sessionOfCharacter(characterId: number): string | null {
    for (const [sid, m] of this.meta) if (m.characterId === characterId) return sid;
    return null;
  }

  // --- Revives ------------------------------------------------------------------------

  private revive(sid: string, p: Player, dt: number) {
    if (p.downTime > 0) return;
    let target: { sid: string; p: Player; d: number } | null = null;
    this.state.players.forEach((other, osid) => {
      if (osid === sid || other.downTime <= 0) return;
      const d = Math.hypot(other.x - p.x, other.y - p.y, other.z - p.z);
      if (d <= COLOSSUS.reviveRange && (!target || d < target.d)) target = { sid: osid, p: other, d };
    });
    const t = target as { sid: string; p: Player } | null;
    if (!t) return;
    this.lastRevived.set(t.sid, this.now());
    t.p.reviveProgress = Math.min(1, t.p.reviveProgress + dt / COLOSSUS.reviveSeconds);
    if (t.p.reviveProgress >= 1) {
      t.p.downTime = 0;
      t.p.reviveProgress = 0;
      t.p.hp = Math.ceil(t.p.maxHp / 2);
      p.ultCharge = Math.min(100, p.ultCharge + 20);
      this.fx({ t: "ring", x: t.p.x, y: t.p.y, z: t.p.z, r: 3, kind: "revive" });
      this.notify(t.sid, `${p.name} revived you.`);
      this.notify(sid, `You revived ${t.p.name}.`);
    }
  }

  // --- Parties --------------------------------------------------------------------------

  private registerPartyMessages() {
    Parties.registerRoom(this.roomId, (sid, type, payload) => this.clientOf(sid)?.send(type, payload));
    this.unsubscribeParty = Parties.subscribe((affected) => this.refreshParty(affected));

    this.onMessage("party:invite", (client, msg: { sessionId?: string; characterId?: number; name?: string }) => {
      const from = this.meta.get(client.sessionId);
      if (!from) return;
      let toId: number | null = null;
      if (typeof msg?.characterId === "number") toId = msg.characterId;
      else if (msg?.sessionId) toId = this.meta.get(msg.sessionId)?.characterId ?? null;
      else if (typeof msg?.name === "string") toId = Parties.findByName(msg.name);
      if (!toId) { this.notify(client.sessionId, "That player isn't online right now."); return; }
      const error = Parties.invite(from.characterId, toId);
      if (error) { this.notify(client.sessionId, error); return; }
      Parties.sendTo(toId, "party:invite", { from: Parties.nameOf(from.characterId) });
      this.notify(client.sessionId, `Invitation sent to ${Parties.nameOf(toId)}.`);
    });
    this.onMessage("party:online", (client) => {
      const me = this.meta.get(client.sessionId);
      if (me) client.send("party:online", Parties.onlinePlayers(me.characterId));
    });
    this.onMessage("party:accept", (client) => {
      const me = this.meta.get(client.sessionId);
      if (!me) return;
      const error = Parties.accept(me.characterId);
      if (error) { this.notify(client.sessionId, error); return; }
      for (const id of Parties.members(me.characterId)) {
        Parties.sendTo(id, "notice", id === me.characterId ? "You joined the party." : `${Parties.nameOf(me.characterId)} joined the party.`);
      }
    });
    this.onMessage("party:decline", (client) => {
      const me = this.meta.get(client.sessionId);
      if (me) Parties.decline(me.characterId);
    });
    this.onMessage("party:leave", (client) => {
      const me = this.meta.get(client.sessionId);
      if (!me) return;
      const others = Parties.members(me.characterId).filter((id) => id !== me.characterId);
      Parties.leave(me.characterId);
      this.notify(client.sessionId, "You left the party.");
      for (const id of others) {
        Parties.sendTo(id, "notice", `${Parties.nameOf(me.characterId)} left the party.`);
      }
    });
    this.onMessage("party:promote", (client, msg: { characterId?: number }) => {
      const me = this.meta.get(client.sessionId);
      if (!me || typeof msg?.characterId !== "number") return;
      const error = Parties.promote(me.characterId, msg.characterId);
      if (error) { this.notify(client.sessionId, error); return; }
      const newName = Parties.nameOf(msg.characterId);
      for (const id of Parties.members(me.characterId)) {
        Parties.sendTo(id, "notice", `${newName} is now the party leader.`);
      }
    });
    this.onMessage("party:join-leader", (client) => {
      const me = this.meta.get(client.sessionId);
      if (!me || this.roomName !== "world") return;
      const loc = Parties.leaderLocation(me.characterId);
      if (!loc || loc.roomId === this.roomId || loc.roomName !== "world") {
        this.notify(client.sessionId, "Your leader isn't in another world copy right now.");
        return;
      }
      Parties.markTransfer([me.characterId]);
      client.send("transfer", { roomId: loc.roomId, kind: "world" });
    });
    this.onMessage("party:rally", (client, msg: { x?: number; y?: number; z?: number; clear?: boolean }) => {
      const me = this.meta.get(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      if (!me || !p) return;
      const rally = msg?.clear ? null : {
        x: Math.round((Number.isFinite(msg?.x) ? msg.x! : p.x) * 10) / 10,
        y: Math.round((Number.isFinite(msg?.y) ? msg.y! : p.y) * 10) / 10,
        z: Math.round((Number.isFinite(msg?.z) ? msg.z! : p.z) * 10) / 10,
      };
      const error = Parties.setRally(me.characterId, rally);
      if (error) { this.notify(client.sessionId, error); return; }
      for (const id of Parties.members(me.characterId)) {
        Parties.sendTo(id, "notice", rally ? `${p.name} set a rally point.` : `${p.name} cleared the rally point.`);
      }
    });
    this.onMessage("party:target", (client, msg: { targetId?: string | null }) => {
      const me = this.meta.get(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      if (!me || !p) return;
      const targetId = typeof msg?.targetId === "string" && msg.targetId ? msg.targetId : null;
      const error = Parties.setTarget(me.characterId, targetId);
      if (error) { this.notify(client.sessionId, error); return; }
      const e = targetId ? this.state.enemies.get(targetId) : undefined;
      if (e) {
        const ping: PingMessage = { id: `t-${Date.now()}`, from: p.name, kind: "target", x: e.x, y: e.y, z: e.z, targetId: targetId! };
        for (const id of Parties.members(me.characterId)) {
          const msid = this.sessionOfCharacter(id);
          if (msid) this.clientOf(msid)?.send("ping", ping);
        }
      }
    });
    this.onMessage("ping", (client, msg: { kind?: PingKind; x?: number; y?: number; z?: number; targetId?: string }) => {
      const me = this.meta.get(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      if (!me || !p || ![msg?.x, msg?.y, msg?.z].every(Number.isFinite)) return;
      const kind: PingKind = msg.kind === "weak" || msg.kind === "revive" || msg.kind === "target" || msg.kind === "rally" ? msg.kind : "ping";
      if (kind === "rally" && Parties.isLeader(me.characterId) && Parties.partyId(me.characterId)) {
        Parties.setRally(me.characterId, { x: msg.x!, y: msg.y!, z: msg.z! });
      }
      if ((kind === "target" || kind === "weak") && msg.targetId && Parties.isLeader(me.characterId) && Parties.partyId(me.characterId)) {
        Parties.setTarget(me.characterId, msg.targetId);
      }
      const ping: PingMessage = {
        id: `${client.sessionId}-${Date.now()}`,
        from: p.name,
        kind,
        x: Math.round(msg.x! * 10) / 10,
        y: Math.round(msg.y! * 10) / 10,
        z: Math.round(msg.z! * 10) / 10,
        targetId: typeof msg.targetId === "string" ? msg.targetId : undefined,
      };
      const recipients = Parties.members(me.characterId);
      for (const id of recipients) {
        const msid = this.sessionOfCharacter(id);
        if (msid) this.clientOf(msid)?.send("ping", ping);
      }
    });
  }

  /** Push the roster to party members in this room and update their party ids. */
  private refreshParty(affected: number[]) {
    for (const id of affected) {
      const sid = this.sessionOfCharacter(id);
      if (!sid) continue;
      const p = this.state.players.get(sid);
      if (p) p.party = Parties.partyId(id);
      this.clientOf(sid)?.send("party", Parties.roster(id));
    }
  }

  private registerDevMessages() {
    // Test accounts only: jump to a spot, or gain XP (for playtests and automated checks).
    this.onMessage("dev:teleport", (client, msg: { x: number; y: number; z: number }) => {
      if (!authConfig.devLogin) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || ![msg?.x, msg?.y, msg?.z].every(Number.isFinite)) return;
      p.x = msg.x; p.y = msg.y; p.z = msg.z; p.vx = p.vy = p.vz = 0; p.mode = Mode.Air;
    });
    this.onMessage("dev:xp", (client, msg: { amount: number }) => {
      if (!authConfig.devLogin) return;
      const p = this.state.players.get(client.sessionId);
      if (p && Number.isFinite(msg?.amount)) this.awardXp(client.sessionId, Math.max(0, Math.min(5000, msg.amount)));
    });
    this.onMessage("dev:down", (client) => {
      if (authConfig.devLogin) this.damagePlayer(client.sessionId, 9999, 0, 0, 0);
    });
    this.onMessage("dev:boss", (client, msg: { hp?: number }) => {
      if (!authConfig.devLogin) return;
      this.devBoss(client.sessionId, msg);
    });
    this.onMessage("technique:set", (client, msg: { id?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof msg?.id !== "string") return;
      if (p.level < UNLOCK_LEVELS.technique) {
        this.notify(client.sessionId, `Reach level ${UNLOCK_LEVELS.technique} to equip signature techniques.`);
        return;
      }
      if (this.roomName !== "world") {
        this.notify(client.sessionId, "Swap your signature technique outside the dungeon.");
        return;
      }
      const valid = techniquesForClass(p.classId).find((t) => t.id === msg.id);
      if (!valid) return;
      p.technique = valid.id;
      void this.save(client.sessionId);
    });
    this.onMessage("mantle-path:set", (client, msg: { id?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof msg?.id !== "string") return;
      if (p.level < UNLOCK_LEVELS.upgradePath) {
        this.notify(client.sessionId, `Reach level ${UNLOCK_LEVELS.upgradePath} to choose a mantle upgrade path.`);
        return;
      }
      if (this.roomName !== "world") {
        this.notify(client.sessionId, "Swap your mantle upgrade path outside the dungeon.");
        return;
      }
      const valid = pathsForMantle(p.mantle).find((m) => m.id === msg.id);
      if (!valid) return;
      p.mantlePath = valid.id;
      void this.save(client.sessionId);
    });
  }

  /** Test accounts only: adjust the encounter (dungeon overrides). */
  protected devBoss(_sid: string, _msg: { hp?: number }) { }

  // --- Joining, leaving, saving -------------------------------------------------------

  onJoin(client: Client) {
    const { character } = client.auth as JoinAuth;
    onlineCharacters.add(character.id);
    this.meta.set(client.sessionId, { characterId: character.id, lastHurt: -100 });

    const player = new Player();
    const spawn = this.spawnPoint(character);
    Object.assign(player, createMoveState({ x: spawn.x, y: spawn.y + 0.5, z: spawn.z }));
    player.name = character.name;
    player.classId = character.classId;
    player.origin = character.origin;
    player.mantle = character.mantle;
    player.skin = character.appearance.skin;
    player.hair = character.appearance.hair;
    player.outfit = character.appearance.outfit;
    player.maxHp = PLAYER_MAX_HP;
    player.hp = PLAYER_MAX_HP;
    player.xp = character.xp;
    player.level = levelForXp(character.xp);
    player.mantleAwakened = character.mantleAwakened ? 1 : 0;
    player.technique = character.technique || defaultTechniqueFor(character.classId);
    player.mantlePath = character.mantlePath || defaultMantlePathFor(character.mantle);
    player.questStep = character.questStep ?? 0;
    player.guarding = 0;
    player.classCharge = 0;
    player.classCooldown = 0;
    player.abilityCooldown = 0;
    player.ability2Cooldown = 0;
    player.exploreCooldown = 0;
    player.ultCharge = 0;
    player.giant = 0;
    // Schema fields start undefined: give every server-owned number a real value.
    player.reviveProgress = 0;
    player.away = 0;
    player.party = Parties.partyId(character.id);
    this.state.players.set(client.sessionId, player);
    Parties.arrive(character.id, character.name, { roomId: this.roomId, sessionId: client.sessionId, roomName: this.roomName, level: player.level });
    this.refreshParty([character.id]);
    console.log(`[${this.roomName} ${this.roomId}] ${player.name} joined (${this.clients.length}/${this.maxClients})`);
  }

  /** Connection lost without leaving: hold their place briefly so they can reconnect. */
  async onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.away = 1;
    await this.save(client.sessionId);
    this.allowReconnection(client, RECONNECT_SECONDS);
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.away = 0;
    console.log(`[${this.roomName} ${this.roomId}] ${player?.name ?? client.sessionId} reconnected`);
  }

  async onLeave(client: Client) {
    await this.save(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    this.state.players.delete(client.sessionId);
    const meta = this.meta.get(client.sessionId);
    this.meta.delete(client.sessionId);
    this.combat.forget(client.sessionId);
    if (meta) {
      onlineCharacters.delete(meta.characterId);
      Parties.depart(meta.characterId);
    }
    console.log(`[${this.roomName} ${this.roomId}] ${player?.name ?? client.sessionId} left`);
  }

  async onDispose() {
    Parties.unregisterRoom(this.roomId);
    this.unsubscribeParty?.();
    await this.saveAll();
  }

  protected async save(sessionId: string) {
    const meta = this.meta.get(sessionId);
    const p = this.state.players.get(sessionId);
    if (!meta || !p) return;
    try {
      const pos = this.savedPosition(p);
      await store.saveProgress(meta.characterId, { ...pos, xp: p.xp, level: p.level, mantleAwakened: p.mantleAwakened === 1, technique: p.technique, mantlePath: p.mantlePath, questStep: p.questStep });
    } catch (err) {
      console.error(`Could not save character ${meta.characterId}:`, err);
    }
  }

  protected async saveAll() {
    await Promise.all([...this.meta.keys()].map((sid) => this.save(sid)));
  }
}
