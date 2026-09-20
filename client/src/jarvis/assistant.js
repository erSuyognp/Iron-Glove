import { SITES } from '../sites.js';

// ---------------------------------------------------------------------------
// JARVIS's side of a conversation: what the pilot said goes in, a spoken reply
// and (sometimes) something to do comes out.
//
// The thinking is done by Grok (xAI), through the dev server (vite.config.js,
// /api/jarvis), which holds the key. When that is not there — no key, a
// production build, no network — a small phrase matcher answers instead, so
// the commands always work; only the small talk needs the model.
//
// An answer is { reply: string, action: string, site?: string }.
// ---------------------------------------------------------------------------

/** Everything JARVIS can do for the pilot. The server offers Grok this same list. */
export const ACTIONS = [
  'none',
  'start_drones',
  'start_fire',
  'start_run',
  'end_mission',
  'mute',
  'unmute',
  'reset_position',
  'switch_view',
  'change_site',
];

const HISTORY_TURNS = 6;
const REQUEST_TIMEOUT_MS = 9000;
const history = []; // [{ role: 'user'|'model', text }]
let modelRetryAt = 0; // after a failure, answer locally for a while

function remember(role, text) {
  history.push({ role, text });
  while (history.length > HISTORY_TURNS * 2) history.shift();
}

async function askModel(text, context) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('/api/jarvis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, context, history }),
      signal: controller.signal,
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    const answer = await res.json();
    if (typeof answer.reply !== 'string' || !ACTIONS.includes(answer.action)) return null;
    return answer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- The fallback: plain phrase matching ----

function findSite(text) {
  const words = text.toLowerCase();
  return SITES.find((s) =>
    [s.name, s.short, ...(s.spoken ?? [])].some((n) => words.includes(n.toLowerCase().replace(/^the /, ''))),
  );
}

function statusLine(c) {
  const parts = [`Suit integrity ${c.health} percent`, `${c.altitude} metres up at ${c.speed} metres per second`];
  if (c.mission) parts.push(c.missionStatus || `${c.mission} mission in progress`);
  return `${parts.join(', ')}.`;
}

const RULES = [
  [/\b(end|stop|abort|cancel|stand down)\b.*\b(mission|run|it)\b|\bstand down\b/, 'end_mission', 'Standing down.'],
  [/\b(fire|fires|water|extinguish|burning)\b/, 'start_fire', 'Fire response it is.'],
  [/\b(drone|drones|hostile|hostiles|combat|strike|fight)\b/, 'start_drones', 'Launching the drones. Do be careful.'],
  [/\b(run|race|gates?|course|rings?|downtown|time trial)\b/, 'start_run', 'Plotting a course.'],
  [/\b(unmute|sound on|audio on)\b/, 'unmute', 'Sound restored.'],
  [/\b(mute|quiet|silence|sound off|audio off)\b/, 'mute', 'Going quiet.'],
  [/\b(reset|respawn|restart|start over|take me back)\b/, 'reset_position', 'Returning you to the arrival point.'],
  [/\b(switch|change|other)\b.*\b(view|camera|pov)\b|\bsuit cam\b/, 'switch_view', 'Switching view.'],
];

function answerLocally(text, context) {
  const words = text.toLowerCase();
  const site = /\b(take me|go|fly|travel|head|location|destination)\b/.test(words) ? findSite(words) : null;
  if (site) return { reply: `Setting course for ${site.name}.`, action: 'change_site', site: site.id };
  if (/\b(status|report|how am i|how are we|integrity|health|damage)\b/.test(words)) {
    return { reply: statusLine(context), action: 'none' };
  }
  if (/\bwhere\b/.test(words)) return { reply: `Over ${context.site}.`, action: 'none' };
  for (const [pattern, action, reply] of RULES) {
    if (pattern.test(words)) return { reply, action };
  }
  if (/\b(hello|hi|hey|you there|jarvis)\b/.test(words)) return { reply: 'At your service.', action: 'none' };
  if (/\b(thanks|thank you)\b/.test(words)) return { reply: 'Always a pleasure.', action: 'none' };
  return { reply: "I'm afraid I didn't follow that. Try a mission, a status report, or a destination.", action: 'none' };
}

/**
 * @param text     what the pilot said
 * @param context  a snapshot of the flight: { site, mission, missionStatus,
 *                 health, altitude, speed, heading, hostiles, missiles, muted }
 */
export async function askJarvis(text, context) {
  let answer = null;
  if (performance.now() >= modelRetryAt) {
    answer = await askModel(text, context);
    if (!answer) modelRetryAt = performance.now() + 60000;
  }
  const thought = Boolean(answer);
  answer ??= answerLocally(text, context);
  if (answer.action === 'change_site' && !SITES.some((s) => s.id === answer.site)) {
    answer = { reply: "I don't have that destination on file.", action: 'none' };
  }
  remember('user', text);
  remember('model', answer.reply);
  // A model reply is a one-off: its audio is not worth keeping on disk.
  return { ...answer, improvised: thought };
}
