import { Room, ServerError, type Client } from "colyseus";
import {
  PATCH_RATE, TICK_RATE, WORLD_ROOM_CAPACITY,
  createMoveState, getWorld, stepMovement,
} from "@worlds-edge/shared";
import { verifySession } from "./auth.ts";
import type { Store, StoredCharacter } from "./db.ts";
import { onlineCharacters } from "./presence.ts";
import { MoveInput, Player, WorldState } from "./schema.ts";

const world = getWorld();
const AUTOSAVE_MS = 20_000;
const RECONNECT_SECONDS = 20;

let store: Store;
export function useStore(s: Store) { store = s; }

interface JoinAuth { accountId: number; character: StoredCharacter }

/**
 * One copy of the shared world (First Harbour, the Broken Isles and the rim).
 * When it fills up, matchmaking opens another copy automatically.
 *
 * The server is authoritative: clients only send inputs, and every player's
 * position comes from running the shared movement code here.
 */
export class WorldRoom extends Room<{ state: WorldState; input: MoveInput }> {
  maxClients = WORLD_ROOM_CAPACITY;
  inputs = this.defineInput(MoveInput, { bufferMaxSize: 32 });
  /** sessionId -> character id, for saving. */
  private characterOf = new Map<string, number>();

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
    this.setFixedTimestep((ctx) => {
      this.state.players.forEach((player, sessionId) => {
        // One input == one fixed step, exactly as the client predicted it.
        for (const input of this.inputs.get(sessionId)) {
          stepMovement(player, input, ctx.dt, world);
        }
      });
    }, TICK_RATE);
    this.clock.setInterval(() => { void this.saveAll(); }, AUTOSAVE_MS);
  }

  onJoin(client: Client) {
    const { character } = client.auth as JoinAuth;
    onlineCharacters.add(character.id);
    this.characterOf.set(client.sessionId, character.id);

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
    const id = this.characterOf.get(client.sessionId);
    if (id !== undefined) onlineCharacters.delete(id);
    this.characterOf.delete(client.sessionId);
    console.log(`[world ${this.roomId}] ${player?.name ?? client.sessionId} left`);
  }

  async onDispose() {
    await this.saveAll();
  }

  /** Save where the player last stood safely (never mid-air or over the sea). */
  private async save(sessionId: string) {
    const id = this.characterOf.get(sessionId);
    const p = this.state.players.get(sessionId);
    if (id === undefined || !p) return;
    try {
      await store.savePosition(id, p.safeX, p.safeY, p.safeZ);
    } catch (err) {
      console.error(`Could not save character ${id}:`, err);
    }
  }

  private async saveAll() {
    await Promise.all([...this.characterOf.keys()].map((sid) => this.save(sid)));
  }
}
