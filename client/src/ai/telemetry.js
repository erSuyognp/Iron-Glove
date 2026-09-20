// Versioned telemetry records shared by RL (and later imitation) features.
// One schema: { schemaVersion, sessionId, timestampMs, type, payload }

export const TELEMETRY_SCHEMA_VERSION = 1;

export const TELEMETRY_TYPES = Object.freeze([
  'session_meta',
  'player_frame',
  'player_action',
  'sentinel_frame',
  'sentinel_action',
  'combat_event',
  'difficulty_state',
  'episode_end',
]);

export function telemetryRecord(sessionId, timestampMs, type, payload) {
  if (!TELEMETRY_TYPES.includes(type)) throw new Error(`unknown telemetry type ${type}`);
  return { schemaVersion: TELEMETRY_SCHEMA_VERSION, sessionId, timestampMs, type, payload };
}
