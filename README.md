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
- ✅ **Low flying + crash damage** — skim rooftops, hit buildings to lose health, auto-reboot at 0 HP
- ✅ **Barrel roll** (Q/E rolls the whole view, auto-levels)
- ✅ **Speed effects** — edge motion blur + vignette + FOV punch that ramp with velocity
- ✅ **In-flight avionics** — animated artificial horizon / pitch ladder, bank arc, scrolling heading tape
- ✅ **Afterburner trail** that brightens/lengthens with throttle
- ✅ **GPWS "PULL UP"** ground-proximity warning
- ✅ **Idle levitation** — the suit gently hovers up/down when still
- ✅ **Adaptive GPU quality** + performance tuning (see below)

Not started yet (later phases): SpacetimeDB multiplayer, phone controller,
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

- Fly into a building or hit the ground hard to take damage; JARVIS calls it out
  and the suit auto-reboots when health hits 0.
- **PULL UP** flashes when you drop below ~45m above ground.
- Let go of all controls and the suit levitates in place.

## Performance & GPU

The app auto-detects the GPU the browser landed on and adapts:

- **Integrated GPU** → lean quality (1× resolution, MSAA off) for smooth FPS.
- **Discrete NVIDIA / RTX / Arc** → HIGH quality (full device-pixel-ratio + 4× MSAA)
  automatically. Check the console for `[IRON GLOVE] GPU: … — HIGH/LEAN quality`.

If you have a discrete GPU (e.g. RTX) but the log says `LEAN`, the browser is
using the integrated GPU. Assign the Claude app / browser to the discrete card
in **Windows → Graphics settings** and **NVIDIA Control Panel → Program
Settings**, plug in on Best Performance power, and restart.

Other tuning applied: ~1.5 GB tile cache, 3× parallel tile requests for faster
streaming, and throttled mesh-height sampling to avoid per-frame GPU stalls.

## Environment variables (`client/.env`)

```env
VITE_CESIUM_TOKEN=your_cesium_ion_token          # required
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_key    # optional (same tiles, Google billing)
# VITE_GROK_API_KEY=...        # Phase 4
# VITE_SPACETIMEDB_HOST=...    # Phase 2
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
    └── hud/
        ├── hud.js        # HUD DOM updates, speed FX, GPWS
        ├── hud.css       # HUD + speed-fx + GPWS styling
        └── attitude.js   # artificial horizon / pitch ladder / heading tape
```
