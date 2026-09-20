"""Gymnasium environment: simplified 3D aerial pursuit approximating tick_sentinels.

No Cesium. Local east/north/up metres, 10 Hz, seeded randomization.
"""

from __future__ import annotations

import math
from typing import Any, Optional

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from iron_glove_rl.obs import build_observation, heading_from_velocity, wrap_pi
from iron_glove_rl.utils.contract import (
    ACT_SIZE,
    ARENA_RADIUS_M,
    ATTACK_SPEED,
    DT,
    FIRE_INTERVAL_S,
    FIRE_RANGE_M,
    HIT_DAMAGE,
    HITS_TO_SUCCESS,
    LOST_TARGET_M,
    LOST_TARGET_STEPS,
    MAX_ALT_M,
    MAX_EPISODE_STEPS,
    MIN_ALT_M,
    OBS_SIZE,
    PLAYER_MAX_SPEED,
    PREFERRED_ATTACK_DIST_M,
    STEER_RATE,
    clip,
)

# Reward weights — documented in docs/rl-system.md
R_DISTANCE = 0.02
R_BEARING = 0.04
R_INTERCEPT = 0.15
R_BAND = 0.08
R_HIT = 4.0
R_KILL = 12.0
P_LOST = 0.05
P_GROUND = 8.0
P_BOUNDS = 8.0
P_WASTED_FIRE = 0.02
P_TIME = 0.005


def _finite(x: np.ndarray) -> bool:
    return bool(np.all(np.isfinite(x)))


class SentinelEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, seed: Optional[int] = None):
        super().__init__()
        self.observation_space = spaces.Box(low=-1.0, high=1.0, shape=(OBS_SIZE,), dtype=np.float32)
        self.action_space = spaces.Box(
            low=np.array([-1.0, -1.0, -1.0, 0.0], dtype=np.float32),
            high=np.array([1.0, 1.0, 1.0, 1.0], dtype=np.float32),
            dtype=np.float32,
        )
        self._np = np.random.RandomState()
        self._seed = seed
        self._reset_state()

    def _reset_state(self) -> None:
        self.steps = 0
        self.lost_steps = 0
        self.hits = 0
        self.shots = 0
        self.valid_hits = 0
        self.intercepted = False
        self.cooldown = FIRE_INTERVAL_S
        self.player_health = 100.0
        self.sentinel_health = 100.0
        self.s_pos = np.zeros(3, dtype=np.float64)
        self.s_vel = np.zeros(3, dtype=np.float64)
        self.s_heading = 0.0
        self.p_pos = np.zeros(3, dtype=np.float64)
        self.p_vel = np.zeros(3, dtype=np.float64)
        self.p_heading = 0.0
        self.p_turn = 0.0
        self._last_distance = 0.0
        self._last_bearing = 0.0

    def reset(self, *, seed: Optional[int] = None, options: Optional[dict] = None):
        super().reset(seed=seed)
        if seed is not None:
            self._seed = seed
            self._np.seed(seed)
            if self.np_random is not None:
                pass
        rng = self._np
        self._reset_state()

        self.p_heading = float(rng.uniform(-math.pi, math.pi))
        speed = float(rng.uniform(8.0, PLAYER_MAX_SPEED * 0.7))
        spawn_r = float(rng.uniform(40.0, 180.0))
        spawn_a = float(rng.uniform(-math.pi, math.pi))
        alt = float(rng.uniform(MIN_ALT_M + 40.0, MAX_ALT_M - 40.0))
        self.p_pos[:] = (math.sin(spawn_a) * spawn_r, math.cos(spawn_a) * spawn_r, alt)
        self.p_vel[:] = (math.sin(self.p_heading) * speed, math.cos(self.p_heading) * speed, 0.0)
        self.p_turn = float(rng.choice([-0.35, 0.0, 0.35]))

        off_a = self.p_heading + float(rng.uniform(0.6, math.pi))
        off_r = float(rng.uniform(80.0, 280.0))
        alt_off = float(rng.uniform(-30.0, 40.0))
        self.s_pos[:] = (
            self.p_pos[0] + math.sin(off_a) * off_r,
            self.p_pos[1] + math.cos(off_a) * off_r,
            clip(self.p_pos[2] + alt_off, MIN_ALT_M + 10.0, MAX_ALT_M - 10.0),
        )
        self.s_heading = wrap_pi(off_a + math.pi)
        cruise = ATTACK_SPEED * 0.4
        self.s_vel[:] = (math.sin(self.s_heading) * cruise, math.cos(self.s_heading) * cruise, 0.0)
        self.cooldown = float(rng.uniform(0.0, FIRE_INTERVAL_S))

        obs = self._obs()
        self._last_distance = self._distance()
        self._last_bearing = abs(self._bearing_error())
        return obs, {}

    def step(self, action):
        action = np.asarray(action, dtype=np.float32).reshape(ACT_SIZE)
        action = np.clip(action, self.action_space.low, self.action_space.high)
        self.steps += 1
        self.cooldown = min(FIRE_INTERVAL_S, self.cooldown + DT)

        self._step_player()
        self._step_sentinel(action)

        distance = self._distance()
        bearing = abs(self._bearing_error())
        in_cone = self._obs()[15] > 0.5
        fired = False
        hit = False
        wasted = False
        if action[3] > 0.5:
            self.shots += 1
            fired = True
            ready = self.cooldown >= FIRE_INTERVAL_S - 1e-6
            if ready and in_cone and distance <= FIRE_RANGE_M:
                self.cooldown = 0.0
                hit = True
                self.hits += 1
                self.valid_hits += 1
                self.player_health = max(0.0, self.player_health - HIT_DAMAGE)
            else:
                wasted = True
                if ready:
                    self.cooldown = 0.0

        intercept = (
            distance < PREFERRED_ATTACK_DIST_M + 40.0
            and bearing < 0.45
            and abs(self.p_pos[2] - self.s_pos[2]) < 40.0
        )
        if intercept:
            self.intercepted = True

        if distance > LOST_TARGET_M:
            self.lost_steps += 1
        else:
            self.lost_steps = 0

        ground = self.s_pos[2] <= MIN_ALT_M + 0.5
        oob = math.hypot(self.s_pos[0], self.s_pos[1]) > ARENA_RADIUS_M
        killed = self.player_health <= 0.0
        success = killed or self.hits >= HITS_TO_SUCCESS
        lost = self.lost_steps >= LOST_TARGET_STEPS
        timeout = self.steps >= MAX_EPISODE_STEPS
        terminated = bool(success or ground or oob or lost)
        truncated = bool(timeout and not terminated)

        reward = self._reward(
            distance=distance,
            bearing=bearing,
            intercept=intercept,
            hit=hit,
            killed=killed,
            wasted=wasted,
            ground=ground,
            oob=oob,
            lost=lost,
        )

        obs = self._obs()
        info = {
            "distance": distance,
            "bearing_error": self._bearing_error(),
            "hits": self.hits,
            "shots": self.shots,
            "intercepted": self.intercepted,
            "success": success,
            "ground_collision": ground,
            "out_of_bounds": oob,
            "lost_target": lost,
            "fired": fired,
            "hit": hit,
        }
        self._last_distance = distance
        self._last_bearing = bearing
        return obs, float(reward), terminated, truncated, info

    def _reward(self, **k: Any) -> float:
        r = -P_TIME
        # Closing distance only while outside the attack band, so ramming is not optimal.
        if k["distance"] > PREFERRED_ATTACK_DIST_M:
            r += R_DISTANCE * (self._last_distance - k["distance"])
        r += R_BEARING * (self._last_bearing - k["bearing"])
        if k["intercept"]:
            r += R_INTERCEPT
        band = abs(k["distance"] - PREFERRED_ATTACK_DIST_M)
        r += R_BAND * math.exp(-((band / 40.0) ** 2))
        if k["hit"]:
            r += R_HIT
        if k["killed"]:
            r += R_KILL
        if k["lost"]:
            r -= P_LOST
        if k["ground"]:
            r -= P_GROUND
        if k["oob"]:
            r -= P_BOUNDS
        if k["wasted"]:
            r -= P_WASTED_FIRE
        return float(r)

    def _step_player(self) -> None:
        self.p_heading = wrap_pi(self.p_heading + self.p_turn * DT)
        speed = math.hypot(self.p_vel[0], self.p_vel[1])
        self.p_vel[0] = math.sin(self.p_heading) * speed
        self.p_vel[1] = math.cos(self.p_heading) * speed
        self.p_pos += self.p_vel * DT
        # Bounce inside the arena so the chase stays well-posed.
        r = math.hypot(self.p_pos[0], self.p_pos[1])
        if r > ARENA_RADIUS_M * 0.75:
            self.p_heading = wrap_pi(self.p_heading + math.pi * 0.6)
            self.p_pos[0] *= 0.75 / (r / ARENA_RADIUS_M + 1e-6)
            self.p_pos[1] *= 0.75 / (r / ARENA_RADIUS_M + 1e-6)
        self.p_pos[2] = clip(self.p_pos[2], MIN_ALT_M + 20.0, MAX_ALT_M - 20.0)

    def _step_sentinel(self, action: np.ndarray) -> None:
        yaw, pitch, throttle = float(action[0]), float(action[1]), float(action[2])
        self.s_heading = wrap_pi(self.s_heading + yaw * 1.8 * DT)
        speed = ((throttle + 1.0) * 0.5) * ATTACK_SPEED
        climb = pitch * 18.0
        want = np.array(
            [math.sin(self.s_heading) * speed, math.cos(self.s_heading) * speed, climb],
            dtype=np.float64,
        )
        k = min(1.0, STEER_RATE * DT)
        self.s_vel += (want - self.s_vel) * k
        self.s_pos += self.s_vel * DT
        self.s_pos[2] = clip(self.s_pos[2], MIN_ALT_M, MAX_ALT_M)
        self.s_heading = heading_from_velocity(self.s_vel[0], self.s_vel[1], self.s_heading)

    def _distance(self) -> float:
        d = self.p_pos - self.s_pos
        return float(math.sqrt(float(d @ d)))

    def _bearing_error(self) -> float:
        rel = self.p_pos - self.s_pos
        bearing = math.atan2(rel[0], rel[1])
        return wrap_pi(bearing - self.s_heading)

    def _obs(self) -> np.ndarray:
        obs = build_observation(
            sentinel_pos=self.s_pos,
            sentinel_vel=self.s_vel,
            sentinel_heading=self.s_heading,
            sentinel_health=self.sentinel_health,
            player_pos=self.p_pos,
            player_vel=self.p_vel,
            player_heading=self.p_heading,
            player_health=self.player_health,
            cooldown_elapsed_s=self.cooldown,
        )
        if not _finite(obs):
            raise RuntimeError("non-finite observation")
        return obs
