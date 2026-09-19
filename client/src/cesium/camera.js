import * as Cesium from 'cesium';

// Third-person chase camera. Given the suit's geodetic position and heading,
// place the camera behind and above it, looking forward.

const BACK_DISTANCE = 90; // meters behind the suit
const UP_DISTANCE = 30; // meters above the suit
const PITCH_DOWN = Cesium.Math.toRadians(-12); // slight downward tilt
// In a nose dive the camera swings up and over the suit and looks down the
// dive with it, so the ground rushes up the screen instead of sliding under it.
const DIVE_SWING = Cesium.Math.toRadians(26);

// Where the chase camera sits relative to a suit and how far it looks down:
// { back, up } in metres and { pitch } in radians. The autolock aims along
// this same view for every suit, on camera or not (combat/autolock.js).
export function chaseRig(state, result = {}) {
  const swing = (state.dive || 0) * DIVE_SWING;
  result.back = BACK_DISTANCE * Math.cos(swing);
  result.up = UP_DISTANCE + BACK_DISTANCE * Math.sin(swing) * 0.8;
  result.pitch = PITCH_DOWN - swing;
  return result;
}
const rig = {};

export function updateChaseCamera(viewer, state) {
  const { longitude, latitude, altitude, heading } = state;

  // Offset the camera position "behind" the suit along its heading.
  // Heading 0 = north; move opposite the facing direction.
  chaseRig(state, rig);
  const headingRad = Cesium.Math.toRadians(heading);
  const backEast = -Math.sin(headingRad) * rig.back;
  const backNorth = -Math.cos(headingRad) * rig.back;

  // Convert local ENU meters to degree deltas.
  const latRad = Cesium.Math.toRadians(latitude);
  const dLat = backNorth / 111320;
  const dLon = backEast / (111320 * Math.cos(latRad));

  const camLon = longitude + dLon;
  const camLat = latitude + dLat;
  // Follow only part of the idle hover so the view breathes without seasickness.
  const camAlt = altitude + rig.up + (state.hover || 0) * 0.5;

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(camLon, camLat, camAlt),
    orientation: {
      heading: headingRad,
      pitch: rig.pitch,
      // Roll the whole view with the suit so Q/E reads as a real barrel roll.
      roll: Cesium.Math.toRadians(state.roll || 0),
    },
  });
}

// Instant fly-to for spawn / reset (no animation for a snappy respawn).
export function snapTo(viewer, state) {
  updateChaseCamera(viewer, state);
}
