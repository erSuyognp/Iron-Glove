// ---------------------------------------------------------------------------
// Suit audio. Everything is synthesised with Web Audio, so the game has its
// full soundscape with no asset files at all:
//   - continuous layers driven by the flight state every frame (boot jets,
//     wind, the water cannon, the ground-proximity alarm),
//   - one-shot effects by name (sfx('explosion')),
//   - JARVIS's voice (voice.js), which ducks the rest while he talks.
//
// The bigger one-shots can be replaced by recorded files: if /sfx/<name>.mp3
// exists it is played instead of the synth. The dev server generates those
// with ElevenLabs the first time they are asked for and saves them under
// public/sfx (see vite.config.js), so they ship with the build afterwards.
//
// Browsers only start audio after a gesture; initAudio() arms that.
// ---------------------------------------------------------------------------

const MASTER_GAIN = 0.8;
const MUTE_KEY = 'ironglove.muted';

// One-shots worth a recorded version. The rest are interface tones, which the
// synth does crisply and instantly.
const RECORDED = ['explosion', 'missile', 'repulsor', 'boost', 'hit', 'extinguish', 'missionStart', 'missionComplete', 'arrive'];

let ctx = null;
let master = null; // everything
let bus = null; // everything but the voice: ducked while JARVIS speaks
let noise = null; // shared white-noise buffer
let brown = null; // shared brown-noise buffer (the jets' body)
let layers = null;
let muted = false;
const samples = new Map(); // name -> AudioBuffer
const lastPlayed = new Map();

try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  /* storage unavailable */
}

function noiseBuffer(seconds, isBrown) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    if (isBrown) {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buffer;
}

function loopNoise(buffer) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start();
  return src;
}

// A looping noise source through one filter into its own gain (silent until driven).
function layer(buffer, type, frequency, q = 0.7) {
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  loopNoise(buffer).connect(filter).connect(gain).connect(bus);
  return { filter, gain };
}

function start() {
  if (ctx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER_GAIN;
  // A gentle limiter: an explosion over full jets must not clip.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.ratio.value = 8;
  master.connect(limiter).connect(ctx.destination);
  bus = ctx.createGain();
  bus.connect(master);

  noise = noiseBuffer(2, false);
  brown = noiseBuffer(3, true);
  layers = {
    jets: layer(brown, 'lowpass', 220),
    hiss: layer(noise, 'bandpass', 2400, 0.9),
    wind: layer(noise, 'bandpass', 700, 0.5),
    spray: layer(noise, 'highpass', 2600),
  };
  // The reactor: a low hum under everything once the suit is live.
  const hum = ctx.createOscillator();
  hum.type = 'sawtooth';
  hum.frequency.value = 55;
  const humFilter = ctx.createBiquadFilter();
  humFilter.type = 'lowpass';
  humFilter.frequency.value = 160;
  const humGain = ctx.createGain();
  humGain.gain.value = 0;
  hum.connect(humFilter).connect(humGain).connect(bus);
  hum.start();
  layers.hum = { osc: hum, gain: humGain };

  for (const name of RECORDED) loadSample(name);
}

async function loadSample(name) {
  try {
    const res = await fetch(`/sfx/${name}.mp3`);
    // A dev server answers an unknown path with index.html, so check the type.
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('audio')) return;
    samples.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
  } catch {
    /* no recorded version: the synth covers it */
  }
}

/** Arm audio: it starts on the first click or key press. */
export function initAudio() {
  const unlock = () => {
    start();
    ctx?.resume();
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  // Interface feedback for every button, present and future.
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('button')) sfx('click');
  });
  document.addEventListener(
    'pointerenter',
    (e) => {
      if (e.target.closest?.('button:not(:disabled)') === e.target) sfx('hover');
    },
    true,
  );
}

export function audioContext() {
  return ctx;
}

/** Where voice.js plugs in: not ducked, straight to the master. */
export function voiceOutput() {
  return master;
}

/** Pull the effects down while JARVIS talks: well down, a boost's roar buries a voice. */
export function duck(on) {
  if (!ctx) return;
  bus.gain.setTargetAtTime(on ? 0.3 : 1, ctx.currentTime, 0.12);
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  if (ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, ctx.currentTime, 0.05);
}

// ---- Synth building blocks ----

// An oscillator note with a pitch slide and a percussive envelope.
function tone(freq, { type = 'sine', dur = 0.2, gain = 0.2, to = freq, at = 0, attack = 0.005 } = {}) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(bus);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

// A burst of filtered noise with a filter sweep.
function burst({ type = 'lowpass', from = 1000, to = from, q = 0.8, dur = 0.4, gain = 0.3, at = 0, attack = 0.005, source = noise } = {}) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = source;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, t);
  if (to !== from) filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(bus);
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

const chime = (notes, { step = 0.09, dur = 0.5, gain = 0.16, type = 'sine' } = {}) =>
  notes.forEach((f, i) => tone(f, { type, dur, gain, at: i * step }));

const SYNTH = {
  click: () => tone(1500, { type: 'square', dur: 0.05, gain: 0.05, to: 900 }),
  hover: () => tone(2300, { dur: 0.03, gain: 0.025 }),
  select: () => chime([880, 1320], { step: 0.05, dur: 0.12, gain: 0.07, type: 'triangle' }),
  deploy() {
    burst({ type: 'bandpass', from: 200, to: 3200, dur: 0.9, gain: 0.3, attack: 0.5 });
    tone(110, { type: 'sawtooth', dur: 0.9, gain: 0.12, to: 440, attack: 0.4 });
    chime([660, 990], { step: 0.12, dur: 0.4, gain: 0.1 });
  },
  arrive() {
    tone(65, { dur: 1.6, gain: 0.3, to: 45, attack: 0.3 });
    burst({ type: 'bandpass', from: 3000, to: 400, dur: 1.2, gain: 0.18, attack: 0.05 });
    chime([523, 784, 1047], { step: 0.14, dur: 0.9, gain: 0.09 });
  },
  boost() {
    burst({ type: 'bandpass', from: 300, to: 2600, q: 1.2, dur: 0.7, gain: 0.4, attack: 0.08 });
    tone(80, { type: 'sawtooth', dur: 0.5, gain: 0.16, to: 220 });
  },
  missile() {
    burst({ type: 'bandpass', from: 2200, to: 300, q: 1.4, dur: 0.9, gain: 0.45, attack: 0.01 });
    tone(320, { type: 'sawtooth', dur: 0.6, gain: 0.14, to: 60 });
  },
  explosion() {
    burst({ from: 2400, to: 60, dur: 1.6, gain: 0.95, source: brown });
    burst({ type: 'highpass', from: 1800, to: 600, dur: 0.35, gain: 0.35 });
    tone(95, { dur: 0.9, gain: 0.6, to: 28 });
  },
  hit() {
    tone(150, { type: 'square', dur: 0.3, gain: 0.35, to: 42 });
    burst({ from: 1100, to: 120, dur: 0.35, gain: 0.5 });
    [0, 0.16, 0.32].forEach((at) => tone(932, { type: 'square', dur: 0.1, gain: 0.08, at }));
  },
  bump() {
    tone(120, { dur: 0.22, gain: 0.4, to: 40 });
    burst({ from: 600, to: 90, dur: 0.18, gain: 0.3 });
  },
  track: () => tone(1046, { dur: 0.06, gain: 0.07 }),
  lock() {
    tone(1568, { type: 'square', dur: 0.07, gain: 0.08 });
    tone(1568, { type: 'square', dur: 0.12, gain: 0.08, at: 0.1 });
  },
  dry: () => tone(170, { type: 'square', dur: 0.14, gain: 0.12, to: 120 }),
  inbound: () => [0, 0.14, 0.28, 0.42].forEach((at) => tone(1244, { type: 'square', dur: 0.08, gain: 0.09, at })),
  warn() {
    tone(660, { type: 'triangle', dur: 0.16, gain: 0.12 });
    tone(520, { type: 'triangle', dur: 0.22, gain: 0.12, at: 0.18 });
  },
  pullUp() {
    tone(740, { type: 'square', dur: 0.12, gain: 0.1, to: 1100 });
    tone(740, { type: 'square', dur: 0.12, gain: 0.1, to: 1100, at: 0.16 });
  },
  repulsor() {
    tone(180, { type: 'sawtooth', dur: 0.22, gain: 0.2, to: 1500, attack: 0.15 });
    burst({ type: 'bandpass', from: 3200, to: 300, q: 0.7, dur: 0.6, gain: 0.55, at: 0.2 });
    tone(140, { dur: 0.6, gain: 0.45, to: 36, at: 0.2 });
  },
  ring: () => chime([988, 1480], { step: 0.07, dur: 0.45, gain: 0.14 }),
  ringMiss: () => tone(300, { type: 'triangle', dur: 0.2, gain: 0.1, to: 200 }),
  extinguish() {
    burst({ type: 'highpass', from: 7000, to: 1500, dur: 0.9, gain: 0.3 });
    chime([784, 1175], { step: 0.1, dur: 0.5, gain: 0.12 });
  },
  tankEmpty: () => tone(240, { type: 'square', dur: 0.2, gain: 0.1, to: 140 }),
  missionStart() {
    tone(98, { type: 'sawtooth', dur: 0.8, gain: 0.16, to: 196, attack: 0.3 });
    chime([392, 523, 784], { step: 0.13, dur: 0.35, gain: 0.12, type: 'triangle' });
  },
  missionEnd: () => chime([784, 587, 392], { step: 0.12, dur: 0.4, gain: 0.11, type: 'triangle' }),
  missionComplete() {
    chime([523, 659, 784, 1047, 1319], { step: 0.1, dur: 0.9, gain: 0.14 });
    tone(131, { dur: 1.4, gain: 0.2, attack: 0.05 });
  },
  downed() {
    tone(400, { type: 'sawtooth', dur: 1.1, gain: 0.25, to: 40 });
    burst({ from: 3000, to: 80, dur: 1.2, gain: 0.5 });
  },
};

/**
 * Play a one-shot. `gap` (ms) drops a repeat that comes too soon after the
 * last one, for effects fired from per-frame conditions.
 */
export function sfx(name, { gap = 40, gain = 1 } = {}) {
  if (!ctx || ctx.state !== 'running' || muted) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < gap) return;
  lastPlayed.set(name, now);

  const sample = samples.get(name);
  if (sample) {
    const src = ctx.createBufferSource();
    src.buffer = sample;
    const g = ctx.createGain();
    g.gain.value = 0.9 * gain;
    src.connect(g).connect(bus);
    src.start();
    return;
  }
  SYNTH[name]?.();
}

/**
 * Drive the continuous layers. Call every frame.
 * @param {{ speed: number, thrust: number, boost: boolean, spray: boolean, live: boolean }} s
 *   speed and thrust are 0..1 (thrust may pass 1 on boost).
 */
export function updateFlightAudio(s) {
  if (!ctx || !layers) return;
  const t = ctx.currentTime;
  const set = (param, value, smooth = 0.12) => param.setTargetAtTime(value, t, smooth);
  const live = s.live ? 1 : 0;
  const thrust = Math.max(0, s.thrust);

  set(layers.hum.gain.gain, 0.05 * live, 0.6);
  set(layers.hum.osc.frequency, 55 + thrust * 30);
  set(layers.jets.gain.gain, live * (0.1 + 0.34 * Math.min(1.3, thrust)));
  set(layers.jets.filter.frequency, 180 + thrust * 1100);
  set(layers.hiss.gain.gain, live * (0.012 + (s.boost ? 0.12 : 0.03 * thrust)));
  set(layers.hiss.filter.frequency, 1800 + thrust * 2600);
  set(layers.wind.gain.gain, live * s.speed * s.speed * 0.32);
  set(layers.wind.filter.frequency, 500 + s.speed * 1600);
  set(layers.spray.gain.gain, s.spray ? 0.22 : 0, 0.06);
}
