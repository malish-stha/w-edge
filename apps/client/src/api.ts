import type { CharacterDraft, CharacterSummary } from "@worlds-edge/shared";

/** Talks to the game server's HTTP API (sign-in and character slots). */
export class Api {
  readonly httpBase: string;
  private token: string | null = null;

  constructor(readonly wsUrl: string) {
    this.httpBase = wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/$/, "");
    try { this.token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }
  }

  get sessionToken() { return this.token; }

  setToken(token: string | null) {
    this.token = token;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* storage unavailable: session lasts until reload */ }
  }

  private async call<T>(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.httpBase}/api${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (res.status === 401) this.setToken(null);
      if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status}).`);
      return body as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, "Couldn't reach the game server.");
    } finally {
      clearTimeout(timer);
    }
  }

  config() {
    return this.call<{ googleClientId: string | null; devLogin: boolean }>("/auth/config", {}, 5000);
  }

  async signInWithGoogle(credential: string) {
    const { token } = await this.call<{ token: string }>("/auth/google", { method: "POST", body: JSON.stringify({ credential }) });
    this.setToken(token);
  }

  async signInDev(player: string) {
    const { token } = await this.call<{ token: string }>("/auth/dev", { method: "POST", body: JSON.stringify({ player }) });
    this.setToken(token);
  }

  characters() {
    return this.call<{ characters: CharacterSummary[]; max: number }>("/characters");
  }

  async createCharacter(draft: CharacterDraft) {
    const { character } = await this.call<{ character: CharacterSummary }>("/characters", { method: "POST", body: JSON.stringify(draft) });
    return character;
  }

  async deleteCharacter(id: number) {
    await this.call(`/characters/${id}`, { method: "DELETE" });
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const TOKEN_KEY = "we.session";
