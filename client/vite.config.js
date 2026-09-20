import { defineConfig, loadEnv } from 'vite';
import cesium from 'vite-plugin-cesium';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// ElevenLabs audio, generated on demand by the dev server and kept as files.
//
//   /voice/<hash>.mp3?text=...   a JARVIS line (src/audio/voice.js)
//   /sfx/<name>.mp3              a sound effect (src/audio/sound.js)
//
// The first request for a file that does not exist yet generates it and saves
// it under public/, so every later request, and the production build, is just
// a static file. The API key is read here, on the server, from
// ELEVENLABS_API_KEY in client/.env. It has no VITE_ prefix on purpose: Vite
// never puts it in the browser bundle. With no key the requests fall through
// and the game uses its built-in synth and the browser's own voice.
// ---------------------------------------------------------------------------

// A calm British male premade voice. Override with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // "Daniel"
const MAX_LINE_LENGTH = 220;

// name -> [prompt, seconds]. Names match RECORDED in src/audio/sound.js.
const SFX_PROMPTS = {
  explosion: ['A large mid-air explosion of a metal drone, deep boom with debris and a short rumbling tail', 2.5],
  missile: ['A small guided micro-missile launching from a shoulder pod, sharp ignition hiss and a fast whoosh away', 1.5],
  repulsor: ['A sci-fi energy repulsor blast, a rising electric charge whine then a powerful plasma discharge thump', 1.5],
  boost: ['A jet thruster afterburner kicking in, a sudden roaring whoosh surge', 1.5],
  hit: ['A metal armour suit struck by a missile, heavy metallic impact clang with electrical sparks', 1.2],
  extinguish: ['A fire being put out by a blast of water, loud steam hiss and sizzle fading out', 2],
  missionStart: ['A futuristic heads-up display powering up, rising digital synth swell with confirmation beeps', 2],
  missionComplete: ['A triumphant futuristic mission complete chime, bright uplifting synth fanfare', 2.5],
  arrive: ['A high-tech armour suit powering up, deep reactor hum rising into a bright energy shimmer', 3],
};

// FNV-1a, as hex: the same hash src/audio/voice.js names its lines with.
function lineHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function elevenLabsAudio(env) {
  const key = env.ELEVENLABS_API_KEY;
  const voiceId = env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const publicDir = path.resolve(process.cwd(), 'public');
  const pending = new Map(); // file -> Promise, so one file is only generated once

  async function request(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const speech = (text) =>
    request(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      text,
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.6, similarity_boost: 0.8, speed: 1.05 },
    });

  const effect = ([prompt, seconds]) =>
    request('https://api.elevenlabs.io/v1/sound-generation', {
      text: prompt,
      duration_seconds: seconds,
      prompt_influence: 0.45,
    });

  function middleware(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    const match = /^\/(voice|sfx)\/([\w-]+)\.mp3$/.exec(url.pathname);
    if (!match || !key) return next();
    const [, kind, name] = match;
    const file = path.join(publicDir, kind, `${name}.mp3`);
    if (fs.existsSync(file)) return next(); // already generated: a static file

    let make;
    if (kind === 'sfx') {
      if (!SFX_PROMPTS[name]) return next();
      make = () => effect(SFX_PROMPTS[name]);
    } else {
      const text = (url.searchParams.get('text') || '').trim();
      // The hash check means this can only ever write the file for that text.
      if (!text || text.length > MAX_LINE_LENGTH || lineHash(text) !== name) return next();
      make = () => speech(text);
    }

    if (!pending.has(file)) {
      pending.set(
        file,
        make()
          .then((audio) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, audio);
            return audio;
          })
          .finally(() => pending.delete(file)),
      );
    }
    pending
      .get(file)
      .then((audio) => {
        res.setHeader('content-type', 'audio/mpeg');
        res.setHeader('cache-control', 'no-cache');
        res.end(audio);
      })
      .catch((err) => {
        console.warn(`[audio] ${kind}/${name}: ${err.message}`);
        res.statusCode = 502;
        res.end();
      });
  }

  return {
    name: 'iron-glove-elevenlabs-audio',
    configureServer(server) {
      if (!key) console.log('[audio] ELEVENLABS_API_KEY not set: using the built-in synth and browser voice');
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [cesium(), elevenLabsAudio(loadEnv(mode, process.cwd(), ''))],
  server: {
    port: 5173,
    host: true,
  },
}));
