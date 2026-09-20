# Offline RL for Iron Glove Sentinel pilots.

Training and evaluation live here. The live game never trains.

```bash
cd ml
uv sync
uv run pytest -q
uv run python -m iron_glove_rl.training.train_sentinel --timesteps 8000 --seed 42
uv run python -m iron_glove_rl.training.evaluate_sentinel --episodes 20 --seed 42
```

Full training:

```bash
uv run python -m iron_glove_rl.training.train_sentinel --timesteps 200000 --seed 42
```

Exported policy: `../client/public/models/sentinel-policy.json`
(also embedded for the server as `../server/src/sentinelPolicyData.ts`).

The file currently in git is the **seed-42 200k-step PPO MLP**. That is a real
export, not a heuristic labeled as RL. Compare against the heuristic with
`evaluate_sentinel` after any retrain.

SB3 `.zip` checkpoints in `iron_glove_rl/models/` are gitignored.
