# IRON GLOVE

Multiplayer Iron Man flight game over the real JHU Homewood campus, rendered in
CesiumJS with Google Photorealistic 3D Tiles.

## Quick start

1. Get a free **Cesium Ion token** at https://ion.cesium.com/tokens
2. Create `client/.env` (copy from `client/.env.example`) and add it:
   ```env
   VITE_CESIUM_TOKEN=your_token_here
   ```
3. Run it:
   ```bash
   cd client
   npm install
   npm run dev
   ```
4. Open http://localhost:5173

That's all you need to fly. Everything else below is optional.

## Controls

| Key | Action |
|---|---|
| `W` / `S` | Thrust / brake |
| `A` / `D` or `←` / `→` | Yaw left / right |
| `↑` / `↓` | Climb / dive |
| `Q` / `E` | Roll (barrel roll) |
| `Space` | Boost |
| `R` | Reset to spawn |
| `V` | Switch camera between pilots |

Buildings and the ground stop the suit (no damage). **PULL UP** flashes below
~45m. Let go of everything and the suit hovers in place.

## Optional features

| Feature | How to enable |
|---|---|
| **Sound & JARVIS voice** | Add `ELEVENLABS_API_KEY` to `client/.env` (no key = built-in synth) |
| **JARVIS AI commands** | Add `GROK_API_KEY` to `client/.env` (no key = phrase matcher) |
| **Multiplayer** | Run a [SpacetimeDB](https://spacetimedb.com/install) instance — see below |
| **RL drone mission** | Press `1` / `M` in game — see [`docs/rl-system.md`](docs/rl-system.md) |

## Environment variables (`client/.env`)

```env
VITE_CESIUM_TOKEN=...        # required
VITE_GOOGLE_MAPS_API_KEY=... # optional: stream tiles direct from Google
ELEVENLABS_API_KEY=...       # optional: real sound effects + JARVIS voice
GROK_API_KEY=...             # optional: AI voice commands
VITE_SPACETIMEDB_HOST=ws://127.0.0.1:3000   # optional (this is the default)
VITE_SPACETIMEDB_DB_NAME=iron-glove         # optional (this is the default)
```

## Multiplayer (optional)

The game flies fine solo — with no database it just shows `LINK: OFFLINE`. For
the full round-trip you need the [SpacetimeDB CLI](https://spacetimedb.com/install)
(built against **2.10.1**) and Node. No Rust required.

```bash
spacetime start                 # leave running

cd server
npm install
npm run publish:local
npm run generate                # regenerates client bindings

cd ../client && npm run dev     # separate terminal
```

Inspect live state:
```bash
spacetime sql iron-glove --server local "SELECT * FROM player_state"
```

## More docs

- [`IRON_GLOVE_PROJECT.md`](IRON_GLOVE_PROJECT.md) — full plan and implementation log
- [`docs/rl-system.md`](docs/rl-system.md) — the RL Sentinel drone mission
