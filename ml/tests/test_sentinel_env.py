from __future__ import annotations

import math

import numpy as np
import pytest

from iron_glove_rl.envs import SentinelEnv
from iron_glove_rl.obs import build_observation, in_player_frontal_cone
from iron_glove_rl.utils.contract import OBS_SIZE
from iron_glove_rl.training.heuristic import heuristic_action


def test_reset_valid_observation():
    env = SentinelEnv()
    obs, info = env.reset(seed=0)
    assert obs.shape == (OBS_SIZE,)
    assert np.all(np.isfinite(obs))
    assert env.observation_space.contains(obs)
    assert isinstance(info, dict)


def test_step_tuple_and_clip():
    env = SentinelEnv()
    env.reset(seed=1)
    huge = np.array([5.0, -5.0, 9.0, 3.0], dtype=np.float32)
    obs, reward, terminated, truncated, info = env.step(huge)
    assert obs.shape == (OBS_SIZE,)
    assert np.all(np.isfinite(obs))
    assert math.isfinite(reward)
    assert isinstance(terminated, bool)
    assert isinstance(truncated, bool)
    assert isinstance(info, dict)


def test_actions_clipped_to_bounds():
    env = SentinelEnv()
    env.reset(seed=2)
    env.step([-2, -2, -2, -1])
    env.step([2, 2, 2, 2])
    # Internal velocity must stay finite after illegal actions were clipped.
    assert np.all(np.isfinite(env.s_vel))
    assert np.all(np.isfinite(env.s_pos))


def test_seeded_reset_reproducible():
    a = SentinelEnv()
    b = SentinelEnv()
    oa, _ = a.reset(seed=42)
    ob, _ = b.reset(seed=42)
    np.testing.assert_allclose(oa, ob, rtol=0, atol=0)
    aa = heuristic_action(oa)
    for _ in range(5):
        oa, *_ = a.step(aa)
        ob, *_ = b.step(aa)
        aa = heuristic_action(oa)
    np.testing.assert_allclose(oa, ob, rtol=0, atol=1e-6)


def test_reward_finite_and_episode_terminates():
    env = SentinelEnv()
    env.reset(seed=3)
    done = False
    steps = 0
    while not done:
        obs = env._obs()
        _, r, term, trunc, _ = env.step(heuristic_action(obs))
        assert math.isfinite(r)
        done = term or trunc
        steps += 1
        assert steps <= 500
    assert done


def test_observation_builder_no_lonlat():
    obs = build_observation(
        sentinel_pos=(10.0, 0.0, 150.0),
        sentinel_vel=(5.0, 0.0, 0.0),
        sentinel_heading=0.0,
        sentinel_health=100.0,
        player_pos=(20.0, 0.0, 150.0),
        player_vel=(0.0, 0.0, 0.0),
        player_heading=0.0,
        player_health=80.0,
        cooldown_elapsed_s=4.0,
    )
    assert obs.shape == (OBS_SIZE,)
    assert np.all(np.abs(obs) <= 1.0001)
    assert obs[13] == pytest.approx(0.8)
    assert obs[14] == pytest.approx(1.0)


def test_frontal_cone_matches_server_fire_gate():
    # Player at origin heading north: a drone 110 m north is in the gun cone;
    # a drone 110 m south is behind.
    assert in_player_frontal_cone(0.0, 110.0, 0.0, 0.0, 0.0, 110.0) is True
    assert in_player_frontal_cone(0.0, -110.0, 0.0, 0.0, 0.0, 110.0) is False
