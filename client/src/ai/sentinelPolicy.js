import { FEATURE_ORDER, OBSERVATION_VERSION, POLICY_VERSION } from './observation.js';
import { heuristicAction } from './heuristic.js';

const POLICY_URL = '/models/sentinel-policy.json';

function sigmoid(x) {
  if (x > 20) return 1;
  if (x < -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function tanh(x) {
  return Math.tanh(x);
}

function matvec(w, x, b) {
  // w: out x in  (torch Linear)
  const out = new Float64Array(w.length);
  for (let i = 0; i < w.length; i++) {
    let s = b[i];
    const row = w[i];
    for (let j = 0; j < row.length; j++) s += row[j] * x[j];
    out[i] = s;
  }
  return out;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('policy is empty');
  if (policy.observationVersion !== OBSERVATION_VERSION) {
    throw new Error(`observationVersion ${policy.observationVersion} != ${OBSERVATION_VERSION}`);
  }
  if (policy.policyVersion !== POLICY_VERSION) {
    throw new Error(`policyVersion ${policy.policyVersion} != ${POLICY_VERSION}`);
  }
  const order = policy.featureOrder;
  if (!Array.isArray(order) || order.length !== FEATURE_ORDER.length) {
    throw new Error('featureOrder length mismatch');
  }
  for (let i = 0; i < order.length; i++) {
    if (order[i] !== FEATURE_ORDER[i]) throw new Error(`featureOrder changed at ${i}: ${order[i]}`);
  }
  if (policy.kind !== 'mlp' && policy.kind !== 'heuristic') {
    throw new Error(`unknown policy kind ${policy.kind}`);
  }
  if (policy.kind === 'mlp' && (!policy.layers || !policy.action)) {
    throw new Error('mlp policy missing layers');
  }
}

export function inferPolicy(policy, obs) {
  if (!policy || policy.kind === 'heuristic') return heuristicAction(obs);
  let x = obs;
  for (const layer of policy.layers) {
    x = matvec(layer.w, x, layer.b);
    if (layer.act === 'tanh') {
      const y = new Float64Array(x.length);
      for (let i = 0; i < x.length; i++) y[i] = tanh(x[i]);
      x = y;
    }
  }
  const mean = matvec(policy.action.w, x, policy.action.b);
  return new Float64Array([tanh(mean[0]), tanh(mean[1]), tanh(mean[2]), sigmoid(mean[3])]);
}

export async function loadSentinelPolicy(fetchImpl = fetch) {
  const res = await fetchImpl(POLICY_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`policy HTTP ${res.status}`);
  const policy = await res.json();
  validatePolicy(policy);
  return policy;
}
