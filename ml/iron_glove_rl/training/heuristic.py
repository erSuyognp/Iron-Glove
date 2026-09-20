"""Deterministic heuristic Sentinel: turn toward the player, hold altitude offset, fire in cone."""

from __future__ import annotations

import math

import numpy as np

from iron_glove_rl.obs import wrap_pi
from iron_glove_rl.utils.contract import (
    ENGAGE_HEIGHT_M,
    FIRE_RANGE_M,
    PREFERRED_ATTACK_DIST_M,
    clip,
)


def heuristic_action(obs: np.ndarray) -> np.ndarray:
    """Map a normalized observation to [yaw, pitch, throttle, fire].

    Uses only the versioned feature vector (no hidden state) so evaluation is reproducible.
    """
    dx, dy, dz = float(obs[0]), float(obs[1]), float(obs[2])
    distance = float(obs[9])  # / POS_SCALE
    bearing_error = float(obs[10])  # / pi
    cooldown = float(obs[14])
    in_cone = float(obs[15]) > 0.5

    yaw = clip(bearing_error * 1.6, -1.0, 1.0)
    # Climb toward a small altitude offset above the player.
    want_dz = (ENGAGE_HEIGHT_M / 200.0) - dz
    pitch = clip(want_dz * 2.2, -1.0, 1.0)

    dist_m = distance * 400.0
    if dist_m > PREFERRED_ATTACK_DIST_M * 1.4:
        throttle = 1.0
    elif dist_m < PREFERRED_ATTACK_DIST_M * 0.6:
        throttle = -0.2
    else:
        throttle = 0.25

    fire = 1.0 if in_cone and dist_m <= FIRE_RANGE_M and cooldown >= 0.95 else 0.0
    return np.array([yaw, pitch, throttle, fire], dtype=np.float32)


def heuristic_from_state(rel_e: float, rel_n: float, rel_u: float, heading: float, cooldown_ready: float, in_cone: bool) -> np.ndarray:
    """Same policy from raw metres — used by tests that skip normalization."""
    dist = math.hypot(rel_e, rel_n, rel_u)
    bearing = math.atan2(rel_e, rel_n)
    err = wrap_pi(bearing - heading) / math.pi
    obs = np.zeros(16, dtype=np.float32)
    obs[0] = clip(rel_e / 400.0, -1, 1)
    obs[1] = clip(rel_n / 400.0, -1, 1)
    obs[2] = clip(rel_u / 400.0, -1, 1)
    obs[9] = clip(dist / 400.0, 0, 1)
    obs[10] = clip(err, -1, 1)
    obs[14] = cooldown_ready
    obs[15] = 1.0 if in_cone else 0.0
    return heuristic_action(obs)
