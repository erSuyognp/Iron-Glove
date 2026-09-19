import * as Cesium from 'cesium';
import { initWorld, hasValidToken, getRenderQuality, JHU_HOMEWOOD } from './cesium/world.js';
import { updateChaseCamera } from './cesium/camera.js';
import { initHomewoodBoundary } from './cesium/homewood-boundary.js';
import { initKeyboard, readAxes } from './input/keyboard.js';
import {
  connectGlove,
  setGloveConnectionHandler,
  isGloveConnected,
  readGloveAxes,
  consumeFist,
  hasWebSerial,
} from './input/glove.js';
import {
  initHUD,
  updateHUD,
  setJarvis,
  setGpws,
  setNet,
  showBanner,
  hideBanner,
  updateSpeedFx,
  onConnectGlove,
  setGloveButton,
  setInputHint,
  flashRepulsor,
  setPov,
  setPovButton,
  onPovButton,
  setGfx,
} from './hud/hud.js';
import { initAttitude, updateAttitude } from './hud/attitude.js';
import { createTracker } from './hud/tracker.js';
import { sampleSurfaceHeight, forwardObstacle } from './suit/collision.js';
import { initTrail } from './suit/thruster.js';
import { initSuitOverlay } from './suit/player.js';
import { createStdbClient } from './spacetimedb/client.js';

// ---- Flight tuning ----
const MAX_SPEED = 60; // m/s forward
const BOOST_MULT = 2.2; // Space multiplies target speed
const YAW_RATE = 55; // deg/s
const ROLL_RATE = 160; // deg/s for manual barrel rolls (Q/E)
const CLIMB_RATE = 40; // m/s vertical
// Idle hover: a gentle levitation bob + attitude sway when the suit is still.
const HOVER_AMP = 1.3; // meters of vertical float
const HOVER_OMEGA = 2.1; // rad/s (period ~3s)
const HOVER_SWAY_ROLL = 2.2; // degrees of idle roll sway
const HOVER_SWAY_PITCH = 1.6; // degrees of idle pitch sway
const HOVER_IDLE_SPEED = 1.5; // treat as "still" below this speed
// Camera field of view: base, plus a punch that opens up at speed.
const BASE_FOV_DEG = 60;
const SPEED_FOV_DEG = 16; // extra FOV at full speed
// Speed at which effects (blur / vignette / FOV) reach full intensity.
const FX_FULL_SPEED = MAX_SPEED * 1.6;
const MIN_ALT = 30; // safety floor (only used if the mesh can't be sampled)
const MAX_ALT = 900;
// A depth sample is only trustworthy when it is at or below the suit. Fresh
// photogrammetry LODs can otherwise briefly report an unrelated tile far above
// the pilot, which must never teleport the player or the chase camera.
const MAX_SURFACE_ABOVE_SUIT = 10;
// Likewise, the coarsest planet-scale tiles sit kilometres below the real
// ground until the campus streams in; ignore samples that deep.
const MAX_SURFACE_BELOW_SUIT = 1500;
// The suit has weight — speed eases toward its target instead of snapping.
// Same 0.08 feel as the glove spring-damper; do not crank this up.
const SPEED_LERP = 0.08;
const ANGLE_LERP = 0.1; // how fast visual pitch/roll settle

// ---- Visual attitude (mesh only; the camera and HUD keep the flight path) ----
// A jet-powered body has to tip its thrust line into the motion: upright in a
// hover, ~72° forward at cruise, near-horizontal on boost, flared back when
// braking or reversing.
const LEAN_GAIN = 3.1; // lean = atan(gain * speed / MAX_SPEED)
const LEAN_REVERSE_GAIN = 0.7; // backing up only leans the chest back ~35°
const CLIMB_LEAN = 24; // deg: climbing at speed noses up the path, diving down
const ACCEL_LEAN = 0.08; // deg per m/s²: thrust leads acceleration
const MAX_ACCEL_LEAN = 20;
const MIN_LEAN = -40;
const MAX_LEAN = 100;
const ACCEL_REF = 120; // m/s² treated as a full-throttle change for the rig
const ACCEL_LERP = 0.15;
// Coordinated-turn bank: grows with airspeed, a small lean when pivoting.
const BANK_HOVER = 10;
const BANK_PER_MS = 0.75;
const MAX_BANK = 55;
// Lean/bank ride a slightly under-damped spring, so the suit swings into an
// attitude and settles instead of snapping to it.
const ATTITUDE_OMEGA = 6.5; // rad/s
const ATTITUDE_ZETA = 0.72;
const SPRING_STEP = 1 / 120; // s, fixed substep keeps the spring framerate-independent

// ---- Collision tuning ----
// Buildings and the ground still stop the suit, but contact never costs
// health: collision damage is off.
const GROUND_CLEARANCE = 4; // how far the suit floats above a surface at rest
const SUIT_RADIUS = 4; // meters, for the forward obstacle ray
const BUMP_COOLDOWN_MS = 700; // min gap between wall bounces
const GPWS_ALT = 45; // AGL below which the "PULL UP" warning flashes

const REPULSOR_LIFE = 0.35; // seconds the blast ellipsoid lasts
const BOUNDARY_WARN_COOLDOWN_MS = 2400;

const REPULSOR_LINES = [
  'Repulsor blast away, sir.',
  'Unibeam capacitor discharged.',
  'Fist gesture confirmed. Repulsors firing.',
];

// ---- SpacetimeDB sync (Phase 2) ----
// The client stays authoritative for physics and rendering; we mirror the
// computed transform into SpacetimeDB for multiplayer. Rendering our own suit
// from a 30 Hz server echo made the chase camera visibly step on a healthy
// connection, so server rows are now telemetry/remote-pilot data only.
const PLAYER_ID = 'suyog';
// Our row is telemetry for other viewers, who dead-reckon between updates, so
// 10 Hz is plenty.
const NET_SEND_HZ = 10;
const NET_SEND_MS = 1000 / NET_SEND_HZ;
// Render-smoothing for remote pilot snapshots. This is net interpolation, not
// physics; the local pilot always renders directly from its 60 fps simulation.
const NET_LERP = 0.5;
// Phones in this mode send control inputs, not positions, and we fly their
// suit here (see the phone controller for the wire format):
//   pitch = throttle, roll = turn, yaw = climb (all -1..1), position_x = boost
const CONTROL_MODE = 'PHONE_CTRL';
// A remote pilot is live while its row keeps updating (phones send at least a
// 1 Hz heartbeat). Rows that only arrive with the initial subscription are
// leftovers from an earlier session and never spawn a suit.
const PILOT_ACTIVE_MS = 3000;
const WINGMAN_OFFSET = 30; // m: a phone pilot appears this far to our right
const REMOTE_SENSORS = { surfaceMs: 100, forwardMs: 200 }; // collision sensing for phone pilots
const TRACK_MAX_LEAD_S = 0.5; // how far ahead we dead-reckon a position stream
const MOTION_LERP = 0.15; // smoothing for velocities read off a remote track
const REMOTE_SURFACE_MS = 250; // AGL sampling under a remote track we're watching
const LABEL_HEIGHT = 14; // m above the boots for a pilot's name tag

const JARVIS_LINES = {
  online: 'Suit online. Homewood airspace is clear, sir.',
  bump: [
    'Structural contact. The architecture is not the enemy, sir.',
    'That was a building. They rarely move.',
  ],
  pilotJoined: (name) =>
    `A second suit has entered Homewood airspace, sir. ${name} is airborne — press V to take their view.`,
  pilotLeft: (name) => `${name}'s suit has gone quiet, sir.`,
  povLost: (name) => `Lost ${name}'s feed. Back on your suit, sir.`,
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Suit state ----
// Flight state for any suit we fly or draw, at rest at a position.
function flightState({ longitude, latitude, altitude, heading }) {
  return {
    longitude,
    latitude,
    altitude,
    heading, // degrees, 0 = north
    speed: 0, // m/s (current, eased)
    vspeed: 0, // m/s vertical (current, eased)
    accel: 0, // m/s² forward, smoothed — drives the flare / tip-in
    turn: 0, // -1..1 smoothed yaw command — drives the rig's steering arms
    pitch: 0, // degrees (visual)
    roll: 0, // degrees — manual barrel roll (Q/E), drives the camera
    bank: 0, // degrees — auto-lean into turns, mesh only
    bankRate: 0,
    lean: 0, // degrees — thrust line tipped into the motion, mesh only
    leanRate: 0,
    hover: 0, // meters — idle levitation offset (visual only)
  };
}

function spawnState() {
  return {
    ...flightState({ ...JHU_HOMEWOOD, heading: 0 }),
    health: 100,
    mode: isGloveConnected() ? 'GLOVE' : 'KEYBOARD',
  };
}

let suit = spawnState();
let repulsor = null; // { entity, born } — fist-clench blast visual

// Collision sensors for one suit: a sampled floor under it and a forward ray.
function sensorState() {
  return {
    surface: undefined, // last trusted surface height under the suit
    sampledAt: 0, // throttles GPU height reads
    forwardAt: 0,
    bumpUntil: 0,
  };
}
const localSensors = sensorState();
// Scene objects the sensors must see through (trails, name tags), so one
// pilot's afterburner trail never reads as a wall to another.
const sensorExclude = [];

let trailClearNeeded = false; // flush the afterburner trail after a teleport
let idle = false; // suit is still enough to levitate
let hoverBlend = 0; // 0..1 ease for the idle hover
let hoverClock = 0; // seconds, advances the hover sine
let homewoodBoundary = null;
let boundaryWarnUntil = 0;

// ---- SpacetimeDB state ----
let stdb = null;
let lastNetSendAt = 0;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Framerate-independent smoothing: a per-frame lerp factor tuned at 60fps is
// remapped for the actual dt, so the feel is identical at 30 or 120 fps.
function smooth(current, target, factor60, dt) {
  const t = 1 - Math.pow(1 - factor60, dt * 60);
  return current + (target - current) * t;
}

// Normalize an angle in degrees to (-180, 180].
function normalizeDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

// Ease a heading toward a target along the shortest arc; result in [0, 360).
function easeHeading(cur, target, k) {
  return (cur + normalizeDeg(target - cur) * k + 360) % 360;
}

// Drive obj[key] toward `target` on a damped spring, carrying its velocity in
// obj[rateKey].
function springTo(obj, key, rateKey, target, dt) {
  const steps = Math.max(1, Math.ceil(dt / SPRING_STEP));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const a =
      ATTITUDE_OMEGA * ATTITUDE_OMEGA * (target - obj[key]) -
      2 * ATTITUDE_ZETA * ATTITUDE_OMEGA * obj[rateKey];
    obj[rateKey] += a * h;
    obj[key] += obj[rateKey] * h;
  }
}

// How far the suit tips its thrust line into the motion, in degrees
// (+ = chest down / head forward). Mesh only.
function leanTarget(s) {
  const cruise = s.speed / MAX_SPEED;
  let lean = Cesium.Math.toDegrees(
    cruise >= 0 ? Math.atan(LEAN_GAIN * cruise) : -Math.atan(LEAN_REVERSE_GAIN * -cruise),
  );
  // Climbing at speed noses the body up the flight path; diving tips it down.
  lean -= (s.vspeed / CLIMB_RATE) * CLIMB_LEAN * Math.max(-1, Math.min(1, cruise));
  // Thrust leads acceleration: tip in while speeding up, flare while slowing.
  // Tipping in fades out near level flight (past it the jets would push the
  // suit down); the braking flare applies at any speed.
  const tip = Math.max(-MAX_ACCEL_LEAN, Math.min(MAX_ACCEL_LEAN, s.accel * ACCEL_LEAN));
  lean += tip > 0 ? tip * Math.max(0, Math.cos(Cesium.Math.toRadians(lean))) : tip;
  return Math.max(MIN_LEAN, Math.min(MAX_LEAN, lean));
}

// One step of the suit flight model, shared by our suit and by the phone
// pilots we fly from their control inputs. `input`: throttle, yaw, climb in
// -1..1 plus a boost flag. Returns true when the Homewood perimeter stopped
// the suit this step.
function flySuit(s, input, dt) {
  // Target forward speed from throttle (+ optional boost).
  // SPEED_LERP 0.08 is the suit's spring-damper — do not crank this up.
  const targetSpeed = input.throttle * MAX_SPEED * (input.boost ? BOOST_MULT : 1);
  const previousSpeed = s.speed;
  s.speed = smooth(s.speed, targetSpeed, SPEED_LERP, dt);
  // Animation drivers: how hard the suit is accelerating and turning.
  if (dt > 0) s.accel = smooth(s.accel, (s.speed - previousSpeed) / dt, ACCEL_LERP, dt);
  s.turn = smooth(s.turn, input.yaw, ANGLE_LERP, dt);

  // Yaw turns the suit; scale by dt so it's framerate-independent.
  s.heading = (s.heading + input.yaw * YAW_RATE * dt + 360) % 360;

  // Climb / dive. Vertical speed eases through the same spring as forward
  // speed, so the suit carries its weight on every axis and the body can lean
  // along a real flight path rather than a key state.
  s.vspeed = smooth(s.vspeed, input.climb * CLIMB_RATE, SPEED_LERP, dt);
  s.altitude += s.vspeed * dt;
  if (s.altitude < MIN_ALT || s.altitude > MAX_ALT) {
    s.altitude = Math.min(MAX_ALT, Math.max(MIN_ALT, s.altitude));
    s.vspeed = 0;
  }

  // Advance position along heading over the ground.
  const previousLongitude = s.longitude;
  const previousLatitude = s.latitude;
  const dist = s.speed * dt; // meters this frame
  const headingRad = Cesium.Math.toRadians(s.heading);
  const dNorth = Math.cos(headingRad) * dist;
  const dEast = Math.sin(headingRad) * dist;
  const latRad = Cesium.Math.toRadians(s.latitude);
  s.latitude += dNorth / 111320;
  s.longitude += dEast / (111320 * Math.cos(latRad));

  // Homewood is the complete playable world: the holographic perimeter is
  // visible at the edge of campus, and this constraint makes it a real flight
  // barrier at every altitude instead of just decorative geometry.
  if (homewoodBoundary) {
    const confined = homewoodBoundary.confine(
      previousLongitude,
      previousLatitude,
      s.longitude,
      s.latitude,
    );
    if (confined.blocked) {
      s.longitude = confined.longitude;
      s.latitude = confined.latitude;
      s.speed *= 0.18;
      return true;
    }
  }
  return false;
}

// Coordinated-turn bank for a yaw command (mesh only, so the camera isn't
// yanked sideways). Positive yaw turns right and positive roll drops the
// right side.
function coordinatedBank(s, yaw) {
  return yaw * Math.min(MAX_BANK, BANK_HOVER + Math.abs(s.speed) * BANK_PER_MS);
}

// Ease the visual attitude: bank into turns, tip the thrust line into the motion.
function settleAttitude(s, bankTarget, dt) {
  springTo(s, 'bank', 'bankRate', bankTarget, dt);
  springTo(s, 'lean', 'leanRate', leanTarget(s), dt);
}

function stepFlight(dt) {
  const keys = readAxes();

  if (keys.reset) {
    suit = spawnState();
    localSensors.surface = undefined;
    trailClearNeeded = true;
    return;
  }

  const gloveOn = isGloveConnected();
  const glove = gloveOn ? readGloveAxes() : null;
  const input = gloveOn
    ? { throttle: glove.throttle, yaw: glove.yaw, climb: glove.climb, boost: keys.boost }
    : { throttle: keys.throttle, yaw: keys.yaw, climb: keys.climb, boost: keys.boost };
  const rollInput = gloveOn ? 0 : keys.roll;
  suit.mode = gloveOn ? 'GLOVE' : 'KEYBOARD';

  if (flySuit(suit, input, dt) && performance.now() >= boundaryWarnUntil) {
    boundaryWarnUntil = performance.now() + BOUNDARY_WARN_COOLDOWN_MS;
    setJarvis('Homewood perimeter engaged. Keeping you inside campus airspace, sir.');
  }

  let bankTarget = 0;
  if (gloveOn) {
    // The glove's roll already leans the suit (and camera) into its turns.
    suit.pitch = smooth(suit.pitch, glove.visualPitch, ANGLE_LERP, dt);
    suit.roll = smooth(suit.roll, glove.visualRoll, ANGLE_LERP, dt);
  } else {
    // HUD pitch: nose up while climbing, down while diving.
    suit.pitch = smooth(suit.pitch, input.climb * 18, ANGLE_LERP, dt);

    // Manual barrel roll (Q/E): rotate continuously while held (can go inverted
    // or all the way around), then auto-level back to upright when released.
    if (rollInput !== 0) {
      suit.roll = normalizeDeg(suit.roll + rollInput * ROLL_RATE * dt);
    } else {
      suit.roll = smooth(normalizeDeg(suit.roll), 0, ANGLE_LERP, dt);
    }

    bankTarget = coordinatedBank(suit, input.yaw);
  }
  settleAttitude(suit, bankTarget, dt);

  // "Still" = no control input and barely moving, so the suit can levitate.
  idle =
    input.throttle === 0 &&
    input.yaw === 0 &&
    input.climb === 0 &&
    rollInput === 0 &&
    !input.boost &&
    Math.abs(suit.speed) < HOVER_IDLE_SPEED &&
    Math.abs(suit.vspeed) < HOVER_IDLE_SPEED;
}

function triggerRepulsor(viewer) {
  flashRepulsor();
  setJarvis(pick(REPULSOR_LINES));

  if (repulsor) {
    viewer.entities.remove(repulsor.entity);
  }

  const born = performance.now();
  const entity = viewer.entities.add({
    position: new Cesium.CallbackProperty(() => {
      return Cesium.Cartesian3.fromDegrees(suit.longitude, suit.latitude, suit.altitude);
    }, false),
    ellipsoid: {
      radii: new Cesium.CallbackProperty(() => {
        const age = (performance.now() - born) / 1000;
        const s = 8 + Math.min(age, REPULSOR_LIFE) * 90;
        return new Cesium.Cartesian3(s, s, s);
      }, false),
      material: new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(() => {
          const age = (performance.now() - born) / 1000;
          const alpha = 0.5 * Math.max(0, 1 - age / REPULSOR_LIFE);
          return Cesium.Color.fromCssColorString('#37e7ff').withAlpha(alpha);
        }, false),
      ),
    },
  });
  repulsor = { entity, born };
}

function stepRepulsor(viewer, now) {
  if (!repulsor) return;
  if ((now - repulsor.born) / 1000 >= REPULSOR_LIFE) {
    viewer.entities.remove(repulsor.entity);
    repulsor = null;
  }
}

// A trustworthy surface sample under a suit, or undefined.
function sampleFloor(viewer, s) {
  const h = sampleSurfaceHeight(viewer, s.longitude, s.latitude, sensorExclude);
  // Ignore samples above us. They are normally an in-flight roof, but can
  // also be a newly streamed 3D-tile depth buffer from a different LOD.
  // Forward-ray collision handles actual buildings; accepting such a sample
  // as a floor would jerk the camera hundreds of metres in one frame.
  if (h === undefined || h > s.altitude + MAX_SURFACE_ABOVE_SUIT) return undefined;
  if (h < s.altitude - MAX_SURFACE_BELOW_SUIT) return undefined;
  return h;
}

// Keep a suit out of the ground and buildings. Contact costs momentum, never
// health. Returns true when the suit just bounced off a wall.
function collide(viewer, s, sensors, now, { surfaceMs = 50, forwardMs = 100 } = {}) {
  // 1) Dynamic floor: don't sink into the ground or a roof beneath us.
  // Sampling the mesh is a GPU read-back that stalls the frame, so refresh the
  // surface height a few times a second and reuse it in between — the floor
  // still clamps every frame against the cached value.
  if (now - sensors.sampledAt > surfaceMs) {
    sensors.sampledAt = now;
    const h = sampleFloor(viewer, s);
    if (h !== undefined) sensors.surface = h;
  }
  if (sensors.surface !== undefined) {
    const floor = sensors.surface + GROUND_CLEARANCE;
    if (s.altitude < floor) {
      s.altitude = floor;
      s.vspeed = Math.max(0, s.vspeed); // the floor stops the descent
      s.speed *= 0.5; // bleed momentum on contact
    }
  }

  // 2) Forward wall: catch flying into the side of a building (throttled).
  if (now - sensors.forwardAt <= forwardMs) return false;
  sensors.forwardAt = now;
  const lookAhead = Math.max(8, Math.abs(s.speed) * 0.2 + SUIT_RADIUS);
  const obstacle = forwardObstacle(viewer, s, lookAhead, sensorExclude);
  if (!obstacle || Math.abs(s.speed) <= 6 || now < sensors.bumpUntil) return false;
  sensors.bumpUntil = now + BUMP_COOLDOWN_MS;
  // Bounce back off the wall.
  s.speed = -Math.abs(s.speed) * 0.2;
  const headingRad = Cesium.Math.toRadians(s.heading);
  const latRad = Cesium.Math.toRadians(s.latitude);
  s.latitude -= (Math.cos(headingRad) * 3) / 111320;
  s.longitude -= (Math.sin(headingRad) * 3) / (111320 * Math.cos(latRad));
  return true;
}

// The player suit is rendered by the Three.js overlay (initSuitOverlay), not a
// Cesium entity. This builds the per-frame view that feeds it: the idle
// levitation sway on top of the (already spring-damped) attitude, plus the
// normalized flight state that poses the rig and throttles its jets.
function suitView(s) {
  const swayRoll = Math.sin(hoverClock * 1.3) * HOVER_SWAY_ROLL * hoverBlend;
  const swayPitch = Math.sin(hoverClock * 1.7 + 1.0) * HOVER_SWAY_PITCH * hoverBlend;
  return {
    ...s,
    swayRoll,
    swayPitch,
    thrust: thrustDrivers(s),
  };
}

// Normalized drivers for the rig's flight poses and jets.
function thrustDrivers(s) {
  return {
    forward: s.speed / MAX_SPEED, // 1 = cruise, up to BOOST_MULT, < 0 reversing
    climb: s.vspeed / CLIMB_RATE, // -1 dive .. 1 climb
    accel: Math.max(-1, Math.min(1, s.accel / ACCEL_REF)),
    turn: s.turn, // -1 left .. 1 right
  };
}

// ---- Remote pilots ----
// Everyone who isn't us, e.g. the judge on the phone controller. Each gets a
// full animated suit and comes in one of two kinds:
//   'sim'   — a phone in CONTROL_MODE sends only its control inputs, and we
//             fly its suit here with the same flight model as ours. Motion is
//             smooth however sparse the updates are, and the judge obeys the
//             campus perimeter and building collisions.
//   'track' — anything streaming its own positions (e.g. another laptop):
//             we dead-reckon between its updates and read the flight state the
//             rig needs back off the drawn track.

const pilots = new Map(); // player_id -> pilot
let povId = null; // null = our own suit; else the id of the pilot we're watching

function displayName(id) {
  return id.toUpperCase();
}

// Floating name tag over a suit. `getView` returns the suit's current view.
function makeNameTag(viewer, text, color, getView) {
  return viewer.entities.add({
    name: `IRON GLOVE — ${text}`,
    position: new Cesium.CallbackProperty((_time, result) => {
      const v = getView();
      return Cesium.Cartesian3.fromDegrees(
        v.longitude,
        v.latitude,
        v.altitude + (v.hover || 0) + LABEL_HEIGHT,
        Cesium.Ellipsoid.WGS84,
        result,
      );
    }, false),
    label: {
      text,
      font: '12px monospace',
      fillColor: Cesium.Color.fromCssColorString(color),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#0a0e17').withAlpha(0.6),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

function createPilot(viewer, overlay, id) {
  const pilot = {
    id,
    name: displayName(id),
    kind: 'track',
    mode: 'PHONE',
    health: 100,
    lastLiveAt: -Infinity, // when the row last changed on the server
    active: false,
    state: null, // flight state drawn this frame (flown or tracked)
    view: null, // view handed to the suit this frame
    sensors: sensorState(), // collisions for 'sim'; AGL readout while watched
    // 'sim': the phone's latest control inputs.
    controls: { throttle: 0, yaw: 0, climb: 0, boost: false },
    hoverBlend: 0,
    // 'track': newest sample from the stream and the velocity between samples.
    sample: null,
    velocity: null,
    suit3d: overlay.createSuit({ name: id, jets: 'amber' }),
    trail: initTrail(viewer, { cool: '#ffb020', hot: '#ff4b2e' }),
    trailOrigin: new Cesium.Cartesian3(),
  };
  pilot.suit3d.setVisible(false);
  pilot.tag = makeNameTag(viewer, pilot.name, '#ffb020', () => pilot.view ?? suit);
  pilot.tag.show = false;
  sensorExclude.push(pilot.trail.entity, pilot.tag);
  return pilot;
}

function clampAxis(v) {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

function receivePilotRow(pilot, row, live) {
  const kind = row.mode === CONTROL_MODE ? 'sim' : 'track';
  if (kind !== pilot.kind) {
    // Switched protocols (e.g. an old phone page reloaded): start over.
    pilot.kind = kind;
    pilot.state = null;
    pilot.sample = null;
    pilot.velocity = null;
  }
  pilot.mode = kind === 'sim' ? 'PHONE' : row.mode;
  pilot.health = row.suitHealth;

  if (kind === 'sim') {
    pilot.controls = {
      throttle: clampAxis(row.pitch),
      yaw: clampAxis(row.roll),
      climb: clampAxis(row.yaw),
      boost: row.positionX > 0.5,
    };
  } else {
    const sample = {
      longitude: row.positionX,
      altitude: row.positionY,
      latitude: row.positionZ,
      heading: row.yaw,
      at: Number(row.updatedAt.toMillis()), // server clock
      receivedAt: performance.now(),
    };
    const prev = pilot.sample;
    if (prev && live && sample.at > prev.at) {
      // Velocity between consecutive samples, timed by the server's clock so
      // network jitter doesn't skew it.
      const s = (sample.at - prev.at) / 1000;
      pilot.velocity = {
        longitude: (sample.longitude - prev.longitude) / s,
        latitude: (sample.latitude - prev.latitude) / s,
        altitude: (sample.altitude - prev.altitude) / s,
        heading: normalizeDeg(sample.heading - prev.heading) / s,
      };
    }
    pilot.sample = sample;
  }
  if (live) pilot.lastLiveAt = performance.now();
}

function removePilot(viewer, pilot) {
  pilot.suit3d.dispose();
  pilot.trail.destroy();
  viewer.entities.remove(pilot.tag);
  for (const o of [pilot.trail.entity, pilot.tag]) {
    const i = sensorExclude.indexOf(o);
    if (i >= 0) sensorExclude.splice(i, 1);
  }
  pilots.delete(pilot.id);
}

// Where a phone pilot appears: beside us, facing our way, so both suits are in
// shot. Falls back to our other side, then our own spot, near the perimeter.
function wingmanSpawn() {
  const headingRad = Cesium.Math.toRadians(suit.heading);
  const metresPerLon = 111320 * Math.cos(Cesium.Math.toRadians(suit.latitude));
  for (const side of [1, -1, 0]) {
    const right = WINGMAN_OFFSET * side; // right of our heading: (east, north) = (cos h, -sin h)
    const longitude = suit.longitude + (Math.cos(headingRad) * right) / metresPerLon;
    const latitude = suit.latitude - (Math.sin(headingRad) * right) / 111320;
    if (side === 0 || !homewoodBoundary || homewoodBoundary.contains(longitude, latitude)) {
      return flightState({ longitude, latitude, altitude: suit.altitude, heading: suit.heading });
    }
  }
}

// Fly a phone pilot's suit from its latest control inputs.
function flyPilot(viewer, pilot, dt, now) {
  const s = pilot.state;
  const c = pilot.controls;
  flySuit(s, c, dt);
  s.pitch = smooth(s.pitch, c.climb * 18, ANGLE_LERP, dt);
  settleAttitude(s, coordinatedBank(s, c.yaw), dt);
  collide(viewer, s, pilot.sensors, now, REMOTE_SENSORS);

  // Parked: the same idle levitation as ours, a beat out of phase.
  const still =
    !c.throttle && !c.yaw && !c.climb && !c.boost &&
    Math.abs(s.speed) < HOVER_IDLE_SPEED &&
    Math.abs(s.vspeed) < HOVER_IDLE_SPEED;
  pilot.hoverBlend = smooth(pilot.hoverBlend, still ? 1 : 0, 0.05, dt);
  s.hover = Math.sin(hoverClock * HOVER_OMEGA + 1.7) * HOVER_AMP * pilot.hoverBlend;
}

// Follow a position stream: dead-reckon the newest sample forward along its
// velocity until the next one arrives, ease toward that, and read the motion
// the rig needs back off the drawn track.
function trackPilot(pilot, dt, now) {
  const s = pilot.state;
  const sample = pilot.sample;
  const v = pilot.velocity;
  const lead = v ? Math.min(TRACK_MAX_LEAD_S, (now - sample.receivedAt) / 1000) : 0;
  const from = { longitude: s.longitude, latitude: s.latitude, altitude: s.altitude, heading: s.heading };
  const k = 1 - Math.pow(1 - NET_LERP, dt * 60);
  s.longitude = lerp(s.longitude, sample.longitude + (v ? v.longitude * lead : 0), k);
  s.latitude = lerp(s.latitude, sample.latitude + (v ? v.latitude * lead : 0), k);
  s.altitude = lerp(s.altitude, sample.altitude + (v ? v.altitude * lead : 0), k);
  s.heading = easeHeading(s.heading, sample.heading + (v ? v.heading * lead : 0), k);

  if (dt > 0) {
    const north = (s.latitude - from.latitude) * 111320;
    const east = (s.longitude - from.longitude) * 111320 * Math.cos(Cesium.Math.toRadians(s.latitude));
    const headingRad = Cesium.Math.toRadians(s.heading);
    const forward = (north * Math.cos(headingRad) + east * Math.sin(headingRad)) / dt;
    const yawRate = normalizeDeg(s.heading - from.heading) / dt;
    const previousSpeed = s.speed;
    s.speed = smooth(s.speed, forward, MOTION_LERP, dt);
    s.vspeed = smooth(s.vspeed, (s.altitude - from.altitude) / dt, MOTION_LERP, dt);
    s.accel = smooth(s.accel, (s.speed - previousSpeed) / dt, ACCEL_LERP, dt);
    s.turn = smooth(s.turn, clampAxis(yawRate / YAW_RATE), ANGLE_LERP, dt);
    s.pitch = (s.vspeed / CLIMB_RATE) * 18;
    settleAttitude(s, coordinatedBank(s, s.turn), dt);
  }
}

// Advance one remote pilot and pose its suit. Returns true if it just came
// online or dropped off, so the caller can update the POV controls.
function stepPilot(viewer, pilot, dt, now) {
  const wasActive = pilot.active;
  pilot.active =
    now - pilot.lastLiveAt < PILOT_ACTIVE_MS && (pilot.kind === 'sim' || Boolean(pilot.sample));
  if (!pilot.active) {
    pilot.suit3d.setVisible(false);
    pilot.tag.show = false;
    pilot.trail.decay();
    return wasActive;
  }

  if (!wasActive || !pilot.state) {
    // (Re)appearing, at rest: phones beside us, streams at their reported spot.
    pilot.state = pilot.kind === 'sim' ? wingmanSpawn() : flightState(pilot.sample);
    pilot.sensors = sensorState();
    pilot.hoverBlend = 0;
    pilot.trail.clear();
  }
  if (pilot.kind === 'sim') flyPilot(viewer, pilot, dt, now);
  else trackPilot(pilot, dt, now);

  const s = pilot.state;
  pilot.view = { ...s, roll: 0, thrust: thrustDrivers(s) };
  pilot.suit3d.setVisible(true);
  pilot.suit3d.setTransform(pilot.view);
  pilot.tag.show = true;

  if (Math.abs(s.speed) > 2) {
    const origin = pilot.suit3d.bootAnchor(pilot.trailOrigin);
    if (origin) pilot.trail.push(origin, Math.min(1, Math.abs(s.speed) / FX_FULL_SPEED));
  } else {
    pilot.trail.decay();
  }
  return !wasActive;
}

function activePilots() {
  return [...pilots.values()].filter((p) => p.active);
}

// Straight-line distance between two suits in metres (flat earth is plenty at
// campus scale).
function metresApart(a, b) {
  const north = (b.latitude - a.latitude) * 111320;
  const east = (b.longitude - a.longitude) * 111320 * Math.cos(Cesium.Math.toRadians(a.latitude));
  return Math.hypot(north, east, b.altitude - a.altitude);
}

// What the blue tracker points at: from our suit, the nearest airborne pilot
// (the friend on the phone); from a pilot we're watching, back at us.
function trackerTarget(watched, localView) {
  if (watched) return { name: displayName(PLAYER_ID), view: localView };
  let nearest = null;
  let nearestM = Infinity;
  for (const pilot of pilots.values()) {
    if (!pilot.active) continue;
    const m = metresApart(localView, pilot.view);
    if (m < nearestM) {
      nearestM = m;
      nearest = pilot;
    }
  }
  return nearest && { name: nearest.name, view: nearest.view };
}

// Refresh the POV readout and the switch button (visible only while another
// pilot is airborne, labelled with the suit it would switch to).
function refreshPov(attention = false) {
  const ids = [null, ...activePilots().map((p) => p.id)];
  const next = ids[(ids.indexOf(povId) + 1) % ids.length];
  setPov(displayName(povId ?? PLAYER_ID));
  setPovButton(ids.length > 1, displayName(next ?? PLAYER_ID), attention);
}

// Cycle the chase camera: our suit -> each airborne pilot -> back to ours.
function cyclePov() {
  const ids = [null, ...activePilots().map((p) => p.id)];
  if (ids.length < 2 && povId === null) return;
  povId = ids[(ids.indexOf(povId) + 1) % ids.length];
  setJarvis(
    povId
      ? `Patching you into ${displayName(povId)}'s suit cam, sir.`
      : 'Back on your suit, sir.',
  );
  refreshPov();
}

async function boot() {
  initHUD();
  initAttitude();
  initKeyboard();

  setGloveButton(false, hasWebSerial());
  setInputHint('KEYBOARD');
  setGloveConnectionHandler((ok) => {
    suit.mode = ok ? 'GLOVE' : 'KEYBOARD';
    setGloveButton(ok, true);
    setInputHint(suit.mode);
    setJarvis(
      ok
        ? 'Glove uplink established. Hand control is yours, sir.'
        : 'Glove uplink lost. Reverting to keyboard, sir.',
    );
  });
  onConnectGlove(() => {
    if (isGloveConnected()) return;
    connectGlove();
  });

  if (!hasValidToken()) {
    showBanner(
      `<b>Cesium Ion token required.</b><br><br>` +
        `Paste your token into <code>client/.env</code>:<br>` +
        `<code>VITE_CESIUM_TOKEN=&lt;your token&gt;</code><br><br>` +
        `Get a free token at <code>ion.cesium.com/tokens</code>, then restart the dev server.`,
      true,
    );
    return;
  }

  let viewer;
  try {
    viewer = await initWorld();
  } catch (err) {
    console.error(err);
    showBanner(
      `<b>Failed to load the world.</b><br><br>` +
        `This usually means the Cesium token is invalid or lacks 3D Tiles access.<br>` +
        `<code>${String(err.message || err)}</code>`,
      true,
    );
    return;
  }

  hideBanner();

  const quality = getRenderQuality();
  const gpuShort =
    quality.gpu.match(/(?:GeForce |Radeon )?(?:RTX|GTX|RX|Arc)\s?\w+|Radeon[^(,]*|Iris[^(,]*|UHD[^(,]*/i)?.[0].trim() ??
    'GPU';
  setGfx(`${quality.label} · ${gpuShort}`, quality.gpu);

  homewoodBoundary = initHomewoodBoundary(viewer);
  const overlay = initSuitOverlay(viewer, '/iron_man_ucm.glb');
  const suit3d = overlay.createSuit({ name: PLAYER_ID });
  const tracker = createTracker(overlay);
  const trail = initTrail(viewer);
  const trailOrigin = new Cesium.Cartesian3();
  updateChaseCamera(viewer, suit);

  // Our own name tag only shows while the camera is on another pilot.
  let localView = suitView(suit);
  const localTag = makeNameTag(viewer, displayName(PLAYER_ID), '#37e7ff', () => localView);
  localTag.show = false;
  sensorExclude.push(trail.entity, localTag);

  // Camera POV switch: V, or the HUD button that appears once another pilot
  // is airborne.
  refreshPov();
  onPovButton(cyclePov);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyV' && !e.repeat) cyclePov();
  });

  function upsertPilot(row, live) {
    let pilot = pilots.get(row.playerId);
    if (!pilot) {
      pilot = createPilot(viewer, overlay, row.playerId);
      pilots.set(row.playerId, pilot);
    }
    receivePilotRow(pilot, row, live);
  }

  function dropPilot(playerId) {
    const pilot = pilots.get(playerId);
    if (!pilot) return;
    removePilot(viewer, pilot);
    if (povId === playerId) povId = null;
    refreshPov();
  }

  // Dev: feed a player_state-shaped row as if it came from SpacetimeDB, to
  // exercise remote suits and the POV switch without a phone.
  if (import.meta.env.DEV) {
    window.__pilots = pilots;
    window.__pilotRow = (row, live = true) => upsertPilot(row, live);
  }

  // SpacetimeDB link: mirror the client-computed transform into the DB and
  // render the suit from the row we read back. Fails soft — if the module is
  // unreachable the game keeps flying on local physics.
  setNet('CONNECTING');
  stdb = createStdbClient({
    playerId: PLAYER_ID,
    mode: suit.mode,
    onStatus: (s) => {
      setNet(s.toUpperCase());
      if (s === 'online') {
        setJarvis('SpacetimeDB link established. Telemetry streaming, sir.');
        console.log('[stdb] online — join_game sent, streaming update_orientation');
      } else if (s === 'offline' || s === 'error') {
        console.warn(`[stdb] link ${s} — flying on local physics only`);
      }
    },
    onPlayer: (row, live) => {
      // Our own row confirms the telemetry round-trip. It must not drive the
      // local chase camera: that row only arrives at NET_SEND_HZ, while the
      // local simulation runs every frame. All other rows are remote pilots.
      if (row.playerId !== PLAYER_ID) upsertPilot(row, live);
    },
    onPlayerLeave: (row) => dropPilot(row.playerId),
  });
  stdb.start();

  // Game loop.
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1; // clamp after tab-out

    stepFlight(dt);
    if (collide(viewer, suit, localSensors, now)) setJarvis(pick(JARVIS_LINES.bump));
    if (isGloveConnected() && consumeFist()) {
      triggerRepulsor(viewer);
    }
    stepRepulsor(viewer, now);

    if (trailClearNeeded) {
      trail.clear();
      trailClearNeeded = false;
    }

    // Idle levitation: ease the bob in when still, out when flying.
    hoverClock += dt;
    hoverBlend = smooth(hoverBlend, idle ? 1 : 0, 0.05, dt);
    suit.hover = Math.sin(hoverClock * HOVER_OMEGA) * HOVER_AMP * hoverBlend;

    // --- SpacetimeDB round-trip ---
    // Push our client-computed transform (throttled to NET_SEND_HZ), then let
    // the subscription hand the row back via onPlayer -> `net`.
    if (stdb && now - lastNetSendAt >= NET_SEND_MS) {
      lastNetSendAt = now;
      stdb.pushTransform({
        positionX: suit.longitude,
        positionY: suit.altitude,
        positionZ: suit.latitude,
        pitch: suit.pitch,
        roll: suit.roll,
        yaw: suit.heading,
        mode: suit.mode,
      });
    }

    // The local player is always rendered from the immediate client state.
    // Networking continues to replicate it, but no server tick can pull the
    // hero suit or its camera backwards between visual frames.
    const view = suitView(suit);
    localView = view;
    suit3d.setTransform(view);

    // Remote pilots (the judge): interpolate, animate, and announce arrivals.
    for (const pilot of pilots.values()) {
      if (!stepPilot(viewer, pilot, dt, now)) continue;
      if (pilot.active) {
        setJarvis(JARVIS_LINES.pilotJoined(pilot.name));
        refreshPov(true);
      } else {
        if (povId === pilot.id) {
          povId = null;
          setJarvis(JARVIS_LINES.povLost(pilot.name));
        } else {
          setJarvis(JARVIS_LINES.pilotLeft(pilot.name));
        }
        refreshPov();
      }
    }

    // The chase camera follows whichever pilot we're watching.
    const watched = povId ? pilots.get(povId) : null;
    updateChaseCamera(viewer, watched ? watched.view : view);
    localTag.show = Boolean(watched);
    // The blue tracker rides that same suit and points at the other pilot.
    tracker.update(watched ? watched.view : view, trackerTarget(watched, view), dt);

    // Speed-driven feel: FOV punch, edge blur, and vignette all ramp together.
    const viewSpeed = watched ? watched.state.speed : suit.speed;
    const speedRatio = Math.min(1, Math.abs(viewSpeed) / FX_FULL_SPEED);
    if (viewer.camera.frustum.fov !== undefined) {
      viewer.camera.frustum.fov = Cesium.Math.toRadians(
        BASE_FOV_DEG + speedRatio * SPEED_FOV_DEG,
      );
    }
    updateSpeedFx(speedRatio);

    // Afterburner trail: extend it while flying, let it drain when parked.
    // It streams from the boot jets, wherever the posed legs put them.
    if (Math.abs(suit.speed) > 2) {
      const origin =
        suit3d.bootAnchor(trailOrigin) ??
        Cesium.Cartesian3.fromDegrees(
          suit.longitude,
          suit.latitude,
          suit.altitude,
          Cesium.Ellipsoid.WGS84,
          trailOrigin,
        );
      trail.push(origin, Math.min(1, Math.abs(suit.speed) / FX_FULL_SPEED));
    } else {
      trail.decay();
    }

    if (watched) {
      // Telemetry for the pilot on camera. A phone pilot's collision sensors
      // already know its ground height; a position stream's is sampled only
      // while we watch it, at a low rate (it's a GPU read-back).
      const w = watched.state;
      const sensors = watched.sensors;
      if (watched.kind === 'track' && now - sensors.sampledAt > REMOTE_SURFACE_MS) {
        sensors.sampledAt = now;
        const h = sampleFloor(viewer, w);
        if (h !== undefined) sensors.surface = h;
      }
      updateAttitude(w.pitch, w.bank, w.heading);
      setGpws(false);
      updateHUD({
        altitude: sensors.surface !== undefined ? Math.max(0, w.altitude - sensors.surface) : w.altitude,
        speed: Math.abs(w.speed),
        pitch: w.pitch,
        roll: w.bank,
        heading: w.heading,
        mode: watched.mode,
        health: watched.health,
      });
    } else {
      // Show height above the ground/rooftops (AGL) when we know the surface.
      const surface = localSensors.surface;
      const agl = surface !== undefined ? Math.max(0, suit.altitude - surface) : suit.altitude;

      // Animated attitude indicator + heading tape.
      updateAttitude(suit.pitch, suit.roll + suit.bank, suit.heading);

      // Ground proximity warning: flash when low.
      setGpws(agl < GPWS_ALT);

      updateHUD({
        altitude: agl,
        speed: Math.abs(suit.speed),
        pitch: suit.pitch,
        roll: suit.roll,
        heading: suit.heading,
        mode: suit.mode,
        health: suit.health,
      });
    }

    // Present both WebGL layers from this single frame. Cesium goes first and
    // the camera-relative Three suits are composited immediately after it.
    viewer.resize();
    viewer.render();
    overlay.render();

    if (import.meta.env.DEV) window.__suitView = view;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
