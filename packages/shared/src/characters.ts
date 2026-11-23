/**
 * Character creation options for the first playable build, and validation used
 * by both the creation screen and the server.
 */

export const ORIGINS = [
  { id: "harbourfolk", name: "Harbourfolk", blurb: "Practical coats and layered scarves. Recover a flight chart from a rooftop beacon." },
  { id: "skyborn", name: "Skyborn", blurb: "Feather crests and wind ribbons. Help repair the wind beacon on the upper terraces." },
  { id: "stonekin", name: "Stonekin", blurb: "Faceted shoulders and crystal growths. Retrieve a guild memorial from the quarry path." },
] as const;

export const CLASSES = [
  { id: "saber", name: "Saber", weapon: "Sword", blurb: "Aerial duelling and counters. Parry an attack, then release it." },
  { id: "archer", name: "Archer", weapon: "Bow", blurb: "Precision and positioning. Plant arrows and fire from two angles." },
  { id: "vanguard", name: "Vanguard", weapon: "Shield", blurb: "Interception and protection. Catch a shockwave and launch allies." },
  { id: "lancer", name: "Lancer", weapon: "Spear", blurb: "High-speed aerial strikes. Build momentum and dive." },
] as const;

export const MANTLES = [
  { id: "storm", name: "Storm", blurb: "Static marks and chain lightning. Ride updrafts." },
  { id: "tide", name: "Tide", blurb: "Currents that drag and redirect. Ride the water's surface." },
  { id: "titan", name: "Titan Strength", blurb: "Stagger giants and hurl debris. Leap between peaks." },
] as const;

export const SKIN_TONES = ["#f4d3b8", "#e9b48a", "#c98e62", "#a26a42", "#7a4b2c", "#553220"] as const;
export const HAIR_COLORS = ["#2b2f3a", "#5a3a22", "#a0622d", "#d9b36a", "#e8e4dc", "#b8443a", "#3e6fb0"] as const;
export const OUTFIT_COLORS = ["#e4572e", "#29335c", "#f3a712", "#669bbc", "#4f9a6a", "#c86fc9", "#2ec4b6", "#8c5a3c"] as const;

export type OriginId = (typeof ORIGINS)[number]["id"];
export type ClassId = (typeof CLASSES)[number]["id"];
export type MantleId = (typeof MANTLES)[number]["id"];

export interface Appearance {
  skin: string;
  hair: string;
  outfit: string;
}

export interface CharacterDraft {
  name: string;
  origin: OriginId;
  classId: ClassId;
  mantle: MantleId;
  appearance: Appearance;
}

/** A saved character as the server returns it. */
export interface CharacterSummary extends CharacterDraft {
  id: number;
  level: number;
  technique: string;
  mantlePath: string;
  updatedAt: string;
}

export const MAX_CHARACTERS = 4;
export const NAME_MIN = 3;
export const NAME_MAX = 16;

export function normalizeName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Returns an error message, or null when the draft is valid. */
export function validateDraft(d: unknown): string | null {
  if (!d || typeof d !== "object") return "Missing character details.";
  const c = d as Record<string, unknown>;
  if (typeof c.name !== "string") return "Choose a name.";
  const name = normalizeName(c.name);
  if (name.length < NAME_MIN || name.length > NAME_MAX) return `Names are ${NAME_MIN}–${NAME_MAX} characters.`;
  if (!/^[\p{L}][\p{L}' -]*$/u.test(name)) return "Names can use letters, spaces, apostrophes and hyphens.";
  if (!ORIGINS.some((o) => o.id === c.origin)) return "Choose an origin.";
  if (!CLASSES.some((o) => o.id === c.classId)) return "Choose a class.";
  if (!MANTLES.some((o) => o.id === c.mantle)) return "Choose a starter mantle.";
  const a = c.appearance as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return "Choose an appearance.";
  if (!(SKIN_TONES as readonly unknown[]).includes(a.skin)) return "Choose a skin tone.";
  if (!(HAIR_COLORS as readonly unknown[]).includes(a.hair)) return "Choose a hair colour.";
  if (!(OUTFIT_COLORS as readonly unknown[]).includes(a.outfit)) return "Choose an outfit colour.";
  return null;
}

export function randomDraft(rand: () => number = Math.random): Omit<CharacterDraft, "name"> {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  return {
    origin: pick(ORIGINS).id,
    classId: pick(CLASSES).id,
    mantle: pick(MANTLES).id,
    appearance: { skin: pick(SKIN_TONES), hair: pick(HAIR_COLORS), outfit: pick(OUTFIT_COLORS) },
  };
}
