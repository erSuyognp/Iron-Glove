// OBSERVATION PRIORITY — which detections are worth a closer look first.
//
// This is a transparent triage heuristic over fields FIRMS actually reports,
// not a fire-risk model and not scientifically validated. It exists so the
// operator can see *why* one hotspot is ranked above another, and every
// reason it gives is backed by a value in the observation. Missing fields
// contribute nothing and produce no reason.
//
//   Recency     age < 24 h → +2 · age < 72 h → +1        (observedAt)
//   Intensity   FRP ≥ 100 MW → +2 · FRP ≥ 30 MW → +1     (frp, megawatts)
//   Confidence  high / ≥ 80 % → +1 · low / < 30 % → −1  (confidence)
//
//   score ≥ 4 → HIGH · score ≥ 2 → MEDIUM · otherwise LOW
//
// The FRP thresholds are round numbers chosen from the distribution of
// VIIRS 375 m detections (most are under 10 MW; a few percent exceed 100 MW),
// so "elevated" means "well above a typical detection", nothing more. All
// thresholds are exported so the evidence panel can quote them.

import { ageHours } from './observations.js';

export const PRIORITY = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });

export const RULES = Object.freeze({
  recentHours: 24,
  windowHours: 72,
  frpElevatedMw: 100,
  frpModerateMw: 30,
  confidenceHighPct: 80,
  confidenceLowPct: 30,
  highScore: 4,
  mediumScore: 2,
});

function confidenceBand(obs) {
  if (obs.confidenceScale === 'class') return obs.confidence; // low | nominal | high
  if (obs.confidenceScale === 'percent') {
    if (obs.confidence >= RULES.confidenceHighPct) return 'high';
    if (obs.confidence < RULES.confidenceLowPct) return 'low';
    return 'nominal';
  }
  return null;
}

function hoursText(h) {
  if (h < 1) return 'under an hour ago';
  if (h < 48) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * @param obs  normalized observation (firms.js)
 * @param now  ms epoch, injectable for tests
 * @returns {{ level, score, reasons: string[], cautions: string[], factors }}
 *   reasons  — positive evidence, each traceable to a field
 *   cautions — evidence that lowers confidence in the detection
 *   factors  — the raw inputs the score was computed from
 */
export function assessPriority(obs, now = Date.now()) {
  let score = 0;
  const reasons = [];
  const cautions = [];

  const age = ageHours(obs.observedAt, now);
  if (age !== null) {
    if (age < RULES.recentHours) {
      score += 2;
      reasons.push(`recently observed (${hoursText(age)})`);
    } else if (age < RULES.windowHours) {
      score += 1;
      reasons.push(`observed within ${RULES.windowHours / 24} days (${hoursText(age)})`);
    }
  }

  const frp = Number.isFinite(obs.frp) ? obs.frp : null;
  if (frp !== null) {
    if (frp >= RULES.frpElevatedMw) {
      score += 2;
      reasons.push(`elevated fire radiative power (${frp.toFixed(1)} MW)`);
    } else if (frp >= RULES.frpModerateMw) {
      score += 1;
      reasons.push(`moderate fire radiative power (${frp.toFixed(1)} MW)`);
    }
  }

  const band = confidenceBand(obs);
  if (band === 'high') {
    score += 1;
    reasons.push('high-confidence satellite detection');
  } else if (band === 'low') {
    score -= 1;
    cautions.push('low-confidence detection');
  }

  const level = score >= RULES.highScore ? PRIORITY.HIGH : score >= RULES.mediumScore ? PRIORITY.MEDIUM : PRIORITY.LOW;
  return { level, score, reasons, cautions, factors: { ageHours: age, frp, confidenceBand: band } };
}

const RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Highest priority first; ties broken by score, then newest observation. */
export function byPriority(now = Date.now()) {
  return (a, b) => {
    const pa = assessPriority(a, now);
    const pb = assessPriority(b, now);
    if (RANK[pa.level] !== RANK[pb.level]) return RANK[pa.level] - RANK[pb.level];
    if (pa.score !== pb.score) return pb.score - pa.score;
    return (b.observedAt ?? '').localeCompare(a.observedAt ?? '');
  };
}
