// Environmental inspection missions — the human-in-the-loop step between
// "the satellite saw something" and "a pilot goes to look".
//
// The system may RECOMMEND an observation; only the operator can ACCEPT it
// (making it ACTIVE) or IGNORE it. Flight is unchanged: the mission is a
// waypoint plus guidance, and it completes when the suit is within
// ARRIVAL_RADIUS_M of the observation on the ground. Nothing here touches
// Cesium or the DOM, so the whole state machine runs in Node.
//
// Shared state — extension point, not implemented on this branch:
//   Missions are local to this browser. To replicate them through
//   SpacetimeDB later, publish `snapshot()` (observationId, status, timestamps,
//   acceptedBy = PLAYER_ID) as a new table and treat the local machine as the
//   authority for the accepting player only. That is deliberately deferred so
//   the multiplayer path stays frozen.

import { assessPriority, byPriority, PRIORITY } from './priority.js';
import { groundDistance, bearingTo, relativeBearing } from './geo.js';

export const MISSION_STATUS = Object.freeze({
  NONE: 'NONE',
  RECOMMENDED: 'RECOMMENDED', // system proposal awaiting ACCEPT / IGNORE
  ACTIVE: 'ACTIVE',
  COMPLETE: 'COMPLETE',
});

export const ARRIVAL_RADIUS_M = 300; // ground distance at which an inspection counts as reached
export const RECOMMEND_RADIUS_M = 40000; // only propose targets within a flyable range of the suit
export const MISSION_TITLE = 'Inspect satellite thermal anomaly';

/**
 * Pick the observation worth recommending from `here`: highest OBSERVATION
 * PRIORITY within RECOMMEND_RADIUS_M, nearest first on ties; never one the
 * operator already ignored. Returns null when nothing qualifies (LOW-only
 * datasets don't generate a recommendation — the operator can still pick).
 */
export function recommend(observations, here, { ignored = new Set(), now = Date.now(), radiusM = RECOMMEND_RADIUS_M } = {}) {
  const candidates = observations
    .filter((o) => !ignored.has(o.id))
    .map((o) => ({ o, d: groundDistance(here, o) }))
    .filter(({ d }) => d <= radiusM);
  if (!candidates.length) return null;
  const rank = byPriority(now);
  candidates.sort((a, b) => rank(a.o, b.o) || a.d - b.d);
  const best = candidates[0];
  const priority = assessPriority(best.o, now);
  if (priority.level === PRIORITY.LOW) return null;
  return { observation: best.o, priority, distanceM: best.d };
}

/**
 * @param opts.onChange  (snapshot) => void after every transition
 */
export function createMissionState({ onChange } = {}) {
  let status = MISSION_STATUS.NONE;
  let observation = null; // target (recommended or active)
  let priority = null;
  let since = null; // ms epoch of the last transition
  let arrivedAt = null;
  const ignored = new Set(); // observation ids the operator declined
  const log = []; // local record of decisions, oldest first

  function snapshot() {
    return {
      status,
      title: observation ? MISSION_TITLE : null,
      observationId: observation?.id ?? null,
      observation,
      priority,
      since,
      arrivedAt,
      ignoredCount: ignored.size,
    };
  }

  function transition(next, obs, pri, now, event) {
    status = next;
    observation = obs;
    priority = pri;
    since = now;
    if (next !== MISSION_STATUS.COMPLETE) arrivedAt = null;
    log.push({ at: now, event, observationId: obs?.id ?? null, status: next });
    onChange?.(snapshot());
  }

  /** System proposal. Refused while a mission is ACTIVE (never pre-empt the operator). */
  function propose(obs, pri, now = Date.now()) {
    if (status === MISSION_STATUS.ACTIVE) return false;
    if (ignored.has(obs.id)) return false;
    transition(MISSION_STATUS.RECOMMENDED, obs, pri, now, 'recommended');
    return true;
  }

  /**
   * Operator decision. With no args, accepts the current recommendation;
   * with an observation, starts a mission on it directly (INSPECT HOTSPOT
   * from the evidence panel — also a human choice).
   */
  function accept(obs = observation, pri = priority, now = Date.now()) {
    if (!obs) return false;
    ignored.delete(obs.id);
    transition(MISSION_STATUS.ACTIVE, obs, pri ?? assessPriority(obs, now), now, 'accepted');
    return true;
  }

  function ignore(now = Date.now()) {
    if (status !== MISSION_STATUS.RECOMMENDED || !observation) return false;
    ignored.add(observation.id);
    transition(MISSION_STATUS.NONE, null, null, now, 'ignored');
    return true;
  }

  function abort(now = Date.now()) {
    if (status !== MISSION_STATUS.ACTIVE) return false;
    transition(MISSION_STATUS.NONE, null, null, now, 'aborted');
    return true;
  }

  function clear(now = Date.now()) {
    if (status === MISSION_STATUS.NONE) return false;
    transition(MISSION_STATUS.NONE, null, null, now, 'cleared');
    return true;
  }

  /**
   * Guidance for the current target from the suit's { latitude, longitude,
   * heading }. Marks the mission COMPLETE on arrival. Returns null when there
   * is no target.
   */
  function progress(suit, now = Date.now()) {
    if (!observation) return null;
    const distanceM = groundDistance(suit, observation);
    const bearingDeg = bearingTo(suit, observation);
    const turnDeg = Number.isFinite(suit.heading) ? relativeBearing(suit.heading, bearingDeg) : null;
    const arrived = distanceM <= ARRIVAL_RADIUS_M;
    if (arrived && status === MISSION_STATUS.ACTIVE) {
      arrivedAt = now;
      transition(MISSION_STATUS.COMPLETE, observation, priority, now, 'arrived');
    }
    return { status, distanceM, bearingDeg, turnDeg, arrived };
  }

  return {
    propose,
    accept,
    ignore,
    abort,
    clear,
    progress,
    snapshot,
    get status() {
      return status;
    },
    get observation() {
      return observation;
    },
    get ignored() {
      return ignored;
    },
    get log() {
      return log.slice();
    },
    /** briefing.js mission_state shape */
    get missionState() {
      return { status, targetId: observation?.id ?? null };
    },
  };
}
