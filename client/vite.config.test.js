import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shownLine, spokenLine } from './src/jarvis/line.js';

// The dev server's ElevenLabs middleware (vite.config.js), without ElevenLabs:
// fetch is a stand-in that counts what it is asked, the project is a temp
// folder, and the clock is ours. What matters is what gets bought, and when.

const ACCOUNT_VOICE = 'ICwKbPHDHAM3eal5tHEZ'; // what "Tony" resolves to in the pretend account
const FALLBACK_VOICE = 'onwK4e9ZLuTAKqWW03F9';
const TURBO = 'eleven_turbo_v2_5';
const MULTILINGUAL = 'eleven_multilingual_v2';
// A complete stamp: the voice id, the name it was looked up for, the model chosen for it.
const FULL_STAMP = [ACCOUNT_VOICE, 'Tony', TURBO, ''].join('\n');
const configUrl = new URL('./vite.config.js', import.meta.url);

function lineHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const lineUrl = (text, extra = '') => `/voice/${lineHash(text)}.mp3?text=${encodeURIComponent(text)}${extra}`;

// ---- The pretend ElevenLabs ----
let calls = []; // every request made, as 'lookup' | 'speech' | 'effect'
let speaking = 0;
let mostAtOnce = 0;
let api = {}; // per test: { lookup, speech } overrides
let spokenWith = null; // the voice id of the last speech request
let spoken = null; // and its body
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  url = String(url);
  const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  if (url.includes('/v2/voices') || url.includes('/shared-voices') || /\/v1\/voices\/\w+$/.test(url)) {
    calls.push('lookup');
    if (api.lookup) return api.lookup(reply, url);
    const tony = { name: 'Tony', voice_id: ACCOUNT_VOICE, high_quality_base_model_ids: api.rated ?? ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'] };
    return reply(200, url.includes('/v1/voices/') ? tony : { voices: [tony] });
  }
  const kind = url.includes('/text-to-speech/') ? 'speech' : 'effect';
  calls.push(kind);
  if (kind === 'speech') {
    spokenWith = url.split('/text-to-speech/')[1].split('?')[0];
    spoken = JSON.parse(init.body);
  }
  mostAtOnce = Math.max(mostAtOnce, ++speaking);
  await new Promise((resolve) => setTimeout(resolve, 5));
  speaking--;
  if (api.speech) return api.speech(reply, JSON.parse(init.body));
  return new Response(Buffer.from('mp3'), { status: 200 });
};

// ---- A project folder and a server over it ----
const made = [];
async function project({ env = '', voice = 'Tony', stamp = null, saved = [], rated } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-glove-audio-'));
  made.push(dir);
  fs.writeFileSync(path.join(dir, '.env'), `ELEVENLABS_API_KEY=pretend\nELEVENLABS_VOICE=${voice}\n${env}\n`);
  const voiceDir = path.join(dir, 'public', 'voice');
  fs.mkdirSync(voiceDir, { recursive: true });
  if (stamp !== null) fs.writeFileSync(path.join(voiceDir, '.voice'), stamp);
  for (const text of saved) fs.writeFileSync(path.join(voiceDir, `${lineHash(text)}.mp3`), 'mp3');

  process.chdir(dir);
  const { default: config } = await import(`${configUrl.href}?${made.length}`);
  const plugin = config({ mode: 'test', command: 'serve' }).plugins.flat().find((p) => p?.name === 'iron-glove-elevenlabs-audio');
  let middleware;
  plugin.configureServer({ middlewares: { use: (fn) => (middleware = fn) } });

  calls = [];
  mostAtOnce = 0;
  api = { rated };
  return {
    voiceDir,
    stamp: () => fs.readFileSync(path.join(voiceDir, '.voice'), 'utf8'),
    onFile: () => fs.readdirSync(voiceDir).filter((f) => f.endsWith('.mp3')).length,
    index: () => JSON.parse(fs.readFileSync(path.join(voiceDir, 'index.json'), 'utf8')),
    // -> 'static' (left to Vite: a saved file, or no voice at all) | 'audio' | 'quiet' (204)
    ask: (url) =>
      new Promise((resolve) => {
        const res = {
          statusCode: 200,
          setHeader() {},
          end: (body) => resolve(res.statusCode === 204 ? 'quiet' : body ? 'audio' : `status ${res.statusCode}`),
        };
        middleware({ url }, res, () => resolve('static'));
      }),
  };
}

const realNow = Date.now;
let ahead = 0;
Date.now = () => realNow() + ahead;

// The server's running commentary ("bought #3: ...") is not the test's.
const say = console.log.bind(console);
const { log, warn } = console;
console.log = console.warn = () => {};

try {
  // ---- A restart asks ElevenLabs nothing, and a saved line costs nothing ----
  let p = await project({ stamp: FULL_STAMP, saved: ['Missile away.'] });
  assert.deepEqual(p.index(), [lineHash('Missile away.')], 'the index is written on start');
  assert.equal(await p.ask(lineUrl('Missile away.')), 'static');
  assert.deepEqual(calls, [], 'a saved line: not one request');
  assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');
  assert.deepEqual(calls, ['speech'], 'a new line: the speech request and nothing else, no voice lookup');
  assert.equal(spokenWith, ACCOUNT_VOICE);
  assert.deepEqual(p.index().sort(), [lineHash('Fox three.'), lineHash('Missile away.')].sort(), 'and it joins the index');
  assert.equal(await p.ask(lineUrl('Fox three.')), 'static', 'bought once');
  assert.deepEqual(calls, ['speech']);

  // ---- How he is asked to speak: a model the voice is rated for, in English, steadily ----
  assert.equal(spoken.text, 'Fox three.');
  assert.equal(spoken.model_id, TURBO);
  assert.equal(spoken.language_code, 'en', 'a three-word line is not left to language detection');
  assert.deepEqual(spoken.voice_settings, { stability: 0.75, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 });

  // A voice rated only for the multilingual model gets that one (which takes no language code).
  p = await project({ stamp: ACCOUNT_VOICE, rated: [MULTILINGUAL] });
  assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');
  assert.equal(spoken.model_id, MULTILINGUAL);
  assert.ok(!('language_code' in spoken));
  assert.equal(p.stamp(), [ACCOUNT_VOICE, 'Tony', MULTILINGUAL, ''].join('\n'));

  // A voice that says nothing about models gets the first choice.
  p = await project({ stamp: ACCOUNT_VOICE, rated: [] });
  assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');
  assert.equal(spoken.model_id, TURBO);

  // ELEVENLABS_MODEL overrides, and then there is nothing to look up.
  p = await project({ env: `ELEVENLABS_MODEL=${MULTILINGUAL}`, stamp: [ACCOUNT_VOICE, 'Tony', ''].join('\n'), saved: ['Missile away.'] });
  assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');
  assert.deepEqual(calls, ['speech']);
  assert.equal(spoken.model_id, MULTILINGUAL);
  assert.equal(p.onFile(), 2, 'a change of model leaves the saved lines alone');

  // A voice given by id is asked about once, by id.
  p = await project({ voice: ACCOUNT_VOICE });
  assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');
  assert.deepEqual(calls, ['lookup', 'speech']);
  assert.equal(p.stamp(), [ACCOUNT_VOICE, '', TURBO, ''].join('\n'));
  p = await project({ voice: ACCOUNT_VOICE, stamp: [ACCOUNT_VOICE, '', TURBO, ''].join('\n') });
  assert.equal(await p.ask(lineUrl('Bird away.')), 'audio');
  assert.deepEqual(calls, ['speech']);

  // ---- An older stamp (no model, or no name either): one lookup, remembered; the saved lines stay ----
  for (const stamp of [ACCOUNT_VOICE, [ACCOUNT_VOICE, 'Tony', ''].join('\n')]) {
    p = await project({ stamp, saved: ['Missile away.', 'Splash one.'] });
    assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');
    assert.deepEqual(calls, ['lookup', 'speech']);
    assert.equal(p.stamp(), FULL_STAMP, 'the stamp now vouches for the name and the model');
    assert.equal(p.onFile(), 3, 'nothing was thrown away');
  }

  // ---- A lookup that FAILS is not a change of voice ----
  p = await project({ stamp: ACCOUNT_VOICE, saved: ['Missile away.', 'Splash one.'] });
  api.lookup = (reply) => reply(429, 'too_many_requests');
  assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');
  assert.equal(p.onFile(), 3, 'the saved lines survive a failed lookup');
  assert.equal(spokenWith, ACCOUNT_VOICE, 'and he keeps the voice they are in, not the fallback');
  assert.equal(spoken.model_id, TURBO);
  assert.equal(p.stamp(), ACCOUNT_VOICE, 'unvouched for, so the next start asks again');

  // ...while a voice that really is different still starts the folder afresh.
  p = await project({ stamp: FALLBACK_VOICE, saved: ['Missile away.', 'Splash one.'] });
  assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');
  assert.equal(p.onFile(), 1, 'the other voice\'s lines are cleared');
  assert.deepEqual(p.index(), [lineHash('Fox three.')]);
  assert.equal(p.stamp(), FULL_STAMP);

  // ---- One request at a time ----
  p = await project({ stamp: FULL_STAMP });
  const burst = ['explosion', 'missile', 'repulsor', 'boost', 'hit'].map((name) => p.ask(`/sfx/${name}.mp3`));
  burst.push(p.ask(lineUrl('Suit online.')), p.ask(lineUrl('Suit online.')));
  assert.deepEqual(await Promise.all(burst), Array(7).fill('audio'));
  assert.equal(mostAtOnce, 1, 'never two requests in flight');
  assert.equal(calls.length, 6, 'and the same line asked for twice is bought once');

  // ---- After a failure: quiet, not hammering ----
  p = await project({ stamp: FULL_STAMP, saved: ['Missile away.'] });
  assert.equal(await p.ask(lineUrl('Missile away.')), 'static'); // settles the voice, so the burst below queues in order
  api.speech = (reply) => reply(429, '{"detail":{"status":"too_many_concurrent_requests"}}');
  const refused = [p.ask(lineUrl('Fox three.')), p.ask(lineUrl('Bird away.')), p.ask('/sfx/explosion.mp3')];
  assert.deepEqual(await Promise.all(refused), ['quiet', 'quiet', 'static'], 'a refused line is a 204; an effect falls to the synth');
  assert.deepEqual(calls, ['speech'], 'what was queued behind the failure was not sent');
  api = {};
  assert.equal(await p.ask(lineUrl('Launching.')), 'quiet');
  assert.equal(await p.ask(lineUrl('Missile away.')), 'static', 'saved lines still play during the pause');
  assert.deepEqual(calls, ['speech'], 'nothing new is bought for a minute');
  ahead += 61 * 1000;
  assert.equal(await p.ask(lineUrl('Launching.')), 'audio', 'then buying resumes');
  assert.equal(await p.ask(lineUrl('Fox three.')), 'quiet', 'but the one that failed is left alone for five minutes');
  ahead += 5 * 60 * 1000;
  assert.equal(await p.ask(lineUrl('Fox three.')), 'audio');

  // ---- ELEVENLABS_RECORD=off: what is saved, and not a single request ----
  p = await project({ env: 'ELEVENLABS_RECORD=off', stamp: ACCOUNT_VOICE, saved: ['Missile away.'] });
  assert.equal(await p.ask(lineUrl('Missile away.')), 'static');
  assert.equal(await p.ask(lineUrl('Fox three.')), 'quiet');
  assert.equal(await p.ask('/sfx/explosion.mp3'), 'static');
  assert.deepEqual(calls, [], 'not even the voice lookup');

  // ---- A one-off (a reply to the pilot) is spoken but never saved ----
  p = await project({ stamp: FULL_STAMP });
  assert.equal(await p.ask(lineUrl('Suit integrity 82 percent, 140 metres up.', '&keep=0')), 'audio');
  assert.equal(p.onFile(), 0);
  assert.deepEqual(p.index(), []);

  // ---- A key ElevenLabs refuses is no key: the browser's voice, the synth ----
  p = await project({ stamp: FULL_STAMP });
  api.speech = (reply) => reply(401, '{"detail":{"status":"invalid_api_key"}}');
  assert.equal(await p.ask(lineUrl('Fox three.')), 'static');
  assert.equal(await p.ask(lineUrl('Bird away.')), 'static');
  assert.deepEqual(calls, ['speech'], 'asked once, then never again');

  // ---- A voice deleted from the account is looked up again ----
  p = await project({ stamp: ['x'.repeat(20), 'Tony', TURBO, ''].join('\n') });
  api.speech = (reply) => (spokenWith === ACCOUNT_VOICE ? new Response(Buffer.from('mp3')) : reply(404, '{"detail":{"status":"voice_not_found"}}'));
  assert.equal(await p.ask(lineUrl('Fox three.')), 'quiet');
  ahead += 61 * 1000;
  assert.equal(await p.ask(lineUrl('Bird away.')), 'audio');
  assert.equal(spokenWith, ACCOUNT_VOICE);
  assert.deepEqual(calls, ['speech', 'lookup', 'speech']);

  // ---- Figures in {braces} are shown, never spoken (src/jarvis/line.js) ----
  const done = 'Course complete{ in 1:23.4}. A new record.';
  assert.equal(shownLine(done), 'Course complete in 1:23.4. A new record.');
  assert.equal(spokenLine(done), 'Course complete. A new record.');
  assert.equal(spokenLine('Every fire is out.{ Total time: 0:58.2.}'), 'Every fire is out.');
  assert.equal(spokenLine('Direct hit.{ Suit integrity at 46 percent.} We are below half.'), 'Direct hit. We are below half.');
  assert.equal(spokenLine('Direct hit.{ Suit integrity at 94 percent.}'), spokenLine('Direct hit.{ Suit integrity at 58 percent.}'), 'one recording, whatever the figure');
  assert.equal(spokenLine('Missile away.'), 'Missile away.');

  say('elevenlabs middleware / spoken lines OK');
} finally {
  Object.assign(console, { log, warn });
  Date.now = realNow;
  globalThis.fetch = realFetch;
  process.chdir(os.tmpdir());
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
}
