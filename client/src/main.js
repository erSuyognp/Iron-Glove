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
const NET_SEND_HZ = 30; // how often we push our transform to the server
const NET_SEND_MS = 1000 / NET_SEND_HZ;
// Render-smoothing for remote pilot snapshots. This is net interpolation, not
// physics; the local pilot always renders directly from its 60 fps simulation.
const NET_LERP = 0.5;
// A remote pilot is live while its row keeps updating (the phone streams at
// ~30 Hz). Rows that only arrive with the initial subscription are leftovers
// from an earlier session and never spawn a suit.
const PILOT_ACTIVE_MS = 3000;
const MOTION_LERP = 0.15; // smoothing for velocities read off a remote track
const REMOTE_SURFACE_MS = 250; // AGL sampling under a remote pilot we're watching
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
function spawnState() {
  return {
    longitude: JHU_HOMEWOOD.longitude,
    latitude: JHU_HOMEWOOD.latitude,
    altitude: JHU_HOMEWOOD.altitude,
    heading: 0, // degrees, 0 = north
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
    health: 100,
    mode: isGloveConnected() ? 'GLOVE' : 'KEYBOARD',
  };
}

let suit = spawnState();
let repulsor = null; // { entity, born } — fist-clench blast visual

// Collision bookkeeping.
let lastSurface; // last sampled surface height under the suit
let bumpCooldownUntil = 0;
let lastForwardCheck = 0;
let lastSurfaceSampleAt = 0; // throttle GPU height reads
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

function stepFlight(dt) {
  const keys = readAxes();

  if (keys.reset) {
    suit = spawnState();
    lastSurface = undefined;
    trailClearNeeded = true;
    return;
  }

  const gloveOn = isGloveConnected();
  let throttle;
  let yaw;
  let climb;
  let rollInput;
  let boost;

  if (gloveOn) {
    const g = readGloveAxes();
    throttle = g.throttle;
    climb = g.climb;
    yaw = g.yaw;
    rollInput = 0;
    boost = keys.boost;
    suit.mode = 'GLOVE';
  } else {
    throttle = keys.throttle;
    yaw = keys.yaw;
    climb = keys.climb;
    rollInput = keys.roll;
    boost = keys.boost;
    suit.mode = 'KEYBOARD';
  }

  // Target forward speed from throttle (+ optional boost).
  // SPEED_LERP 0.08 is the suit's spring-damper — do not crank this up.
  const targetSpeed = throttle * MAX_SPEED * (boost ? BOOST_MULT : 1);
  const previousSpeed = suit.speed;
  suit.speed = smooth(suit.speed, targetSpeed, SPEED_LERP, dt);
  // Animation drivers: how hard the suit is accelerating and turning.
  if (dt > 0) suit.accel = smooth(suit.accel, (suit.speed - previousSpeed) / dt, ACCEL_LERP, dt);
  suit.turn = smooth(suit.turn, yaw, ANGLE_LERP, dt);

  // Yaw turns the suit; scale by dt so it's framerate-independent.
  suit.heading = (suit.heading + yaw * YAW_RATE * dt + 360) % 360;

  // Climb / dive. Vertical speed eases through the same spring as forward
  // speed, so the suit carries its weight on every axis and the body can lean
  // along a real flight path rather than a key state.
  suit.vspeed = smooth(suit.vspeed, climb * CLIMB_RATE, SPEED_LERP, dt);
  suit.altitude += suit.vspeed * dt;
  if (suit.altitude < MIN_ALT || suit.altitude > MAX_ALT) {
    suit.altitude = Math.min(MAX_ALT, Math.max(MIN_ALT, suit.altitude));
    suit.vspeed = 0;
  }

  // Advance position along heading over the ground.
  const previousLongitude = suit.longitude;
  const previousLatitude = suit.latitude;
  const dist = suit.speed * dt; // meters this frame
  const headingRad = Cesium.Math.toRadians(suit.heading);
  const dNorth = Math.cos(headingRad) * dist;
  const dEast = Math.sin(headingRad) * dist;
  const latRad = Cesium.Math.toRadians(suit.latitude);
  suit.latitude += dNorth / 111320;
  suit.longitude += dEast / (111320 * Math.cos(latRad));

  // Homewood is the complete playable world: the holographic perimeter is
  // visible at the edge of campus, and this constraint makes it a real flight
  // barrier at every altitude instead of just decorative geometry.
  if (homewoodBoundary) {
    const confined = homewoodBoundary.confine(
      previousLongitude,
      previousLatitude,
      suit.longitude,
      suit.latitude,
    );
    if (confined.blocked) {
      suit.longitude = confined.longitude;
      suit.latitude = confined.latitude;
      suit.speed *= 0.18;
      if (performance.now() >= boundaryWarnUntil) {
        boundaryWarnUntil = performance.now() + BOUNDARY_WARN_COOLDOWN_MS;
        setJarvis('Homewood perimeter engaged. Keeping you inside campus airspace, sir.');
      }
    }
  }

  let bankTarget = 0;
  if (gloveOn) {
    // The glove's roll already leans the suit (and camera) into its turns.
    const g = readGloveAxes();
    suit.pitch = smooth(suit.pitch, g.visualPitch, ANGLE_LERP, dt);
    suit.roll = smooth(suit.roll, g.visualRoll, ANGLE_LERP, dt);
  } else {
    // HUD pitch: nose up while climbing, down while diving.
    suit.pitch = smooth(suit.pitch, climb * 18, ANGLE_LERP, dt);

    // Manual barrel roll (Q/E): rotate continuously while held (can go inverted
    // or all the way around), then auto-level back to upright when released.
    if (rollInput !== 0) {
      suit.roll = normalizeDeg(suit.roll + rollInput * ROLL_RATE * dt);
    } else {
      suit.roll = smooth(normalizeDeg(suit.roll), 0, ANGLE_LERP, dt);
    }

    // Auto-bank into turns (mesh only, so the camera isn't yanked sideways).
    // Positive yaw turns right and positive roll drops the right side.
    bankTarget = yaw * Math.min(MAX_BANK, BANK_HOVER + Math.abs(suit.speed) * BANK_PER_MS);
  }
  springTo(suit, 'bank', 'bankRate', bankTarget, dt);
  springTo(suit, 'lean', 'leanRate', leanTarget(suit), dt);

  // "Still" = no control input and barely moving, so the suit can levitate.
  idle =
    throttle === 0 &&
    yaw === 0 &&
    climb === 0 &&
    rollInput === 0 &&
    !boost &&
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

// A wall contact costs momentum, never health. Returns true when a bounce
// should happen (i.e. not within the cooldown of the previous one).
function bump() {
  const now = performance.now();
  if (now < bumpCooldownUntil) return false;
  bumpCooldownUntil = now + BUMP_COOLDOWN_MS;
  setJarvis(pick(JARVIS_LINES.bump));
  return true;
}

function collisionStep(viewer) {
  // The suit is now an overlay canvas, not a Cesium entity, so there's nothing
  // in the scene to exclude from the height/obstacle sensors.
  const exclude = [];
  const now = performance.now();

  // 1) Dynamic floor: don't sink into the ground or a roof beneath us.
  // Sampling the mesh is a GPU read-back that stalls the frame, so refresh the
  // surface height ~20x/sec and reuse it in between — the floor still clamps
  // every frame against the cached value.
  if (now - lastSurfaceSampleAt > 50) {
    lastSurfaceSampleAt = now;
    const s = sampleSurfaceHeight(viewer, suit.longitude, suit.latitude, exclude);
    // Ignore samples above us. They are normally an in-flight roof, but can
    // also be a newly streamed 3D-tile depth buffer from a different LOD.
    // Forward-ray collision handles actual buildings; accepting such a sample
    // as a floor would jerk the camera hundreds of metres in one frame.
    if (
      s !== undefined &&
      s <= suit.altitude + MAX_SURFACE_ABOVE_SUIT &&
      s >= suit.altitude - MAX_SURFACE_BELOW_SUIT
    ) {
      lastSurface = s;
    }
  }
  if (lastSurface !== undefined) {
    const floor = lastSurface + GROUND_CLEARANCE;
    if (suit.altitude < floor) {
      suit.altitude = floor;
      suit.vspeed = Math.max(0, suit.vspeed); // the floor stops the descent
      suit.speed *= 0.5; // bleed momentum on contact
    }
  }

  // 2) Forward wall: catch flying into the side of a building (throttled).
  if (now - lastForwardCheck > 100) {
    lastForwardCheck = now;
    const lookAhead = Math.max(8, Math.abs(suit.speed) * 0.2 + SUIT_RADIUS);
    const obstacle = forwardObstacle(viewer, suit, lookAhead, exclude);
    if (obstacle && Math.abs(suit.speed) > 6) {
      if (bump()) {
        // Bounce back off the wall.
        suit.speed = -Math.abs(suit.speed) * 0.2;
        const headingRad = Cesium.Math.toRadians(suit.heading);
        const latRad = Cesium.Math.toRadians(suit.latitude);
        suit.latitude -= (Math.cos(headingRad) * 3) / 111320;
        suit.longitude -= (Math.sin(headingRad) * 3) / (111320 * Math.cos(latRad));
      }
    }
  }
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
// full animated suit. The phone only streams position and heading, so the
// flight state the rig needs (speed, climb, acceleration, turn, lean, bank) is
// read back off the interpolated track with the same attitude model as ours.

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
    mode: 'PHONE',
    health: 100,
    target: null, // newest transform from the DB
    render: null, // eased transform actually drawn
    view: null, // view handed to the suit this frame
    flight: { speed: 0, vspeed: 0, accel: 0, turn: 0, lean: 0, leanRate: 0, bank: 0, bankRate: 0 },
    lastLiveAt: -Infinity, // when the row last changed on the server
    active: false,
    surface: undefined, // ground height under the pilot, sampled while watched
    surfaceSampledAt: 0,
    suit3d: overlay.createSuit({ name: id, jets: 'amber' }),
    trail: initTrail(viewer, { cool: '#ffb020', hot: '#ff4b2e' }),
    trailOrigin: new Cesium.Cartesian3(),
  };
  pilot.suit3d.setVisible(false);
  pilot.tag = makeNameTag(viewer, pilot.name, '#ffb020', () => pilot.view ?? pilot.render);
  pilot.tag.show = false;
  return pilot;
}

function receivePilotRow(pilot, row, live) {
  pilot.target = {
    longitude: row.positionX,
    altitude: row.positionY,
    latitude: row.positionZ,
    heading: row.yaw,
  };
  pilot.mode = row.mode;
  pilot.health = row.suitHealth;
  if (live) pilot.lastLiveAt = performance.now();
}

function removePilot(viewer, pilot) {
  pilot.suit3d.dispose();
  pilot.trail.destroy();
  viewer.entities.remove(pilot.tag);
  pilots.delete(pilot.id);
}

// Advance one remote pilot: ease toward the newest snapshot, read its motion
// off the drawn track, and pose its suit. Returns true if it just came online
// or dropped off, so the caller can update the POV controls.
function stepPilot(pilot, dt, now) {
  const wasActive = pilot.active;
  pilot.active = Boolean(pilot.target) && now - pilot.lastLiveAt < PILOT_ACTIVE_MS;
  if (!pilot.active) {
    pilot.suit3d.setVisible(false);
    pilot.tag.show = false;
    pilot.trail.decay();
    return wasActive;
  }

  const f = pilot.flight;
  if (!wasActive || !pilot.render) {
    // (Re)appearing: start exactly at the reported spot, at rest.
    pilot.render = { ...pilot.target };
    Object.assign(f, { speed: 0, vspeed: 0, accel: 0, turn: 0, lean: 0, leanRate: 0, bank: 0, bankRate: 0 });
    pilot.trail.clear();
  }

  // Snapshot interpolation from the ~30 Hz stream to the frame rate.
  const r = pilot.render;
  const from = { longitude: r.longitude, latitude: r.latitude, altitude: r.altitude, heading: r.heading };
  const k = 1 - Math.pow(1 - NET_LERP, dt * 60);
  r.longitude = lerp(r.longitude, pilot.target.longitude, k);
  r.latitude = lerp(r.latitude, pilot.target.latitude, k);
  r.altitude = lerp(r.altitude, pilot.target.altitude, k);
  r.heading = easeHeading(r.heading, pilot.target.heading, k);

  if (dt > 0) {
    const north = (r.latitude - from.latitude) * 111320;
    const east = (r.longitude - from.longitude) * 111320 * Math.cos(Cesium.Math.toRadians(r.latitude));
    const headingRad = Cesium.Math.toRadians(r.heading);
    const forward = (north * Math.cos(headingRad) + east * Math.sin(headingRad)) / dt;
    const yawRate = normalizeDeg(r.heading - from.heading) / dt;
    const previousSpeed = f.speed;
    f.speed = smooth(f.speed, forward, MOTION_LERP, dt);
    f.vspeed = smooth(f.vspeed, (r.altitude - from.altitude) / dt, MOTION_LERP, dt);
    f.accel = smooth(f.accel, (f.speed - previousSpeed) / dt, ACCEL_LERP, dt);
    f.turn = smooth(f.turn, Math.max(-1, Math.min(1, yawRate / YAW_RATE)), ANGLE_LERP, dt);
    springTo(f, 'lean', 'leanRate', leanTarget(f), dt);
    const bankTarget = f.turn * Math.min(MAX_BANK, BANK_HOVER + Math.abs(f.speed) * BANK_PER_MS);
    springTo(f, 'bank', 'bankRate', bankTarget, dt);
  }

  pilot.view = {
    longitude: r.longitude,
    latitude: r.latitude,
    altitude: r.altitude,
    heading: r.heading,
    lean: f.lean,
    bank: f.bank,
    roll: 0,
    hover: 0,
    thrust: thrustDrivers(f),
  };
  pilot.suit3d.setVisible(true);
  pilot.suit3d.setTransform(pilot.view);
  pilot.tag.show = true;

  if (Math.abs(f.speed) > 2) {
    const origin = pilot.suit3d.bootAnchor(pilot.trailOrigin);
    if (origin) pilot.trail.push(origin, Math.min(1, Math.abs(f.speed) / FX_FULL_SPEED));
  } else {
    pilot.trail.decay();
  }
  return !wasActive;
}

function activePilots() {
  return [...pilots.values()].filter((p) => p.active);
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
  const trail = initTrail(viewer);
  const trailOrigin = new Cesium.Cartesian3();
  updateChaseCamera(viewer, suit);

  // Our own name tag only shows while the camera is on another pilot.
  let localView = suitView(suit);
  const localTag = makeNameTag(viewer, displayName(PLAYER_ID), '#37e7ff', () => localView);
  localTag.show = false;

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
    collisionStep(viewer);
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
      if (!stepPilot(pilot, dt, now)) continue;
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

    // Speed-driven feel: FOV punch, edge blur, and vignette all ramp together.
    const viewSpeed = watched ? watched.flight.speed : suit.speed;
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
      // Telemetry for the pilot on camera. Their ground height is sampled only
      // while we watch them, and at a low rate (it's a GPU read-back).
      const w = watched.view;
      if (now - watched.surfaceSampledAt > REMOTE_SURFACE_MS) {
        watched.surfaceSampledAt = now;
        const s = sampleSurfaceHeight(viewer, w.longitude, w.latitude, []);
        if (
          s !== undefined &&
          s <= w.altitude + MAX_SURFACE_ABOVE_SUIT &&
          s >= w.altitude - MAX_SURFACE_BELOW_SUIT
        ) {
          watched.surface = s;
        }
      }
      const pitch = (watched.flight.vspeed / CLIMB_RATE) * 18;
      updateAttitude(pitch, watched.flight.bank, w.heading);
      setGpws(false);
      updateHUD({
        altitude:
          watched.surface !== undefined ? Math.max(0, w.altitude - watched.surface) : w.altitude,
        speed: Math.abs(watched.flight.speed),
        pitch,
        roll: watched.flight.bank,
        heading: w.heading,
        mode: watched.mode,
        health: watched.health,
      });
    } else {
      // Show height above the ground/rooftops (AGL) when we know the surface.
      const agl =
        lastSurface !== undefined ? Math.max(0, suit.altitude - lastSurface) : suit.altitude;

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
