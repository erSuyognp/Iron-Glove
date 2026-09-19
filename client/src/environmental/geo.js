// Great-circle helpers for "how far / which way" from the suit to an
// observation. Spherical earth is plenty at these ranges (<0.5 % error).

const R = 6371008.8; // mean earth radius, m
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Ground distance in metres between two { latitude, longitude } points. */
export function groundDistance(a, b) {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, s)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearingTo(a, b) {
  const dLon = rad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(rad(b.latitude));
  const x =
    Math.cos(rad(a.latitude)) * Math.sin(rad(b.latitude)) -
    Math.sin(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed heading change (-180, 180] from `heading` to face `bearing`. */
export function relativeBearing(heading, bearing) {
  let d = (bearing - heading) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

const POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export function compassPoint(bearing) {
  return POINTS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

export function formatDistance(m) {
  if (!Number.isFinite(m)) return 'N/A';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
