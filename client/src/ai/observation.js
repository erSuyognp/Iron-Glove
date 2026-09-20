// Sentinel observation contract v1 — local ENU metres, never raw lon/lat.
// Must match ml/iron_glove_rl/utils/contract.py and ml/iron_glove_rl/obs.py.

export const OBSERVATION_VERSION = 1;
export const POLICY_VERSION = 1;

export const FEATURE_ORDER = Object.freeze([
  'dx',
  'dy',
  'dz',
  'dvx',
  'dvy',
  'dvz',
  'svx',
  'svy',
  'svz',
  'distance',
  'bearing_error',
  'altitude_diff',
  'sentinel_health',
  'player_health',
  'cooldown_ready',
  'in_cone',
]);

export const NORMALIZATION = Object.freeze({
  posScale: 400,
  velScale: 60,
  altScale: 200,
  distanceScale: 400,
  bearingScale: Math.PI,
});

export const FIRE_INTERVAL_S = 4;
export const FIRE_RANGE_M = 250;
export const FRONT_ARC_DEG = 50;

export function clip(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function headingFromVelocity(ve, vn, fallback = 0) {
  if (ve * ve + vn * vn < 1e-6) return fallback;
  return Math.atan2(ve, vn);
}

export function inPlayerFrontalCone(sentinelE, sentinelN, playerE, playerN, playerHeading, rangeM) {
  if (rangeM > FIRE_RANGE_M) return false;
  // Same convention as tick_sentinels: vector from drone to player.
  const de = playerE - sentinelE;
  const dn = playerN - sentinelN;
  const flat = Math.hypot(de, dn) || 1;
  const ahead = (-de * Math.sin(playerHeading) - dn * Math.cos(playerHeading)) / flat;
  return ahead >= Math.cos((FRONT_ARC_DEG * Math.PI) / 180);
}

/**
 * @param state
 *   sentinel: { pos:[e,n,u], vel:[e,n,u], heading, health }
 *   player:   { pos:[e,n,u], vel:[e,n,u], heading, health }
 *   cooldownElapsedS
 * @returns Float64Array length 16, values in [-1, 1] (fractions in [0, 1])
 */
export function buildObservation({ sentinel, player, cooldownElapsedS }) {
  const [se, sn, su] = sentinel.pos;
  const [pe, pn, pu] = player.pos;
  const [sve, svn, svu] = sentinel.vel;
  const [pve, pvn, pvu] = player.vel;
  const relE = pe - se;
  const relN = pn - sn;
  const relU = pu - su;
  const distance = Math.hypot(relE, relN, relU);
  const heading = headingFromVelocity(sve, svn, sentinel.heading ?? 0);
  const bearing = Math.atan2(relE, relN);
  const bearingError = wrapPi(bearing - heading);
  const { posScale: P, velScale: V, altScale: A } = NORMALIZATION;
  const cooldownReady = clip(cooldownElapsedS / FIRE_INTERVAL_S, 0, 1);
  const cone = inPlayerFrontalCone(se, sn, pe, pn, player.heading, distance) ? 1 : 0;
  return new Float64Array([
    clip(relE / P, -1, 1),
    clip(relN / P, -1, 1),
    clip(relU / P, -1, 1),
    clip((pve - sve) / V, -1, 1),
    clip((pvn - svn) / V, -1, 1),
    clip((pvu - svu) / V, -1, 1),
    clip(sve / V, -1, 1),
    clip(svn / V, -1, 1),
    clip(svu / V, -1, 1),
    clip(distance / P, 0, 1),
    clip(bearingError / Math.PI, -1, 1),
    clip(relU / A, -1, 1),
    clip((sentinel.health ?? 100) / 100, 0, 1),
    clip((player.health ?? 100) / 100, 0, 1),
    cooldownReady,
    cone,
  ]);
}

export function decisionFromObservation(obs, fire) {
  const distanceM = obs[9] * NORMALIZATION.distanceScale;
  const bearing = Math.abs(obs[10]);
  if (fire > 0.5 && obs[15] > 0.5) return 'ATTACK';
  if (distanceM < 150 && bearing < 0.35) return 'INTERCEPT';
  if (obs[10] > 0.55 || obs[10] < -0.55) return 'EVADE';
  if (distanceM < 320) return 'CHASE';
  return 'SEARCH';
}
