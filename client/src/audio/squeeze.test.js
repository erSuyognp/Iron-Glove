import assert from 'node:assert/strict';
import { squeezeSilence, soundsWrong } from './squeeze.js';

// Clips built from tone ("speech") and silence, in seconds, so what comes out
// can be checked against what went in.
const RATE = 22050;
function clip(parts, { floor = 0 } = {}) {
  const total = parts.reduce((n, [, s]) => n + Math.round(s * RATE), 0);
  const data = new Float32Array(total);
  let at = 0;
  let seed = 3;
  for (const [kind, seconds] of parts) {
    const size = Math.round(seconds * RATE);
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const hiss = (seed / 2147483648 - 0.5) * 2 * floor;
      data[at + i] = kind === 'tone' ? 0.5 * Math.sin((2 * Math.PI * 220 * (at + i)) / RATE) : hiss;
    }
    at += size;
  }
  return data;
}
const near = (actual, expected, slack, what) => assert.ok(Math.abs(actual - expected) <= slack, `${what}: ${actual.toFixed(3)} s, expected about ${expected} s`);

// ---- Two seconds of dead air between two sentences, and silence at both ends ----
let data = clip([['quiet', 0.5], ['tone', 1], ['quiet', 2.5], ['tone', 1], ['quiet', 0.8]]);
let out = squeezeSilence([data], RATE);
near(out.before, 5.8, 0.001, 'length before');
near(out.after, 0.06 + 1 + 0.35 + 1 + 0.06, 0.05, 'length after');
near(out.voiced, 2, 0.05, 'seconds of sound');
// Every sample that made a sound is still there, in order: the tone's energy is untouched.
const energy = (a) => a.reduce((n, v) => n + v * v, 0);
assert.ok(Math.abs(energy(out.channels[0]) - energy(data)) / energy(data) < 0.01, 'no sound was removed');
// ...and no cut left a click: nothing jumps further than the tone itself does.
const toneStep = 0.5 * 2 * Math.PI * (220 / RATE) * 1.05;
let jump = 0;
for (let i = 1; i < out.channels[0].length; i++) jump = Math.max(jump, Math.abs(out.channels[0][i] - out.channels[0][i - 1]));
assert.ok(jump <= toneStep, `no click at a cut (largest step ${jump.toFixed(4)})`);

// ---- Natural pauses are left exactly as they were ----
data = clip([['quiet', 0.04], ['tone', 0.9], ['quiet', 0.3], ['tone', 1.2], ['quiet', 0.05]]);
out = squeezeSilence([data], RATE);
assert.equal(out.channels[0], data, 'the very same samples come back');
assert.equal(out.after, out.before);

// ---- A cloned voice's faint hiss is still silence ----
data = clip([['tone', 0.8], ['quiet', 2], ['tone', 0.8]], { floor: 0.01 });
out = squeezeSilence([data], RATE);
near(out.after, 0.8 + 0.35 + 0.8, 0.05, 'with a noise floor');

// ---- Both channels of a stereo clip are cut alike ----
const left = clip([['tone', 0.7], ['quiet', 1.5], ['tone', 0.7], ['quiet', 1]]);
out = squeezeSilence([left, left.slice()], RATE);
assert.equal(out.channels.length, 2);
assert.equal(out.channels[0].length, out.channels[1].length);
near(out.after, 0.7 + 0.35 + 0.7 + 0.06, 0.05, 'stereo');

// ---- Nothing to go on: left alone ----
out = squeezeSilence([new Float32Array(RATE)], RATE); // pure silence
assert.equal(out.after, out.before);
out = squeezeSilence([new Float32Array(100)], RATE); // too short to judge
assert.equal(out.after, out.before);

// ---- Telling a bad recording from a good one (figures from real clips) ----
assert.equal(soundsWrong('Suit online. Johns Hopkins University airspace is clear.', 2.56), null);
assert.equal(soundsWrong('Glove uplink established. Hand control is yours.', 1.98), null);
assert.match(soundsWrong('That covers it. The sky is yours.', 3.44), /more than the words/, 'two seconds of noise after the words');
assert.match(soundsWrong('Afterburner is in. Do hold on to something.', 1.12), /too little/, 'half the words missing');
assert.equal(soundsWrong('Fox three.', 3), null, 'a very short line is not judged');

console.log('voice clip squeeze OK');
