import assert from 'node:assert/strict';

// The glove's steadying stage, driven end to end: a fake Web Serial port
// streams the firmware's CSV, and a virtual clock stands in for
// performance.now(), so seconds of flying take no time at all.

let clock = 1000;
performance.now = () => clock;

let port = null; // the open stream's controller
Object.defineProperty(globalThis.navigator, 'serial', {
  configurable: true,
  value: {
    requestPort: async () => ({
      open: async () => {},
      close: async () => {},
      readable: new ReadableStream({
        start(controller) {
          port = controller;
        },
      }),
    }),
  },
});

const glove = await import('./glove.js');
const { readGloveAxes } = glove;

const SAMPLE_MS = 20; // the firmware's 50 Hz
const encoder = new TextEncoder();
const turn = () => new Promise((resolve) => setImmediate(resolve)); // let the serial pump run

const line = ({ pitch = 0, roll = 0, ax = 0, ay = 0, az = 1 }) => `${pitch},${roll},${ax},${ay},${az}\n`;

// Stream `sample` (an object, or a function of the sample index) for `ms`.
// `each` sees the axes after every sample. `burst` samples arrive per read.
async function stream(sample, ms, { each, burst = 1 } = {}) {
  const count = Math.round(ms / SAMPLE_MS);
  for (let i = 0; i < count; i += burst) {
    let chunk = '';
    for (let j = i; j < Math.min(count, i + burst); j++) chunk += line(typeof sample === 'function' ? sample(j) : sample);
    clock += SAMPLE_MS * burst;
    port.enqueue(encoder.encode(chunk));
    await turn();
    each?.(readGloveAxes());
  }
}

const angDist = (a, b) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180);
const onStep = (v) => Math.abs(v * 20 - Math.round(v * 20)) < 1e-9; // a multiple of 0.05
// Repeatable noise in -1..1.
let seed = 7;
const noise = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return (seed / 2147483648) * 2 - 1;
};

assert.equal(await glove.connectGlove(), true);
assert.equal(glove.isGloveConnected(), true);
assert.deepEqual(
  (({ throttle, climb, dive, yaw }) => ({ throttle, climb, dive, yaw }))(readGloveAxes()),
  { throttle: 0, climb: 0, dive: 0, yaw: 0 },
  'nothing is commanded before the first sample',
);

// ---- The ±180 seam: palm-down rest must never average out to palm-up ----
await stream((i) => ({ roll: i % 2 ? 178 : -178, az: -1 }), 1000);
let axes = readGloveAxes();
assert.ok(angDist(axes.roll, 180) < 3, `roll held on the seam, got ${axes.roll}`);
assert.ok(axes.climb >= 0.7, `palm-down still climbs, got ${axes.climb}`);
assert.equal(axes.dive, 0, 'and never dives');

// ---- A shaky hand in the thrust pose is a steady command ----
await stream({ roll: -120, az: -1 }, 600);
const seen = [];
await stream(() => ({ pitch: noise() * 5, roll: -120 + noise() * 6, az: -1 }), 2000, { each: (a) => seen.push(a) });
const throttles = seen.map((a) => a.throttle);
assert.ok(Math.min(...throttles) >= 0.9, `throttle stays up, fell to ${Math.min(...throttles)}`);
assert.ok(new Set(throttles).size <= 2, `throttle barely moves, saw ${[...new Set(throttles)]}`);
assert.ok(seen.every((a) => a.yaw === 0), 'tremor inside the dead zone never turns the suit');
const rollSwing = Math.max(...seen.map((a) => a.visualRoll)) - Math.min(...seen.map((a) => a.visualRoll));
assert.ok(rollSwing < 5, `the camera roll is calmer than the ±5° it was fed, swung ${rollSwing.toFixed(1)}°`);

// ---- Stepped, and at most 10 changes a second ----
await stream({ roll: 80 }, 1000); // hover
axes = readGloveAxes();
assert.deepEqual([axes.throttle, axes.climb, axes.dive, axes.yaw], [0, 0, 0, 0], 'the hover pose is a true zero');
const changes = [];
let previous = JSON.stringify([axes.throttle, axes.climb, axes.dive, axes.yaw]);
const stepStart = clock;
let at95 = null;
await stream({ pitch: 30, roll: -120, az: -1 }, 1000, {
  each(a) {
    const now = JSON.stringify([a.throttle, a.climb, a.dive, a.yaw]);
    if (now !== previous) changes.push(clock);
    previous = now;
    if (at95 === null && a.throttle >= 0.95) at95 = clock - stepStart;
    assert.ok([a.throttle, a.climb, a.dive, a.yaw].every(onStep), 'every axis sits on a 0.05 step');
  },
});
assert.ok(changes.length > 2, 'the controls did follow the hand');
for (let i = 1; i < changes.length; i++) {
  assert.ok(changes[i] - changes[i - 1] >= 100, `controls changed ${changes[i] - changes[i - 1]} ms apart`);
}
assert.ok(at95 > 100 && at95 <= 600, `low-passed but not laggy: full thrust after ${at95} ms`);

// ---- Steering: a dead zone that starts from zero, full at 45° ----
const yawAt = async (pitch) => {
  await stream({ pitch, roll: 80 }, 900);
  return readGloveAxes().yaw;
};
assert.ok(Math.abs(await yawAt(9)) <= 0.05, 'just past the dead zone is a whisper of a turn, not a quarter-rate one');
assert.equal(await yawAt(45), -1, 'pitch up is a full left turn');
assert.equal(await yawAt(-45), 1, 'pitch down is a full right turn');
assert.equal(await yawAt(26.5), -0.5);
assert.equal(await yawAt(-6), 0, 'the thrust pose\'s own -6° of pitch does not turn the suit');

// ---- Samples that arrive in bursts are still each counted ----
await stream({ roll: 80 }, 600);
await stream({ roll: -120, az: -1 }, 600, { burst: 5 });
assert.equal(readGloveAxes().throttle, 1, 'five samples per serial read converge like five samples');

// ---- The glove never boosts by itself, however long thrust is held ----
await stream({ roll: 80 }, 600);
await stream({ roll: -120, az: -1 }, 6000, {
  each: (a) => assert.ok(!a.boost, 'boost is the keyboard\'s Shift, not the glove\'s'),
});
assert.equal(readGloveAxes().throttle, 1);

// ---- Gestures still read every raw sample ----
glove.consumeFist();
glove.consumeFire();
clock += 1000; // clear their cooldowns
await stream({ roll: 170, ax: 0.1, az: -1 }, 200);
await stream({ roll: 170, ax: 1.9, az: -1 }, SAMPLE_MS); // one 20 ms sample
await stream({ roll: 170, ax: 0.1, az: -1 }, 200);
assert.equal(glove.consumeFist(), true, 'a one-sample punch is still a punch');
assert.equal(glove.consumeFist(), false);
assert.equal(glove.consumeFire(), false, 'and not a flick');
clock += 1000;
await stream({ roll: 170, ax: 2, ay: 2, az: -1.5 }, 80);
assert.equal(glove.consumeFire(), true, 'a sustained 3 g flick fires');

// ---- Unplugged: everything lets go ----
await stream({ roll: -120, az: -1 }, 1000);
assert.equal(readGloveAxes().throttle, 1);
port.close();
await turn();
await turn();
assert.equal(glove.isGloveConnected(), false);
axes = readGloveAxes();
assert.deepEqual([axes.throttle, axes.climb, axes.dive, axes.yaw, axes.visualRoll], [0, 0, 0, 0, 0]);

console.log('glove steadying OK');
