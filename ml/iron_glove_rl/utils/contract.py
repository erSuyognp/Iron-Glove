"""Shared numeric contract for Sentinel observations, actions, and the simplified 3D flight model.

This module is the source of truth for Python training. The game copies the
same numbers in `client/src/ai/observation.js` and `server/src/sentinelPolicy.ts`.
`observationVersion` / `featureOrder` must not change silently.
"""

from __future__ import annotations

SCHEMA_VERSION = 1
POLICY_VERSION = 1
OBSERVATION_VERSION = 1

# Match server/src/index.ts
DT = 0.1  # s — same as tick_sentinels
PLAYER_MAX_SPEED = 60.0
ATTACK_SPEED = PLAYER_MAX_SPEED * 0.6
STEER_RATE = 2.5
FIRE_INTERVAL_S = 4.0
FIRE_RANGE_M = 250.0
FRONT_ARC_DEG = 50.0
ENGAGE_HEIGHT_M = 12.0
PREFERRED_ATTACK_DIST_M = 110.0
ARENA_RADIUS_M = 400.0
MIN_ALT_M = 70.0
MAX_ALT_M = 380.0
HIT_DAMAGE = 6.0
PLAYER_MAX_HEALTH = 100.0
SENTINEL_MAX_HEALTH = 100.0
MAX_EPISODE_STEPS = 400
LOST_TARGET_M = 380.0
LOST_TARGET_STEPS = 40
HITS_TO_SUCCESS = 3

POS_SCALE = 400.0
VEL_SCALE = 60.0
ALT_SCALE = 200.0

FEATURE_ORDER = (
    "dx",
    "dy",
    "dz",
    "dvx",
    "dvy",
    "dvz",
    "svx",
    "svy",
    "svz",
    "distance",
    "bearing_error",
    "altitude_diff",
    "sentinel_health",
    "player_health",
    "cooldown_ready",
    "in_cone",
)

OBS_SIZE = len(FEATURE_ORDER)
ACT_SIZE = 4  # yaw, pitch, throttle, fire
YAW, PITCH, THROTTLE, FIRE = 0, 1, 2, 3

NORMALIZATION = {
    "posScale": POS_SCALE,
    "velScale": VEL_SCALE,
    "altScale": ALT_SCALE,
    "distanceScale": POS_SCALE,
    "bearingScale": 3.141592653589793,
}


def clip(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x
