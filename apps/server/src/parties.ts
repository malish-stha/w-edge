/**
 * Parties of up to four, tracked per server process so they survive moving
 * between world copies and dungeons. (Multi-process deployments move this to
 * Colyseus presence/Redis.)
 */
export const PARTY_MAX = 4;
const INVITE_SECONDS = 60;

export interface Party {
  id: string;
  leader: number;
  members: number[];
  rally: { x: number; y: number; z: number } | null;
  targetId: string | null;
}

export interface RosterMember { id: number; name: string; leader: boolean; roomId: string | null; sessionId: string | null }
export interface Roster {
  partyId: string;
  members: RosterMember[];
  rally: { x: number; y: number; z: number } | null;
  targetId: string | null;
}

interface Location { roomId: string; sessionId: string; roomName: string; level: number }
type RoomSender = (sessionId: string, type: string, payload: unknown) => void;

const parties = new Map<string, Party>();
const partyOf = new Map<number, string>();
const invites = new Map<number, { from: number; expires: number }>();
const names = new Map<number, string>();
const where = new Map<number, Location>();
const roomSenders = new Map<string, RoomSender>();
/** Characters moving between rooms (world → dungeon → world): leaving isn't logging out. */
const transfers = new Set<number>();
/** Characters in a live dungeon, so a reconnecting player is sent back into it. */
const dungeonOf = new Map<number, string>();
let nextId = 1;

type Listener = (affected: number[]) => void;
const listeners = new Set<Listener>();
function changed(affected: number[]) { for (const l of listeners) l(affected); }

export const Parties = {
  subscribe(l: Listener) { listeners.add(l); return () => listeners.delete(l); },
  registerRoom(roomId: string, send: RoomSender) { roomSenders.set(roomId, send); },
  unregisterRoom(roomId: string) { roomSenders.delete(roomId); },

  sendTo(characterId: number, type: string, payload: unknown): boolean {
    const loc = where.get(characterId);
    if (!loc) return false;
    const send = roomSenders.get(loc.roomId);
    if (!send) return false;
    send(loc.sessionId, type, payload);
    return true;
  },

  arrive(characterId: number, name: string, loc: Location) {
    names.set(characterId, name);
    where.set(characterId, loc);
    transfers.delete(characterId);
    const pid = partyOf.get(characterId);
    if (pid) changed(parties.get(pid)!.members);
  },

  updateLevel(characterId: number, level: number) {
    const loc = where.get(characterId);
    if (loc) loc.level = level;
  },

  /** Called when a character leaves a room. Logging out (not transferring) leaves the party. */
  depart(characterId: number) {
    where.delete(characterId);
    if (transfers.has(characterId)) return;
    invites.delete(characterId);
    this.leave(characterId);
  },

  markTransfer(characterIds: number[]) { for (const id of characterIds) transfers.add(id); },
  setDungeon(characterIds: number[], roomId: string | null) {
    for (const id of characterIds) {
      if (roomId) dungeonOf.set(id, roomId);
      else if (dungeonOf.get(id)) dungeonOf.delete(id);
    }
  },
  dungeonFor(characterId: number) { return dungeonOf.get(characterId) ?? null; },
  clearDungeon(roomId: string) { for (const [id, r] of dungeonOf) if (r === roomId) dungeonOf.delete(id); },

  partyId(characterId: number) { return partyOf.get(characterId) ?? ""; },
  members(characterId: number): number[] {
    const pid = partyOf.get(characterId);
    return pid ? [...parties.get(pid)!.members] : [characterId];
  },
  isLeader(characterId: number) {
    const pid = partyOf.get(characterId);
    return !pid || parties.get(pid)!.leader === characterId;
  },
  leaderLocation(characterId: number): Location | null {
    const pid = partyOf.get(characterId);
    if (!pid) return null;
    return where.get(parties.get(pid)!.leader) ?? null;
  },

  onlinePlayers(excludeId: number) {
    const out: Array<{ id: number; name: string; roomId: string; roomName: string; level: number; inParty: boolean }> = [];
    for (const [id, loc] of where) {
      if (id === excludeId) continue;
      out.push({ id, name: names.get(id) ?? "?", roomId: loc.roomId, roomName: loc.roomName, level: loc.level, inParty: partyOf.has(id) });
    }
    return out;
  },

  findByName(name: string): number | null {
    const needle = name.trim().toLowerCase();
    if (!needle) return null;
    for (const [id] of where) {
      if ((names.get(id) ?? "").toLowerCase() === needle) return id;
    }
    return null;
  },

  roster(characterId: number): Roster | null {
    const pid = partyOf.get(characterId);
    if (!pid) return null;
    const p = parties.get(pid)!;
    return {
      partyId: pid,
      rally: p.rally,
      targetId: p.targetId,
      members: p.members.map((id) => ({
        id, name: names.get(id) ?? "?", leader: id === p.leader,
        roomId: where.get(id)?.roomId ?? null, sessionId: where.get(id)?.sessionId ?? null,
      })),
    };
  },

  /** Returns an error message, or null when the invite was sent. */
  invite(from: number, to: number): string | null {
    if (from === to) return "You can't invite yourself.";
    if (!where.has(to)) return "That player isn't online right now.";
    const fromParty = partyOf.get(from);
    if (fromParty && parties.get(fromParty)!.members.length >= PARTY_MAX) return "Your party is full.";
    if (partyOf.get(to) && partyOf.get(to) === fromParty) return `${names.get(to)} is already in your party.`;
    if (partyOf.get(to)) return `${names.get(to)} is already in a party.`;
    invites.set(to, { from, expires: Date.now() + INVITE_SECONDS * 1000 });
    return null;
  },

  pendingInviteFrom(to: number): number | null {
    const inv = invites.get(to);
    if (!inv || inv.expires < Date.now()) return null;
    return inv.from;
  },

  /** Accept the pending invite. Returns an error message, or null on success. */
  accept(to: number): string | null {
    const inv = invites.get(to);
    invites.delete(to);
    if (!inv || inv.expires < Date.now()) return "That invitation has expired.";
    if (!where.has(inv.from)) return "They're no longer online.";
    let pid = partyOf.get(inv.from);
    if (!pid) {
      pid = `p${nextId++}`;
      parties.set(pid, { id: pid, leader: inv.from, members: [inv.from], rally: null, targetId: null });
      partyOf.set(inv.from, pid);
    }
    const party = parties.get(pid)!;
    if (party.members.length >= PARTY_MAX) return "That party is full.";
    this.leave(to);
    party.members.push(to);
    partyOf.set(to, pid);
    changed(party.members);
    return null;
  },

  decline(to: number) { invites.delete(to); },

  promote(from: number, to: number): string | null {
    const pid = partyOf.get(from);
    if (!pid) return "You're not in a party.";
    const party = parties.get(pid)!;
    if (party.leader !== from) return "Only the party leader can transfer leadership.";
    if (!party.members.includes(to)) return "That player isn't in your party.";
    party.leader = to;
    changed(party.members);
    return null;
  },

  setRally(from: number, rally: { x: number; y: number; z: number } | null): string | null {
    const pid = partyOf.get(from);
    if (!pid) return "You're not in a party.";
    const party = parties.get(pid)!;
    if (party.leader !== from) return "Only the party leader can set a rally point.";
    party.rally = rally;
    changed(party.members);
    return null;
  },

  setTarget(from: number, targetId: string | null): string | null {
    const pid = partyOf.get(from);
    if (!pid) return "You're not in a party.";
    const party = parties.get(pid)!;
    if (party.leader !== from) return "Only the party leader can mark a target.";
    party.targetId = targetId;
    changed(party.members);
    return null;
  },

  leave(characterId: number) {
    const pid = partyOf.get(characterId);
    if (!pid) return;
    const party = parties.get(pid)!;
    party.members = party.members.filter((m) => m !== characterId);
    partyOf.delete(characterId);
    const affected = [characterId, ...party.members];
    if (party.members.length <= 1) {
      for (const m of party.members) partyOf.delete(m);
      parties.delete(pid);
    } else if (party.leader === characterId) {
      party.leader = party.members[0];
    }
    changed(affected);
  },

  nameOf(characterId: number) { return names.get(characterId) ?? "?"; },
};
