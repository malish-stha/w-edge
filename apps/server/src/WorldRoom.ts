import { Room, ServerError, type Client } from "colyseus";
import {
  DOWN_SECONDS, HP_REGEN, HP_REGEN_DELAY, MANTLE_SKILLS, MANTLES, MAX_LEVEL, Mode, PATCH_RATE, PLAYER_MAX_HP, SHRINE, TICK_RATE,
  WORLD_ROOM_CAPACITY, createMoveState, createStepEvents, getWorld, levelForXp, stepMovement, type Fx,
} from "@worlds-edge/shared";
import { authConfig, verifySession } from "./auth.ts";
import { Combat } from "./combat.ts";
import type { Store, StoredCharacter } from "./db.ts";
import { Enemies, type Host } from "./enemies.ts";
import { onlineCharacters } from "./presence.ts";
import { MoveInput, Player, WorldState } from "./schema.ts";

const world = getWorld();
const AUTOSAVE_MS = 20_000;
const RECONNECT_SECONDS = 20;

let store: Store;
export function useStore(s: Store) { store = s; }

interface JoinAuth { accountId: number; character: StoredCharacter }

/** Server-only facts about a connected player. */
interface Meta { characterId: number; lastHurt: number }

/**
 * One copy of the shared world (First Harbour, the Broken Isles and the rim).
 * When it fills up, matchmaking opens another copy automatically.
 *
 * The server is authoritative: clients only send inputs. Every player's movement
 * comes from running the shared movement code here; attacks, enemies, damage
 * and rewards are resolved here too.
 */
export class WorldRoom extends Room<{ state: WorldState; input: MoveInput }> implements Host {
  maxClients = WORLD_ROOM_CAPACITY;
  inputs = this.defineInput(MoveInput, { bufferMaxSize: 32 });
  private meta = new Map<string, Meta>();
  private pendingFx: Fx[] = [];
  private enemies!: Enemies;
  private combat!: Combat;

  /** Runs before a seat is reserved: check the session token and that the character is theirs. */
  static async onAuth(token: string, options: { characterId?: unknown }): Promise<JoinAuth> {
    const accountId = await verifySession(token);
    if (!accountId) throw new ServerError(401, "Please sign in again.");
    const characterId = Number(options?.characterId);
    if (!Number.isInteger(characterId)) throw new ServerError(400, "Choose a character.");
    const character = await store.getCharacter(characterId, accountId);
    if (!character) throw new ServerError(404, "Character not found.");
    if (onlineCharacters.has(characterId)) throw new ServerError(409, "That character is already in the world.");
    return { accountId, character };
  }

  onCreate() {
    this.state = new WorldState();
    this.patchRate = 1000 / PATCH_RATE;
    this.enemies = new Enemies(this);
    this.combat = new Combat(this, this.enemies);
    const ev = createStepEvents();

    this.setFixedTimestep((ctx) => {
      this.state.players.forEach((player, sid) => {
        // One input == one fixed step, exactly as the client predicted it.
        for (const input of this.inputs.get(sid)) {
          const wasDown = player.downTime > 0;
          stepMovement(player, input, ctx.dt, world, ev);
          if (wasDown && player.downTime === 0) player.hp = player.maxHp;
          this.combat.resolve(sid, player, ev, input.yaw, input.pitch);
          if (ev.ability1 && !this.combat.ability(sid, player)) this.explainAbility(sid, player);
          if (ev.interact) this.interact(sid, player);
        }
        player.abilityCooldown = Math.max(0, player.abilityCooldown - ctx.dt);
        const meta = this.meta.get(sid);
        if (meta && player.downTime === 0 && player.hp < player.maxHp && this.now() - meta.lastHurt > HP_REGEN_DELAY) {
          player.hp = Math.min(player.maxHp, player.hp + HP_REGEN * ctx.dt);
        }
      });
      this.enemies.update(ctx.dt);
      if (this.pendingFx.length) {
        this.broadcast("fx", this.pendingFx);
        this.pendingFx = [];
      }
    }, TICK_RATE);

    this.clock.setInterval(() => { void this.saveAll(); }, AUTOSAVE_MS);

    // Test accounts only: jump to a spot (for playtests and automated checks).
    this.onMessage("dev:teleport", (client, msg: { x: number; y: number; z: number }) => {
      if (!authConfig.devLogin) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || ![msg?.x, msg?.y, msg?.z].every(Number.isFinite)) return;
      p.x = msg.x; p.y = msg.y; p.z = msg.z; p.vx = p.vy = p.vz = 0; p.mode = Mode.Air;
    });
  }

  // --- Host interface used by enemies and combat ---------------------------------

  now() { return this.clock.currentTime / 1000; }

  fx(e: Fx) { this.pendingFx.push(e); }

  damagePlayer(sid: string, amount: number, knockX: number, knockZ: number, power: number) {
    const p = this.state.players.get(sid);
    const meta = this.meta.get(sid);
    if (!p || !meta || p.downTime > 0) return;
    meta.lastHurt = this.now();
    p.hp = Math.max(0, p.hp - amount);
    p.vx += knockX * power; p.vz += knockZ * power; p.vy = Math.max(p.vy, 5);
    if (p.mode === Mode.Ground) p.mode = Mode.Air;
    this.fx({ t: "hurt", id: sid, n: amount });
    if (p.hp === 0) {
      p.downTime = DOWN_SECONDS;
      p.vx = 0; p.vz = 0;
      this.fx({ t: "down", id: sid });
      this.notify(sid, `You're down. Recovering at your last safe spot in ${DOWN_SECONDS} seconds.`);
    }
  }

  awardXp(sid: string, amount: number) {
    const p = this.state.players.get(sid);
    if (!p || amount <= 0) return;
    const before = p.level;
    p.xp = Math.min(65535, p.xp + amount);
    p.level = levelForXp(p.xp);
    if (p.level > before) {
      this.fx({ t: "level", id: sid, level: p.level });
      this.notify(sid, p.level >= MAX_LEVEL ? `Level ${p.level}: the Drowned Colossus awaits beyond the rim.` : `Level ${p.level}!`);
      void this.save(sid);
    }
  }

  private notify(sid: string, text: string) {
    this.clients.find((c) => c.sessionId === sid)?.send("notice", text);
  }

  // --- Interactions ---------------------------------------------------------------

  private interact(sid: string, p: Player) {
    const atShrine = Math.hypot(p.x - SHRINE.x, p.z - SHRINE.z) < SHRINE.radius && Math.abs(p.y - SHRINE.y) < 4;
    if (!atShrine) return;
    const mantle = MANTLES.find((m) => m.id === p.mantle)?.name ?? "Your";
    if (p.mantleAwakened) { this.notify(sid, `Your ${mantle} mantle is already awake.`); return; }
    p.mantleAwakened = 1;
    this.fx({ t: "ring", x: SHRINE.x, y: SHRINE.y, z: SHRINE.z, r: 8, kind: "shrine" });
    const skill = MANTLE_SKILLS[p.mantle];
    this.notify(sid, `The ${mantle} mantle awakens. Press 1 for ${skill?.name ?? "your mantle skill"}.`);
    void this.save(sid);
  }

  private explainAbility(sid: string, p: Player) {
    if (!p.mantleAwakened) this.notify(sid, "Your mantle is still dormant. Awaken it at the training-yard shrine (E).");
  }

  // --- Joining, leaving, saving -------------------------------------------------------

  onJoin(client: Client) {
    const { character } = client.auth as JoinAuth;
    onlineCharacters.add(character.id);
    this.meta.set(client.sessionId, { characterId: character.id, lastHurt: -100 });

    const player = new Player();
    const spawn = character.position ?? {
      x: world.spawn.x + (Math.random() - 0.5) * 8,
      y: world.spawn.y,
      z: world.spawn.z + (Math.random() - 0.5) * 8,
    };
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
    this.state.players.set(client.sessionId, player);
    console.log(`[world ${this.roomId}] ${player.name} joined (${this.clients.length}/${this.maxClients})`);
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
    console.log(`[world ${this.roomId}] ${player?.name ?? client.sessionId} reconnected`);
  }

  async onLeave(client: Client) {
    await this.save(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    this.state.players.delete(client.sessionId);
    const meta = this.meta.get(client.sessionId);
    if (meta) onlineCharacters.delete(meta.characterId);
    this.meta.delete(client.sessionId);
    this.combat.forget(client.sessionId);
    console.log(`[world ${this.roomId}] ${player?.name ?? client.sessionId} left`);
  }

  async onDispose() {
    await this.saveAll();
  }

  /** Save progress and where the player last stood safely (never mid-air or over the sea). */
  private async save(sessionId: string) {
    const meta = this.meta.get(sessionId);
    const p = this.state.players.get(sessionId);
    if (!meta || !p) return;
    try {
      await store.saveProgress(meta.characterId, {
        x: p.safeX, y: p.safeY, z: p.safeZ,
        xp: p.xp, level: p.level, mantleAwakened: p.mantleAwakened === 1,
      });
    } catch (err) {
      console.error(`Could not save character ${meta.characterId}:`, err);
    }
  }

  private async saveAll() {
    await Promise.all([...this.meta.keys()].map((sid) => this.save(sid)));
  }
}
