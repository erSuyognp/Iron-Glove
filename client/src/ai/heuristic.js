import { clip } from './observation.js';

const ENGAGE_HEIGHT_M = 12;
const PREFERRED_ATTACK_DIST_M = 110;
const FIRE_RANGE_M = 250;

/** Explicit deterministic baseline — never labeled as RL. */
export function heuristicAction(obs) {
  const dz = obs[2];
  const distance = obs[9];
  const bearingError = obs[10];
  const cooldown = obs[14];
  const inCone = obs[15] > 0.5;
  const yaw = clip(bearingError * 1.6, -1, 1);
  const wantDz = ENGAGE_HEIGHT_M / 200 - dz;
  const pitch = clip(wantDz * 2.2, -1, 1);
  const distM = distance * 400;
  let throttle = 0.25;
  if (distM > PREFERRED_ATTACK_DIST_M * 1.4) throttle = 1;
  else if (distM < PREFERRED_ATTACK_DIST_M * 0.6) throttle = -0.2;
  const fire = inCone && distM <= FIRE_RANGE_M && cooldown >= 0.95 ? 1 : 0;
  return new Float64Array([yaw, pitch, throttle, fire]);
}
