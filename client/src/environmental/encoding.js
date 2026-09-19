// Visual encoding of a normalized observation — the numbers behind the marker,
// kept free of Cesium so the rules can be read and tested on their own.
//
//   size        Fire Radiative Power (MW), square-root scaled and clamped so
//               one 400 MW pixel doesn't dwarf everything; unknown FRP draws
//               at the smallest size.
//   alpha       age: fresh detections are solid, week-old ones fade, never
//               below ALPHA_MIN so historical data stays visible.
//   tone        data-status band (LIVE / RECENT / HISTORICAL) picks the hue.
//   outline     confidence class: high = bright, nominal = normal, low = grey.
//               Confidence is a label here, not a bigger dot: FIRMS confidence
//               is a pixel-quality flag, not a measure of fire size.

import { ageHours, dataStatus, DATA_STATUS } from './observations.js';

export const FRP_FULL_MW = 150; // FRP at which a marker reaches full size
export const SIZE_MIN_PX = 6;
export const SIZE_MAX_PX = 16;
export const ALPHA_MIN = 0.45;
export const ALPHA_MAX = 0.95;
export const FADE_HOURS = 7 * 24;

export const TONES = Object.freeze({
  [DATA_STATUS.LIVE]: '#ff4a1c',
  [DATA_STATUS.RECENT]: '#ff7f2a',
  [DATA_STATUS.HISTORICAL]: '#ffb04a',
  [DATA_STATUS.UNKNOWN]: '#c9b58f',
});

export const OUTLINES = Object.freeze({
  high: { css: '#fff6e0', width: 2 },
  nominal: { css: '#ffd9a8', width: 1 },
  low: { css: '#8f8f8f', width: 1 },
  unknown: { css: '#ffd9a8', width: 1 },
});

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function sizeForFrp(frp) {
  if (frp === null || frp === undefined || !Number.isFinite(frp)) return SIZE_MIN_PX;
  return SIZE_MIN_PX + (SIZE_MAX_PX - SIZE_MIN_PX) * Math.sqrt(clamp01(frp / FRP_FULL_MW));
}

export function alphaForAge(observedAt, now = Date.now()) {
  const h = ageHours(observedAt, now);
  if (h === null) return ALPHA_MIN;
  return ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * (1 - clamp01(h / FADE_HOURS));
}

// Confidence class key for OUTLINES. Percent confidences (MODIS) map to the
// same three bands FIRMS uses for its own MODIS legend (<30 low, <80 nominal).
export function confidenceClass(obs) {
  if (obs.confidenceScale === 'class') return obs.confidence;
  if (obs.confidenceScale === 'percent') return obs.confidence < 30 ? 'low' : obs.confidence < 80 ? 'nominal' : 'high';
  return 'unknown';
}

/** Everything a renderer needs for one marker. */
export function encodeObservation(obs, now = Date.now()) {
  const status = dataStatus(obs.observedAt, now);
  return {
    status,
    size: sizeForFrp(obs.frp),
    alpha: alphaForAge(obs.observedAt, now),
    tone: TONES[status],
    outline: OUTLINES[confidenceClass(obs)] ?? OUTLINES.unknown,
  };
}
