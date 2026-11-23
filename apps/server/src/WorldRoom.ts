import { ServerError, matchMaker, type Client } from "colyseus";
import {
  COLOSSUS, MANTLE_SKILLS, MANTLES, ORIGIN_QUESTS, SHRINE, WORLD_ROOM_CAPACITY, getWorld,
} from "@worlds-edge/shared";
import type { StoredCharacter } from "./db.ts";
import { WORLD_SPAWNS } from "./enemies.ts";
import { GameRoom } from "./GameRoom.ts";
import { Parties } from "./parties.ts";
import type { Player } from "./schema.ts";

export { useStore } from "./GameRoom.ts";

const READY_SECONDS = 30;
/** Party members must be this close to the gate for the ready check. */
const GATHER_RADIUS = 30;

interface ReadyCheck { members: number[]; ready: Set<number>; expires: number }

/**
 * One copy of the shared world (First Harbour, the Broken Isles and the rim).
 * When it fills up, matchmaking opens another copy automatically.
 */
export class WorldRoom extends GameRoom {
  maxClients = WORLD_ROOM_CAPACITY;
  readonly world = getWorld();
  /** Ready checks by party leader's character id. */
  private readyChecks = new Map<number, ReadyCheck>();

  onCreate() {
    this.setup(WORLD_SPAWNS);
    this.onMessage("party:ready", (client) => this.markReady(client));
    this.clock.setInterval(() => this.expireReadyChecks(), 1000);
  }

  /** A character still in a live dungeon (after a long disconnect) goes back into it. */
  protected checkJoin(c: StoredCharacter) {
    const dungeon = Parties.dungeonFor(c.id);
    if (dungeon) throw new ServerError(409, `dungeon:${dungeon}`);
  }

  protected onInteract(sid: string, p: Player) {
    const q = ORIGIN_QUESTS[p.origin];
    if (q && p.questStep === 0 && Math.hypot(p.x - q.target.x, p.z - q.target.z) < q.target.radius && Math.abs(p.y - q.target.y) < 6) {
      p.questStep = 1;
      this.fx({ t: "ring", x: q.target.x, y: q.target.y, z: q.target.z, r: 5, kind: "shrine" });
      this.notify(sid, `${q.title}: recovered! Return to the training-yard shrine (E).`);
      void this.save(sid);
      return;
    }
    if (Math.hypot(p.x - SHRINE.x, p.z - SHRINE.z) < SHRINE.radius && Math.abs(p.y - SHRINE.y) < 4) this.awaken(sid, p);
    else if (Math.hypot(p.x - COLOSSUS.gate.x, p.z - COLOSSUS.gate.z) < COLOSSUS.gate.radius && Math.abs(p.y - COLOSSUS.gate.y) < 6) void this.startReadyCheck(sid);
  }

  private awaken(sid: string, p: Player) {
    const mantle = MANTLES.find((m) => m.id === p.mantle)?.name ?? "Your";
    const q = ORIGIN_QUESTS[p.origin];
    let changed = false;
    if (!p.mantleAwakened) {
      p.mantleAwakened = 1;
      this.fx({ t: "ring", x: SHRINE.x, y: SHRINE.y, z: SHRINE.z, r: 8, kind: "shrine" });
      const skill = MANTLE_SKILLS[p.mantle];
      this.notify(sid, `The ${mantle} mantle awakens. Press 1 for ${skill?.name ?? "your mantle skill"}.`);
      changed = true;
    } else if (!q || p.questStep !== 1) {
      this.notify(sid, `Your ${mantle} mantle is already awake.`);
    }
    if (q && p.questStep === 1) {
      p.questStep = 2;
      this.awardXp(sid, q.xp);
      this.fx({ t: "ring", x: SHRINE.x, y: SHRINE.y, z: SHRINE.z, r: 9, kind: "shrine" });
      this.notify(sid, `Quest complete: ${q.title}! Earned ${q.reward}.`);
      changed = true;
    }
    if (changed) void this.save(sid);
  }

  // --- The Colossus gate: ready check, then a private dungeon for the party -------------

  private async startReadyCheck(sid: string) {
    const me = this.meta.get(sid);
    if (!me) return;
    if (!Parties.isLeader(me.characterId)) { this.notify(sid, "Only your party leader can lead the party through the gate."); return; }
    if (this.readyChecks.has(me.characterId)) return;
    const members = Parties.members(me.characterId);

    // Everyone must be here, at the gate, and experienced enough.
    for (const id of members) {
      const msid = this.sessionOfCharacter(id);
      const mp = msid ? this.state.players.get(msid) : undefined;
      const name = Parties.nameOf(id);
      if (!msid || !mp) { this.notify(sid, `${name} isn't in this part of the world. Gather everyone at the gate first.`); return; }
      if (Math.hypot(mp.x - COLOSSUS.gate.x, mp.z - COLOSSUS.gate.z) > GATHER_RADIUS || Math.abs(mp.y - COLOSSUS.gate.y) > 10) {
        this.notify(sid, `Wait for ${name} to reach the gate.`); return;
      }
      if (mp.level < COLOSSUS.minLevel) { this.notify(sid, `${name} needs to reach level ${COLOSSUS.minLevel} to face the Colossus.`); return; }
      if (mp.downTime > 0) { this.notify(sid, `${name} is down.`); return; }
    }

    const check: ReadyCheck = { members, ready: new Set([me.characterId]), expires: this.now() + READY_SECONDS };
    this.readyChecks.set(me.characterId, check);
    if (members.length === 1) { await this.launch(check); return; }
    for (const id of members) {
      const msid = this.sessionOfCharacter(id)!;
      if (id === me.characterId) this.notify(msid, "Ready check sent. Waiting for your party…");
      else this.clientOf(msid)?.send("ready-check", { leader: Parties.nameOf(me.characterId), seconds: READY_SECONDS });
    }
  }

  private async markReady(client: Client) {
    const me = this.meta.get(client.sessionId);
    if (!me) return;
    for (const [leader, check] of this.readyChecks) {
      if (!check.members.includes(me.characterId)) continue;
      check.ready.add(me.characterId);
      const lsid = this.sessionOfCharacter(leader);
      if (lsid) this.notify(lsid, `${Parties.nameOf(me.characterId)} is ready (${check.ready.size}/${check.members.length}).`);
      if (check.ready.size === check.members.length) await this.launch(check);
      return;
    }
  }

  private expireReadyChecks() {
    const now = this.now();
    for (const [leader, check] of this.readyChecks) {
      if (check.expires > now) continue;
      this.readyChecks.delete(leader);
      for (const id of check.members) {
        const sid = this.sessionOfCharacter(id);
        if (sid) this.notify(sid, "The ready check timed out.");
      }
    }
  }

  private async launch(check: ReadyCheck) {
    const leader = check.members[0];
    for (const [l, c] of this.readyChecks) if (c === check) this.readyChecks.delete(l);
    // Everyone must still be here.
    const sessions = check.members.map((id) => this.sessionOfCharacter(id));
    if (sessions.some((s) => !s)) {
      for (const s of sessions) if (s) this.notify(s, "Someone left before the party could enter.");
      return;
    }
    const room = await matchMaker.createRoom("colossus", { allowed: check.members, worldRoomId: this.roomId });
    Parties.markTransfer(check.members);
    Parties.setDungeon(check.members, room.roomId);
    for (const sid of sessions) this.clientOf(sid!)?.send("transfer", { roomId: room.roomId, kind: "colossus" });
    console.log(`[world ${this.roomId}] party of ${check.members.length} (leader ${Parties.nameOf(leader)}) entered colossus ${room.roomId}`);
  }
}
