/**
 * Sign-in. Google Identity Services gives the browser a signed ID token; we
 * verify it against Google's public keys, then issue our own short session token
 * (HS256 JWT) that the client sends with API calls and when joining a room.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";

const production = process.env.NODE_ENV === "production";

export const authConfig = {
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  /** Name-only test accounts. On by default in development, off in production unless ALLOW_DEV_LOGIN=1. */
  devLogin: process.env.ALLOW_DEV_LOGIN === "1" || (!production && process.env.ALLOW_DEV_LOGIN !== "0"),
};

function loadSecret(): Uint8Array {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
    return new TextEncoder().encode(fromEnv);
  }
  if (production) throw new Error("Set SESSION_SECRET in production (32+ random characters).");
  // Development: keep a generated secret on disk so sessions survive restarts.
  const dir = resolve(process.env.DATA_DIR ?? "data");
  const file = resolve(dir, "dev-session-secret");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, randomBytes(48).toString("base64url"));
  }
  return new TextEncoder().encode(readFileSync(file, "utf8").trim());
}

const secret = loadSecret();
const SESSION_DAYS = 30;

export async function issueSession(accountId: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(accountId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .setIssuer("worlds-edge")
    .sign(secret);
}

/** Returns the account id, or null if the token is missing, forged or expired. */
export async function verifySession(token: string | undefined): Promise<number | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: "worlds-edge", algorithms: ["HS256"] });
    const id = Number(payload.sub);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/** Verify a Google ID token and return the stable Google account id (`sub`). */
export async function verifyGoogleCredential(credential: string): Promise<string> {
  if (!authConfig.googleClientId) throw new Error("Google sign-in is not configured.");
  const { payload } = await jwtVerify(credential, googleKeys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: authConfig.googleClientId,
  });
  if (!payload.sub) throw new Error("Google token has no subject.");
  return payload.sub;
}
