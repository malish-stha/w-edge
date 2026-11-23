import { Server, WebSocketTransport } from "colyseus";
import { ROOM_WORLD } from "@worlds-edge/shared";
import { createApi } from "./api.ts";
import { authConfig } from "./auth.ts";
import { openSql, Store } from "./db.ts";
import { WorldRoom, useStore } from "./WorldRoom.ts";

const port = Number(process.env.PORT ?? 2567);

const sql = await openSql();
const store = new Store(sql);
useStore(store);

const server = new Server({
  transport: new WebSocketTransport(),
  greet: false,
  express: (app) => {
    // Behind Caddy or Cloudflare Tunnel, trust the local proxy for client IPs (rate limiting).
    app.set("trust proxy", "loopback");
    app.get("/health", (_req, res) => { res.json({ ok: true }); });
    app.use("/api", createApi(store));
  },
});

server.define(ROOM_WORLD, WorldRoom);
server.onShutdown(async () => { await sql.close(); });

// Simulate round-trip latency in development, e.g. LATENCY=120 npm run dev.
if (process.env.LATENCY) server.simulateLatency(Number(process.env.LATENCY));

await server.listen(port);
console.log(`World's Edge server listening on ws://localhost:${port}`);
console.log(`Sign-in: Google ${authConfig.googleClientId ? "on" : "off (set GOOGLE_CLIENT_ID)"} · test accounts ${authConfig.devLogin ? "on" : "off"}`);
