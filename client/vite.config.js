import { defineConfig, loadEnv } from 'vite';
import cesium from 'vite-plugin-cesium';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// ElevenLabs audio, generated on demand by the dev server and kept as files.
//
//   /voice/<hash>.mp3?text=...   a JARVIS line (src/audio/voice.js);
//                                &keep=0 for a one-off that is not saved
//   /sfx/<name>.mp3              a sound effect (src/audio/sound.js)
//
// The first request for a file that does not exist yet generates it and saves
// it under public/, so every later request, and the production build, is just
// a static file. The API key is read here, on the server, from
// ELEVENLABS_API_KEY in client/.env. It has no VITE_ prefix on purpose: Vite
// never puts it in the browser bundle. With no key the requests fall through
// and the game uses its built-in synth and the browser's own voice.
// ---------------------------------------------------------------------------

// Who speaks. ELEVENLABS_VOICE is a voice's name (looked up in the account's
// own voices, "My Voices" on elevenlabs.io) or a voice id. A Voice Library
// voice has to be added to My Voices before the API will speak with it.
const DEFAULT_VOICE = 'Tony';
// If that voice is not in the account: a calm British premade one.
const FALLBACK_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // "Daniel"
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{20}$/;
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
  const wanted = (env.ELEVENLABS_VOICE || env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE).trim();
  const publicDir = path.resolve(process.cwd(), 'public');
  const pending = new Map(); // file -> Promise, so one file is only generated once
  let voice = null; // Promise<voice id>, resolved on the first line spoken
  let voiceSettled = false; // the saved lines are known to be in that voice

  async function get(url) {
    const res = await fetch(url, { headers: { 'xi-api-key': key } });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  // Turn ELEVENLABS_VOICE into a voice id: an id is used as it is; a name is
  // matched against the account's voices (exact name first, then "contains").
  async function findVoice() {
    if (VOICE_ID_PATTERN.test(wanted)) return wanted;
    const name = wanted.toLowerCase();
    try {
      const { voices = [] } = await get(`https://api.elevenlabs.io/v2/voices?page_size=100&search=${encodeURIComponent(wanted)}`);
      const match =
        voices.find((v) => v.name.toLowerCase() === name) ||
        voices.find((v) => v.name.toLowerCase().split(/[\s\-–—]+/).includes(name)) ||
        voices.find((v) => v.name.toLowerCase().includes(name));
      if (match) {
        console.log(`[audio] JARVIS speaks with "${match.name}" (${match.voice_id})`);
        return match.voice_id;
      }
      // Not in the account. Say what the Voice Library has under that name.
      const { voices: shared = [] } = await get(`https://api.elevenlabs.io/v1/shared-voices?page_size=5&search=${encodeURIComponent(wanted)}`).catch(() => ({}));
      console.warn(`[audio] No voice named "${wanted}" in this ElevenLabs account; using the fallback voice.`);
      if (shared.length) {
        console.warn('[audio] Voice Library matches (add one to My Voices on elevenlabs.io, or set ELEVENLABS_VOICE to its id):');
        for (const v of shared) console.warn(`[audio]   ${v.name}  ${v.voice_id}`);
      }
    } catch (err) {
      console.warn(`[audio] voice lookup failed (${err.message}); using the fallback voice.`);
    }
    return FALLBACK_VOICE_ID;
  }

  // Saved lines belong to the voice that spoke them: on a change of voice the
  // old ones are cleared, or JARVIS would switch voices mid-flight.
  function claimVoiceFolder(voiceId) {
    const dir = path.join(publicDir, 'voice');
    const stamp = path.join(dir, '.voice');
    fs.mkdirSync(dir, { recursive: true });
    const previous = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : null;
    if (previous === voiceId) return;
    if (previous) {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.mp3')) fs.unlinkSync(path.join(dir, f));
      console.log('[audio] voice changed: cleared the saved JARVIS lines');
    }
    fs.writeFileSync(stamp, voiceId);
  }

  function voiceId() {
    voice ??= findVoice().then((id) => {
      claimVoiceFolder(id);
      voiceSettled = true;
      return id;
    });
    return voice;
  }

  async function request(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const speech = async (text) =>
    request(`https://api.elevenlabs.io/v1/text-to-speech/${await voiceId()}?output_format=mp3_44100_128`, {
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
    if (kind === 'voice' && !voiceSettled) {
      // First line since the server started: settle whose voice the saved
      // lines are in before serving (or clearing) any of them.
      voiceId()
        .catch(() => {})
        .finally(() => {
          voiceSettled = true; // even on failure: never ask twice for one request
          middleware(req, res, next);
        });
      return;
    }
    if (fs.existsSync(file)) return next(); // already generated: a static file

    let make;
    let keep = true;
    if (kind === 'sfx') {
      if (!SFX_PROMPTS[name]) return next();
      make = () => effect(SFX_PROMPTS[name]);
    } else {
      const text = (url.searchParams.get('text') || '').trim();
      // The hash check means this can only ever write the file for that text.
      if (!text || text.length > MAX_LINE_LENGTH || lineHash(text) !== name) return next();
      make = () => speech(text);
      keep = url.searchParams.get('keep') !== '0';
    }

    if (!pending.has(file)) {
      pending.set(
        file,
        make()
          .then((audio) => {
            if (keep) {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, audio);
            }
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

// ---------------------------------------------------------------------------
// Talking to JARVIS: POST /api/jarvis { text, context, history } -> { reply,
// action, site? }. The pilot's words and a snapshot of the flight go to Grok
// (xAI), which answers in character and picks one of the actions the game
// knows how to carry out (src/jarvis/assistant.js). The key is GROK_API_KEY in
// client/.env, read only here. With no key the route is not served and the
// game falls back to its own phrase matcher.
// ---------------------------------------------------------------------------

const GROK_URL = 'https://api.x.ai/v1/chat/completions';
const DEFAULT_GROK_MODEL = 'grok-4-fast-non-reasoning';
const MAX_BODY_BYTES = 8192;

// Kept in step with ACTIONS in src/jarvis/assistant.js and SITES in src/sites.js.
const JARVIS_ACTIONS = ['none', 'start_drones', 'start_fire', 'start_run', 'end_mission', 'mute', 'unmute', 'reset_position', 'switch_view', 'change_site'];
const JARVIS_SITES = ['jhu', 'umd', 'statue-of-liberty', 'national-mall', 'golden-gate', 'grand-canyon', 'santa-monica-pier', 'griffith-observatory'];

const JARVIS_PROMPT = `You are JARVIS, the AI inside the pilot's flying armoured suit in the game IRON GLOVE. You are speaking aloud into their helmet.

Voice: calm, precise, British, dry wit. Never address the pilot as "sir" (or by any title). One or two short sentences, under 180 characters, plain spoken English: no markdown, lists, emoji or stage directions.

Each message from the pilot comes with TELEMETRY, the live state of the flight. Use it to answer questions about the suit, the mission or where they are. Do not invent readings that are not in it.

Choose exactly one action:
- none: just talk.
- start_drones: launch the drone strike mission (four hostile drones, two shoot back).
- start_fire: launch the fire response mission (put out five fires with the water cannon, hold F).
- start_run: launch the downtown run (a timed course of twelve gates).
- end_mission: end whichever mission is running.
- mute / unmute: the game's sound.
- reset_position: put the suit back at the arrival point.
- switch_view: cycle the camera to another pilot's suit.
- change_site: fly somewhere else. Set "site" to one of: jhu (Johns Hopkins, Baltimore), umd (University of Maryland, College Park), statue-of-liberty, national-mall (Washington DC), golden-gate (San Francisco), grand-canyon, santa-monica-pier, griffith-observatory (Los Angeles). This reloads the game, so only do it when clearly asked.

Only act when the pilot asks for it. If a mission is already running and they ask for another, tell them to end the current one first and use "none". If they ask for something the suit cannot do, say so with good grace.`;

const JARVIS_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: JARVIS_ACTIONS },
    site: { type: 'string', enum: [...JARVIS_SITES, ''] },
  },
  required: ['reply', 'action', 'site'],
  additionalProperties: false,
};

function jarvisBrain(env) {
  // GROK_API_KEY is the documented name; the others are accepted so an
  // existing key does not have to be renamed.
  const key = env.GROK_API_KEY || env.XAI_API_KEY || env.VITE_GROK_API_KEY;
  const model = env.GROK_MODEL || DEFAULT_GROK_MODEL;

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) reject(new Error('request too large'));
        else chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function think({ text, context, history }) {
    const messages = [{ role: 'system', content: JARVIS_PROMPT }];
    for (const turn of Array.isArray(history) ? history.slice(-12) : []) {
      if (typeof turn?.text !== 'string') continue;
      messages.push({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.text.slice(0, 400) });
    }
    messages.push({
      role: 'user',
      content: `TELEMETRY: ${JSON.stringify(context ?? {}).slice(0, 1200)}\n\nPILOT: ${String(text).slice(0, 400)}`,
    });
    const res = await fetch(GROK_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 300,
        response_format: { type: 'json_schema', json_schema: { name: 'jarvis_answer', strict: true, schema: JARVIS_SCHEMA } },
      }),
    });
    if (!res.ok) throw new Error(`Grok ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const answer = JSON.parse(data.choices[0].message.content);
    return {
      reply: String(answer.reply || '').slice(0, 220),
      action: JARVIS_ACTIONS.includes(answer.action) ? answer.action : 'none',
      site: JARVIS_SITES.includes(answer.site) ? answer.site : undefined,
    };
  }

  function middleware(req, res, next) {
    if (req.method !== 'POST' || !key) return next();
    readBody(req)
      .then((body) => think(JSON.parse(body)))
      .then((answer) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer));
      })
      .catch((err) => {
        console.warn(`[jarvis] ${err.message}`);
        res.statusCode = 502;
        res.end();
      });
  }

  return {
    name: 'iron-glove-jarvis',
    configureServer(server) {
      if (!key) console.log('[jarvis] GROK_API_KEY not set: voice commands use the built-in phrase matcher');
      server.middlewares.use('/api/jarvis', middleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [cesium(), elevenLabsAudio(env), jarvisBrain(env)],
    server: {
      port: 5173,
      host: true,
    },
  };
});
