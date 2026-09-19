# Environmental Intelligence — California Wildfire world

Iron Glove now has two worlds. `?world=jhu` (default) is the unchanged
Homewood training/combat world. `?world=california-wildfire` puts the suit over
the Sierra Nevada with real NASA FIRMS active-fire detections drawn in the
scene, an evidence panel for each one, a transparent observation-priority
score, and a human-accepted inspection mission with a 3D waypoint.

This is a research/demo decision-support slice. Satellite detections may
contain uncertainty and are not ground truth; nothing here is suitable for
protecting life or property.

## Architecture

```
worlds/registry.js  ──?world=──▶  main.js (one world per page load)
        │
        ├─ jhu ................ spawn, Homewood boundary, combat HUD, JHU JARVIS
        └─ california-wildfire  AGL spawn, no boundary, environmentalLayers: ['firms']
                                          │
   environmental/                         ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ data source        providers.js  demo CSV (bundled) │ /api/firms (live) │
   │ normalize          firms.js      CSV row → observation (null = N/A)     │
   │ analyse            observations.js  status/age/summary                  │
   │                    priority.js   OBSERVATION PRIORITY (documented rules) │
   │                    briefing.js   deterministic JARVIS from evidence      │
   │ render             encoding.js + wildfireLayer.js  Cesium points        │
   │ evidence           evidencePanel.js  fields, N/A, provenance, disclaimer │
   │ human decision     mission.js    RECOMMENDED → ACCEPT/IGNORE → ACTIVE    │
   │ field action       missionMarker.js  beacon + guidance; manual flight    │
   └────────────────────────────────────────────────────────────────────────┘
                                          │
                                   HUD (hud.js/css)        SpacetimeDB: unchanged
```

Data flow for one detection:

```
NASA FIRMS CSV row
→ normalize   firms.normalizeFirmsRow    { latitude, longitude, observedAt, satellite,
                                           instrument, confidence(+scale), frp, brightnessK, … }
→ analyze     observations.dataStatus    LIVE / RECENT / HISTORICAL
              priority.assessPriority    { level, score, reasons[], cautions[] }
→ visualize   encoding.encodeObservation size=√FRP, alpha=age, hue=status, outline=confidence
              wildfireLayer              CustomDataSource, terrain-sampled heights, click → select
→ evidence    evidencePanel.show         every field or N/A, provenance footer, disclaimer
→ recommend   mission.recommend          best priority within 40 km, never LOW, never ignored
→ human       ACCEPT / IGNORE / INSPECT HOTSPOT / ABORT
→ action      missionMarker + HUD guidance; pilot flies manually; COMPLETE within 300 m
```

Live and historical data share the same observation shape, so nothing past
`providers.js` knows where a detection came from.

### Design decisions

- **World switch = page reload.** Cesium/Three resources in this codebase have
  no full teardown path; reloading guarantees no leaked or duplicated entities.
- **Combat code is not conditioned on world.** In the wildfire world the combat
  HUD is hidden by CSS (`.hud[data-world-mode='wildfire'] .hud-combat`); the
  combat loop still runs harmlessly. Known cleanup for a later
  world-capabilities abstraction.
- **Multiplayer is frozen.** `server/`, `spacetimedb/client.js` and the
  generated bindings are untouched. Missions are local; `mission.js` documents
  the replication extension point.
- **No fabricated measurements.** Missing FIRMS fields are `null` and render as
  `N/A`. The bundled dataset is unmodified NASA output with a meta file
  recording provenance.

## Observation priority (not a fire-risk model)

Deterministic triage over fields FIRMS reports; thresholds in
`priority.js#RULES`:

| Factor | Rule | Points |
| --- | --- | --- |
| Recency | age < 24 h / < 72 h | +2 / +1 |
| Intensity | FRP ≥ 100 MW / ≥ 30 MW | +2 / +1 |
| Confidence | high or ≥ 80 % / low or < 30 % | +1 / −1 (shown as a caution) |

`score ≥ 4 → HIGH`, `≥ 2 → MEDIUM`, else `LOW`. A reason is emitted only when
the field is present. FRP thresholds are round numbers relative to typical
VIIRS 375 m detections and are not scientifically validated.

## Environment variables (`client/.env`)

```env
# default 'demo' = bundled real HISTORICAL DEMO; 'live' = local proxy, falls back to demo
# VITE_FIRMS_MODE=demo
# VITE_FIRMS_PROXY_URL=/api/firms
# VITE_FIRMS_DAYS=2                 # 1–10

# server-side only: read by vite.config.js for the dev proxy; never bundled
FIRMS_MAP_KEY=
```

`FIRMS_MAP_KEY` is intentionally not `VITE_`-prefixed. The dev proxy in
`vite.config.js` (`/api/firms/area/csv/<PRODUCT>/<bbox>/<days>`) inserts it
server-side. **Production live mode needs a real proxy** (Vercel Function,
Cloudflare Worker, backend): the Vite dev server is not part of `vite build`.
Without a key or in production the app uses the labelled historical dataset.

## Manual test procedure

**JHU regression** — `npm run dev`, open `/`. Title `HOMEWOOD`, WORLD row
`HOMEWOOD`, OPS `URBAN OPERATOR TRAINING`, combat block visible, no `ENV DATA`
block, no evidence panel. Fly to the campus edge → perimeter JARVIS line.
Drones spawn and can be locked/fired on as before. `R` respawns over Keyser Quad.

**Wildfire world** — open `/?world=california-wildfire`. Title
`CALIFORNIA WILDFIRE`, OPS `ENVIRONMENTAL INTELLIGENCE`, combat block hidden.
Suit spawns ~150 m above terrain (console: `[world] terrain at spawn …`), or at
the 1780 m fallback if terrain sampling fails.

**FIRMS loading** — `ENV DATA` shows `LOADING`, then `HISTORICAL DEMO` with
`981 detections · NASA FIRMS · VIIRS · Suomi NPP` and `2026-09-12 → 2026-09-19 UTC`
(dates from the bundled meta). Orange markers appear; JARVIS reports the
count. Live: set `FIRMS_MAP_KEY` and `VITE_FIRMS_MODE=live`, restart dev
server → badge `LIVE`; remove the key → badge stays `HISTORICAL DEMO` and the
tooltip/provenance shows the fallback reason. Failure path: temporarily
rename the demo CSV → badge `UNAVAILABLE`, flight unaffected.

**Observation selection** — click a marker: cyan ring, right-hand panel with
TYPE/SOURCE/SENSOR/OBSERVED/CONFIDENCE/FRP/BRIGHTNESS/DAY-NIGHT/LOCATION/
RANGE/DATA STATUS (`N/A` where the row lacks a value), priority with reasons,
provenance footer, disclaimer. JARVIS gives a one-line evidence briefing.
`Esc` or `×` closes and clears the ring.

**Mission creation** — ~6 s after load a `RECOMMENDED` card appears (if any
MEDIUM+ detection is within 40 km). `ACCEPT` → gold beacon, `MISSION` block with
distance and turn cue (`◄ 47° LEFT` / `ON COURSE`), panel action becomes
`TARGET · ABORT`. Fly to within 300 m → beacon turns cyan, `COMPLETE`, JARVIS
confirms. `IGNORE` withdraws and that detection is not re-proposed. Any
marker's `INSPECT HOTSPOT` starts a mission directly.

**World switching** — use the WORLD dropdown; the page reloads with `?world=…`
and other query params preserved. An invalid id falls back to `jhu`.

**Multiplayer regression** — with SpacetimeDB running, open two tabs of `/`:
both pilots appear, tags/tracker/POV switch work as before. Expected (not yet
verified with two live clients): a tab opened as `/?world=california-wildfire`
joins the same match, so its position is shared even though the worlds differ
— a known limitation, see below.

## Automated checks

`npm run build` (client) must pass and the bundle must not contain
`FIRMS_MAP_KEY`. The pure modules (`firms`, `observations`, `encoding`,
`priority`, `briefing`, `geo`, `mission`, `providers`) have no browser
dependencies and were exercised with Node `assert` scripts during development
(rule boundaries, determinism, N/A handling, live→demo fallback, mission
state machine, arrival radius). They are not yet checked in as a test suite.

## Limitations

- **Live vs demo**: default is the bundled 7-day Suomi NPP dataset captured
  2026-09-19; it ages and is labelled accordingly. Live mode is dev-only.
- **Proxy**: no production proxy is shipped; FIRMS quotas/errors surface as a
  fallback reason, not as live data.
- **Scientific**: FIRMS pixels are ~375 m thermal anomalies, not confirmed
  fires or perimeters; confidence is a pixel-quality flag; priority is a
  heuristic. Marker heights use terrain level 11 (±tens of metres on slopes).
- **Multiplayer**: SpacetimeDB has one match; a wildfire-world pilot and a JHU
  pilot see each other's positions across worlds. Missions are not shared.
- **Deferred**: world-capabilities abstraction (disable combat properly),
  mission replication, re-recommendation after IGNORE/COMPLETE, live refresh,
  MODIS/NOAA-20/21 products in the demo set.

## Extension points (not implemented)

- **Computer vision / ML**: emit additional observation types through
  `providers.js` in the same normalized shape (`type`, position, time, source,
  confidence); `encoding.js` and the panel key off `type`.
- **Agent**: replace `briefing.briefObservation` with a model that receives the
  same `{ observation, nearby_context, mission_state }` envelope.
- **RL / route planning**: consume `mission.progress()` and the flight state;
  the flight model is untouched and remains the actuator.
- **Forecasting**: a new analysis module beside `priority.js`, surfaced as
  additional evidence fields, never as fabricated measurements.
