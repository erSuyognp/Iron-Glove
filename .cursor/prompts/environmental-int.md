# IRON GLOVE — Human-AI Environmental Intelligence Digital Twin

> **Role:** You are a senior geospatial/software engineer working inside the existing IRON GLOVE repository.

**Working branch:** `anupama/spacetimedb`

---

## Git safety

1. Run `git branch --show-current`. It **MUST** be `anupama/spacetimedb`.
2. Run `git status --short`.

Rules:

- Do **not** discard, reset, stash, rebase, checkout, or overwrite existing changes.
- Do **not** switch branches.
- Do **not** push anything.
- If existing uncommitted changes overlap files you need to modify, preserve them and integrate around them.
- At the end, show the changed files, build/test results, and diff summary.
- Do **not** commit unless explicitly asked.

---

## Project context

IRON GLOVE currently has:

- CesiumJS + Google Photorealistic 3D Tiles
- JHU Homewood as the current world
- Client-side flight physics
- Keyboard + glove control
- HUD
- Collision detection
- SpacetimeDB multiplayer
- `PlayerState` synchronization
- Player identity/ownership work on this branch
- Disconnect handling work on this branch
- Remote-player interpolation

**Do NOT redesign or replace these systems.**

In particular, preserve:

- Current player identity/ownership behavior
- Disconnect handling
- Current SpacetimeDB reducers, unless this feature absolutely requires an additive change
- JHU behavior, exactly
- Keyboard/glove flight
- Collision
- Remote-player interpolation
- Current Cesium performance optimizations

The goal is an **incremental environmental-intelligence feature, NOT a rewrite**.

---

## Product direction

Reframe IRON GLOVE as:

**IRON GLOVE — Human-AI Environmental Intelligence Digital Twin**

The Iron Man UI is the interface, not the core use case.

The platform should eventually support multiple real-world environmental scenarios:

| World | Name | Focus |
| --- | --- | --- |
| **WORLD 01** | JHU Homewood | Urban operator training |
| **WORLD 02** | California Wildfire Intelligence | NASA FIRMS + terrain + environmental observations |

Future worlds — **not** part of this implementation:

- **WORLD 03** — Flood response
- **WORLD 04** — Ecological/biodiversity monitoring
- **WORLD 05** — Earthquake/environmental disaster assessment

**Only implement WORLD 01 and WORLD 02 now.**

---

## Main objective

Introduce a clean world abstraction so JHU is no longer hardcoded throughout the application.

Then implement one complete Environmental Intelligence vertical slice: **California Wildfire Intelligence**.

The slice should demonstrate:

```
REAL ENVIRONMENTAL DATA
  → VISUALIZATION
  → EVIDENCE / PROVENANCE
  → INTERPRETATION
  → ACTIONABLE MISSION
```

Do not implement a collection of disconnected visual effects.

---

## STEP 1 — Inspect before editing

Inspect at minimum:

- `client/src/main.js`
- `client/src/cesium/world.js`
- `client/src/cesium/camera.js`
- `client/src/hud/hud.js`
- `client/src/hud/hud.css`
- `client/src/spacetimedb/client.js`
- `client/package.json`
- `server/src/index.ts`
- Generated bindings, only as needed
- Vite/deployment configuration

Determine:

- Where JHU coordinates are currently hardcoded.
- Which Cesium resources require cleanup when switching worlds.
- How the HUD can gain a world selector without breaking the existing layout.
- Whether the repository already has a secure server-side/API pattern for external API credentials.

**Do not start by editing `main.js` blindly.**

---

## STEP 2 — Introduce a world registry

Create a small world/configuration abstraction. Prefer something similar to:

```
client/src/worlds/registry.js
```

Each world should expose structured configuration rather than scattering conditionals around `main.js`.

Conceptually:

```js
{
  id: 'jhu',
  name: 'JHU Homewood',
  category: 'TRAINING',
  description: 'Urban operator training',
  spawn: {
    longitude,
    latitude,
    altitude
  },
  camera: {...},
  environmentMode: 'urban',
  imageryMode: 'photorealistic',
  environmentalLayers: []
}
```

and:

```js
{
  id: 'california-wildfire',
  name: 'California Wildfire Intelligence',
  category: 'ENVIRONMENTAL_INTELLIGENCE',
  description: 'Satellite-informed wildfire observation',
  spawn: {...},
  camera: {...},
  environmentMode: 'wildfire',
  environmentalLayers: ['firms']
}
```

Do not over-engineer this into a plugin framework. It should be enough to add another world later without rewriting `main.js`.

---

## STEP 3 — Preserve JHU exactly

WORLD 01 must continue behaving exactly as it does today:

- Same JHU spawn
- Same photorealistic tiles
- Same collision
- Same flight
- Same camera
- Same HUD
- Same multiplayer
- Same performance behavior

Refactoring JHU into the world registry must not change gameplay. **This is an acceptance requirement.**

---

## STEP 4 — Add a World selector

Add a compact HUD control:

```
WORLD

[ JHU TRAINING            ]
[ WILDFIRE INTELLIGENCE   ]
```

Or an equivalent small dropdown.

Current world should also be visible in the HUD:

```
WORLD
CALIFORNIA WILDFIRE

MODE
ENVIRONMENTAL INTELLIGENCE
```

Do not let this dominate the existing Iron Man HUD.

Switching worlds should:

- Clean up world-specific entities/layers
- Update the active world config
- Reposition the local player to that world's spawn
- Move the camera appropriately
- Load only that world's environmental layers
- Not duplicate Cesium entities on repeated switches

If a clean runtime switch is unreasonably risky with the current architecture, prefer a controlled application reload with `?world=<id>` rather than introducing brittle state.

**Reliability is more important than cleverness.**

---

## STEP 5 — Implement NASA FIRMS as an environmental data provider

Create an environmental-data layer separate from rendering. Suggested structure:

```
client/src/environmental/
    firms.js
    observations.js
    wildfireLayer.js
```

Exact names may change based on the existing architecture. The important separation is:

```
DATA FETCHING
    ↓
NORMALIZED OBSERVATIONS
    ↓
ANALYSIS
    ↓
CESIUM RENDERING
```

Do not put NASA fetch logic directly in `main.js`.

Normalize a FIRMS observation into an internal shape approximately like:

```js
{
  id,
  type: 'ACTIVE_FIRE_DETECTION',
  latitude,
  longitude,

  observedAt,

  source: 'NASA FIRMS',
  satellite,
  instrument,

  confidence,
  frp,

  raw: ...
}
```

FRP means **Fire Radiative Power**.

**Do not invent missing values.**

---

## STEP 6 — Credential/data strategy

NASA FIRMS API/web services may require a `MAP_KEY`.

**NEVER hardcode a credential.**

First inspect whether this repo already has an appropriate server-side or Vercel API pattern.

**If a secure server-side pattern exists:**

- Proxy FIRMS through it
- Keep the `MAP_KEY` server-side

**If no server-side API architecture exists:**

- Do **not** introduce an entire new framework merely for this
- Build the FIRMS provider abstraction
- Support a documented local/demo data mode
- Optionally support a configurable proxy URL
- Clearly document what is still needed for secure live deployment

**Never fabricate environmental observations.**

Any bundled demo dataset must be real data and clearly labelled with:

- Source
- Observation date
- Whether it is historical/demo data

The UI must visibly distinguish `LIVE / RECENT` from `HISTORICAL DEMO`.

---

## STEP 7 — Visualize environmental observations

In the wildfire world, render active-fire detections on Cesium.

**Do NOT render giant generic red dots with no meaning.**

Visual encoding should use actual observation properties when possible. For example:

| Property | Encoding |
| --- | --- |
| Location | Latitude/longitude |
| Intensity/size | FRP, with sensible clamping |
| Confidence | Label/detail, not an exaggerated visual claim |
| Age | Opacity or metadata |

Clicking/selecting a detection should open an environmental evidence panel.

---

## STEP 8 — Build an Environmental Evidence panel

This is important for the Environmental Intelligence track.

For a selected observation show something like:

```
ENVIRONMENTAL OBSERVATION

TYPE
Satellite thermal anomaly

SOURCE
NASA FIRMS

SENSOR
VIIRS / NOAA-21

OBSERVED
2026-...

CONFIDENCE
...

FIRE RADIATIVE POWER
... MW

LOCATION
lat / lon

DATA STATUS
LIVE / RECENT / HISTORICAL
```

If a field is unavailable, display `N/A`. **Do not infer values.**

Include a subtle source/provenance indicator.

> The principle is: every environmental claim visible to the operator should be traceable to its underlying observation.

---

## STEP 9 — Add basic environmental intelligence

Do not call every detection a confirmed wildfire. NASA FIRMS represents satellite-derived active-fire / thermal-anomaly detections.

**Use terminology such as:**

- Thermal anomaly
- Active-fire detection
- Satellite observation
- Hotspot

**Never say:**

> This building is on fire

unless the data actually establishes that.

Create a simple transparent prioritization function for observation missions. For MVP, prioritize observations using only fields actually present in FIRMS, such as:

- Recency
- FRP
- Confidence, where available

Call the result **OBSERVATION PRIORITY**, not **DISASTER RISK**.

The scoring algorithm must be:

- Deterministic
- Easy to explain
- Documented
- Not presented as a scientifically validated fire-risk model

Example UI:

```
OBSERVATION PRIORITY
HIGH

Why:
• recently observed
• elevated fire radiative power
• high-confidence satellite detection
```

Only include a reason if supported by the data.

---

## STEP 10 — Turn intelligence into an action

This is the feature that makes the project more than a map.

For a high-priority observation, allow:

```
[ INSPECT HOTSPOT ]
```

Selecting it should create a local environmental mission/waypoint:

```
MISSION

Inspect satellite thermal anomaly

DISTANCE
12.4 km

SOURCE
NASA FIRMS

STATUS
ACTIVE
```

Add a visible 3D waypoint/marker and direction/distance guidance.

The flight system should remain unchanged. The operator manually flies toward the observation.

This demonstrates:

```
environmental observation
        ↓
intelligence
        ↓
human decision
        ↓
field action
```

**Do not create autonomous flight yet.**

---

## STEP 11 — Human-in-the-loop behavior

Do not let an AI agent silently initiate missions.

The system may recommend:

```
RECOMMENDED:
Inspect Observation #42
```

but the human must choose: **ACCEPT** or **IGNORE**.

Record this state locally for now unless there is already a safe, simple shared-state mechanism.

Avoid changing the SpacetimeDB schema solely for this first vertical slice if it risks conflicting with the current player-ownership work. Environmental missions can be replicated in SpacetimeDB in a later step.

---

## STEP 12 — JARVIS environmental intelligence

Do **not** add an LLM dependency if one is not already working.

First implement a deterministic grounded summary from the structured observation. Example:

```
JARVIS:
NOAA-21 reported a recent thermal anomaly ahead.
Elevated fire radiative power makes it a priority observation.
```

Only mention properties actually present.

Structure the code so this can later be replaced by an LLM/agent receiving:

```json
{
  "observation": {},
  "nearby_context": {},
  "mission_state": {}
}
```

The future AI must reason over supplied evidence rather than invent facts.

---

## STEP 13 — Add an explicit data disclaimer

This project is a research/demo decision-support system, not an operational emergency-response product.

In the wildfire evidence UI include a small notice approximately:

> Research/demo decision support.
> Satellite detections may contain uncertainty and are not ground truth.

Do not present the system as suitable for protecting life/property.

---

## STEP 14 — Architecture goal

The completed architecture should approximately be:

```
                    WORLD REGISTRY
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
       JHU TRAINING          WILDFIRE EI
              │                     │
              │                NASA FIRMS
              │                     │
              │              observations
              │                     │
              └──────────┬──────────┘
                         ▼
                      CESIUM
                         │
               environmental layer
                         │
              evidence/provenance
                         │
              priority assessment
                         │
                         ▼
                 HUMAN DECISION
                         │
                  inspect mission
                         │
                         ▼
                    FLIGHT UI
                         │
                         ▼
                   SPACETIMEDB
              multiplayer/shared state
```

Do not force data into SpacetimeDB merely to match this diagram. Existing multiplayer remains shared through SpacetimeDB; environmental mission replication can follow after the vertical slice works.

---

## STEP 15 — Keep future AI/RL extension points obvious

Do not implement these yet, but leave clean boundaries for:

- **Computer vision** — drone imagery → smoke / vegetation / damage observations
- **ML** — environmental-observation classification
- **RL** — route planning / shared autonomy under terrain, hazards, battery, no-fly areas
- **Agent** — evidence-grounded mission recommendations
- **Forecasting** — fire-spread / environmental hazard prediction

No fake AI placeholders are necessary.

---

## Acceptance criteria

Verify **all** of these before declaring the task complete:

- [ ] Existing JHU world still works.
- [ ] Existing multiplayer still works.
- [ ] Existing ownership/disconnect changes are preserved.
- [ ] User can choose JHU or Wildfire world.
- [ ] Switching worlds does not leak/duplicate Cesium entities.
- [ ] Wildfire world displays real, source-labelled environmental observations when data is available.
- [ ] Demo/historical observations are clearly labelled if live data is unavailable.
- [ ] No fabricated environmental measurements exist.
- [ ] Selecting an observation shows its source and metadata.
- [ ] Observation priority has an explainable deterministic basis.
- [ ] User can turn an observation into an inspection mission.
- [ ] Mission creates a visible waypoint.
- [ ] JARVIS text uses only information actually present in the observation.
- [ ] API credentials are not hardcoded or committed.
- [ ] `npm run build` passes.
- [ ] Existing app still runs if environmental-data loading fails.
- [ ] Environmental-data failure produces a useful non-blocking status rather than breaking flight.

---

## Deliverables

After implementation, provide:

### A. Architecture summary

Explain what changed and why.

### B. Files changed

For each file, explain its responsibility.

### C. Environmental data flow

Show:

```
NASA FIRMS
→ normalize
→ analyze
→ visualize
→ evidence
→ recommendation
→ human action
```

### D. Environment variables

List any new variables and provide `.env.example` entries. **Never include actual credentials.**

### E. Test procedure

Give exact manual steps for:

- JHU regression test
- Wildfire world
- FIRMS loading
- Observation selection
- Mission creation
- World switching
- Multiplayer regression

### F. Build verification

Run the relevant build/tests and report actual output.

### G. Remaining limitations

Explicitly identify:

- Live-vs-demo environmental data limitations
- API/proxy limitations
- Scientific limitations
- Features intentionally deferred

> **Do not claim success for anything you did not actually test.**



