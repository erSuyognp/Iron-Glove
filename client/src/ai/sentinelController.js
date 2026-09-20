import { AI_FEATURES, SENTINEL_INFER_HZ } from './config.js';
import { buildObservation, decisionFromObservation } from './observation.js';
import { heuristicAction } from './heuristic.js';
import { inferPolicy, loadSentinelPolicy } from './sentinelPolicy.js';

// 10–20 Hz inference. Missing/invalid policy → explicit heuristic fallback.
// Never writes player health. Fire is a candidate; the server still gates missiles.

export const SOURCE = Object.freeze({
  OFF: 'OFF',
  RL: 'RL',
  FALLBACK: 'HEURISTIC FALLBACK',
});

export function createSentinelController() {
  let policy = null;
  let source = AI_FEATURES.rlSentinel ? SOURCE.FALLBACK : SOURCE.OFF;
  let loadError = null;
  let decision = 'SEARCH';
  let lastInfer = 0;
  const interval = 1000 / SENTINEL_INFER_HZ;
  let lastAction = heuristicAction(new Float64Array(16));

  async function start() {
    if (!AI_FEATURES.rlSentinel) {
      source = SOURCE.OFF;
      return;
    }
    try {
      policy = await loadSentinelPolicy();
      source = policy.kind === 'heuristic' ? SOURCE.FALLBACK : SOURCE.RL;
      if (source === SOURCE.FALLBACK) {
        console.warn('[ai] sentinel policy is the explicit heuristic artifact, not a trained MLP');
      } else {
        console.log('[ai] sentinel RL policy loaded', policy.policyVersion, policy.kind);
      }
    } catch (err) {
      loadError = err?.message ?? String(err);
      policy = null;
      source = SOURCE.FALLBACK;
      console.warn('[ai] sentinel policy failed — heuristic fallback:', loadError);
    }
  }

  function infer(obs, now) {
    if (!AI_FEATURES.rlSentinel) {
      source = SOURCE.OFF;
      return lastAction;
    }
    if (now - lastInfer < interval) return lastAction;
    lastInfer = now;
    try {
      lastAction = policy && policy.kind === 'mlp' ? inferPolicy(policy, obs) : heuristicAction(obs);
      if (policy?.kind === 'mlp') source = SOURCE.RL;
      else source = SOURCE.FALLBACK;
    } catch (err) {
      loadError = err?.message ?? String(err);
      lastAction = heuristicAction(obs);
      source = SOURCE.FALLBACK;
      console.warn('[ai] sentinel inference error — heuristic fallback:', loadError);
    }
    decision = decisionFromObservation(obs, lastAction[3]);
    return lastAction;
  }

  function observe({ sentinel, player, cooldownElapsedS, now }) {
    try {
      const obs = buildObservation({ sentinel, player, cooldownElapsedS });
      for (let i = 0; i < obs.length; i++) {
        if (!Number.isFinite(obs[i])) throw new Error('non-finite sentinel observation');
      }
      return infer(obs, now);
    } catch (err) {
      loadError = err?.message ?? String(err);
      lastAction = heuristicAction(new Float64Array(16));
      source = SOURCE.FALLBACK;
      console.warn('[ai] sentinel observation error — heuristic fallback:', loadError);
      return lastAction;
    }
  }

  return {
    start,
    observe,
    infer,
    get source() {
      return source;
    },
    get decision() {
      return decision;
    },
    get loadError() {
      return loadError;
    },
    get enabled() {
      return AI_FEATURES.rlSentinel;
    },
  };
}
