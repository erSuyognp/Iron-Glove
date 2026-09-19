import { jarvisComment, GAME_EVENTS } from './jarvis.js';

let lastScan = 0;
const SCAN_INTERVAL_MS = 60_000;

let onThreat = () => {};
export function setThreatHandler(fn) { onThreat = fn; }

export async function scanCampusThreats(apiKey) {
  const now = Date.now();
  if (now - lastScan < SCAN_INTERVAL_MS) return;
  lastScan = now;

  const comment = await jarvisComment(GAME_EVENTS.CAMPUS_SCAN, apiKey);
  if (comment) onThreat(comment);
  return comment;
}
