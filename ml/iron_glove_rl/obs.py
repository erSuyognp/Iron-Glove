"""Observation builder — local ENU metres, never raw lon/lat."""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from iron_glove_rl.utils.contract import (
    ALT_SCALE,
    FEATURE_ORDER,
    FIRE_INTERVAL_S,
    FIRE_RANGE_M,
    FRONT_ARC_DEG,
    OBS_SIZE,
    POS_SCALE,
    VEL_SCALE,
    clip,
)


def heading_from_velocity(ve: float, vn: float, fallback: float = 0.0) -> float:
    if ve * ve + vn * vn < 1e-6:
        return fallback
    return math.atan2(ve, vn)  # 0 = north, clockwise-positive matches the game


def bearing_to(dx_e: float, dx_n: float) -> float:
    return math.atan2(dx_e, dx_n)


def wrap_pi(a: float) -> float:
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


def in_player_frontal_cone(
    sentinel_e: float,
    sentinel_n: float,
    player_e: float,
    player_n: float,
    player_heading: float,
    range_m: float,
    arc_deg: float = FRONT_ARC_DEG,
    fire_range: float = FIRE_RANGE_M,
) -> bool:
    """Server fire gate: drone sits inside the player's forward arc and range."""
    if range_m > fire_range:
        return False
    de = player_e - sentinel_e
    dn = player_n - sentinel_n
    flat = math.hypot(de, dn) or 1.0
    # Same convention as tick_sentinels: vector from drone to player.
    ahead = (-de * math.sin(player_heading) - dn * math.cos(player_heading)) / flat
    return ahead >= math.cos(math.radians(arc_deg))


def build_observation(
    *,
    sentinel_pos: Sequence[float],
    sentinel_vel: Sequence[float],
    sentinel_heading: float,
    sentinel_health: float,
    player_pos: Sequence[float],
    player_vel: Sequence[float],
    player_heading: float,
    player_health: float,
    cooldown_elapsed_s: float,
) -> np.ndarray:
    """Relative ENU observation, clipped to [-1, 1] except the 0–1 fractions.

    sentinel_pos / player_pos: (east, north, up) metres.
    velocities: m/s in the same frame.
    """
    se, sn, su = float(sentinel_pos[0]), float(sentinel_pos[1]), float(sentinel_pos[2])
    pe, pn, pu = float(player_pos[0]), float(player_pos[1]), float(player_pos[2])
    sve, svn, svu = float(sentinel_vel[0]), float(sentinel_vel[1]), float(sentinel_vel[2])
    pve, pvn, pvu = float(player_vel[0]), float(player_vel[1]), float(player_vel[2])

    rel_e, rel_n, rel_u = pe - se, pn - sn, pu - su
    distance = math.sqrt(rel_e * rel_e + rel_n * rel_n + rel_u * rel_u)
    heading = heading_from_velocity(sve, svn, sentinel_heading)
    bearing = bearing_to(rel_e, rel_n)
    bearing_error = wrap_pi(bearing - heading)

    cooldown_ready = clip(cooldown_elapsed_s / FIRE_INTERVAL_S, 0.0, 1.0)
    cone = 1.0 if in_player_frontal_cone(se, sn, pe, pn, player_heading, distance) else 0.0

    obs = np.array(
        [
            clip(rel_e / POS_SCALE, -1.0, 1.0),
            clip(rel_n / POS_SCALE, -1.0, 1.0),
            clip(rel_u / POS_SCALE, -1.0, 1.0),
            clip((pve - sve) / VEL_SCALE, -1.0, 1.0),
            clip((pvn - svn) / VEL_SCALE, -1.0, 1.0),
            clip((pvu - svu) / VEL_SCALE, -1.0, 1.0),
            clip(sve / VEL_SCALE, -1.0, 1.0),
            clip(svn / VEL_SCALE, -1.0, 1.0),
            clip(svu / VEL_SCALE, -1.0, 1.0),
            clip(distance / POS_SCALE, 0.0, 1.0),
            clip(bearing_error / math.pi, -1.0, 1.0),
            clip(rel_u / ALT_SCALE, -1.0, 1.0),
            clip(sentinel_health / 100.0, 0.0, 1.0),
            clip(player_health / 100.0, 0.0, 1.0),
            cooldown_ready,
            cone,
        ],
        dtype=np.float32,
    )
    assert obs.shape == (OBS_SIZE,)
    assert FEATURE_ORDER  # keep the tuple imported so contract tests can see it
    return obs
