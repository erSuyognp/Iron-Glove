// Helpers over normalized observations (see firms.js for the shape). Pure:
// no Cesium, no fetch, no DOM, so every rule here can be checked in Node.

// Data-status bands by age of the observation. FIRMS near-real-time data
// typically reach the service ~3 h after the satellite overpass, so a
// detection under LIVE_MAX_H is as fresh as the feed gets; RECENT covers the
// last couple of days; anything older is HISTORICAL.
export const LIVE_MAX_H = 6;
export const RECENT_MAX_H = 48;

export const DATA_STATUS = Object.freeze({
  LIVE: 'LIVE',
  RECENT: 'RECENT',
  HISTORICAL: 'HISTORICAL',
  UNKNOWN: 'UNKNOWN', // no usable observation time
});

export function ageHours(observedAt, now = Date.now()) {
  if (!observedAt) return null;
  const t = Date.parse(observedAt);
  if (Number.isNaN(t)) return null;
  return (now - t) / 3_600_000;
}

export function dataStatus(observedAt, now = Date.now()) {
  const h = ageHours(observedAt, now);
  if (h === null) return DATA_STATUS.UNKNOWN;
  if (h <= LIVE_MAX_H) return DATA_STATUS.LIVE;
  if (h <= RECENT_MAX_H) return DATA_STATUS.RECENT;
  return DATA_STATUS.HISTORICAL;
}

// bbox: { west, south, east, north } in degrees.
export function inBounds(obs, bbox) {
  if (!bbox) return true;
  return (
    obs.latitude >= bbox.south &&
    obs.latitude <= bbox.north &&
    obs.longitude >= bbox.west &&
    obs.longitude <= bbox.east
  );
}

export function filterToBounds(observations, bbox) {
  return bbox ? observations.filter((o) => inBounds(o, bbox)) : observations;
}

// What a set of observations covers, for status lines and provenance.
export function summarize(observations) {
  let from = null;
  let to = null;
  const satellites = new Set();
  const instruments = new Set();
  let withFrp = 0;
  let maxFrp = null;
  for (const o of observations) {
    if (o.observedAt) {
      if (!from || o.observedAt < from) from = o.observedAt;
      if (!to || o.observedAt > to) to = o.observedAt;
    }
    if (o.satellite) satellites.add(o.satellite);
    if (o.instrument) instruments.add(o.instrument);
    if (o.frp !== null && o.frp !== undefined) {
      withFrp++;
      if (maxFrp === null || o.frp > maxFrp) maxFrp = o.frp;
    }
  }
  return {
    count: observations.length,
    from,
    to,
    satellites: [...satellites],
    instruments: [...instruments],
    withFrp,
    maxFrp,
  };
}

// Newest first; observations without a time sort last.
export function byNewest(a, b) {
  if (!a.observedAt) return b.observedAt ? 1 : 0;
  if (!b.observedAt) return -1;
  return a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0;
}
