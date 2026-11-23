/**
 * Persistence. Uses Postgres when DATABASE_URL is set; otherwise PGlite, an
 * in-process Postgres (WASM) stored under ./data, so local development needs no
 * database install. Both run the same SQL.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultMantlePathFor, defaultTechniqueFor, type CharacterDraft, type CharacterSummary } from "@worlds-edge/shared";

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

const MIGRATION = /* sql */ `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  class_id TEXT NOT NULL,
  mantle TEXT NOT NULL,
  appearance JSONB NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  pos_x REAL, pos_y REAL, pos_z REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE characters ADD COLUMN IF NOT EXISTS mantle_awakened BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS colossus_clears INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS technique TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS mantle_path TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS quest_step INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS dungeon_clears (
  run_id TEXT NOT NULL,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  cleared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, character_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS characters_name_unique ON characters (lower(name));
CREATE INDEX IF NOT EXISTS characters_account ON characters (account_id);
`;

/**
 * PGlite is single-process: two servers opening the same folder corrupt it.
 * Refuse to start if another live process holds the lock.
 */
function lockDataDir(lockFile: string): () => void {
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, "utf8"));
    let alive = false;
    try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch { /* not running: stale lock */ }
    if (alive) {
      throw new Error(`Another server (process ${pid}) is already using ${lockFile.replace(/\.lock$/, "")}. Stop it, or set DATA_DIR to a different folder.`);
    }
  }
  writeFileSync(lockFile, String(process.pid));
  const release = () => { try { if (readFileSync(lockFile, "utf8") === String(process.pid)) unlinkSync(lockFile); } catch { /* already gone */ } };
  process.once("exit", release);
  return release;
}

export async function openSql(): Promise<Sql> {
  let sql: Sql;
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "0" ? undefined : process.env.DATABASE_URL.includes("localhost") ? undefined : { rejectUnauthorized: false },
      max: 5,
    });
    sql = {
      async query(text, params) { return (await pool.query(text, params as unknown[])).rows; },
      async exec(text) { await pool.query(text); },
      async close() { await pool.end(); },
    };
    console.log("Database: Postgres");
  } else {
    const dir = resolve(process.env.DATA_DIR ?? "data", "pglite");
    mkdirSync(dir, { recursive: true });
    const releaseLock = lockDataDir(`${dir}.lock`);
    const { PGlite } = await import("@electric-sql/pglite");
    const db = await PGlite.create(dir);
    sql = {
      async query<T>(text: string, params?: unknown[]) { return (await db.query<T>(text, params)).rows; },
      async exec(text) { await db.exec(text); },
      async close() { await db.close(); releaseLock(); },
    };
    console.log(`Database: PGlite at ${dir}`);
  }
  await sql.exec(MIGRATION);
  return sql;
}

interface CharacterRow {
  id: number;
  account_id: number;
  name: string;
  origin: string;
  class_id: string;
  mantle: string;
  appearance: CharacterDraft["appearance"];
  level: number;
  xp: number;
  mantle_awakened: boolean;
  technique: string;
  mantle_path: string;
  quest_step: number;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  updated_at: Date | string;
}

export interface StoredCharacter extends CharacterSummary {
  accountId: number;
  xp: number;
  mantleAwakened: boolean;
  questStep: number;
  position: { x: number; y: number; z: number } | null;
}

export interface Progress {
  x: number; y: number; z: number;
  xp: number;
  level: number;
  mantleAwakened: boolean;
  technique: string;
  mantlePath: string;
  questStep: number;
}

function toCharacter(r: CharacterRow): StoredCharacter {
  const classId = r.class_id as StoredCharacter["classId"];
  const mantle = r.mantle as StoredCharacter["mantle"];
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    origin: r.origin as StoredCharacter["origin"],
    classId,
    mantle,
    appearance: typeof r.appearance === "string" ? JSON.parse(r.appearance) : r.appearance,
    level: r.level,
    xp: r.xp,
    mantleAwakened: r.mantle_awakened,
    technique: r.technique || defaultTechniqueFor(classId),
    mantlePath: r.mantle_path || defaultMantlePathFor(mantle),
    questStep: r.quest_step ?? 0,
    updatedAt: new Date(r.updated_at).toISOString(),
    position: r.pos_x === null || r.pos_y === null || r.pos_z === null ? null : { x: r.pos_x, y: r.pos_y, z: r.pos_z },
  };
}

export class NameTakenError extends Error { }

export class Store {
  constructor(private sql: Sql) { }

  /** Find or create the account for an identity provider subject. Returns the account id. */
  async accountFor(provider: string, subject: string): Promise<number> {
    const rows = await this.sql.query<{ id: number }>(
      `INSERT INTO accounts (provider, subject) VALUES ($1, $2)
       ON CONFLICT (provider, subject) DO UPDATE SET last_login_at = now()
       RETURNING id`,
      [provider, subject],
    );
    return rows[0].id;
  }

  async listCharacters(accountId: number): Promise<StoredCharacter[]> {
    const rows = await this.sql.query<CharacterRow>(
      `SELECT * FROM characters WHERE account_id = $1 ORDER BY updated_at DESC`, [accountId],
    );
    return rows.map(toCharacter);
  }

  async countCharacters(accountId: number): Promise<number> {
    const rows = await this.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM characters WHERE account_id = $1`, [accountId]);
    return rows[0].n;
  }

  async createCharacter(accountId: number, d: CharacterDraft): Promise<StoredCharacter> {
    try {
      const rows = await this.sql.query<CharacterRow>(
        `INSERT INTO characters (account_id, name, origin, class_id, mantle, appearance, technique, mantle_path)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
        [accountId, d.name, d.origin, d.classId, d.mantle, JSON.stringify(d.appearance), defaultTechniqueFor(d.classId), defaultMantlePathFor(d.mantle)],
      );
      return toCharacter(rows[0]);
    } catch (err) {
      if (String((err as { code?: string }).code) === "23505") throw new NameTakenError("That name is taken.");
      throw err;
    }
  }

  async getCharacter(id: number, accountId: number): Promise<StoredCharacter | null> {
    const rows = await this.sql.query<CharacterRow>(
      `SELECT * FROM characters WHERE id = $1 AND account_id = $2`, [id, accountId],
    );
    return rows[0] ? toCharacter(rows[0]) : null;
  }

  async deleteCharacter(id: number, accountId: number): Promise<boolean> {
    const rows = await this.sql.query(`DELETE FROM characters WHERE id = $1 AND account_id = $2 RETURNING id`, [id, accountId]);
    return rows.length > 0;
  }

  /**
   * Record a dungeon clear and grant its reward in ONE statement, so the reward
   * can't be claimed twice for the same run (reconnecting, double messages).
   * Returns the character's new XP, or null if this run was already rewarded.
   */
  async grantClear(runId: string, characterId: number, xp: number): Promise<number | null> {
    const rows = await this.sql.query<{ xp: number }>(
      `WITH ins AS (
         INSERT INTO dungeon_clears (run_id, character_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING character_id
       )
       UPDATE characters SET xp = LEAST(xp + $3, 65535), colossus_clears = colossus_clears + 1, updated_at = now()
       WHERE id IN (SELECT character_id FROM ins)
       RETURNING xp`,
      [runId, characterId, xp],
    );
    return rows[0]?.xp ?? null;
  }

  async saveProgress(id: number, p: Progress): Promise<void> {
    await this.sql.query(
      `UPDATE characters SET pos_x = $2, pos_y = $3, pos_z = $4, xp = $5, level = $6, mantle_awakened = $7, technique = $8, mantle_path = $9, quest_step = $10, updated_at = now()
       WHERE id = $1`,
      [id, p.x, p.y, p.z, p.xp, p.level, p.mantleAwakened, p.technique, p.mantlePath, p.questStep],
    );
  }
}
