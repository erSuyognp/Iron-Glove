// WebSerial reader for the MPU-6050 glove.
// Firmware streams CSV at 115200 baud, 50 Hz, newline-terminated:
//   pitch,roll,ax,ay,az
// All floats. No JSON.

const BAUD = 115200;
export const FIST_G = 1.5; // abs(ax) above this (in g) is a fist clench
const FIST_COOLDOWN_MS = 500;
// Missile trigger: a sharp flick of the hand. The accelerometer magnitude
// sqrt(ax² + ay² + az²) sits near 1 g at rest; it has to stay above FIRE_G for
// longer than FIRE_HOLD_MS — a single noisy sample never fires.
export const FIRE_G = 2.5;
const FIRE_HOLD_MS = 30;
const FIRE_COOLDOWN_MS = 500;
const SAMPLE_MS = 20; // firmware streams at 50 Hz
const MAX_BUFFER = 4096;

let onGloveData = () => {};
let onConnection = () => {};

let connected = false;
let connecting = false;
let latest = { pitch: 0, roll: 0, ax: 0, ay: 0, az: 0, fist: false };

let fistDown = false;
let fistQueued = false;
let fistCooldownUntil = 0;

let jerkSince = 0; // when the magnitude first crossed FIRE_G (0 = below it)
let jerkSamples = 0; // consecutive samples above it
let jerkFired = false; // this spike already fired
let fireQueued = false;
let fireCooldownUntil = 0;

export function setGloveHandler(fn) {
  onGloveData = fn || (() => {});
}

export function setGloveConnectionHandler(fn) {
  onConnection = fn || (() => {});
}

export function isGloveConnected() {
  return connected;
}

export function hasWebSerial() {
  return Boolean(navigator.serial);
}

// Latest CSV sample (raw firmware degrees / g). ay/az stored for future gestures.
export function readGlove() {
  return latest;
}

// Empirical poses from the live IMU (pitch, roll):
//   (0, 160)   climb
//   (0, 0)     nose dive (palm up)
//   (-6, -120) forward speed
//   pitch up   lean left
//   pitch down lean right
export const ROLL_CLIMB = 160;
export const ROLL_DOWN = 0;
export const ROLL_FWD = -120;
export const ROLL_LOBE = 80; // deg — far enough that the three poses don't overlap
const PITCH_DEADZONE = 8; // keeps the (-6, -120) thrust pose from also turning
const PITCH_YAW_SCALE = 45;

// ---- Steadying the hand ----
// The flight model never sees a raw sample. The firmware's angles carry hand
// tremor and, through its accelerometer blend, every jolt of the arm, and at
// 50 Hz all of it used to land on the suit (and on the camera, which rolls with
// the glove). So the glove is treated the way the phone controller treats its
// tilt sensor: each sample goes through a low-pass, the axes that come out are
// quantized with hysteresis, and they are refreshed at most 10 times a second,
// so a steady hand is a steady command. The suit's own weight (main.js
// SPEED_LERP) eases between the steps. Gestures still read every raw sample: a
// punch is a spike, which all of this would erase.
const TILT_SMOOTH_MS = 90; // low-pass on the raw angles (hand tremor, sensor noise)
// Per sample rather than by the clock: serial reads hand over samples in bursts.
const TILT_K = 1 - Math.exp(-SAMPLE_MS / TILT_SMOOTH_MS);
const CONTROL_MS = 100; // the axes change at most 10x/s...
const STEP = 0.05; // ...and in steps this big

let tilt = null; // low-passed { pitch, roll }; null until the first sample
let controls = { throttle: 0, climb: 0, dive: 0, yaw: 0 };
let controlsAt = -Infinity; // when the controls were last refreshed

function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

function angDist(a, b) {
  return Math.abs(wrapDeg(a - b));
}

function lobe(roll, center, width = ROLL_LOBE) {
  return Math.max(0, 1 - angDist(roll, center) / width);
}

function clampAxis(v) {
  return Math.max(-1, Math.min(1, v));
}

// Tilt in degrees -> axis: nothing inside the dead zone, then linear up to
// full. It starts from zero at the dead zone's edge, so a hand resting near
// that edge doesn't flick a quarter-rate turn on and off.
function tiltAxis(deg, deadzone, full) {
  const mag = Math.max(0, Math.abs(deg) - deadzone) / (full - deadzone);
  return clampAxis(Math.sign(deg) * mag);
}

function quantize(v) {
  return Number((Math.round(v / STEP) * STEP).toFixed(2)) || 0; // || 0 drops -0
}

// Quantize with hysteresis: move to a new step only once the input has clearly
// left the current one, so a hand held near a step boundary doesn't flicker
// between two values.
function settle(raw, current) {
  return Math.abs(raw - current) < STEP * 0.75 ? current : quantize(raw);
}

// Feed one sample through the low-pass and, when they are due, refresh the
// controls.
function steady(sample, now) {
  if (!tilt) {
    tilt = { pitch: sample.pitch, roll: sample.roll };
  } else {
    tilt.pitch += (sample.pitch - tilt.pitch) * TILT_K;
    // Roll lives on a circle, and palm-down (the resting pose) sits right on
    // its ±180 seam: averaging 179 and -179 the plain way would read palm-up.
    tilt.roll = wrapDeg(tilt.roll + wrapDeg(sample.roll - tilt.roll) * TILT_K);
  }
  if (now - controlsAt < CONTROL_MS) return;
  controlsAt = now;

  controls = {
    throttle: settle(lobe(tilt.roll, ROLL_FWD), controls.throttle),
    climb: settle(lobe(tilt.roll, ROLL_CLIMB), controls.climb),
    // Palm up is a nose dive, not a gentle descent: the flight model tips the
    // suit head-down and flies it down the slope. Easing into the pose gives a
    // shallow dive, so there is still a way to come down gently.
    dive: settle(lobe(tilt.roll, ROLL_DOWN), controls.dive),
    // Increase pitch → yaw left; decrease pitch → yaw right.
    yaw: settle(-tiltAxis(tilt.pitch, PITCH_DEADZONE, PITCH_YAW_SCALE), controls.yaw),
  };
}

function resetSteady() {
  tilt = null;
  controls = { throttle: 0, climb: 0, dive: 0, yaw: 0 };
  controlsAt = -Infinity;
}

// Flight axes from the glove: the steadied controls, and the attitude the suit
// (and the camera) should show. `roll` / `pitch` are the low-passed IMU angles
// all of it came from. The attitude follows those directly rather than the
// stepped controls, so the view stays fluid. (Boost is Shift on the keyboard.)
export function readGloveAxes() {
  const roll = tilt ? tilt.roll : 0;
  const pitch = tilt ? tilt.pitch : 0;
  return {
    ...controls,
    visualPitch: tilt ? lobe(roll, ROLL_CLIMB) * 18 - lobe(roll, ROLL_DOWN) * 60 : 0,
    visualRoll: -pitch || 0, // || 0 drops -0
    roll,
    pitch,
  };
}

// Rising-edge fist with cooldown. True once per punch.
export function consumeFist() {
  if (!fistQueued) return false;
  fistQueued = false;
  return true;
}

// Missile fire command from the jerk trigger. True once per flick.
export function consumeFire() {
  if (!fireQueued) return false;
  fireQueued = false;
  return true;
}

function resetFist() {
  fistDown = false;
  fistQueued = false;
  fistCooldownUntil = 0;
  jerkSince = 0;
  jerkSamples = 0;
  jerkFired = false;
  fireQueued = false;
  fireCooldownUntil = 0;
}

function noteJerk(sample, now) {
  sample.jerk = Math.sqrt(sample.ax * sample.ax + sample.ay * sample.ay + sample.az * sample.az);
  if (sample.jerk <= FIRE_G) {
    jerkSince = 0;
    jerkSamples = 0;
    jerkFired = false;
    return;
  }
  if (!jerkSince) jerkSince = now;
  jerkSamples++;
  // Serial reads hand over several lines at once, all stamped with the same
  // arrival time, so the spike's length is also counted in samples.
  const heldMs = Math.max(now - jerkSince, (jerkSamples - 1) * SAMPLE_MS);
  if (heldMs > FIRE_HOLD_MS && !jerkFired && now >= fireCooldownUntil) {
    jerkFired = true;
    fireQueued = true;
    fireCooldownUntil = now + FIRE_COOLDOWN_MS;
  }
}

function setConnected(value) {
  if (connected === value) return;
  connected = value;
  resetSteady(); // a fresh link starts from its own first sample
  if (!value) {
    resetFist();
    latest = { pitch: 0, roll: 0, ax: 0, ay: 0, az: 0, fist: false };
  }
  onConnection(value);
}

function parseCsvLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(',');
  if (parts.length < 5) return null;

  const pitch = Number(parts[0]);
  const roll = Number(parts[1]);
  const ax = Number(parts[2]);
  const ay = Number(parts[3]);
  const az = Number(parts[4]);
  if (![pitch, roll, ax, ay, az].every(Number.isFinite)) return null;

  return { pitch, roll, ax, ay, az };
}

function noteSample(sample) {
  const now = performance.now();
  const punching = Math.abs(sample.ax) > FIST_G;
  sample.fist = punching;

  if (punching && !fistDown && now >= fistCooldownUntil) {
    fistQueued = true;
    fistCooldownUntil = now + FIST_COOLDOWN_MS;
  }
  fistDown = punching;
  noteJerk(sample, now);
  steady(sample, now);

  latest = sample;
  onGloveData(sample);
}

async function pump(port) {
  const decoder = new TextDecoder();
  let buffer = '';
  let reader;

  try {
    reader = port.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-1024);

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();

      for (const line of lines) {
        const data = parseCsvLine(line);
        if (data) noteSample(data);
      }
    }
  } catch (err) {
    console.warn('[glove] serial read ended', err);
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      // already released
    }
    try {
      await port.close();
    } catch {
      // already closed (unplug)
    }
    setConnected(false);
  }
}

export async function connectGlove() {
  if (connected) return true;
  if (connecting) return false;

  if (!navigator.serial) {
    alert('Web Serial requires Chrome. Switch browsers to use the glove.');
    return false;
  }

  connecting = true;
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: BAUD });
    setConnected(true);
    pump(port);
    return true;
  } catch (err) {
    // NotFoundError / AbortError: user cancelled the port picker.
    if (err?.name !== 'NotFoundError' && err?.name !== 'AbortError') {
      console.warn('[glove] connect failed', err);
    }
    return false;
  } finally {
    connecting = false;
  }
}
