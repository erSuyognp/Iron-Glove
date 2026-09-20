"""Versioned telemetry schema used by RL and (later) imitation features.

Do not invent per-feature field names. Every record is:

    { schemaVersion, sessionId, timestampMs, type, payload }
"""

from __future__ import annotations

SCHEMA_VERSION = 1

RECORD_TYPES = (
    "session_meta",
    "player_frame",
    "player_action",
    "sentinel_frame",
    "sentinel_action",
    "combat_event",
    "difficulty_state",
    "episode_end",
)


def record(session_id: str, timestamp_ms: int, record_type: str, payload: dict) -> dict:
    if record_type not in RECORD_TYPES:
        raise ValueError(f"unknown telemetry type {record_type!r}")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": session_id,
        "timestampMs": int(timestamp_ms),
        "type": record_type,
        "payload": payload,
    }
