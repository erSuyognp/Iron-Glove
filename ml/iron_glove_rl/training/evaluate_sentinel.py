"""Evaluate heuristic vs RL Sentinel policies.

  uv run python -m iron_glove_rl.training.evaluate_sentinel --episodes 100 --seed 42
  uv run python -m iron_glove_rl.training.evaluate_sentinel --episodes 8 --seed 42  # smoke
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

import numpy as np

from iron_glove_rl.envs import SentinelEnv
from iron_glove_rl.training.heuristic import heuristic_action
from iron_glove_rl.utils.export_policy import DEFAULT_JSON, infer, load_policy

MODELS = Path(__file__).resolve().parents[1] / "models"


def run_episode(env: SentinelEnv, policy_fn, seed: int) -> dict:
    obs, _ = env.reset(seed=seed)
    total = 0.0
    steps = 0
    info = {}
    while True:
        action = policy_fn(obs)
        obs, reward, terminated, truncated, info = env.step(action)
        total += reward
        steps += 1
        if terminated or truncated:
            break
    return {
        "reward": total,
        "steps": steps,
        "success": bool(info.get("success")),
        "intercepted": bool(info.get("intercepted")),
        "hits": int(info.get("hits") or 0),
        "shots": int(info.get("shots") or 0),
        "distance": float(info.get("distance") or 0),
        "ground": bool(info.get("ground_collision")),
        "oob": bool(info.get("out_of_bounds")),
        "lost": bool(info.get("lost_target")),
        "time_to_intercept": steps * 0.1 if info.get("intercepted") or info.get("success") else None,
    }


def summarize(name: str, rows: list[dict]) -> dict:
    n = len(rows) or 1
    hits = sum(r["hits"] for r in rows)
    shots = sum(r["shots"] for r in rows)
    intercepts = [r["time_to_intercept"] for r in rows if r["time_to_intercept"] is not None]
    summary = {
        "name": name,
        "episodes": len(rows),
        "intercept_success_rate": sum(1 for r in rows if r["intercepted"] or r["success"]) / n,
        "mean_time_to_intercept_s": statistics.mean(intercepts) if intercepts else None,
        "hit_rate": hits / shots if shots else 0.0,
        "kill_or_success_rate": sum(1 for r in rows if r["success"]) / n,
        "average_final_distance_m": statistics.mean(r["distance"] for r in rows),
        "out_of_bounds_rate": sum(1 for r in rows if r["oob"]) / n,
        "ground_collision_rate": sum(1 for r in rows if r["ground"]) / n,
        "shots_per_successful_hit": (shots / hits) if hits else None,
        "mean_episode_reward": statistics.mean(r["reward"] for r in rows),
    }
    return summary


def print_summary(s: dict) -> None:
    print(f"\n=== {s['name']} ({s['episodes']} episodes) ===")
    for k, v in s.items():
        if k in ("name", "episodes"):
            continue
        if isinstance(v, float):
            print(f"  {k:28s} {v:8.4f}")
        else:
            print(f"  {k:28s} {v}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--policy", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args()

    env = SentinelEnv()
    heuristic_rows = [run_episode(env, heuristic_action, args.seed + i) for i in range(args.episodes)]
    h = summarize("heuristic", heuristic_rows)
    print_summary(h)

    rl = None
    if args.policy.exists():
        policy = load_policy(args.policy)
        rl_rows = [run_episode(env, lambda o, p=policy: infer(p, o), args.seed + i) for i in range(args.episodes)]
        rl = summarize(f"rl:{policy.get('kind')}", rl_rows)
        print_summary(rl)
        print(
            f"\nRL vs heuristic  success {rl['kill_or_success_rate'] - h['kill_or_success_rate']:+.3f}"
            f"  intercept {rl['intercept_success_rate'] - h['intercept_success_rate']:+.3f}"
            f"  reward {rl['mean_episode_reward'] - h['mean_episode_reward']:+.3f}"
        )
    else:
        print(f"\nno policy at {args.policy} — heuristic only")

    if args.json_out:
        args.json_out.write_text(json.dumps({"heuristic": h, "rl": rl}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
