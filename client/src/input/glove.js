// WebSerial reader for the MPU-6050 glove.
// Firmware streams CSV at 115200 baud, 50 Hz, newline-terminated:
//   pitch,roll,ax,ay,az
// All floats. No JSON.

const BAUD = 115200;
const FIST_G = 1.5; // abs(ax) above this (in g) is a fist clench
const FIST_COOLDOWN_MS = 500;
const MAX_BUFFER = 4096;

let onGloveData = () => {};
let onConnection = () => {};

let connected = false;
let connecting = false;
let latest = { pitch: 0, roll: 0, ax: 0, ay: 0, az: 0, fist: false };

let fistDown = false;
let fistQueued = false;
let fistCooldownUntil = 0;

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
//   (0, 0)     down
//   (-6, -120) forward speed
//   pitch up   lean left
//   pitch down lean right
const ROLL_CLIMB = 160;
const ROLL_DOWN = 0;
const ROLL_FWD = -120;
const ROLL_LOBE = 80; // deg — far enough that the three poses don't overlap
const PITCH_DEADZONE = 8; // keeps the (-6, -120) thrust pose from also turning
const PITCH_YAW_SCALE = 45;

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

// Flight axes from the current (or provided) IMU sample.
export function readGloveAxes(sample = latest) {
  const climb = lobe(sample.roll, ROLL_CLIMB) - lobe(sample.roll, ROLL_DOWN);
  const throttle = lobe(sample.roll, ROLL_FWD);
  const pitchCmd = Math.abs(sample.pitch) < PITCH_DEADZONE ? 0 : sample.pitch;
  // Increase pitch → yaw left; decrease pitch → yaw right.
  const yaw = clampAxis(-pitchCmd / PITCH_YAW_SCALE);
  return {
    throttle,
    climb,
    yaw,
    visualPitch: climb * 18,
    visualRoll: -sample.pitch,
  };
}

// Rising-edge fist with cooldown. True once per punch.
export function consumeFist() {
  if (!fistQueued) return false;
  fistQueued = false;
  return true;
}

function resetFist() {
  fistDown = false;
  fistQueued = false;
  fistCooldownUntil = 0;
}

function setConnected(value) {
  if (connected === value) return;
  connected = value;
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
