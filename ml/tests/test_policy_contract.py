from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from iron_glove_rl.utils.contract import FEATURE_ORDER, OBSERVATION_VERSION, POLICY_VERSION
from iron_glove_rl.utils.export_policy import heuristic_artifact, infer, metadata
from iron_glove_rl.training.heuristic import heuristic_action
from iron_glove_rl.utils.telemetry_schema import SCHEMA_VERSION, record


def test_metadata_matches_observation_schema():
    art = heuristic_artifact(42)
    assert art["policyVersion"] == POLICY_VERSION
    assert art["observationVersion"] == OBSERVATION_VERSION
    assert tuple(art["featureOrder"]) == FEATURE_ORDER
    assert "posScale" in art["normalization"]
    assert art["trainingSeed"] == 42


def test_heuristic_infer_is_explicit_kind():
    policy = heuristic_artifact(0)
    obs = np.zeros(len(FEATURE_ORDER), dtype=np.float32)
    obs[10] = 0.4
    obs[14] = 1.0
    a = infer(policy, obs)
    b = heuristic_action(obs)
    np.testing.assert_allclose(a, b)
    assert policy["kind"] == "heuristic"


def test_mlp_infer_finite_and_bounded():
    # Tiny identity-ish net: two tanh layers then 4-d action.
    rng = np.random.RandomState(0)
    w0 = (rng.randn(32, 16) * 0.1).tolist()
    b0 = np.zeros(32).tolist()
    w1 = (rng.randn(32, 32) * 0.1).tolist()
    b1 = np.zeros(32).tolist()
    wa = (rng.randn(4, 32) * 0.1).tolist()
    ba = np.zeros(4).tolist()
    policy = metadata(
        1,
        "mlp",
        {
            "layers": [
                {"w": w0, "b": b0, "act": "tanh"},
                {"w": w1, "b": b1, "act": "tanh"},
            ],
            "action": {"w": wa, "b": ba, "act": "identity"},
        },
    )
    obs = rng.randn(16).astype(np.float32)
    obs = np.clip(obs, -1, 1)
    act = infer(policy, obs)
    assert act.shape == (4,)
    assert np.all(np.isfinite(act))
    assert act[0] >= -1 and act[0] <= 1
    assert act[3] >= 0 and act[3] <= 1


def test_telemetry_record_versioned():
    rec = record("sess", 10, "sentinel_action", {"yaw": 0.1})
    assert rec["schemaVersion"] == SCHEMA_VERSION
    assert rec["type"] == "sentinel_action"


def test_exported_client_policy_if_present():
    path = Path(__file__).resolve().parents[2] / "client" / "public" / "models" / "sentinel-policy.json"
    if not path.exists():
        return
    policy = json.loads(path.read_text(encoding="utf-8"))
    assert tuple(policy["featureOrder"]) == FEATURE_ORDER
    assert policy["observationVersion"] == OBSERVATION_VERSION
    assert policy["kind"] in ("mlp", "heuristic")
