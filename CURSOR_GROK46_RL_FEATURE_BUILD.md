# IRON GLOVE — Cursor Terminal Build Prompt for Grok 4.6

## Mission

You are a senior reinforcement-learning engineer and gameplay/backend engineer working inside the existing **Iron Glove** repository.

Your goal is to add three AI/RL features without destabilizing the current multiplayer game:

1. **RL Sentinel Pilot — HIGH priority**
   - A Sentinel drone learns to chase, intercept, evade, and attack a player.
   - This is the main RL showcase.

2. **RL Adaptive Difficulty — MEDIUM priority**
   - The game adapts Sentinel aggression to the current player's observed skill.
   - The system should make gameplay challenging without becoming impossible.

3. **Imitation-Learned Flight Assistant — MEDIUM priority**
   - Learn from good human flight trajectories.
   - Assist beginners without taking full control away from them.

Do **not** rewrite the game architecture or existing flight system just to make RL easier.

---

# 0. First: inspect before editing

Before changing any code, inspect the repository and produce a concise implementation report.

Run and inspect:

```bash
pwd
git status
git branch --show-current
git log --oneline -8

find . -maxdepth 3 -type f \
  ! -path './node_modules/*' \
  ! -path './client/node_modules/*' \
  ! -path './server/node_modules/*' \
  | sort
```

Read at minimum:

```text
README.md
client/package.json
client/src/main.js
client/src/suit/physics.js
client/src/suit/collision.js
client/src/sentinel/sentinel.js
client/src/spacetimedb/client.js
client/src/hud/hud.js
client/src/input/keyboard.js
server/package.json
server/src/index.ts
```

Also inspect any existing world-switching, GameEvent, combat, remote-player, or Sentinel code that exists even if the file names differ.

Before implementation, write a short report in the terminal covering:

```text
1. Current branch
2. Existing Sentinel implementation
3. Existing combat authority
4. Existing GameEvent flow
5. Existing player-state ownership model
6. Existing flight-state representation
7. Which files you intend to modify
8. Which files you intend to add
9. Any architectural conflicts with this prompt
```

If the repository differs from this prompt, **adapt to the actual repository** rather than forcing outdated file names.

---

# 1. Non-negotiable architecture rules

These rules are more important than any individual feature.

## 1.1 Preserve the existing human flight model

The current player flight behavior is already tuned.

Do not replace it with RL.

Preserve:

```text
human input
    ↓
existing flight controller
    ↓
existing physics / smoothing
    ↓

player transform
```

RL may assist, predict, or control NPCs, but must not silently replace the human flight implementation.

Do not change the intentional flight feel constants such as the existing `0.08` smoothing/lerp unless the existing code already exposes them as configuration.

---

## 1.2 Preserve multiplayer authority boundaries

Treat SpacetimeDB as the authoritative source for shared gameplay state.

Desired split:

```text
CLIENT
- human input
- rendering
- camera
- local visual interpolation
- particles
- HUD
- local inference for already-trained ML policies

SPACETIMEDB
- shared identity / ownership
- authoritative health
- kills / score
- shared Sentinel state
- authoritative combat outcomes
- GameEvent records
- authoritative difficulty state if shared

OFFLINE PYTHON TRAINING
- RL training
- imitation learning training
- evaluation
- policy export
```

Do not make browser-side RL training authoritative.

---

## 1.3 Never stream neural-network internals through SpacetimeDB

Do not replicate:

```text
network weights
activations
optimizer state
experience replay buffers
per-frame particle data
training batches
```

Replicate only gameplay state and events.

Example:

```text
Sentinel position
Sentinel velocity
Sentinel target
Sentinel action mode
Sentinel health
Difficulty profile
Weapon fire event
Hit event
```

---

## 1.4 Separate training from inference

Training should run offline in Python.

Browser/game inference should be lightweight and deterministic enough for a hackathon demo.

Preferred flow:

```text
Python environment
    ↓
train policy
    ↓
evaluate policy
    ↓
export compact policy artifact
    ↓
client loads artifact
    ↓
client/server uses inference result
```

Preferred export order:

1. simple JSON policy if model is tiny,
2. ONNX if practical,
3. another small deterministic representation if necessary.

Do not introduce a heavyweight ML runtime unless needed.

---

## 1.5 Add feature flags

All three AI systems must be independently switchable.

Add a central configuration module similar to:

```javascript
export const AI_FEATURES = {
  rlSentinel: true,
  adaptiveDifficulty: true,
  flightAssistant: false,
};
```

If configuration already exists, extend it instead of creating a competing config system.

The game must still run when every AI feature is disabled.

---

# 2. Recommended repository additions

Use the existing project structure if equivalent folders already exist.

Preferred additions:

```text
iron-glove/
├── client/
│   └── src/
│       └── ai/
│           ├── config.js
│           ├── sentinelPolicy.js
│           ├── sentinelController.js
│           ├── difficultyController.js
│           ├── flightAssistant.js
│           └── telemetry.js
│
├── ml/
│   ├── pyproject.toml
│   ├── README.md
│   ├── data/
│   │   ├── .gitkeep
│   │   └── README.md
│   ├── iron_glove_rl/
│   │   ├── __init__.py
│   │   ├── envs/
│   │   │   ├── __init__.py
│   │   │   └── sentinel_env.py
│   │   ├── training/
│   │   │   ├── __init__.py
│   │   │   ├── train_sentinel.py
│   │   │   ├── evaluate_sentinel.py
│   │   │   └── train_flight_assistant.py
│   │   ├── models/
│   │   │   └── .gitkeep
│   │   └── utils/
│   │       ├── telemetry_schema.py
│   │       └── export_policy.py
│   └── tests/
│       ├── test_sentinel_env.py
│       └── test_policy_contract.py
│
└── docs/
    └── rl-system.md
```

Do not create duplicate folders if the repository already has appropriate equivalents.

---

# 3. Python environment

Use **uv**, not `venv`.

Inside the repository root:

```bash
mkdir -p ml
cd ml
uv init --no-workspace
```

If `ml/pyproject.toml` already exists, do not reinitialize it.

Add only the minimum dependencies needed.

Preferred baseline:

```bash
uv add numpy gymnasium stable-baselines3 torch
uv add --dev pytest
```

Only add:

```text
onnx
onnxruntime
skl2onnx
scikit-learn
pandas
```

if the chosen implementation genuinely uses them.

Do not add TensorFlow.

---

# 4. FEATURE A — RL Sentinel Pilot

This is the primary feature.

## 4.1 Product goal

The Sentinel should behave like an opponent that has learned aerial pursuit rather than like a hard-coded waypoint bot.

It should learn the following behavior:

```text
SEARCH
  ↓
CHASE
  ↓
INTERCEPT
  ↓
ATTACK
  ↓
EVADE / REPOSITION
  ↓
CHASE
```

The policy should not need photorealistic Cesium pixels.

Use compact numeric game state.

---

## 4.2 Observation space

Create a normalized observation vector based on relative game state.

Minimum useful inputs:

```text
relative player position:
  dx
  dy
  dz

relative player velocity:
  dvx
  dvy
  dvz

Sentinel velocity:
  svx
  svy
  svz

distance to player

bearing error

altitude difference

Sentinel health fraction

player health fraction

weapon cooldown fraction

whether target is inside firing cone
```

Normalize observations to stable numerical ranges.

Do not feed raw longitude/latitude magnitudes directly into the policy.

Convert to a local tangent/Cartesian frame or another local coordinate representation.

---

## 4.3 Action space

Start simple.

Prefer a continuous action vector:

```text
yaw command       [-1, 1]
pitch command     [-1, 1]
throttle command  [-1, 1]
fire probability/action [0, 1]
```

If continuous fire complicates training, make fire a derived action:

```text
fire = firing_cone && distance < threshold && policy_attack_score > threshold
```

Do not begin with a huge action space.

---

## 4.4 Training environment

Build a lightweight Gymnasium environment in:

```text
ml/iron_glove_rl/envs/sentinel_env.py
```

The environment does not need Cesium.

It needs a simplified 3D flight model approximating the game.

The first environment should support:

```python
reset()
step(action)
observation_space
action_space
```

Episode conditions:

```text
success:
- Sentinel reaches effective attack geometry
- Sentinel lands enough simulated hits
- player health reaches zero

failure:
- Sentinel loses target for too long
- Sentinel leaves arena bounds
- Sentinel collides with ground
- max episode steps reached
```

Use seeded randomness.

Randomize:

```text
player starting position
player heading
player speed
Sentinel starting position
Sentinel altitude offset
```

This prevents the policy from memorizing one scenario.

---

## 4.5 Reward design

Keep reward shaping interpretable.

Suggested components:

```text
+ reward for reducing distance when outside attack range
+ reward for reducing bearing error
+ reward for achieving intercept geometry
+ reward for staying inside preferred attack distance
+ large reward for valid hit
+ very large reward for kill

- penalty for losing target
- penalty for ground collision
- penalty for leaving arena
- small penalty for unnecessary firing
- small time penalty
```

Avoid rewarding only "distance decreases", because that can teach collision-style chasing.

Document the exact reward equation in `docs/rl-system.md`.

---

## 4.6 Baseline before RL

Before training RL, implement one deterministic heuristic baseline in Python.

Example baseline:

```text
turn toward player
maintain preferred altitude offset
accelerate when far
slow when close
fire inside cone
```

Evaluate both:

```text
heuristic
RL policy
```

This gives the project an actual ML evaluation story instead of merely saying "we used PPO".

---

## 4.7 RL algorithm

Use **PPO** first unless repository/runtime constraints strongly justify another algorithm.

Reason:

```text
continuous action space
simple implementation
robust baseline
easy Stable-Baselines3 integration
```

Do not spend hackathon time implementing PPO from scratch.

Training command should eventually look like:

```bash
cd ml
uv run python -m iron_glove_rl.training.train_sentinel \
  --timesteps 200000 \
  --seed 42
```

Evaluation:

```bash
uv run python -m iron_glove_rl.training.evaluate_sentinel \
  --episodes 100 \
  --seed 42
```

The scripts must support smaller smoke-test values.

---

## 4.8 Evaluation metrics

Log at minimum:

```text
intercept success rate
mean time to intercept
hit rate
kill rate
average distance to target
out-of-bounds rate
ground-collision rate
shots per successful hit
episode reward
```

Evaluation must compare the trained policy to the heuristic baseline.

Output a concise terminal summary.

Optional CSV/JSON output is useful.

---

## 4.9 Policy export

Export the trained policy into a browser-consumable form.

Preferred target:

```text
client/public/models/sentinel-policy.onnx
```

or, for a tiny network:

```text
client/public/models/sentinel-policy.json
```

Add metadata:

```json
{
  "policyVersion": 1,
  "observationVersion": 1,
  "featureOrder": [],
  "normalization": {},
  "trainingSeed": 42
}
```

Never silently change feature ordering.

Add a policy contract test.

---

## 4.10 Game integration

Do not let the RL controller directly mutate player health.

Preferred game runtime:

```text
shared SentinelState
      ↓
Sentinel controller reads target state
      ↓
policy inference
      ↓
desired movement/action
      ↓
existing Sentinel movement system
      ↓
server/shared state update
```

Combat outcome must still follow the project's authoritative combat path.

If combat authority is not yet implemented, RL firing may initially emit a **candidate fire action** without directly damaging players.

Mark that limitation clearly.

---

## 4.11 Runtime safety fallback

The Sentinel must have a fallback heuristic controller.

Runtime:

```text
policy loads successfully
    → use RL

policy missing / invalid / inference error
    → use heuristic
```

The demo must not fail because a model file fails to load.

HUD/dev console should show:

```text
SENTINEL AI: RL
```

or:

```text
SENTINEL AI: HEURISTIC FALLBACK
```

---

# 5. FEATURE B — RL Adaptive Difficulty

Do not train a giant second agent for this feature.

Use the simplest learning formulation that tells a strong story.

Preferred implementation:

```text
player performance estimator
        ↓
difficulty controller
        ↓
Sentinel parameter profile
```

---

## 5.1 Skill telemetry

Track rolling-window gameplay features such as:

```text
player hit accuracy
damage taken per minute
time alive
average speed
collision frequency
successful evasions
time on target
kills / deaths
distance maintained from Sentinel
```

Do not use personally identifying information.

Keep the telemetry game-local.

---

## 5.2 Difficulty dimensions

Difficulty should adjust a small set of bounded parameters.

Example:

```javascript
{
  aggression: 0.0 to 1.0,
  aimTolerance: wide to narrow,
  preferredAttackDistance: far to close,
  fireCooldownMultiplier: slow to fast,
  pursuitSpeedMultiplier: 0.8 to 1.2,
  evadeProbability: low to high
}
```

Never allow adaptive difficulty to:

```text
teleport enemies
ignore weapon cooldown
ignore collision
give impossible speed
secretly alter human controls
```

---

## 5.3 Learning method

Preferred first version:

### Option A — contextual bandit

Context:

```text
recent player-performance vector
```

Actions:

```text
difficulty profile 0
difficulty profile 1
difficulty profile 2
difficulty profile 3
```

Reward target:

```text
player remains challenged but survives long enough to continue playing
```

A reasonable proxy reward can balance:

```text
engagement duration
successful player hits
damage taken
deaths
```

Do not optimize for maximizing player deaths.

### Option B — bounded adaptive controller

If implementing a real bandit would add too much risk, implement a mathematically explicit adaptive controller and label it honestly as adaptive difficulty, not RL.

Do not fake RL terminology.

---

## 5.4 Difficulty profiles

Define human-readable presets such as:

```text
CADET
MARK I
AVENGER
EXTREMIS
```

But store underlying numeric parameters.

The learner can choose/blend between profiles.

HUD may briefly show:

```text
JARVIS: THREAT RESPONSE ADAPTED
```

Do not constantly expose difficulty changes if it harms immersion.

---

## 5.5 Stability constraints

Avoid oscillation.

Rules:

```text
evaluate only every N seconds
require enough telemetry samples
limit maximum change per update
apply hysteresis
never change difficulty every frame
```

Suggested cadence:

```text
10–20 seconds
```

---

# 6. FEATURE C — Imitation-Learned Flight Assistant

The flight assistant is not autopilot.

It should gently help inexperienced users follow stable flight patterns learned from strong demonstrations.

---

## 6.1 Demonstration recording

Add an opt-in telemetry recorder.

Record at a bounded rate such as 10–20 Hz.

Each row should contain:

```text
timestamp
position
velocity
pitch
roll
yaw
throttle
human input command
AGL
speed
collision warning state
```

Target/action label:

```text
the expert player's next flight-control command
```

Use a versioned schema.

Example output:

```text
ml/data/flight_demos/session-YYYYMMDD-HHMMSS.jsonl
```

Do not commit large raw trajectory files.

Add them to `.gitignore`.

Keep a tiny synthetic/example fixture if tests need one.

---

## 6.2 Assistant model

Start with supervised imitation learning.

Do not jump directly to reinforcement learning.

Baseline model choices:

```text
small MLP
or
linear/ridge model if it performs adequately
```

Input:

```text
current flight state
current human command
```

Output:

```text
recommended corrected command
```

---

## 6.3 Assist blending

Never replace human input.

Blend:

```text
final_command =
    (1 - assist_strength) * human_command
    + assist_strength * model_command
```

Bound:

```text
assist_strength ∈ [0, 0.35]
```

Default:

```text
0.15
```

The user must always retain control.

---

## 6.4 Trigger assistance selectively

Do not assist every frame with equal strength.

Increase assistance when:

```text
low altitude + unstable pitch
large uncontrolled roll
rapid heading oscillation
repeated collision warnings
beginner mode enabled
```

Decrease assistance when:

```text
expert mode
stable flight
intentional aerobatic maneuver
high confidence human command
```

Do not fight deliberate barrel rolls.

---

## 6.5 Confidence gate

If the imitation model is uncertain or out-of-distribution:

```text
assist_strength = 0
```

A simple first implementation may use:

```text
distance from training feature ranges
or
prediction disagreement if an ensemble is used
```

Keep this lightweight.

---

## 6.6 User-facing mode

Add a simple mode:

```text
FLIGHT ASSIST: OFF
FLIGHT ASSIST: BEGINNER
```

Optional:

```text
FLIGHT ASSIST: TRAINING
```

Do not call it "autopilot" unless it truly becomes one.

---

# 7. Telemetry contract

Create one central telemetry schema used by RL/imitation features.

Do not let each feature invent incompatible field names.

At minimum distinguish:

```text
player observation
player action
Sentinel observation
Sentinel action
combat event
difficulty state
episode/session metadata
```

Use schema version numbers.

Example:

```json
{
  "schemaVersion": 1,
  "sessionId": "...",
  "timestampMs": 0,
  "type": "player_frame",
  "payload": {}
}
```

---

# 8. Testing requirements

Do not consider the feature complete because it visually moves.

Add tests.

## Python tests

At minimum:

```text
environment reset returns valid observation
environment step returns valid tuple
observations remain finite
actions are clipped to legal bounds
seeded reset is reproducible
reward is finite
episode terminates correctly
policy metadata matches observation schema
```

Run:

```bash
cd ml
uv run pytest -q
```

---

## Client tests / checks

Use the repository's existing JavaScript test setup if one exists.

If no JS test framework exists, do not introduce a huge testing stack solely for this feature.

At minimum add deterministic pure-function tests where practical for:

```text
observation construction
normalization
difficulty update
assist blending
feature-flag fallback
```

---

## Integration smoke test

Manual smoke test:

```text
1. Start SpacetimeDB if required.
2. Start the client.
3. Disable all AI feature flags.
4. Confirm original game behavior still works.
5. Enable RL Sentinel.
6. Confirm Sentinel loads RL policy or explicit fallback.
7. Confirm human flight controls remain unchanged.
8. Confirm Sentinel can pursue a moving player.
9. Confirm no NaN/Infinity reaches movement state.
10. Enable adaptive difficulty.
11. Confirm updates occur at bounded intervals.
12. Enable flight assistant.
13. Confirm assistant never takes full control.
14. Disable assistant during flight.
15. Confirm immediate return to pure human control.
```

---

# 9. Performance requirements

This game already has expensive Cesium rendering.

Do not introduce per-frame heavyweight ML work.

Requirements:

```text
no training in render loop
no network call per frame
no model reload per frame
no telemetry disk write per frame
no large allocations in tight loops when avoidable
```

Policy inference should preferably run at:

```text
10–20 Hz
```

and interpolate/control between decisions.

Rendering can remain at display framerate.

---

# 10. UI / HUD additions

Keep these minimal.

Useful debug/dev lines:

```text
SENTINEL AI    RL
AI DECISION    INTERCEPT
DIFFICULTY     AVENGER
FLIGHT ASSIST  15%
```

Do not overload the existing cinematic HUD.

Make advanced debug information optionally toggleable.

---

# 11. Demo story

The final demo should support this narrative:

```text
1. Human flies Iron Man manually over JHU.
2. Sentinel appears.
3. Explain that the Sentinel policy was trained in a simplified 3D environment.
4. Sentinel visibly intercepts instead of following a static patrol.
5. Player performs well.
6. Difficulty system increases aggression within bounded limits.
7. Switch to a beginner control mode.
8. Flight assistant smooths unstable inputs while the player still controls the suit.
9. Turn assistant off and immediately return to raw human control.
```

The RL story should be explainable in one sentence:

> We train the enemy's pursuit policy offline, evaluate it against a deterministic baseline, export the learned policy, and run lightweight inference inside the live multiplayer game.

---

# 12. Development order

Do not implement all three features simultaneously.

Use this order:

```text
A0. Repository inspection
A1. Shared telemetry schema
A2. Sentinel Gymnasium environment
A3. Heuristic Sentinel baseline
A4. PPO training
A5. Evaluation
A6. Policy export contract
A7. Game inference integration
A8. Runtime fallback
A9. RL Sentinel manual smoke test

B1. Player skill telemetry
B2. Difficulty profiles
B3. Adaptive/bandit controller
B4. Stability/hysteresis
B5. HUD integration
B6. Manual test

C1. Flight demonstration recorder
C2. Dataset loader
C3. Supervised imitation baseline
C4. Model evaluation
C5. Export
C6. Client inference
C7. Assist blending
C8. Confidence gate
C9. Manual test
```

After each major section, run tests and make a small focused commit.

Suggested commits:

```text
feat(ml): add sentinel training environment
feat(ml): add sentinel heuristic baseline and evaluation
feat(ml): train and export sentinel PPO policy
feat(ai): integrate sentinel policy inference
feat(ai): add adaptive difficulty controller
feat(ml): add flight demonstration pipeline
feat(ai): add imitation flight assistance
docs: document RL architecture and demo workflow
```

Do not commit broken intermediate states.

---

# 13. Definition of done — RL Sentinel

The RL Sentinel feature is complete only when:

```text
[ ] Gymnasium environment exists
[ ] deterministic heuristic baseline exists
[ ] PPO training script exists
[ ] evaluation script exists
[ ] seeded smoke training works
[ ] trained model can be exported
[ ] observation feature order is versioned
[ ] game loads learned policy
[ ] fallback controller works
[ ] policy inference does not block rendering
[ ] Sentinel visibly chases/intercepts a moving player
[ ] combat authority is not bypassed
[ ] tests pass
[ ] documentation exists
```

---

# 14. Definition of done — Adaptive Difficulty

```text
[ ] rolling player-performance telemetry exists
[ ] difficulty profiles are numeric and bounded
[ ] adaptation runs at a slow cadence
[ ] hysteresis prevents rapid oscillation
[ ] player controls are never secretly modified
[ ] impossible enemy parameters are disallowed
[ ] current difficulty can be inspected/debugged
[ ] feature can be disabled cleanly
```

---

# 15. Definition of done — Flight Assistant

```text
[ ] expert trajectories can be recorded
[ ] trajectory schema is versioned
[ ] training script exists
[ ] baseline validation metrics are printed
[ ] model can be exported
[ ] assistant blends with human input
[ ] maximum assist strength is bounded
[ ] assistant can be disabled instantly
[ ] confidence/OOD gate can reduce assist to zero
[ ] deliberate barrel rolls are not automatically suppressed
[ ] raw human flight remains unchanged when feature is off
```

---

# 16. Documentation

Create:

```text
docs/rl-system.md
```

It must explain:

```text
1. Why training is outside the browser
2. Observation/action spaces
3. Reward design
4. Heuristic baseline
5. PPO choice
6. Evaluation metrics
7. Policy export format
8. Runtime inference loop
9. Adaptive difficulty formulation
10. Imitation-learning dataset
11. Assist blending
12. Failure/fallback behavior
13. Exact commands to retrain
14. Exact commands to evaluate
15. Exact commands to run the game
```

Keep it understandable by a hackathon judge and by a future engineer.

---

# 17. Important implementation constraints

Do not:

```text
- replace current player physics with RL
- make RL training run in the browser
- make Grok/xAI API calls inside the frame loop
- use an LLM as the low-level flight controller
- let the client directly decide authoritative damage
- add giant dependencies without justification
- rewrite SpacetimeDB architecture unless required
- hand-edit generated SpacetimeDB bindings
- commit large training artifacts or replay buffers
- silently swallow policy-loading errors
- fake an RL result with a hard-coded controller while labeling it RL
```

Do:

```text
- preserve current game behavior behind feature flags
- use deterministic seeds for evaluation
- make the heuristic baseline explicit
- measure RL against the baseline
- expose fallback state
- keep models small
- keep inference cheap
- document every assumption
```

---

# 18. Grok 4.6 working style

Work like a careful senior engineer, not an autonomous code generator that edits everything at once.

For every phase:

```text
1. inspect relevant files
2. state intended changes
3. implement smallest coherent slice
4. run tests/build/lint
5. fix failures
6. summarize exact files changed
7. continue
```

When an architectural decision is ambiguous:

- prefer the choice that changes the fewest existing systems,
- preserve currently working gameplay,
- keep shared gameplay authoritative,
- keep ML training offline,
- leave a concise TODO only when a dependency genuinely blocks implementation.

Do not stop merely because the existing repository differs from this plan. Adapt intelligently.

---

# 19. Start now

Begin with **repository inspection only**.

Do not edit files until you have reported:

```text
CURRENT ARCHITECTURE
FILES TO TOUCH
FILES TO ADD
RISKS
IMPLEMENTATION ORDER
```

Then implement **Feature A: RL Sentinel Pilot** first.

Do not begin Adaptive Difficulty or Flight Assistant until the RL Sentinel smoke test passes.
