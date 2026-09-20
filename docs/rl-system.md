# Iron Glove — RL system

We train the enemy's pursuit policy offline, evaluate it against a deterministic baseline, export the learned policy, and run lightweight inference inside the live multiplayer game.

Feature A (RL Sentinel Pilot) is implemented. Features B and C are specified here so the architecture is obvious; they are not wired yet.

## 1. Why training is outside the browser

Cesium already spends the frame on tiles, the suit, and combat interpolation. PPO needs thousands of environment steps, a replay-sized rollout buffer, and PyTorch. None of that belongs in `requestAnimationFrame`.

```text
Python (ml/)  train → evaluate → export JSON
                    ↓
client/public/models/sentinel-policy.json
server/src/sentinelPolicyData.ts   (same bytes, embedded)
                    ↓
browser HUD inference @ 15 Hz
SpacetimeDB tick_sentinels @ 10 Hz (authoritative movement + fire gate)
```

The live game never trains, never writes weights through SpacetimeDB, and never calls an LLM as a flight controller.

## 2. Observation / action spaces

Versioned in `ml/iron_glove_rl/utils/contract.py`. Copies live in `client/src/ai/observation.js` and `server/src/sentinelPolicy.ts`. `observationVersion` / `featureOrder` must not change silently.

Local east / north / up metres. Never raw lon/lat.

| index | feature | scale |
|---|---|---|
| 0–2 | player − sentinel position | / 400 m, clip [−1, 1] |
| 3–5 | relative velocity | / 60 m/s |
| 6–8 | sentinel velocity | / 60 m/s |
| 9 | distance | / 400 m, clip [0, 1] |
| 10 | bearing error (wrap π) | / π |
| 11 | altitude difference | / 200 m |
| 12–13 | sentinel / player health | / 100 |
| 14 | fire cooldown ready | 0–1 |
| 15 | in player's frontal cone | 0 or 1 |

Action (Box): `[yaw, pitch, throttle, fire]` with yaw/pitch/throttle in [−1, 1] and fire in [0, 1]. Fire is a **candidate**. Missiles still require the existing 4 s cooldown, 250 m range, and 50° frontal arc in `tick_sentinels`. Health is never written by the policy.

## 3. Reward design

Simplified 3D chase, 10 Hz, 400-step cap. Weights in `ml/iron_glove_rl/envs/sentinel_env.py`:

- close distance while outside the 110 m attack band
- reduce bearing error
- bonus for intercept geometry and for sitting in the band
- +4 per valid hit, +12 if the dummy player is “killed”
- penalties: time, lost target, ground, out of bounds, wasted fire

Closing-distance reward stops inside the band so ramming is not the optimum.

## 4. Heuristic baseline

`heuristic_action(obs)` turns toward the player, holds a 12 m altitude offset, and fires only in-cone at range with a ready cooldown. It is deterministic, seeded-reproducible, and **never labeled RL**. If the exported artifact has `"kind": "heuristic"`, the HUD shows `HEURISTIC FALLBACK`.

## 5. PPO choice

Stable-Baselines3 `PPO` + `MlpPolicy`, two tanh layers of 32, CPU, seed 42. Continuous actions match the four-D command used by the game. The network is small enough to unroll with a handful of matvecs in JS/TS — no ONNX runtime.

## 6. Evaluation metrics

`uv run python -m iron_glove_rl.training.evaluate_sentinel --episodes 100 --seed 42`

- intercept success rate and time-to-intercept
- hit rate and shots per successful hit
- kill/success rate
- mean final distance
- out-of-bounds and ground-collision rates
- mean episode reward vs the heuristic

## 7. Policy export format

JSON (and the same string embedded for the server):

```text
{
  policyVersion, observationVersion, featureOrder, normalization, trainingSeed,
  kind: "mlp" | "heuristic",
  layers: [{ w: [[out x in]], b, act: "tanh" }, ...],   // mlp only
  action: { w, b, act: "identity" }                      // mlp only
}
```

Torch Linear layout `(out, in)`. Runtime: `x = tanh(x @ W.T + b)` then action mean; yaw/pitch/throttle through tanh, fire through sigmoid.

## 8. Runtime inference loop

1. Client sets `AI_FEATURES.rlSentinel`. `activate_mission` is called with `site.id + "|rl"` (no schema change; `client/src/spacetimedb/client.js` is untouched).
2. Server `missionUsesRl` selects `commandSentinel` for attackers. PATROL/FLEE drones stay on the old heuristic. Fire still goes through cooldown/range/cone. `apply_damage` / `destroy_sentinel` are unchanged.
3. Client loads `/models/sentinel-policy.json` once, infers at 15 Hz for the HUD (`SENTINEL AI` / `AI DECISION`). Rendering stays at display framerate.
4. Player velocity on the server is estimated from the last tick’s position (not a new column).

## 9. Adaptive difficulty formulation (Feature B — not wired)

Planned: rolling skill features (hits taken, kills, time-on-target) → bounded profile (`ROOKIE` … `AVENGER`) → Sentinel speed/aggression multipliers with hysteresis. Flag: `AI_FEATURES.adaptiveDifficulty` (currently false).

## 10. Imitation-learning dataset (Feature C — not wired)

Planned: versioned JSONL of `player_frame` / `player_action` records (`ml/iron_glove_rl/utils/telemetry_schema.py`). Do not commit raw demos (`ml/data/flight_demos/` is gitignored).

## 11. Assist blending (Feature C — not wired)

Planned: `output = (1 - w) * human + w * assist` with `w` capped well below 1. The existing `SPEED_LERP = 0.08` flight model stays the human path. Flag: `AI_FEATURES.flightAssistant` (currently false).

## 12. Failure / fallback behavior

```text
missing / HTTP error / version mismatch / non-finite math
    → HEURISTIC FALLBACK (console.warn, HUD says so)
kind === "heuristic"
    → HEURISTIC FALLBACK (explicit; not labeled RL)
kind === "mlp"
    → SENTINEL AI: RL
AI_FEATURES.rlSentinel === false
    → original tick_sentinels station-keeping, HUD rows hidden
```

The demo must not die because a model file failed to load.

## 13. Retrain

```bash
cd ml
uv sync
uv run python -m iron_glove_rl.training.train_sentinel --timesteps 200000 --seed 42
```

Smoke (CI / this machine):

```bash
uv run python -m iron_glove_rl.training.train_sentinel --timesteps 8000 --seed 42 --n-envs 1
```

The checked-in `sentinel-policy.json` is the seed-42 **200k-step** PPO MLP (`kind: "mlp"`), not a heuristic in disguise. On 100 seeded eval episodes it still lags the deterministic heuristic on intercept and reward; use `evaluate_sentinel` after any retrain.

## 14. Evaluate

```bash
cd ml
uv run pytest -q
uv run python -m iron_glove_rl.training.evaluate_sentinel --episodes 100 --seed 42
```

## 15. Run the game

```bash
# terminal 1
spacetime start
# terminal 2
cd server && npm run publish:local
# terminal 3
cd client && npm run dev
```

Open the client, fly, press `1` or `M` (drones mission). HUD: `SENTINEL AI` is `RL` or `HEURISTIC FALLBACK`. Human WASD is unchanged (`SPEED_LERP = 0.08`).

Disable the feature: set `rlSentinel: false` in `client/src/ai/config.js`. The `|rl` tag is not sent and attackers use the original face-to-face station code.

Known limitation: there is no `spacetime` CLI in every checkout, so the `|rl` site tag is the toggle that does not require new reducers or regenerated bindings.
