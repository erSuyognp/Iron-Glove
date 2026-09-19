# IRON GLOVE

Multiplayer Iron Man flight game over the real JHU Homewood campus, rendered in
CesiumJS with Google Photorealistic 3D Tiles.

See [`IRON_GLOVE_PROJECT.md`](IRON_GLOVE_PROJECT.md) for the full plan and the
detailed Phase 1 implementation log.

## Status — Phase 1 (Foundation) ✅

Phase 1 is client-only (no SpacetimeDB / Grok yet, by design) and complete, with
extra gameplay and flight-feel features added on top:

- ✅ CesiumJS viewer with Google Photorealistic 3D Tiles at JHU Homewood
- ✅ Keyboard flight with a weighted flight model (0.08 lerp, framerate-independent)
- ✅ Third-person chase camera
- ✅ HUD: ALT (height above ground), SPD, PITCH, ROLL, HDG, MODE, suit HP, JARVIS ticker
- ✅ **Low flying** — skim rooftops; buildings and the ground stop the suit (no collision damage)
- ✅ **Barrel roll** (Q/E rolls the whole view, auto-levels)
- ✅ **Speed effects** — edge motion blur + vignette + FOV punch that ramp with velocity
- ✅ **In-flight avionics** — animated artificial horizon / pitch ladder, bank arc, scrolling heading tape
- ✅ **Afterburner trail** that brightens/lengthens with throttle
- ✅ **GPWS "PULL UP"** ground-proximity warning
- ✅ **Idle levitation** — the suit gently hovers up/down when still
- ✅ **Adaptive GPU quality** + performance tuning (see below)

## Status — Phase 2 (Multiplayer plumbing) ✅ (single-player)

The SpacetimeDB layer is wired end to end for one player:

- ✅ **SpacetimeDB module** (`server/`) with the `PlayerState` and `GameEvent`
  tables and the `join_game` + `update_orientation` reducers.
- ✅ **JS SDK wired into the client** — on load it connects, subscribes to
  `player_state`, and calls `join_game`.
- ✅ **Round-trip** — each frame the client pushes its computed transform via
  `update_orientation`, then renders the suit from the row it reads back. The
  HUD shows `LINK: ONLINE` when connected.
- ✅ **Physics stays client-side.** The server does zero movement/game logic —
  it just stores rows and broadcasts deltas, exactly as the plan requires.

> **Note:** the plan specifies a *Rust* module, but this machine has no Rust
> toolchain, so the module is written in **TypeScript** (SpacetimeDB TS modules
> run on V8 and publish with just the CLI + Node). Same tables, same reducer
> names. `update_orientation` also carries `position_x/y/z` — with no physics on
> the server, the client is the only thing that can produce a position, so it
> sends its already-computed one for the server to store.

Not started yet (later phases): the second player / phone controller,
MPU-6050 glove, Grok/JARVIS AI, 3D suit model.

## Setup

1. **Get a Cesium Ion token** (free) at https://ion.cesium.com/tokens
2. Add it to `client/.env` (already git-ignored):
   ```env
   VITE_CESIUM_TOKEN=your_real_token_here
   ```
3. Install and run:

   ```bash
   cd client
   npm install
   npm run dev
   ```

4. Open http://localhost:5173

If the token is missing or invalid, the app shows an on-screen banner telling
you what to fix instead of a blank world.

## SpacetimeDB (Phase 2)

The client fails soft: with no database reachable it just flies on local physics
and shows `LINK: OFFLINE`. To run the full round-trip locally you need the
[SpacetimeDB CLI](https://spacetimedb.com/install) (this repo was built against
**2.10.1**) and Node — **no Rust toolchain required**.

```bash
# 1. Start a local SpacetimeDB instance (leave running)
spacetime start

# 2. Build + publish the TypeScript module, then generate client bindings
cd server
npm install
npm run publish:local          # spacetime publish iron-glove --server local -y
npm run generate               # regenerates client/src/module_bindings

# 3. Run the client (separate terminal)
cd ../client && npm run dev
```

The client reads `VITE_SPACETIMEDB_HOST` / `VITE_SPACETIMEDB_DB_NAME` from
`client/.env` (defaults: `ws://127.0.0.1:3000` and `iron-glove`). Inspect state
directly with:

```bash
spacetime sql iron-glove --server local "SELECT * FROM player_state"
```

`server/src/module_bindings` is generated code — re-run `npm run generate`
whenever the module schema changes.

## Controls

| Key | Action |
|---|---|
| `W` / `S` | Thrust forward / brake |
| `A` / `D` | Yaw left / right |
| `←` / `→` | Yaw left / right |
| `↑` / `↓` | Climb / dive |
| `Q` / `E` | Roll left / right (barrel roll) |
| `Space` | Boost (afterburner) |
| `R` | Reset to spawn |
| `V` | Switch camera POV between your suit and other airborne pilots |

- Buildings and the ground stop the suit, but collisions never cost health.
- **PULL UP** flashes when you drop below ~45m above ground.
- Let go of all controls and the suit levitates in place.
- When a second pilot (e.g. the judge on the phone controller) starts
  streaming, their suit appears with amber thrusters, JARVIS announces them,
  and a **POV ▸ JUDGE** button appears in the HUD — click it or press `V` to
  follow their suit. If their feed stops for 3 s the camera returns to yours.

## Performance & GPU

The app auto-detects the GPU the browser landed on and picks a quality tier
(shown in the HUD as `GFX`, and in the console as `[IRON GLOVE] GPU: …`):

- **LEAN** — integrated GPUs: 1× resolution, no MSAA, relaxed tile detail.
- **HIGH** — other discrete GPUs: full device-pixel-ratio, 4× MSAA, HDR, sharper tiles.
- **ULTRA** — RTX 30/40/50-series, Radeon RX 7000/9000, Arc B-series: HIGH plus
  the sharpest tiles, a 4 GB tile cache, and 1.5× supersampling on low-DPI displays.

Force a tier with `?quality=lean|high|ultra`, e.g. `http://localhost:5173/?quality=ultra`.

If you have a discrete GPU (e.g. RTX) but the HUD says `LEAN`, the browser is
using the integrated GPU. Assign the Claude app / browser to the discrete card
in **Windows → Settings → System → Display → Graphics** (choose *High
performance*) and **NVIDIA Control Panel → Program Settings**, plug in on Best
Performance power, and restart it.

Realism settings on every tier: real sunlight at a fixed late-afternoon time
(sky and atmospheric haze follow it), Cesium's globe hidden under Google's
planet-wide tiles, and every level of detail refined in order so the horizon
never shows the coarse placeholder tiles as a dark band.

Other tuning applied: 3× parallel tile requests for faster streaming, and
throttled mesh-height sampling to avoid per-frame GPU stalls.

## Environment variables (`client/.env`)

```env
VITE_CESIUM_TOKEN=your_cesium_ion_token          # required
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_key    # optional (same tiles, Google billing)
VITE_SPACETIMEDB_HOST=ws://127.0.0.1:3000        # Phase 2 (default if unset)
VITE_SPACETIMEDB_DB_NAME=iron-glove              # Phase 2 (default if unset)
# VITE_GROK_API_KEY=...        # Phase 4
```

By default the Google Photorealistic 3D Tiles are streamed through Cesium Ion
asset `2275207` using the Ion token — no Google Maps key required. If you set
`VITE_GOOGLE_MAPS_API_KEY`, the tiles stream directly from Google instead
(identical imagery, Google billing).

## Project layout (Phase 1)

```
client/
├── index.html            # HUD markup + Cesium container + speed-fx layers
├── vite.config.js        # Vite + vite-plugin-cesium
├── .env                  # VITE_CESIUM_TOKEN (git-ignored)
├── .env.example          # template
└── src/
    ├── main.js           # entry: flight model, collision/health, hover, game loop
    ├── cesium/
    │   ├── world.js      # viewer, Google 3D Tiles, adaptive GPU quality
    │   └── camera.js     # third-person chase camera (roll + hover aware)
    ├── input/
    │   └── keyboard.js   # WASD / arrows controller
    ├── suit/
    │   ├── collision.js  # mesh height sampling + forward obstacle ray
    │   └── thruster.js   # afterburner trail (glowing polyline)
    ├── hud/
    │   ├── hud.js        # HUD DOM updates, speed FX, GPWS, LINK status
    │   ├── hud.css       # HUD + speed-fx + GPWS styling
    │   └── attitude.js   # artificial horizon / pitch ladder / heading tape
    ├── spacetimedb/
    │   └── client.js     # Phase 2: connect, subscribe, join_game, push/read-back
    └── module_bindings/  # generated by `spacetime generate` (do not edit)

server/                   # Phase 2: SpacetimeDB module (TypeScript, runs on V8)
├── package.json          # build / publish:local / generate scripts
└── src/
    └── index.ts          # PlayerState + GameEvent tables, join_game + update_orientation
```
