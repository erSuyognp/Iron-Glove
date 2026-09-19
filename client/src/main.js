import * as Cesium from 'cesium';
import { initWorld, hasValidToken, JHU_HOMEWOOD } from './cesium/world.js';
import { updateChaseCamera } from './cesium/camera.js';
import { initKeyboard, readAxes } from './input/keyboard.js';
import { initHUD, updateHUD, setJarvis, setGpws, setNet, showBanner, hideBanner, updateSpeedFx } from './hud/hud.js';
import { initAttitude, updateAttitude } from './hud/attitude.js';
import { sampleSurfaceHeight, forwardObstacle } from './suit/collision.js';
import { initTrail } from './suit/thruster.js';
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
// The suit has weight — speed eases toward its target instead of snapping.
// Same 0.08 feel as the glove spring-damper; do not crank this up.
const SPEED_LERP = 0.08;
const ANGLE_LERP = 0.1; // how fast visual pitch/roll settle

// ---- Collision / damage tuning ----
const GROUND_CLEARANCE = 4; // how far the suit floats above a surface at rest
const SUIT_RADIUS = 4; // meters, for the forward obstacle ray
const IMPACT_COOLDOWN_MS = 700; // min gap between damage ticks
const REBOOT_MS = 1800; // downtime after health hits 0
const SCRAPE_SPEED = 12; // below this, touching ground doesn't hurt
const DAMAGE_SCALE = 0.55; // m/s -> HP
const DAMAGE_MIN = 6;
const DAMAGE_MAX = 45;
const GPWS_ALT = 45; // AGL below which the "PULL UP" warning flashes

// ---- SpacetimeDB sync (Phase 2) ----
// The client stays authoritative for physics; we mirror the computed transform
// into SpacetimeDB and render the player from the row we read back.
const PLAYER_ID = 'suyog';
const NET_SEND_HZ = 30; // how often we push our transform to the server
const NET_SEND_MS = 1000 / NET_SEND_HZ;
// Render-smoothing for the position we read back. This is snapshot
// interpolation (netcode), NOT physics — it just keeps the 30 Hz stream smooth
// at 60 fps. Physics still runs entirely client-side in stepFlight().
const NET_LERP = 0.5;

const JARVIS_LINES = {
  online: 'Suit online. Homewood airspace is clear, sir.',
  minor: [
    'Structural contact. The architecture is not the enemy, sir.',
    'That was a building. They rarely move.',
    'Minor impact. The suit can take it — barely.',
  ],
  major: [
    'Heavy impact! Integrity dropping fast.',
    'We really cannot keep hitting things, sir.',
    'Warning: sustained collision damage.',
  ],
  reboot: 'Suit integrity depleted. Emergency reboot in progress, sir.',
  restored: 'Systems restored. Back in Homewood airspace, sir.',
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
    pitch: 0, // degrees (visual)
    roll: 0, // degrees — manual barrel roll (Q/E), drives the camera
    bank: 0, // degrees — auto-lean into turns, mesh only
    hover: 0, // meters — idle levitation offset (visual only)
    health: 100,
    mode: 'KEYBOARD',
  };
}

let suit = spawnState();

// Collision / crash bookkeeping.
let lastSurface; // last sampled surface height under the suit
let damageCooldownUntil = 0;
let crashedUntil = 0; // > now while rebooting after a fatal crash
let lastForwardCheck = 0;
let lastSurfaceSampleAt = 0; // throttle GPU height reads
let trailClearNeeded = false; // flush the afterburner trail after a teleport
let idle = false; // suit is still enough to levitate
let hoverBlend = 0; // 0..1 ease for the idle hover
let hoverClock = 0; // seconds, advances the hover sine

// ---- SpacetimeDB state ----
// `net` holds the latest transform read back from our player_state row (mapped
// out of the position_x/y/z convention). `renderPos` eases toward it so the
// rendered suit is driven by the round-tripped server state when online.
let stdb = null;
let net = null; // { longitude, latitude, altitude, heading, pitch, roll } | null
const renderPos = { longitude: 0, latitude: 0, altitude: 0, heading: 0, pitch: 0, roll: 0 };
let renderInit = false; // renderPos seeded from the first net snapshot
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

function stepFlight(dt) {
  const axes = readAxes();

  if (axes.reset) {
    suit = spawnState();
    trailClearNeeded = true;
    return;
  }

  // Target forward speed from throttle (+ optional boost).
  const targetSpeed = axes.throttle * MAX_SPEED * (axes.boost ? BOOST_MULT : 1);
  suit.speed = smooth(suit.speed, targetSpeed, SPEED_LERP, dt);

  // Yaw turns the suit; scale by dt so it's framerate-independent.
  suit.heading = (suit.heading + axes.yaw * YAW_RATE * dt + 360) % 360;

  // Climb / dive.
  suit.altitude += axes.climb * CLIMB_RATE * dt;
  suit.altitude = Math.min(MAX_ALT, Math.max(MIN_ALT, suit.altitude));

  // Advance position along heading over the ground.
  const dist = suit.speed * dt; // meters this frame
  const headingRad = Cesium.Math.toRadians(suit.heading);
  const dNorth = Math.cos(headingRad) * dist;
  const dEast = Math.sin(headingRad) * dist;
  const latRad = Cesium.Math.toRadians(suit.latitude);
  suit.latitude += dNorth / 111320;
  suit.longitude += dEast / (111320 * Math.cos(latRad));

  // Pitch: nose up/down with climb input.
  suit.pitch = smooth(suit.pitch, axes.climb * 18, ANGLE_LERP, dt);

  // Manual barrel roll (Q/E): rotate continuously while held (can go inverted
  // or all the way around), then auto-level back to upright when released.
  if (axes.roll !== 0) {
    suit.roll = normalizeDeg(suit.roll + axes.roll * ROLL_RATE * dt);
  } else {
    suit.roll = smooth(normalizeDeg(suit.roll), 0, ANGLE_LERP, dt);
  }

  // Auto-bank: lean into turns (mesh only, so the camera isn't yanked sideways).
  suit.bank = smooth(suit.bank, -axes.yaw * 28, ANGLE_LERP, dt);

  // "Still" = no control input and barely moving, so the suit can levitate.
  idle =
    axes.throttle === 0 &&
    axes.yaw === 0 &&
    axes.climb === 0 &&
    axes.roll === 0 &&
    !axes.boost &&
    Math.abs(suit.speed) < HOVER_IDLE_SPEED;
}

// Apply impact damage; returns true if damage actually landed (not on cooldown).
function registerImpact(impactSpeed) {
  const now = performance.now();
  if (now < damageCooldownUntil) return false;
  damageCooldownUntil = now + IMPACT_COOLDOWN_MS;

  const dmg = Math.min(DAMAGE_MAX, Math.max(DAMAGE_MIN, Math.abs(impactSpeed) * DAMAGE_SCALE));
  suit.health = Math.max(0, suit.health - dmg);

  if (suit.health <= 0) {
    crashedUntil = now + REBOOT_MS;
    setJarvis(JARVIS_LINES.reboot);
  } else {
    setJarvis(pick(dmg >= 22 ? JARVIS_LINES.major : JARVIS_LINES.minor));
  }
  return true;
}

function collisionStep(viewer, suitEntity) {
  const exclude = [suitEntity];
  const now = performance.now();

  // 1) Dynamic floor: don't sink into the ground or a roof beneath us.
  // Sampling the mesh is a GPU read-back that stalls the frame, so refresh the
  // surface height ~20x/sec and reuse it in between — the floor still clamps
  // every frame against the cached value.
  if (now - lastSurfaceSampleAt > 50) {
    lastSurfaceSampleAt = now;
    const s = sampleSurfaceHeight(viewer, suit.longitude, suit.latitude, exclude);
    if (s !== undefined) lastSurface = s;
  }
  if (lastSurface !== undefined) {
    const floor = lastSurface + GROUND_CLEARANCE;
    if (suit.altitude < floor) {
      const penetration = floor - suit.altitude;
      // Hard landing / fast scrape hurts; a gentle settle doesn't.
      if (Math.abs(suit.speed) > SCRAPE_SPEED || penetration > 3) {
        registerImpact(Math.abs(suit.speed) + penetration * 6);
      }
      suit.altitude = floor;
      suit.speed *= 0.5; // bleed momentum on contact
    }
  }

  // 2) Forward wall: catch flying into the side of a building (throttled).
  if (now - lastForwardCheck > 100) {
    lastForwardCheck = now;
    const lookAhead = Math.max(8, Math.abs(suit.speed) * 0.2 + SUIT_RADIUS);
    const obstacle = forwardObstacle(viewer, suit, lookAhead, exclude);
    if (obstacle && Math.abs(suit.speed) > 6) {
      if (registerImpact(Math.abs(suit.speed))) {
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

function makeSuitEntity(viewer) {
  return viewer.entities.add({
    name: 'IRON GLOVE — Player 1',
    position: Cesium.Cartesian3.fromDegrees(suit.longitude, suit.latitude, suit.altitude),
    // Placeholder body until the GLTF suit lands in Phase 3.
    box: {
      dimensions: new Cesium.Cartesian3(6, 10, 3),
      material: Cesium.Color.fromCssColorString('#00ccff').withAlpha(0.9),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#7fe9ff'),
    },
    // A small "thruster" trail marker under the suit.
    point: {
      pixelSize: 8,
      color: Cesium.Color.fromCssColorString('#ffb020'),
    },
  });
}

function updateSuitEntity(entity, s) {
  entity.position = Cesium.Cartesian3.fromDegrees(
    s.longitude,
    s.latitude,
    s.altitude + s.hover,
  );
  // Idle sway: a slow roll/pitch wobble, as if thrusters are holding a hover.
  const swayRoll = Math.sin(hoverClock * 1.3) * HOVER_SWAY_ROLL * hoverBlend;
  const swayPitch = Math.sin(hoverClock * 1.7 + 1.0) * HOVER_SWAY_PITCH * hoverBlend;
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(s.heading),
    Cesium.Math.toRadians(s.pitch + swayPitch),
    Cesium.Math.toRadians(s.roll + s.bank + swayRoll),
  );
  entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
    entity.position.getValue(Cesium.JulianDate.now()),
    hpr,
  );
}

// A remote pilot's suit (e.g. the judge on the phone). Gold/red so it reads as
// a second suit, distinct from the cyan Player 1 box, with a name label.
function makeOtherEntity(viewer, id) {
  return viewer.entities.add({
    name: `IRON GLOVE — ${id}`,
    position: Cesium.Cartesian3.fromDegrees(
      JHU_HOMEWOOD.longitude,
      JHU_HOMEWOOD.latitude,
      JHU_HOMEWOOD.altitude,
    ),
    box: {
      dimensions: new Cesium.Cartesian3(6, 10, 3),
      material: Cesium.Color.fromCssColorString('#ffb020').withAlpha(0.9),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#ff5b2e'),
    },
    point: {
      pixelSize: 8,
      color: Cesium.Color.fromCssColorString('#37e7ff'),
    },
    label: {
      text: id.toUpperCase(),
      font: '12px monospace',
      fillColor: Cesium.Color.fromCssColorString('#ffb020'),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#0a0e17').withAlpha(0.6),
      pixelOffset: new Cesium.Cartesian2(0, -28),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

function updateOtherEntity(entity, r) {
  entity.position = Cesium.Cartesian3.fromDegrees(r.longitude, r.latitude, r.altitude);
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(r.heading),
    Cesium.Math.toRadians(r.pitch),
    Cesium.Math.toRadians(r.roll),
  );
  entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
    entity.position.getValue(Cesium.JulianDate.now()),
    hpr,
  );
}

async function boot() {
  initHUD();
  initAttitude();
  initKeyboard();

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

  const suitEntity = makeSuitEntity(viewer);
  const trail = initTrail(viewer);
  updateChaseCamera(viewer, suit);

  // Remote pilots (everyone that isn't us). Keyed by player_id; each holds its
  // Cesium entity, the latest transform from the DB (`target`), and an eased
  // `render` transform for smooth 30 Hz -> 60 fps motion.
  const others = new Map();

  function upsertOther(row) {
    const target = {
      longitude: row.positionX,
      altitude: row.positionY,
      latitude: row.positionZ,
      heading: row.yaw,
      pitch: row.pitch,
      roll: row.roll,
    };
    const existing = others.get(row.playerId);
    if (existing) {
      existing.target = target;
    } else {
      others.set(row.playerId, {
        entity: makeOtherEntity(viewer, row.playerId),
        target,
        render: { ...target },
        init: true,
      });
    }
  }

  function removeOther(playerId) {
    const o = others.get(playerId);
    if (o) {
      viewer.entities.remove(o.entity);
      others.delete(playerId);
    }
  }

  // SpacetimeDB link: mirror the client-computed transform into the DB and
  // render the suit from the row we read back. Fails soft — if the module is
  // unreachable the game keeps flying on local physics.
  setNet('CONNECTING');
  stdb = createStdbClient({
    playerId: PLAYER_ID,
    mode: 'KEYBOARD',
    onStatus: (s) => {
      setNet(s.toUpperCase());
      if (s === 'online') {
        setJarvis('SpacetimeDB link established. Telemetry streaming, sir.');
        console.log('[stdb] online — join_game sent, streaming update_orientation');
      } else if (s === 'offline' || s === 'error') {
        net = null;
        console.warn(`[stdb] link ${s} — flying on local physics only`);
      }
    },
    onPlayer: (row) => {
      // Map the position_x/y/z convention back to lon/lat/alt. Our own row
      // drives the local suit; every other row is a remote pilot (the judge).
      if (row.playerId === PLAYER_ID) {
        net = {
          longitude: row.positionX,
          altitude: row.positionY,
          latitude: row.positionZ,
          heading: row.yaw,
          pitch: row.pitch,
          roll: row.roll,
        };
      } else {
        upsertOther(row);
      }
    },
    onPlayerLeave: (row) => removeOther(row.playerId),
  });
  stdb.start();

  // Game loop.
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1; // clamp after tab-out

    let rebooting = false;
    if (crashedUntil) {
      // Rebooting after a fatal crash — controls frozen until systems restore.
      rebooting = true;
      if (now >= crashedUntil) {
        suit = spawnState();
        crashedUntil = 0;
        lastSurface = undefined;
        trailClearNeeded = true;
        setJarvis(JARVIS_LINES.restored);
        rebooting = false;
      }
    } else {
      stepFlight(dt);
      collisionStep(viewer, suitEntity);
    }

    if (trailClearNeeded) {
      trail.clear();
      trailClearNeeded = false;
    }

    // Idle levitation: ease the bob in when still, out when flying/rebooting.
    hoverClock += dt;
    hoverBlend = smooth(hoverBlend, idle && !rebooting ? 1 : 0, 0.05, dt);
    suit.hover = Math.sin(hoverClock * HOVER_OMEGA) * HOVER_AMP * hoverBlend;

    // --- SpacetimeDB round-trip ---
    // Push our client-computed transform (throttled to NET_SEND_HZ), then let
    // the subscription hand the row back via onPlayer -> `net`.
    if (stdb && !rebooting && now - lastNetSendAt >= NET_SEND_MS) {
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

    // Render from the server-echoed position when online; else local physics.
    let view;
    if (stdb && stdb.online && net) {
      if (!renderInit) {
        Object.assign(renderPos, net);
        renderInit = true;
      }
      const k = 1 - Math.pow(1 - NET_LERP, dt * 60);
      renderPos.longitude = lerp(renderPos.longitude, net.longitude, k);
      renderPos.latitude = lerp(renderPos.latitude, net.latitude, k);
      renderPos.altitude = lerp(renderPos.altitude, net.altitude, k);
      renderPos.pitch = lerp(renderPos.pitch, net.pitch, k);
      renderPos.roll = lerp(renderPos.roll, net.roll, k);
      renderPos.heading = easeHeading(renderPos.heading, net.heading, k);
      // Position/orientation come from the DB round-trip; bank/hover/speed are
      // local visual-only extras that aren't part of the schema.
      view = {
        longitude: renderPos.longitude,
        latitude: renderPos.latitude,
        altitude: renderPos.altitude,
        heading: renderPos.heading,
        pitch: renderPos.pitch,
        roll: renderPos.roll,
        bank: suit.bank,
        hover: suit.hover,
        speed: suit.speed,
      };
    } else {
      renderInit = false; // reseed from net when the link (re)appears
      view = suit;
    }

    updateSuitEntity(suitEntity, view);
    updateChaseCamera(viewer, view);

    // Remote pilots (the judge): ease each entity from its last DB transform
    // toward the newest one, same snapshot interpolation we use for our row.
    if (others.size) {
      const k = 1 - Math.pow(1 - NET_LERP, dt * 60);
      for (const o of others.values()) {
        if (o.init) {
          Object.assign(o.render, o.target);
          o.init = false;
        } else {
          o.render.longitude = lerp(o.render.longitude, o.target.longitude, k);
          o.render.latitude = lerp(o.render.latitude, o.target.latitude, k);
          o.render.altitude = lerp(o.render.altitude, o.target.altitude, k);
          o.render.pitch = lerp(o.render.pitch, o.target.pitch, k);
          o.render.roll = lerp(o.render.roll, o.target.roll, k);
          o.render.heading = easeHeading(o.render.heading, o.target.heading, k);
        }
        updateOtherEntity(o.entity, o.render);
      }
    }

    // Speed-driven feel: FOV punch, edge blur, and vignette all ramp together.
    const speedRatio = Math.min(1, Math.abs(suit.speed) / FX_FULL_SPEED);
    if (viewer.camera.frustum.fov !== undefined) {
      viewer.camera.frustum.fov = Cesium.Math.toRadians(
        BASE_FOV_DEG + speedRatio * SPEED_FOV_DEG,
      );
    }
    updateSpeedFx(speedRatio);

    // Afterburner trail: extend it while flying, let it drain when parked.
    if (!rebooting && Math.abs(suit.speed) > 2) {
      trail.push(suit.longitude, suit.latitude, suit.altitude, speedRatio);
    } else {
      trail.decay();
    }

    // Show height above the ground/rooftops (AGL) when we know the surface.
    const agl =
      lastSurface !== undefined ? Math.max(0, suit.altitude - lastSurface) : suit.altitude;

    // Animated attitude indicator + heading tape.
    updateAttitude(suit.pitch, suit.roll + suit.bank, suit.heading);

    // Ground proximity warning: flash when low and not mid-reboot.
    setGpws(!rebooting && agl < GPWS_ALT);

    updateHUD({
      altitude: agl,
      speed: Math.abs(suit.speed),
      pitch: suit.pitch,
      roll: suit.roll,
      heading: suit.heading,
      mode: suit.mode,
      health: suit.health,
    });

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
