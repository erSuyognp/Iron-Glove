import * as Cesium from 'cesium';
import { sitePerimeter } from '../sites.js';

// A site's playable airspace. At Homewood the polygon follows the campus
// envelope rather than a generic circle, keeping every flight over the
// university while giving the quad, athletic fields, and surrounding campus
// buildings room to breathe; the landmarks get a ring around the landmark
// (sites.js). Coordinates are [longitude, latitude].

// Height of the net, in metres relative to the site's altitude offset (so the
// numbers are Homewood's). Away from Homewood the ground can fall a long way
// inside the ring, and the strands run down to meet it.
const NET_TOP = 430;
const NET_BOTTOM = -30;
const NET_BOTTOM_RUGGED = -900;
const MAX_STRANDS = 16;

function contains(perimeter, longitude, latitude) {
  let inside = false;
  for (let i = 0, j = perimeter.length - 1; i < perimeter.length; j = i++) {
    const [xi, yi] = perimeter[i];
    const [xj, yj] = perimeter[j];
    const crosses = (yi > latitude) !== (yj > latitude);
    if (crosses && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Keep a motion segment inside the polygon. A short binary search finds the
// perimeter intersection without jumping the suit to an arbitrary campus point.
function confine(perimeter, fromLongitude, fromLatitude, toLongitude, toLatitude) {
  if (contains(perimeter, toLongitude, toLatitude)) {
    return { longitude: toLongitude, latitude: toLatitude, blocked: false };
  }

  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) * 0.5;
    const longitude = fromLongitude + (toLongitude - fromLongitude) * mid;
    const latitude = fromLatitude + (toLatitude - fromLatitude) * mid;
    if (contains(perimeter, longitude, latitude)) low = mid;
    else high = mid;
  }

  // Stay a fraction inside the perimeter so the next frame does not oscillate
  // across the line because of floating-point rounding.
  const safe = Math.max(0, low - 0.0005);
  return {
    longitude: fromLongitude + (toLongitude - fromLongitude) * safe,
    latitude: fromLatitude + (toLatitude - fromLatitude) * safe,
    blocked: true,
  };
}

export function initBoundary(viewer, site) {
  const perimeter = sitePerimeter(site);
  const closed = [...perimeter, perimeter[0]];
  const top = NET_TOP + site.altOffset;
  const bottom = (site.polygon ? NET_BOTTOM : NET_BOTTOM_RUGGED) + site.altOffset;
  const positions = Cesium.Cartesian3.fromDegreesArrayHeights(
    closed.flatMap(([longitude, latitude]) => [longitude, latitude, site.polygon ? 0 : site.altOffset]),
  );

  // A holographic net made from perimeter rails and sparse vertical laser
  // strands. A filled Wall/Grid material darkens the entire skyline from a
  // chase camera, so this reads as a high-tech boundary without masking JHU.
  viewer.entities.add({
    name: 'Flight perimeter',
    polyline: {
      positions,
      width: 2.5,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.22,
        color: Cesium.Color.fromCssColorString('#37e7ff').withAlpha(0.72),
      }),
    },
  });

  const topPositions = Cesium.Cartesian3.fromDegreesArrayHeights(
    closed.flatMap(([longitude, latitude]) => [longitude, latitude, top]),
  );
  viewer.entities.add({
    name: 'Flight perimeter crown',
    polyline: {
      positions: topPositions,
      width: 1.4,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.2,
        color: Cesium.Color.fromCssColorString('#37e7ff').withAlpha(0.34),
      }),
    },
  });

  // Vertex and edge-midpoint strands give the perimeter a readable net rhythm
  // while preserving an unobstructed campus panorama.
  // Few corners (Homewood): a strand at each and at each edge midpoint. Many
  // (a ring): a strand at every Nth corner.
  const midpoints = perimeter.length * 2 <= MAX_STRANDS;
  const every = Math.max(1, Math.round(perimeter.length / MAX_STRANDS));
  for (let i = 0; i < perimeter.length; i++) {
    const a = perimeter[i];
    const b = perimeter[(i + 1) % perimeter.length];
    const posts = midpoints ? [a, [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]] : i % every === 0 ? [a] : [];
    for (const [longitude, latitude] of posts) {
      viewer.entities.add({
        name: 'Net strand',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            longitude, latitude, bottom,
            longitude, latitude, top,
          ]),
          width: 1,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.16,
            color: Cesium.Color.fromCssColorString('#37e7ff').withAlpha(0.32),
          }),
        },
      });
    }
  }

  return {
    confine: (fromLongitude, fromLatitude, toLongitude, toLatitude) =>
      confine(perimeter, fromLongitude, fromLatitude, toLongitude, toLatitude),
    contains: (longitude, latitude) => contains(perimeter, longitude, latitude),
  };
}
