import * as Cesium from 'cesium';

// Homewood's playable airspace. The polygon follows the campus envelope rather
// than a generic circle, keeping every flight over the university while giving
// the quad, athletic fields, and surrounding campus buildings room to breathe.
// Coordinates are [longitude, latitude].
const HOMEWOOD = [
  [-76.6282, 39.3338],
  [-76.6229, 39.3367],
  [-76.6174, 39.3362],
  [-76.6148, 39.3328],
  [-76.6158, 39.3268],
  [-76.6191, 39.3249],
  [-76.6254, 39.3255],
  [-76.6284, 39.3292],
];

const CLOSED_HOMEWOOD = [...HOMEWOOD, HOMEWOOD[0]];

function contains(longitude, latitude) {
  let inside = false;
  for (let i = 0, j = HOMEWOOD.length - 1; i < HOMEWOOD.length; j = i++) {
    const [xi, yi] = HOMEWOOD[i];
    const [xj, yj] = HOMEWOOD[j];
    const crosses = (yi > latitude) !== (yj > latitude);
    if (crosses && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Keep a motion segment inside the polygon. A short binary search finds the
// perimeter intersection without jumping the suit to an arbitrary campus point.
function confine(fromLongitude, fromLatitude, toLongitude, toLatitude) {
  if (contains(toLongitude, toLatitude)) {
    return { longitude: toLongitude, latitude: toLatitude, blocked: false };
  }

  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) * 0.5;
    const longitude = fromLongitude + (toLongitude - fromLongitude) * mid;
    const latitude = fromLatitude + (toLatitude - fromLatitude) * mid;
    if (contains(longitude, latitude)) low = mid;
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

export function initHomewoodBoundary(viewer) {
  const positions = Cesium.Cartesian3.fromDegreesArray(CLOSED_HOMEWOOD.flat());

  // A holographic net made from perimeter rails and sparse vertical laser
  // strands. A filled Wall/Grid material darkens the entire skyline from a
  // chase camera, so this reads as a high-tech boundary without masking JHU.
  viewer.entities.add({
    name: 'Homewood flight perimeter',
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
    CLOSED_HOMEWOOD.flatMap(([longitude, latitude]) => [longitude, latitude, 430]),
  );
  viewer.entities.add({
    name: 'Homewood flight perimeter crown',
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
  for (let i = 0; i < HOMEWOOD.length; i++) {
    const a = HOMEWOOD[i];
    const b = HOMEWOOD[(i + 1) % HOMEWOOD.length];
    for (const [longitude, latitude] of [a, [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]]) {
      viewer.entities.add({
        name: 'Homewood net strand',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            longitude, latitude, -30,
            longitude, latitude, 430,
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
    confine,
    contains,
  };
}
