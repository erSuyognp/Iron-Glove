import assert from 'node:assert/strict';
import { buildObservation, FEATURE_ORDER, inPlayerFrontalCone } from './observation.js';
import { heuristicAction } from './heuristic.js';
import { inferPolicy, validatePolicy } from './sentinelPolicy.js';
import { AI_FEATURES } from './config.js';
import { telemetryRecord } from './telemetry.js';

const obs = buildObservation({
  sentinel: { pos: [10, 0, 150], vel: [5, 0, 0], heading: 0, health: 100 },
  player: { pos: [20, 0, 150], vel: [0, 0, 0], heading: 0, health: 80 },
  cooldownElapsedS: 4,
});
assert.equal(obs.length, FEATURE_ORDER.length);
assert.ok([...obs].every(Number.isFinite));
assert.ok(Math.abs(obs[13] - 0.8) < 1e-9);
assert.equal(obs[14], 1);

assert.equal(inPlayerFrontalCone(0, 110, 0, 0, 0, 110), true);
assert.equal(inPlayerFrontalCone(0, -110, 0, 0, 0, 110), false);

const act = heuristicAction(obs);
assert.equal(act.length, 4);
assert.ok(act[0] >= -1 && act[0] <= 1);
assert.ok(act[3] === 0 || act[3] === 1);

const heuristicPolicy = {
  policyVersion: 1,
  observationVersion: 1,
  featureOrder: [...FEATURE_ORDER],
  normalization: {},
  trainingSeed: 0,
  kind: 'heuristic',
};
validatePolicy(heuristicPolicy);
const inferred = inferPolicy(heuristicPolicy, obs);
assert.deepEqual([...inferred], [...act]);

assert.equal(AI_FEATURES.rlSentinel, true);
assert.equal(AI_FEATURES.flightAssistant, false);

const rec = telemetryRecord('s', 1, 'sentinel_action', { yaw: 0 });
assert.equal(rec.schemaVersion, 1);

console.log('ai observation/heuristic contract OK');
