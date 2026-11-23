# World's Edge

Prototype of the World's Edge MMORPG: a shared coastal city, flight, the Broken Isles and the ocean route to the rim, with server-authoritative multiplayer.

**Stack:** TypeScript everywhere · Babylon.js 9 (WebGL 2) client · Colyseus 0.18 server · npm workspaces.

## Run it

```sh
npm install
npm run dev        # server on :2567, client on http://localhost:5173
```

Open the client in two browser windows to see each other. Click the game to capture the mouse; Esc releases it.

| Key | Action |
|---|---|
| WASD + mouse | Move and look |
| Space | Jump; Space again in midair to take off; hold to climb |
| Ctrl or C | Descend; a slow approach lands |
| Shift | Run on foot, boost in flight; look down while boosting to dive |
| Q | Dodge |
| Wheel | Camera distance |
| H / F3 | Toggle help / performance stats |

URL options: `?quality=low|medium|high`, `?offline` (solo), `?server=wss://…`.

## Checks

```sh
npm test           # movement simulation tests
npm run typecheck
npm run bot        # headless player against a running server; verifies inputs are acked and prediction matches
npx tsx scripts/smoke.ts <outDir>   # headless browser run with screenshots (needs Edge/Chrome)
```

## How it fits together

```
packages/shared   movement + collision + world layout — the ONLY copy, run by both sides
apps/server       Colyseus room: buffers each client's inputs, steps them at 30 Hz, broadcasts state at 20 Hz
apps/client       Babylon.js renderer, input, camera, HUD; predicts the local player, interpolates others
```

- **Prediction.** The client applies its inputs immediately using `stepMovement`, sends them, and when the server's state arrives the Colyseus reconciler rewinds to it and replays unacknowledged inputs. Because both sides run identical code, corrections are normally zero.
- **Remote players** render ~100 ms in the past, interpolated between server snapshots.
- **World geometry** is generated deterministically from a seed in `packages/shared/src/world.ts`, so server collision and client rendering always match. Everything solid is an axis-aligned box.
- **Low-end rendering.** The whole static world is one mesh with lighting baked into vertex colours and a hand-written unlit shader (one draw call). The ocean is a camera-following grid with a vertex-wave shader. Resolution scales down automatically when the frame rate drops.

## Deploy

**Client → Vercel** (static files). `vercel.json` is already set up. In the Vercel project settings set `VITE_SERVER_URL=wss://your-game-domain`, then `npx vercel` (or connect the Git repo). Without it the deployed client runs solo.
Vercel's free Hobby plan is for non-commercial use; Cloudflare Pages works the same way (build `npm run build -w @worlds-edge/client`, output `apps/client/dist`).

**Server → a long-running host** (Oracle Cloud Always Free VM, any VPS, or your PC with Cloudflare Tunnel):

```sh
git clone <repo> worlds-edge && cd worlds-edge
npm ci && npm run build -w @worlds-edge/server
node apps/server/dist/index.js           # or install deploy/worlds-edge.service
```

Put Caddy in front for TLS (`deploy/Caddyfile`); browsers on an https page can only connect to `wss://`. Simulate latency locally with `LATENCY=150 npm run dev -w @worlds-edge/server`.

## Not built yet

Google sign-in and saved characters (Postgres), character creation, classes and combat, the Colossus dungeon, parties, chat. Characters are box-built placeholders; real models come from Blender as glTF on the shared rig.
