import * as Cesium from 'cesium';

// Collision helpers against the 3D mesh (terrain + Google 3D Tiles).
// Two sensors:
//   1. sampleSurfaceHeight — cheap GPU depth read straight down, for the
//      dynamic floor (roofs, streets, ground) so the suit can skim low.
//   2. forwardObstacle — a short ray along the flight path, to catch flying
//      into the side of a building.

const scratchCarto = new Cesium.Cartographic();

// Height of the topmost surface directly below a lon/lat, or undefined if the
// mesh there isn't loaded / sampling isn't supported.
export function sampleSurfaceHeight(viewer, longitude, latitude, exclude) {
  const scene = viewer.scene;
  if (!scene.sampleHeightSupported) return undefined;
  Cesium.Cartographic.fromDegrees(longitude, latitude, 0, scratchCarto);
  const h = scene.sampleHeight(scratchCarto, exclude);
  return Number.isFinite(h) ? h : undefined;
}

// Cast a ray forward along the suit's heading. Returns { distance } of the
// first obstacle within `lookAhead` meters, or undefined.
export function forwardObstacle(viewer, suit, lookAhead, exclude) {
  const scene = viewer.scene;
  if (!scene.pickPositionSupported) return undefined;

  const origin = Cesium.Cartesian3.fromDegrees(
    suit.longitude,
    suit.latitude,
    suit.altitude,
  );

  // Convert a local east-north-up forward vector to world coordinates.
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const headingRad = Cesium.Math.toRadians(suit.heading);
  // Nudge the ray slightly downward when diving so we detect the ground ahead.
  const localForward = new Cesium.Cartesian3(
    Math.sin(headingRad),
    Math.cos(headingRad),
    0,
  );
  const worldDir = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    localForward,
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.normalize(worldDir, worldDir);

  const ray = new Cesium.Ray(origin, worldDir);
  const hit = scene.pickFromRay(ray, exclude);
  if (hit && Cesium.defined(hit.position)) {
    const distance = Cesium.Cartesian3.distance(origin, hit.position);
    if (distance <= lookAhead) return { distance };
  }
  return undefined;
}
