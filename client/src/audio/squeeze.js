// ---------------------------------------------------------------------------
// Squeezing the dead air out of a spoken line.
//
// A cloned voice keeps the habits of the recording it was made from, long
// pauses included: about one JARVIS line in four comes back from ElevenLabs
// with two seconds of silence between its sentences (whichever model speaks
// it), and some with a second of it at the end. The words are all there; the
// line just sounds broken, and holds up everything queued behind it.
//
// So every clip is squeezed as it is decoded (voice.js): a pause is cut down to
// PAUSE_S, the silence at either end to EDGE_S. It is done on the decoded
// samples, costs nothing, and mends the clips already on file too. Nothing that
// makes a sound is ever removed: only the middle of a silence longer than
// PAUSE_S goes, so the tail of one word and the start of the next stay whole.
//
// The same pass measures the clip, which is how a bad recording is told from a
// good one (words dropped, or seconds of noise that are not words at all).
// ---------------------------------------------------------------------------

const WINDOW_S = 0.02; // loudness is judged over windows this long
const SILENCE = 0.07; // ...and a window under this share of the clip's loudest is silent
const PAUSE_S = 0.35; // the longest pause left inside a line (a natural one is 0.3 - 0.5 s)
const EDGE_S = 0.06; // silence left at either end
const FADE_S = 0.004; // each side of a cut is faded, so a cut in faint noise cannot click
// Speech runs at some 17 - 30 characters per second of actual sound. Far outside
// that, the recording is not the line: words were dropped, or noise added.
const SLOWEST = 12;
const FASTEST = 34;
const SHORTEST_JUDGED = 20; // characters: shorter lines vary too much to judge

/**
 * @param {Float32Array[]} channels  the decoded clip, one array per channel
 * @param {number} sampleRate
 * @returns {{ channels: Float32Array[], before: number, after: number, voiced: number }}
 *   the squeezed samples; the length in seconds before and after; and how many
 *   seconds of it made a sound
 */
export function squeezeSilence(channels, sampleRate) {
  const length = channels[0].length;
  const win = Math.max(1, Math.round(WINDOW_S * sampleRate));
  const count = Math.floor(length / win);
  const before = length / sampleRate;
  if (count < 3) return { channels, before, after: before, voiced: before };

  // Loudness per window, across the channels.
  const level = new Float32Array(count);
  let loudest = 0;
  for (let w = 0; w < count; w++) {
    let sum = 0;
    for (const data of channels) {
      for (let i = w * win; i < (w + 1) * win; i++) sum += data[i] * data[i];
    }
    level[w] = Math.sqrt(sum / (win * channels.length));
    loudest = Math.max(loudest, level[w]);
  }
  if (loudest === 0) return { channels, before, after: before, voiced: 0 };

  // The stretches to keep, in samples. A silence longer than its allowance
  // keeps half of that allowance at each end and loses its middle.
  const quiet = (w) => level[w] < loudest * SILENCE;
  const keep = [];
  let voiced = 0;
  let from = 0; // start of the stretch being kept
  let w = 0;
  while (w < count) {
    if (!quiet(w)) {
      voiced++;
      w++;
      continue;
    }
    let end = w;
    while (end < count && quiet(end)) end++;
    const atStart = w === 0;
    const atEnd = end === count;
    const allowed = Math.round(((atStart || atEnd ? EDGE_S : PAUSE_S) * sampleRate) / win); // in windows
    if (end - w > allowed) {
      const head = atStart ? 0 : atEnd ? allowed : Math.ceil(allowed / 2);
      const tail = atStart ? allowed : atEnd ? 0 : Math.floor(allowed / 2);
      if (w + head > 0) keep.push([from, (w + head) * win]);
      from = atEnd ? length : (end - tail) * win;
    }
    w = end;
  }
  if (from < length) keep.push([from, length]);

  const total = keep.reduce((n, [a, b]) => n + (b - a), 0);
  if (total === length) return { channels, before, after: before, voiced: voiced * WINDOW_S };

  const fade = Math.min(Math.round(FADE_S * sampleRate), win);
  const squeezed = channels.map((data) => {
    const out = new Float32Array(total);
    let at = 0;
    keep.forEach(([a, b], n) => {
      out.set(data.subarray(a, b), at);
      const size = b - a;
      const ramp = Math.min(fade, size >> 1);
      for (let i = 0; i < ramp; i++) {
        if (n > 0) out[at + i] *= i / ramp; // in, after a cut
        if (n < keep.length - 1) out[at + size - 1 - i] *= i / ramp; // out, before one
      }
      at += size;
    });
    return out;
  });
  return { channels: squeezed, before, after: total / sampleRate, voiced: voiced * WINDOW_S };
}

/**
 * Whether a recording can be the line it is meant to be, going by how much
 * sound it holds for its length. Returns what is wrong with it, or null.
 */
export function soundsWrong(text, voicedSeconds) {
  if (text.length < SHORTEST_JUDGED || voicedSeconds <= 0) return null;
  const rate = text.length / voicedSeconds;
  if (rate < SLOWEST) return `${voicedSeconds.toFixed(1)} s of sound for ${text.length} characters: more than the words would take`;
  if (rate > FASTEST) return `${voicedSeconds.toFixed(1)} s of sound for ${text.length} characters: too little for all the words`;
  return null;
}
