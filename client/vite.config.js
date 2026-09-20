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
//
// Every request to ElevenLabs costs credits, so:
//   - A saved line is never bought twice. The folder's stamp (public/voice/
//     .voice) records whose voice the lines are in, the ELEVENLABS_VOICE it was
//     looked up for and the model chosen for it, so a restart asks ElevenLabs
//     nothing; and a lookup
//     that merely fails (offline, rate limited, a key without voice access)
//     keeps that voice instead of switching to the fallback one, which would
//     throw every saved line away.
//   - One request at a time. A page load asks for nine effects and a line at
//     once, and a plan's concurrency limit turns that into failures that come
//     back on every reload. After a failure nothing new is bought for a while.
//   - A line that cannot be bought right now is answered 204: the game shows
//     it in the ticker and stays quiet, rather than change voices for it.
//   - ELEVENLABS_RECORD=off plays what is saved and buys nothing at all.
//   - Every purchase is logged with a running count.
// public/voice/index.json lists the lines on file, so the game can tell which
// takes of a line already have a recording (src/audio/voice.js).
// ---------------------------------------------------------------------------

// Who speaks. ELEVENLABS_VOICE is a voice's name (looked up in the account's
// own voices, "My Voices" on elevenlabs.io) or a voice id. A Voice Library
// voice has to be added to My Voices before the API will speak with it.
const DEFAULT_VOICE = 'Tony';
// If that voice is not in the account: a calm British premade one.
const FALLBACK_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // "Daniel"
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{20}$/;
const MAX_LINE_LENGTH = 220;

// Which model speaks, and how. A line is bought once and kept, so how long a
// request takes hardly matters and how well the voice survives the model does:
// on the low-latency flash model a cloned voice rushed every line and, one line
// in three, dropped words or left seconds of dead air in the middle of it. A
// voice lists the models it is rated for (high_quality_base_model_ids): the
// first of these it lists is used, or ELEVENLABS_MODEL if that is set. Turbo
// v2.5 costs the same per character as flash v2.5; multilingual v2 is the
// steadiest of all and costs twice that.
const MODEL_PREFERENCE = ['eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2', 'eleven_flash_v2'];
// These guess the language from the text unless told, and a three-word line
// ("Fox three.") is easy to guess wrong.
const TAKES_LANGUAGE = ['eleven_turbo_v2_5', 'eleven_flash_v2_5'];
// Steady and unhurried: JARVIS is calm, and a line is only heard over the jets.
const VOICE_SETTINGS = { stability: 0.75, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 };
const PAUSE_AFTER_FAILURE_MS = 60 * 1000; // after a failed request, nothing new is bought for this long
const RETRY_FAILED_MS = 5 * 60 * 1000; // and the file that failed is left alone for this long

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
  const wantedModel = (env.ELEVENLABS_MODEL || '').trim();
  // ELEVENLABS_RECORD=off: play what is saved, buy nothing new.
  const recording = !/^(off|0|false|no)$/i.test((env.ELEVENLABS_RECORD || '').trim());
  const publicDir = path.resolve(process.cwd(), 'public');
  const voiceDir = path.join(publicDir, 'voice');
  const stampFile = path.join(voiceDir, '.voice');
  const pending = new Map(); // file -> Promise, so one file is only generated once
  const failedAt = new Map(); // file -> when buying it last failed
  let pausedUntil = 0; // nothing new is bought before this (a request has just failed)
  let keyRejected = false; // ElevenLabs refused the key: carry on as if there were none
  let queue = Promise.resolve(); // the requests to ElevenLabs, one after another
  let bought = 0; // purchases since the server started
  let voice = null; // Promise<voice id>, resolved on the first line spoken
  let voiceSettled = false; // the saved lines are known to be in that voice

  async function get(url) {
    const res = await fetch(url, { headers: { 'xi-api-key': key } });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  // The stamp, a line each: the voice id the saved lines are in, the
  // ELEVENLABS_VOICE name that id was looked up for (empty if it never was), and
  // the model chosen for that voice. With all three a restart asks nothing.
  function readStamp() {
    if (!fs.existsSync(stampFile)) return null;
    const [id, name = '', model = ''] = fs.readFileSync(stampFile, 'utf8').split('\n').map((s) => s.trim());
    return VOICE_ID_PATTERN.test(id) ? { id, name, model } : null;
  }

  // The model for a voice rated for `rated` (ids, best guess first when empty).
  function chooseModel(rated = []) {
    if (wantedModel) return wantedModel;
    return MODEL_PREFERENCE.find((m) => rated.includes(m)) ?? MODEL_PREFERENCE[0];
  }

  // The lines on file, for the game (src/audio/voice.js). Ships with the build.
  function writeIndex() {
    if (!fs.existsSync(voiceDir)) return;
    const hashes = fs.readdirSync(voiceDir).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(0, -4)).sort();
    const file = path.join(voiceDir, 'index.json');
    const json = JSON.stringify(hashes);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== json) fs.writeFileSync(file, json);
    return hashes.length;
  }

  // Turn ELEVENLABS_VOICE into a voice and the model to speak it with: an id is
  // used as it is; a name is matched against the account's voices (exact name
  // first, then "contains"). `name` is set when the id came from looking that
  // name up. Looking a voice up costs no credits, and the stamp spares the next
  // start even that.
  async function findVoice() {
    const stamp = readStamp();
    const byId = VOICE_ID_PATTERN.test(wanted);
    const known = stamp && (byId ? stamp.id === wanted : stamp.name === wanted);
    // Looked up before: nothing to ask. (ELEVENLABS_MODEL needs no rating either.)
    if (known && (stamp.model || wantedModel)) return { ...stamp, model: wantedModel || stamp.model };
    const name = wanted.toLowerCase();
    try {
      if (byId) {
        const voice = await get(`https://api.elevenlabs.io/v1/voices/${wanted}`);
        const model = chooseModel(voice.high_quality_base_model_ids);
        console.log(`[audio] JARVIS speaks with "${voice.name}" (${wanted}) on ${model}`);
        return { id: wanted, name: '', model };
      }
      const { voices = [] } = await get(`https://api.elevenlabs.io/v2/voices?page_size=100&search=${encodeURIComponent(wanted)}`);
      const match =
        voices.find((v) => v.name.toLowerCase() === name) ||
        voices.find((v) => v.name.toLowerCase().split(/[\s\-–—]+/).includes(name)) ||
        voices.find((v) => v.name.toLowerCase().includes(name));
      if (match) {
        const model = chooseModel(match.high_quality_base_model_ids);
        console.log(`[audio] JARVIS speaks with "${match.name}" (${match.voice_id}) on ${model}`);
        return { id: match.voice_id, name: wanted, model };
      }
      // Not in the account. Say what the Voice Library has under that name.
      const { voices: shared = [] } = await get(`https://api.elevenlabs.io/v1/shared-voices?page_size=5&search=${encodeURIComponent(wanted)}`).catch(() => ({}));
      console.warn(`[audio] No voice named "${wanted}" in this ElevenLabs account; using the fallback voice.`);
      if (shared.length) {
        console.warn('[audio] Voice Library matches (add one to My Voices on elevenlabs.io, or set ELEVENLABS_VOICE to its id):');
        for (const v of shared) console.warn(`[audio]   ${v.name}  ${v.voice_id}`);
      }
    } catch (err) {
      // Could not ask. That is no reason to change voices: it would throw away
      // every saved line, and again when the next lookup succeeds. The name and
      // model stay unvouched for, so the next start asks again.
      if (byId || stamp) {
        const id = byId ? wanted : stamp.id;
        console.warn(`[audio] voice lookup failed (${err.message}); staying with ${id}.`);
        return { id, name: '', model: '', speakWith: chooseModel() };
      }
      console.warn(`[audio] voice lookup failed (${err.message}); using the fallback voice.`);
    }
    return { id: FALLBACK_VOICE_ID, name: '', model: '', speakWith: chooseModel() }; // a premade voice: good on any model
  }

  // Saved lines belong to the voice that spoke them: on a change of voice the
  // old ones are cleared, or JARVIS would switch voices mid-flight. (A change
  // of model leaves them be: delete public/voice/*.mp3 to have them re-recorded.)
  function claimVoiceFolder({ id, name, model }) {
    fs.mkdirSync(voiceDir, { recursive: true });
    const previous = readStamp();
    if (previous && previous.id !== id) {
      const old = fs.readdirSync(voiceDir).filter((f) => f.endsWith('.mp3'));
      for (const f of old) fs.unlinkSync(path.join(voiceDir, f));
      console.log(`[audio] voice changed (${previous.id} -> ${id}): cleared ${old.length} saved JARVIS lines`);
    }
    if (!previous || previous.id !== id || previous.name !== name || previous.model !== model) {
      fs.writeFileSync(stampFile, name || model ? `${id}\n${name}\n${model}\n` : id);
    }
    writeIndex();
  }

  // -> { id, model }: who speaks, and on which model.
  function voiceId() {
    voice ??= findVoice().then((found) => {
      claimVoiceFolder(found);
      voiceSettled = true;
      return { id: found.id, model: found.model || found.speakWith };
    });
    return voice;
  }

  // The voice the stamp vouches for is gone from the account: look it up afresh.
  function forgetVoice() {
    const stamp = readStamp();
    if (stamp?.name || stamp?.model) fs.writeFileSync(stampFile, stamp.id);
    voice = null;
    voiceSettled = false;
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

  const speech = async (text) => {
    try {
      const { id, model } = await voiceId();
      return await request(`https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`, {
        text,
        model_id: model,
        ...(TAKES_LANGUAGE.includes(model) ? { language_code: 'en' } : {}),
        voice_settings: VOICE_SETTINGS,
      });
    } catch (err) {
      if (/voice_not_found/i.test(err.message)) forgetVoice();
      throw err;
    }
  };

  const effect = ([prompt, seconds]) =>
    request('https://api.elevenlabs.io/v1/sound-generation', {
      text: prompt,
      duration_seconds: seconds,
      prompt_influence: 0.45,
    });

  // Run `make` once everything asked for before it has finished.
  function inTurn(make) {
    const run = queue.then(make, make);
    queue = run.catch(() => {});
    return run;
  }

  // Why a missing file will not be bought right now, or null if it will be.
  function declined(file) {
    if (!recording) return 'recording is off';
    if (Date.now() < pausedUntil) return 'paused after a failed request';
    if (Date.now() - (failedAt.get(file) ?? -Infinity) < RETRY_FAILED_MS) return 'it failed a moment ago';
    return null;
  }

  function middleware(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    const match = /^\/(voice|sfx)\/([\w-]+)\.mp3$/.exec(url.pathname);
    if (!match || !key || keyRejected) return next();
    const [, kind, name] = match;
    const file = path.join(publicDir, kind, `${name}.mp3`);
    if (kind === 'voice' && !voiceSettled && recording) {
      // First line since the server started: settle whose voice the saved
      // lines are in before serving (or clearing) any of them. (With recording
      // off nothing is asked of ElevenLabs, not even that.)
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
    let what;
    if (kind === 'sfx') {
      if (!SFX_PROMPTS[name]) return next();
      make = () => effect(SFX_PROMPTS[name]);
      what = `effect "${name}"`;
    } else {
      const text = (url.searchParams.get('text') || '').trim();
      // The hash check means this can only ever write the file for that text.
      if (!text || text.length > MAX_LINE_LENGTH || lineHash(text) !== name) return next();
      make = () => speech(text);
      keep = url.searchParams.get('keep') !== '0';
      what = `line "${text}"${keep ? '' : ' (one-off, not saved)'}`;
    }

    // Not bought: an effect falls back to the synth; a line is answered 204, so
    // the game shows it and stays quiet rather than change voices for it.
    const pass = () => {
      if (kind === 'sfx') return next();
      res.statusCode = 204;
      res.end();
    };
    if (!pending.has(file) && declined(file)) return pass();

    if (!pending.has(file)) {
      pending.set(
        file,
        inTurn(async () => {
          // Something ahead of it in the queue may have just failed.
          const reason = declined(file);
          if (reason) throw Object.assign(new Error(reason), { declined: true });
          const audio = await make();
          if (keep) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, audio);
            if (kind === 'voice') writeIndex();
          }
          console.log(`[audio] bought #${++bought}: ${what}`);
          return audio;
        })
          .catch((err) => {
            if (!err.declined) {
              failedAt.set(file, Date.now());
              pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS;
              keyRejected ||= /invalid_api_key/i.test(err.message);
              console.warn(`[audio] ${kind}/${name}: ${err.message}`);
              console.warn(
                keyRejected
                  ? '[audio] ElevenLabs refused the key: using the built-in synth and browser voice'
                  : `[audio] buying nothing new for ${PAUSE_AFTER_FAILURE_MS / 1000} s`,
              );
            }
            throw err;
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
      .catch(() => (keyRejected ? next() : pass()));
  }

  return {
    name: 'iron-glove-elevenlabs-audio',
    configureServer(server) {
      const onFile = writeIndex() ?? 0; // also without a key: the saved lines still play
      if (!key) console.log('[audio] ELEVENLABS_API_KEY not set: using the built-in synth and browser voice');
      else if (!recording) console.log(`[audio] ELEVENLABS_RECORD is off: playing the ${onFile} saved JARVIS lines, buying nothing`);
      else console.log(`[audio] ${onFile} JARVIS lines on file; a new one is bought the first time it is spoken (ELEVENLABS_RECORD=off stops that)`);
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
