# World's Edge

Prototype of the World's Edge MMORPG: a shared coastal city, flight, the Broken Isles and the ocean route to the rim, with server-authoritative multiplayer.

**Stack:** TypeScript everywhere · Babylon.js 9 (WebGL 2) client · Colyseus 0.18 server · npm workspaces.

## Run it

```sh
npm install
npm run dev        # server on :2567, client on http://localhost:5173
```

In development you sign in with a **test account** (type any name, no password) — use different names in two browser windows to play together. Create a character, then click the game to capture the mouse; Esc opens the menu (change character, sign out). Characters, XP, level, awakened mantle and last safe position are saved to `apps/server/data/` (PGlite).

**Where to go:** training dummies stand in the training yard where you spawn, and the shrine (pale blue pillar) is at the yard's far end, to your left as you start — press E there to awaken your mantle. Flying toward the rim (the way you face at the start), Reef Wretches live on the first island ahead-left, and a Hullbreaker guards an isle ahead-right. Kills give XP; levels 1–5 are proposed playtest values.

**Parties and the Drowned Colossus:** press P to open the party panel and invite nearby players (up to 4); invitees press Y to join. At level 5, gather at the arch beyond the rim settlement (fly over the falls and down); the leader presses E, everyone presses Y, and the party moves into its own copy of the dungeon. Phases: break the three anchors while the arm slams the platforms, survive two waves (fly over, skim the sea under, or hide behind rock), break the chest plate and hit the exposed heart, then chase the heart through the air. Hold E next to a downed teammate to revive them; if everyone goes down, the fight resets to the start of the phase. The clear gives 200 XP, once. Press E on the entry platform afterwards to return.

| Key | Action |
|---|---|
| WASD + mouse | Move and look |
| Space | Jump; Space again in midair to take off; hold to climb |
| Ctrl or C | Descend; a slow approach lands |
| Shift | Run on foot, boost in flight; look down while boosting to dive |
| Q | Dodge |
| Left mouse | Attack (hold to keep the three-hit combo going) |
| 1 | Mantle skill (after the shrine): Tide Undertow, Storm Chain Lightning, Titan Slam |
| E | Interact (shrine, dungeon gate); hold to revive a downed player |
| P | Party panel (invite nearby players, leave party) |
| Y / N | Accept / decline a party invite; Y = ready at the gate |
| Wheel | Camera distance |
| Esc | Menu |
| H / F3 | Toggle help / performance stats |

URL options: `?quality=low|medium|high`, `?offline` (solo), `?server=wss://…`.

## Checks

```sh
npm test           # movement simulation tests
npm run typecheck
npm run bot        # headless player (test account) against a running server; verifies inputs are acked and prediction matches
npm run combat-bot # headless fight: dummy, shrine, wretches + Undertow, Hullbreaker charge/shield, dive impact
npm run dungeon-bot # two players: party, ready check, private dungeon, revive, wipe reset, reconnect, all phases, reward once
npx tsx scripts/smoke.ts <outDir>          # browser: sign-in → create → play → sign out → resume, with screenshots (needs Edge/Chrome)
npx tsx scripts/combat-smoke.ts <outDir>   # browser: the combat slice, with screenshots
npx tsx scripts/dungeon-smoke.ts <outDir>  # two browsers: party panel → gate → Colossus phases → clear → home
```

## Environment art

Everything you see is a model from the free CC0 packs in `Worlds_Edge_Free_3D_Environment_Packs.pdf` — no plain blocks. The islands, the harbour and the settlement shelf are laid out on a hex grid and built from **KayKit Medieval Hexagon** tiles (grass tops, rock columns down to the sea); First Harbour is a town of KayKit buildings; each isle is dressed with its own pack:

| Area | Pack | Status |
|---|---|---|
| Terrain everywhere, First Harbour's town, clouds | KayKit Medieval Hexagon | ✅ |
| First Harbour: beacon tower, siege engines | Kenney Castle Kit | ✅ |
| Docks and lighthouse | Kenney Pirate Kit | ✅ |
| Ocean route | Kenney Watercraft Kit | ✅ |
| Wretch isle | Kenney Nature Kit | ✅ |
| Smuggler's cove | Kenney Pirate Kit | ✅ |
| Rim settlement | Kenney Modular Cave Kit + KayKit buildings and torches | ✅ |
| Colossus arena | KayKit Dungeon (pillars, plate) + Kenney Modular Dungeon Kit | ✅ |
| Pinecrest | Quaternius Ultimate Nature | stand-in (Nature Kit pines) |
| Castaway camp | Quaternius Survival Pack | stand-in (KayKit camp) |
| Ember spire | Quaternius Ultimate Stylized Nature | stand-in (Nature Kit autumn) |
| Farmstead | Quaternius Medieval Village Pack | stand-in (KayKit farm) |
| Darkwood | Quaternius Modular Medieval Buildings | stand-in (Nature Kit dark forest, KayKit ruins) |
| Palm reach | Quaternius Pirate Kit | stand-in (Nature Kit palms) |
| Wreck spire | Quaternius Ships Pack | stand-in (Pirate Kit wreckage) |

```sh
npm run fetch-assets   # download packs into .asset-cache/ (git-ignored)
npm run build-env      # convert what the world places into apps/client/public/env + the model table
npx tsx scripts/preview-models.ts <pack> [regex]   # then open /preview.html?pack=<pack> to compare models
```

- **Terrain** (`packages/shared/src/hex.ts`): cells are KayKit hex tiles, pointy along z. Each cell is a grass tile on a stretched stone column; collision is one brick per cell (bricks of neighbouring rows interlock exactly) merged into runs, so what you see is what you stand on, to within a metre at the zigzag edges. Isle tops are flat for fights, with broken ledges around their rims.
- **Layout** (`packages/shared/src/world.ts`): the harbour town (buildings on a jittered grid facing the plaza, training yard with walls, shrine, terrace stairs, beacon, docks), the isles (hex pillars, shards, peaks), the rim (rocks along the lip, a sea of cloud below) and the settlement shelf. Gameplay spots keep their old coordinates (spawn, shrine, stairs, beacon, docks, isles, gate). Props per area are scattered by `packages/shared/src/dressing.ts` (island top, cliff edge, shallows, open water), seeded so the server and clients agree.
- **Colliders follow the models.** The asset build stores a 4×4 height profile for every model; buildings, towers, peaks and walls get stepped colliders from it (land on roofs and towers), trees get a trunk, rocks a box.
- **Colour.** The build recolours the Kenney Nature Kit's turquoise palette to match KayKit and remaps KayKit's grass and cliff swatches, so the packs sit together.
- **Rendering** (`apps/client/src/render/dressing.ts`): one merged mesh per model per area, drawn as thin instances with a slight colour variation per instance; terrain and landmarks load at once, props within ~650 m. Clouds drift and boats ride the swell.
- **Atmosphere** (`render/atmosphere.ts`, `render/ambience.ts`, ocean shader): sun shadows around the camera on medium/high (dropped automatically if the frame rate can't hold), a light colour grade, turquoise shallows and surf around every coast, sun glints, the beacon's fire and smoke, shrine motes, torch flames, and spray where the sea pours over the rim. Low quality skips shadows and grading.
- Quaternius packs come from Google Drive, which refused them with "download quota exceeded" — re-run `npm run fetch-assets` later, then `npm run build-env`; their isles switch from stand-ins automatically. KayKit Medieval Hexagon and Dungeon come from KayKit's official GitHub repositories (extracted into `.asset-cache/kaykit-medieval-hexagon` and `.asset-cache/kaykit-dungeon`); the other itch.io packs need a browser download.
- Credits: `apps/client/public/env/CREDITS.md`.

## How it fits together

```
packages/shared   movement + collision + world layout + character options — the ONLY copy, run by both sides
apps/server       Colyseus room (inputs at 30 Hz, state at 20 Hz), /api sign-in + character slots, Postgres/PGlite
apps/client       Babylon.js renderer, input, camera, HUD, menus; predicts the local player, interpolates others
```

- **Accounts.** The browser gets a Google ID token from Google Identity Services; the server verifies it against Google's keys and issues its own 30-day session token. Only Google's account id is stored — no email or name. Joining the world checks the token and that the character belongs to the account, and refuses a character that's already online.
- **Saving.** A character's last safe ground position, XP, level and mantle are saved every 20 s, on level-up and awakening, when the connection drops, and on leaving. A dropped player's place is held for 20 s while the client reconnects.
- **Rooms.** `GameRoom` holds everything shared (auth, input loop, combat, revives, parties, saving); `WorldRoom` adds the overworld, shrine and gate; `ColossusRoom` is one private dungeon per party with its own arena geometry (`packages/shared/src/colossus.ts`). Parties live per server process (`parties.ts`) so they survive moving between rooms. Dungeon clears and their XP are written in one SQL statement keyed by run, so a reward can't be claimed twice. A player who disconnects mid-dungeon is sent back into it when they rejoin.
- **Local database lock.** PGlite only supports one process: the server takes `data/pglite.lock` and refuses to start if another live server holds it (two servers on one folder corrupt it).
- **Combat.** Attacks are input bits, so the swing and lunge are predicted like movement; the server resolves hits (`apps/server/src/combat.ts`), runs enemy AI (`enemies.ts`) and sends one batch of effects per tick. Every hit has separate health and guard damage; breaking guard staggers. Tuning lives in `packages/shared/src/combat.ts`. Kill credit goes to everyone who hit the enemy in the last 30 s.

- **Prediction.** The client applies its inputs immediately using `stepMovement`, sends them, and when the server's state arrives the Colyseus reconciler rewinds to it and replays unacknowledged inputs. Because both sides run identical code, corrections are normally zero.
- **Remote players** render ~100 ms in the past, interpolated between server snapshots.
- **World geometry** is generated deterministically in `packages/shared/src/world.ts`, so server collision and client rendering always match. Collision is axis-aligned boxes (invisible); everything drawn is a pack model.
- **Low-end rendering.** Each model is one draw call per area (thin instances). The ocean is a camera-following grid with a vertex-wave shader. When the frame rate drops, shadows go first, then the resolution scales down. `?quality=low` skips shadows and post-processing.

## Deploy

**Client → Vercel** (static files). `vercel.json` is already set up. In the Vercel project settings set `VITE_SERVER_URL=wss://your-game-domain`, then `npx vercel` (or connect the Git repo). Without it the deployed client runs solo.
Vercel's free Hobby plan is for non-commercial use; Cloudflare Pages works the same way (build `npm run build -w @worlds-edge/client`, output `apps/client/dist`).

**Server → a long-running host** (Oracle Cloud Always Free VM, any VPS, or your PC with Cloudflare Tunnel):

```sh
git clone <repo> worlds-edge && cd worlds-edge
npm ci && npm run build -w @worlds-edge/server
node apps/server/dist/index.js           # or install deploy/worlds-edge.service
```

Put Caddy in front for TLS (`deploy/Caddyfile`); browsers on an https page can only connect to `wss://`. Server settings are listed in `apps/server/.env.example`; production needs `SESSION_SECRET` and `GOOGLE_CLIENT_ID`. Without `DATABASE_URL` the server keeps using PGlite files on the VM's disk, which is fine for playtests; point it at Postgres (Supabase/Neon free tier or Postgres on the VM) before real players arrive. Simulate latency locally with `LATENCY=150 npm run dev -w @worlds-edge/server`.

### Turning on Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create a project, configure the OAuth consent screen (External, app name, support email), then **Create credentials → OAuth client ID → Web application**.
2. Under **Authorized JavaScript origins** add every address the client is served from: `http://localhost:5173` for development and your production origin (e.g. `https://worlds-edge.vercel.app`). No redirect URIs are needed.
3. Set `GOOGLE_CLIENT_ID` on the **server** (`apps/server/.env`). The client reads it from the server, so there's nothing to set on Vercel.

## Status

The design document carries a full done / left checklist (section "Build status"). In short, still to build: the class signature mechanics other than the Lancer's Horizon Break, signature techniques, ultimates, the harder dungeon version, gear and currencies, chat and pings, and real art. Characters are box-built placeholders (real models come from Blender as glTF on the shared rig); monsters use the CC0 monster models in `apps/client/public/monsters`.
