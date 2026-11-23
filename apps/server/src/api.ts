/**
 * HTTP API under /api: sign-in and character slots. Authenticated with a Bearer
 * session token (no cookies), so cross-origin calls from the hosted client are safe.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { MAX_CHARACTERS, normalizeName, validateDraft, type CharacterDraft, type CharacterSummary } from "@worlds-edge/shared";
import { authConfig, issueSession, verifyGoogleCredential, verifySession } from "./auth.ts";
import { NameTakenError, type Store, type StoredCharacter } from "./db.ts";
import { onlineCharacters } from "./presence.ts";

const allowedOrigins = (process.env.CLIENT_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
}

/** Small fixed-window limiter for sign-in endpoints. */
function rateLimit(perMinute: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + 60_000 });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    if (++entry.count > perMinute) { res.status(429).json({ error: "Too many attempts. Try again in a minute." }); return; }
    next();
  };
}

function publicCharacter(c: StoredCharacter): CharacterSummary {
  return { id: c.id, name: c.name, origin: c.origin, classId: c.classId, mantle: c.mantle, appearance: c.appearance, level: c.level, technique: c.technique, mantlePath: c.mantlePath, questStep: c.questStep, updatedAt: c.updatedAt };
}

type Authed = Request & { accountId: number };

async function requireAccount(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const accountId = await verifySession(token);
  if (!accountId) { res.status(401).json({ error: "Please sign in again." }); return; }
  (req as Authed).accountId = accountId;
  next();
}

export function createApi(store: Store) {
  const api = express.Router();
  api.use(cors);
  api.use(express.json({ limit: "8kb" }));

  api.get("/auth/config", (_req, res) => {
    res.json({ googleClientId: authConfig.googleClientId, devLogin: authConfig.devLogin });
  });

  api.post("/auth/google", rateLimit(20), async (req, res) => {
    const credential = req.body?.credential;
    if (typeof credential !== "string") { res.status(400).json({ error: "Missing Google credential." }); return; }
    try {
      const subject = await verifyGoogleCredential(credential);
      const accountId = await store.accountFor("google", subject);
      res.json({ token: await issueSession(accountId) });
    } catch (err) {
      console.warn("Google sign-in rejected:", (err as Error).message);
      res.status(401).json({ error: "Google sign-in failed. Try again." });
    }
  });

  api.post("/auth/dev", rateLimit(30), async (req, res) => {
    if (!authConfig.devLogin) { res.status(404).json({ error: "Not available." }); return; }
    const player = typeof req.body?.player === "string" ? req.body.player.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) : "";
    if (!player) { res.status(400).json({ error: "Enter a test account name (letters and numbers)." }); return; }
    const accountId = await store.accountFor("dev", player);
    res.json({ token: await issueSession(accountId) });
  });

  api.get("/characters", requireAccount, async (req, res) => {
    const list = await store.listCharacters((req as Authed).accountId);
    res.json({ characters: list.map(publicCharacter), max: MAX_CHARACTERS });
  });

  api.post("/characters", requireAccount, async (req, res) => {
    const accountId = (req as Authed).accountId;
    const problem = validateDraft(req.body);
    if (problem) { res.status(400).json({ error: problem }); return; }
    if ((await store.countCharacters(accountId)) >= MAX_CHARACTERS) {
      res.status(400).json({ error: `You can have up to ${MAX_CHARACTERS} characters.` });
      return;
    }
    const body = req.body as CharacterDraft;
    const draft: CharacterDraft = {
      name: normalizeName(body.name),
      origin: body.origin, classId: body.classId, mantle: body.mantle,
      appearance: { skin: body.appearance.skin, hair: body.appearance.hair, outfit: body.appearance.outfit },
    };
    try {
      res.status(201).json({ character: publicCharacter(await store.createCharacter(accountId, draft)) });
    } catch (err) {
      if (err instanceof NameTakenError) { res.status(409).json({ error: err.message }); return; }
      throw err;
    }
  });

  api.delete("/characters/:id", requireAccount, async (req, res) => {
    const id = Number(req.params.id);
    if (onlineCharacters.has(id)) { res.status(409).json({ error: "That character is in the world right now." }); return; }
    const ok = Number.isInteger(id) && (await store.deleteCharacter(id, (req as Authed).accountId));
    res.status(ok ? 204 : 404).end();
  });

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return api;
}
