// JARVIS environmental briefing — a deterministic sentence or two built from
// the structured evidence, mentioning only properties that are present.
//
// The input is the same envelope a future model would receive:
//
//   { observation, nearby_context, mission_state }
//
// so swapping this for an LLM/agent later is a change of implementation, not
// of interface. Whatever replaces it must keep the same contract: reason over
// the supplied evidence, never invent a field that isn't there.

import { assessPriority, PRIORITY } from './priority.js';
import { compassPoint, formatDistance } from './geo.js';

function whenText(ageHours) {
  if (ageHours === null || ageHours === undefined) return null;
  if (ageHours < 1) return 'within the last hour';
  const h = Math.round(ageHours);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(ageHours / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * @param evidence.observation     normalized observation (firms.js)
 * @param evidence.nearby_context  { distanceM?, bearingDeg? } from the suit, or null
 * @param evidence.mission_state   { status?, targetId? } or null (Stage 7)
 * @param now                      ms epoch, injectable for tests
 * @returns {{ text: string, priority: object }}
 */
export function briefObservation({ observation, nearby_context = null, mission_state = null }, now = Date.now()) {
  const priority = assessPriority(observation, now);
  const parts = [];

  const who = observation.satellite ?? (observation.instrument ? `The ${observation.instrument} sensor` : 'A satellite');
  const when = whenText(priority.factors.ageHours);
  const where =
    nearby_context && Number.isFinite(nearby_context.distanceM)
      ? ` ${formatDistance(nearby_context.distanceM)}${
          Number.isFinite(nearby_context.bearingDeg) ? ` to the ${compassPoint(nearby_context.bearingDeg)}` : ''
        }`
      : '';
  parts.push(`${who} reported a thermal anomaly${when ? ` ${when}` : ''}${where}.`);

  if (priority.level === PRIORITY.HIGH) {
    const drivers = priority.reasons.filter((r) => !r.startsWith('recently') && !r.startsWith('observed within'));
    parts.push(
      drivers.length
        ? `${capitalize(stripFigures(drivers[0]))} makes it a priority observation.`
        : 'Its recency makes it a priority observation.',
    );
  } else if (priority.level === PRIORITY.MEDIUM) {
    parts.push('Medium observation priority.');
  } else {
    parts.push('Low observation priority.');
  }

  if (priority.cautions.length) parts.push(`Note: ${priority.cautions.join('; ')}.`);

  if (mission_state?.status === 'ACTIVE' && mission_state.targetId === observation.id) {
    parts.push('This is your current inspection target.');
  }

  return { text: parts.join(' '), priority };
}

// "elevated fire radiative power (152.3 MW)" → "elevated fire radiative power"
function stripFigures(reason) {
  return reason.replace(/\s*\(.*\)$/, '');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
