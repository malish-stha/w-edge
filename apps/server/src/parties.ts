/**
 * Parties of up to four, tracked per server process so they survive moving
 * between the overworld and a dungeon. (Multi-process deployments move this to
 * Colyseus presence/Redis.)
 */
export const PARTY_MAX = 4;
const INVITE_SECONDS = 60;

export interface Party { id: string; leader: number; members: number[] }

export interface RosterMember { id: number; name: string; leader: boolean; roomId: string | null; sessionId: string | null }
export interface Roster { partyId: string; members: RosterMember[] }

interface Location { roomId: string; sessionId: string }

const parties = new Map<string, Party>();
const partyOf = new Map<number, string>();
const invites = new Map<number, { from: number; expires: number }>();
const names = new Map<number, string>();
const where = new Map<number, Location>();
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

  arrive(characterId: number, name: string, loc: Location) {
    names.set(characterId, name);
    where.set(characterId, loc);
    transfers.delete(characterId);
    const pid = partyOf.get(characterId);
    if (pid) changed(parties.get(pid)!.members);
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

  roster(characterId: number): Roster | null {
    const pid = partyOf.get(characterId);
    if (!pid) return null;
    const p = parties.get(pid)!;
    return {
      partyId: pid,
      members: p.members.map((id) => ({
        id, name: names.get(id) ?? "?", leader: id === p.leader,
        roomId: where.get(id)?.roomId ?? null, sessionId: where.get(id)?.sessionId ?? null,
      })),
    };
  },

  /** Returns an error message, or null when the invite was sent. */
  invite(from: number, to: number): string | null {
    if (from === to) return "You can't invite yourself.";
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
      parties.set(pid, { id: pid, leader: inv.from, members: [inv.from] });
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

  leave(characterId: number) {
    const pid = partyOf.get(characterId);
    if (!pid) return;
    const party = parties.get(pid)!;
    party.members = party.members.filter((m) => m !== characterId);
    partyOf.delete(characterId);
    const affected = [characterId, ...party.members];
    if (party.members.length <= 1) {
      // A party of one is just a player.
      for (const m of party.members) partyOf.delete(m);
      parties.delete(pid);
    } else if (party.leader === characterId) {
      party.leader = party.members[0];
    }
    changed(affected);
  },

  nameOf(characterId: number) { return names.get(characterId) ?? "?"; },
};
