"""Train a PPO Sentinel pursuit policy.

  cd ml
  uv run python -m iron_glove_rl.training.train_sentinel --timesteps 200000 --seed 42
  uv run python -m iron_glove_rl.training.train_sentinel --timesteps 8000 --seed 42   # smoke
"""

from __future__ import annotations

import argparse
from pathlib import Path

from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import DummyVecEnv

from iron_glove_rl.envs import SentinelEnv
from iron_glove_rl.utils.export_policy import export_sb3, write_policy

MODELS = Path(__file__).resolve().parents[1] / "models"


def make_env(seed: int):
    def _thunk():
        env = SentinelEnv()
        env.reset(seed=seed)
        return env

    return _thunk


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timesteps", type=int, default=200_000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--n-envs", type=int, default=4)
    parser.add_argument("--skip-export", action="store_true")
    args = parser.parse_args()

    MODELS.mkdir(parents=True, exist_ok=True)
    env = DummyVecEnv([make_env(args.seed + i) for i in range(args.n_envs)])
    model = PPO(
        "MlpPolicy",
        env,
        seed=args.seed,
        verbose=1,
        device="cpu",
        n_steps=256,
        batch_size=256,
        n_epochs=8,
        learning_rate=3e-4,
        gamma=0.99,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=0.01,
        policy_kwargs=dict(net_arch=dict(pi=[32, 32], vf=[32, 32])),
        tensorboard_log=None,
    )
    model.learn(total_timesteps=args.timesteps, progress_bar=False)
    zip_path = MODELS / f"sentinel_ppo_seed{args.seed}.zip"
    model.save(zip_path)
    print(f"saved {zip_path}")
    if not args.skip_export:
        artifact = export_sb3(model, args.seed)
        if artifact.get("kind") != "mlp" or not artifact.get("layers"):
            raise SystemExit("export produced no MLP layers — refusing to label a heuristic as RL")
        out = write_policy(artifact)
        print(f"exported {out} kind={artifact['kind']} features={len(artifact['featureOrder'])}")
    env.close()


if __name__ == "__main__":
    main()
