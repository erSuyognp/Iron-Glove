// Compact Sentinel policy runtime for tick_sentinels.
// Same observation/action contract as ml/iron_glove_rl and client/src/ai/.
// Fire is only a candidate: the caller still applies FIRE_INTERVAL / range / cone.

import { SENTINEL_POLICY_JSON } from "./sentinelPolicyData";

// V8 provides console at runtime; the module tsconfig has no DOM lib.
declare const console: { warn(...args: unknown[]): void };

type Vec = { e: number; n: number; u: number };

const POS = 400;
const VEL = 60;
const ALT = 200;
const FIRE_INTERVAL_S = 4;
const FIRE_RANGE_M = 250;
const FRONT_ARC_DEG = 50;
const ENGAGE_HEIGHT_M = 12;
const PREFERRED_ATTACK_DIST_M = 110;
const ATTACK_SPEED = 36;
const FEATURE_ORDER = [
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
];

type Policy = {
  kind: string;
  observationVersion: number;
  policyVersion: number;
  featureOrder: string[];
  layers?: { w: number[][]; b: number[]; act: string }[];
  action?: { w: number[][]; b: number[]; act: string };
};

let POLICY: Policy | null = null;
let POLICY_ERROR: string | null = null;

function loadPolicy(): Policy | null {
  if (POLICY || POLICY_ERROR) return POLICY;
  try {
    const p = JSON.parse(SENTINEL_POLICY_JSON) as Policy;
    if (p.observationVersion !== 1 || p.policyVersion !== 1) throw new Error("version mismatch");
    if (!p.featureOrder || p.featureOrder.length !== FEATURE_ORDER.length) throw new Error("featureOrder");
    for (let i = 0; i < FEATURE_ORDER.length; i++) {
      if (p.featureOrder[i] !== FEATURE_ORDER[i]) throw new Error(`featureOrder ${i}`);
    }
    POLICY = p;
    return POLICY;
  } catch (err: any) {
    POLICY_ERROR = err?.message ?? String(err);
    console.warn("[rl] sentinel policy invalid — heuristic fallback:", POLICY_ERROR);
    return null;
  }
}

function clip(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x;
}

function wrapPi(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function headingFromVelocity(ve: number, vn: number, fallback: number) {
  if (ve * ve + vn * vn < 1e-6) return fallback;
  return Math.atan2(ve, vn);
}

export function inPlayerFrontalCone(se: number, sn: number, pe: number, pn: number, playerHeading: number, rangeM: number) {
  if (rangeM > FIRE_RANGE_M) return false;
  const de = pe - se;
  const dn = pn - sn;
  const flat = Math.hypot(de, dn) || 1;
  const ahead = (-de * Math.sin(playerHeading) - dn * Math.cos(playerHeading)) / flat;
  return ahead >= Math.cos((FRONT_ARC_DEG * Math.PI) / 180);
}

export function buildObs(
  sPos: Vec,
  sVel: Vec,
  sHeading: number,
  sHealth: number,
  pPos: Vec,
  pVel: Vec,
  pHeading: number,
  pHealth: number,
  cooldownElapsedS: number,
): number[] {
  const relE = pPos.e - sPos.e;
  const relN = pPos.n - sPos.n;
  const relU = pPos.u - sPos.u;
  const distance = Math.hypot(relE, relN, relU);
  const heading = headingFromVelocity(sVel.e, sVel.n, sHeading);
  const bearing = Math.atan2(relE, relN);
  const cone = inPlayerFrontalCone(sPos.e, sPos.n, pPos.e, pPos.n, pHeading, distance) ? 1 : 0;
  return [
    clip(relE / POS, -1, 1),
    clip(relN / POS, -1, 1),
    clip(relU / POS, -1, 1),
    clip((pVel.e - sVel.e) / VEL, -1, 1),
    clip((pVel.n - sVel.n) / VEL, -1, 1),
    clip((pVel.u - sVel.u) / VEL, -1, 1),
    clip(sVel.e / VEL, -1, 1),
    clip(sVel.n / VEL, -1, 1),
    clip(sVel.u / VEL, -1, 1),
    clip(distance / POS, 0, 1),
    clip(wrapPi(bearing - heading) / Math.PI, -1, 1),
    clip(relU / ALT, -1, 1),
    clip(sHealth / 100, 0, 1),
    clip(pHealth / 100, 0, 1),
    clip(cooldownElapsedS / FIRE_INTERVAL_S, 0, 1),
    cone,
  ];
}

function heuristic(obs: number[]): number[] {
  const dz = obs[2];
  const distance = obs[9];
  const bearingError = obs[10];
  const cooldown = obs[14];
  const inCone = obs[15] > 0.5;
  const yaw = clip(bearingError * 1.6, -1, 1);
  const pitch = clip((ENGAGE_HEIGHT_M / 200 - dz) * 2.2, -1, 1);
  const distM = distance * 400;
  let throttle = 0.25;
  if (distM > PREFERRED_ATTACK_DIST_M * 1.4) throttle = 1;
  else if (distM < PREFERRED_ATTACK_DIST_M * 0.6) throttle = -0.2;
  const fire = inCone && distM <= FIRE_RANGE_M && cooldown >= 0.95 ? 1 : 0;
  return [yaw, pitch, throttle, fire];
}

function sigmoid(x: number) {
  if (x > 20) return 1;
  if (x < -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function matvec(w: number[][], x: number[], b: number[]): number[] {
  const out = new Array(w.length);
  for (let i = 0; i < w.length; i++) {
    let s = b[i];
    const row = w[i];
    for (let j = 0; j < row.length; j++) s += row[j] * x[j];
    out[i] = s;
  }
  return out;
}

function mlp(policy: Policy, obs: number[]): number[] {
  let x = obs;
  for (const layer of policy.layers ?? []) {
    x = matvec(layer.w, x, layer.b);
    if (layer.act === "tanh") x = x.map(Math.tanh);
  }
  const mean = matvec(policy.action!.w, x, policy.action!.b);
  return [Math.tanh(mean[0]), Math.tanh(mean[1]), Math.tanh(mean[2]), sigmoid(mean[3])];
}

export function actionToWant(action: number[], heading: number): Vec {
  const yaw = action[0];
  const pitch = action[1];
  const throttle = action[2];
  const h = wrapPi(heading + yaw * 1.8 * 0.1);
  const speed = ((throttle + 1) * 0.5) * ATTACK_SPEED;
  const climb = pitch * 18;
  return { e: Math.sin(h) * speed, n: Math.cos(h) * speed, u: climb };
}

export type SentinelCommand = { want: Vec; fire: boolean; source: "rl" | "heuristic" };

export function commandSentinel(
  sPos: Vec,
  sVel: Vec,
  sHealth: number,
  pPos: Vec,
  pVel: Vec,
  pHeading: number,
  pHealth: number,
  cooldownElapsedS: number,
): SentinelCommand {
  const heading = headingFromVelocity(sVel.e, sVel.n, 0);
  const obs = buildObs(sPos, sVel, heading, sHealth, pPos, pVel, pHeading, pHealth, cooldownElapsedS);
  const policy = loadPolicy();
  let action: number[];
  let source: "rl" | "heuristic" = "heuristic";
  try {
    if (policy?.kind === "mlp") {
      action = mlp(policy, obs);
      source = "rl";
    } else {
      action = heuristic(obs);
    }
    if (action.some((v) => !Number.isFinite(v))) throw new Error("non-finite action");
  } catch (err: any) {
    console.warn("[rl] inference failed — heuristic fallback:", err?.message ?? err);
    action = heuristic(obs);
    source = "heuristic";
  }
  return { want: actionToWant(action, heading), fire: action[3] > 0.5, source };
}

export function missionUsesRl(site: string): boolean {
  return site.endsWith("|rl");
}

export function missionSiteId(site: string): string {
  return site.endsWith("|rl") ? site.slice(0, -3) : site;
}
