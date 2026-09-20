import { audioContext, voiceOutput, duck, isMuted } from './sound.js';
import { squeezeSilence, soundsWrong } from './squeeze.js';

// ---------------------------------------------------------------------------
// JARVIS's voice. Every line shown in the HUD ticker is also spoken.
//
// A line's audio lives at /voice/<hash>.mp3. In development the Vite server
// answers that URL itself: a line it has not heard before is generated once
// with ElevenLabs (the key stays on the server, see vite.config.js) and saved
// under public/voice, so it is a plain static file from then on, in the build
// too. With no key, or for a line the build never shipped, the browser's own
// speech synthesis reads it instead.
//
// He never talks over himself: while a line is playing, ordinary lines are
// dropped (the ticker still shows them) and only `urgent` ones cut in.
//
// Every clip has its dead air squeezed out as it is decoded (squeeze.js): a
// cloned voice leaves seconds of it between sentences, whichever model speaks.
//
// A new recording costs credits, so the game helps keep their number down:
// /voice/index.json (kept by the dev server) lists the lines on file, and
// isRecorded() lets a list of takes stay with the ones it already has
// (main.js pick). When the server has his voice but will not buy a line just
// now, it answers 204 and he stays quiet, rather than change voices for it.
// ---------------------------------------------------------------------------

const MIN_GAP_MS = 900; // breathing room between lines
const MAX_LENGTH = 220; // longer lines are ticker-only

let playing = null; // { stop() }
let quietUntil = 0;
let recordedRetryAt = 0; // after a miss, don't ask the server again for a while
const RETRY_MS = 60000;
const clips = new Map(); // text -> Promise<AudioBuffer|SILENT|null>
const SILENT = Symbol('silent'); // there is a voice, but no recording of this line: say nothing
const onFile = new Set(); // hashes of the lines with a saved recording

fetch('/voice/index.json')
  .then((res) => (res.ok && (res.headers.get('content-type') || '').includes('json') ? res.json() : []))
  .then((hashes) => {
    for (const hash of hashes) onFile.add(hash);
  })
  .catch(() => {
    /* no index: nothing is known to be on file */
  });

// FNV-1a, as hex. vite.config.js names the files with the same hash.
export function lineHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// A clip as it should be played: its dead air squeezed out (squeeze.js). A
// cloned voice leaves seconds of it between sentences, one line in four.
function tidy(decoded, text, saved) {
  const channels = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const result = squeezeSilence(channels, decoded.sampleRate);
  if (import.meta.env.DEV && saved) {
    // Squeezing cannot mend a recording that dropped words, or added noise.
    const wrong = soundsWrong(text, result.voiced);
    if (wrong) console.warn(`[voice] "${text}" does not sound right (${wrong}). Delete client/public/voice/${lineHash(text)}.mp3 to have it recorded again.`);
  }
  if (result.channels === channels) return decoded;
  const buffer = audioContext().createBuffer(channels.length, result.channels[0].length, decoded.sampleRate);
  result.channels.forEach((data, c) => buffer.copyToChannel(data, c));
  return buffer;
}

/** Whether a line (as spoken) already has a saved recording. */
export function isRecorded(text) {
  return onFile.has(lineHash(text));
}

function fetchClip(text, keep) {
  if (!clips.has(text)) {
    clips.set(
      text,
      (async () => {
        const res = await fetch(`/voice/${lineHash(text)}.mp3?text=${encodeURIComponent(text)}${keep ? '' : '&keep=0'}`);
        if (res.status === 204) return SILENT;
        if (!res.ok || !(res.headers.get('content-type') || '').startsWith('audio')) return null;
        const decoded = await audioContext().decodeAudioData(await res.arrayBuffer());
        if (keep) onFile.add(lineHash(text));
        return tidy(decoded, text, keep);
      })().catch(() => null),
    );
  }
  return clips.get(text);
}

function finish(entry) {
  if (playing !== entry) return;
  playing = null;
  quietUntil = performance.now() + MIN_GAP_MS;
  duck(false);
}

function playBuffer(buffer) {
  const ctx = audioContext();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  // A touch of "helmet speaker": thin the lows, lift the presence band.
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 180;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2600;
  presence.gain.value = 4;
  const gain = ctx.createGain();
  gain.gain.value = 1.25; // he has to be understood over the jets; the master limiter catches the peaks
  src.connect(highpass).connect(presence).connect(gain).connect(voiceOutput());
  const entry = { stop: () => src.stop() };
  src.onended = () => finish(entry);
  src.start();
  return entry;
}

function playBrowserVoice(text) {
  if (!('speechSynthesis' in window)) return null;
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  utterance.voice =
    voices.find((v) => /en-GB/i.test(v.lang) && /male|george|daniel|ryan|arthur/i.test(v.name)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    null;
  utterance.rate = 1.05;
  utterance.pitch = 0.9;
  const entry = { stop: () => speechSynthesis.cancel() };
  utterance.onend = utterance.onerror = () => finish(entry);
  speechSynthesis.speak(utterance);
  return entry;
}

/** Cut JARVIS off (the pilot has started talking). */
export function hush() {
  playing?.stop();
}

/**
 * Speak a JARVIS line. `urgent` lines interrupt whatever he is saying;
 * `keep: false` marks a one-off (a conversational reply) whose audio the dev
 * server should not save.
 */
export async function speak(text, { urgent = false, keep = true } = {}) {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running' || isMuted() || !text || text.length > MAX_LENGTH) return;
  if (playing && !urgent) return;
  if (!urgent && performance.now() < quietUntil) return;

  // Claim the floor before the fetch, so a burst of lines cannot all get in.
  const claim = { stop() {} };
  playing?.stop();
  playing = claim;

  // A miss keeps him from asking again for a while, but never for a line that
  // is known to be on file.
  const ask = isRecorded(text) || performance.now() >= recordedRetryAt;
  const buffer = ask ? await fetchClip(text, keep) : null;
  if (playing !== claim) return; // an urgent line took over while this one loaded
  if (buffer === SILENT) {
    clips.delete(text); // the server may be willing next time
    playing = null;
    return;
  }
  if (!buffer) {
    recordedRetryAt = performance.now() + RETRY_MS;
    clips.delete(text);
  }
  if (!keep) clips.delete(text); // nor is it worth holding in memory
  duck(true);
  playing = (buffer ? playBuffer(buffer) : playBrowserVoice(text)) ?? null;
  if (!playing) duck(false);
}
