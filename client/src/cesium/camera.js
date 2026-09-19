import * as Cesium from 'cesium';

// Third-person chase camera. Given the suit's geodetic position and heading,
// place the camera behind and above it, looking forward.

const BACK_DISTANCE = 90; // meters behind the suit
const UP_DISTANCE = 30; // meters above the suit
const PITCH_DOWN = Cesium.Math.toRadians(-12); // slight downward tilt

export function updateChaseCamera(viewer, state) {
  const { longitude, latitude, altitude, heading } = state;

  // Offset the camera position "behind" the suit along its heading.
  // Heading 0 = north; move opposite the facing direction.
  const headingRad = Cesium.Math.toRadians(heading);
  const backEast = -Math.sin(headingRad) * BACK_DISTANCE;
  const backNorth = -Math.cos(headingRad) * BACK_DISTANCE;

  // Convert local ENU meters to degree deltas.
  const latRad = Cesium.Math.toRadians(latitude);
  const dLat = backNorth / 111320;
  const dLon = backEast / (111320 * Math.cos(latRad));

  const camLon = longitude + dLon;
  const camLat = latitude + dLat;
  // Follow only part of the idle hover so the view breathes without seasickness.
  const camAlt = altitude + UP_DISTANCE + (state.hover || 0) * 0.5;

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(camLon, camLat, camAlt),
    orientation: {
      heading: headingRad,
      pitch: PITCH_DOWN,
      // Roll the whole view with the suit so Q/E reads as a real barrel roll.
      roll: Cesium.Math.toRadians(state.roll || 0),
    },
  });
}

// Instant fly-to for spawn / reset (no animation for a snappy respawn).
export function snapTo(viewer, state) {
  updateChaseCamera(viewer, state);
}
