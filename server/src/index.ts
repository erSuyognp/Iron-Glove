// IRON GLOVE — SpacetimeDB module (Phase 2)
//
// Written in TypeScript (runs on V8) because this machine has no Rust toolchain.
// It is a faithful port of the Rust schema in IRON_GLOVE_PROJECT.md to the
// SpacetimeDB 2.10 TypeScript module API.
//
// Design contract for Phase 2 (see the project plan):
//   * ALL flight physics live in the client. The Phase 1 flight model is
//     untouched.
//   * The server is a dumb store: it persists PlayerState rows and lets
//     SpacetimeDB broadcast the deltas to every subscriber. No movement,
//     integration, or game logic runs here.
//
// Tables and reducers keep the exact names/fields from the plan. The one
// deviation from the plan's `update_orientation(pitch, roll, yaw, mode)`
// signature: it also carries position_x/y/z. That is required by the two
// constraints above — with no physics on the server, the client is the only
// thing that can produce a position, so it sends its already-computed position
// and the reducer simply stores it. This is what makes "position written to
// SpacetimeDB and read back" work.

import { schema, table, t } from "spacetimedb/server";

// Spawn point: above the JHU Homewood quad (Keyser Quad).
// The client works in lon/lat/alt; the repo convention (from the plan's
// join_game) maps that to the position columns as:
//   position_x = longitude, position_y = altitude, position_z = latitude.
const SPAWN_X = -76.6205; // longitude
const SPAWN_Y = 150.0; //    altitude (m)
const SPAWN_Z = 39.3299; //  latitude

const playerState = table(
  { name: "player_state", public: true },
  {
    player_id: t.string().primaryKey(), // "suyog" | "judge"
    position_x: t.f32(),
    position_y: t.f32(),
    position_z: t.f32(),
    pitch: t.f32(),
    roll: t.f32(),
    yaw: t.f32(),
    suit_health: t.f32(), // 0.0 .. 100.0
    mode: t.string(), //     "GLOVE" | "PHONE" | "KEYBOARD"
    is_connected: t.bool(),
    updated_at: t.timestamp(),
  }
);

const gameEvent = table(
  { name: "game_event", public: true },
  {
    event_id: t.u64().primaryKey().autoInc(),
    event_type: t.string(), // "DAMAGE" | "KILL" | "CRASH" | "THREAT"
    player_id: t.string(),
    detail: t.string(),
    timestamp: t.timestamp(),
  }
);

const spacetimedb = schema({ playerState, gameEvent });
export default spacetimedb;

// join_game — insert (or reset) a player's row at the spawn position.
// Upserts so re-joining an existing player_id is safe.
export const join_game = spacetimedb.reducer(
  { player_id: t.string(), mode: t.string() },
  (ctx, { player_id, mode }) => {
    const row = {
      player_id,
      position_x: SPAWN_X,
      position_y: SPAWN_Y,
      position_z: SPAWN_Z,
      pitch: 0,
      roll: 0,
      yaw: 0,
      suit_health: 100.0,
      mode,
      is_connected: true,
      updated_at: ctx.timestamp,
    };

    if (ctx.db.playerState.player_id.find(player_id)) {
      ctx.db.playerState.player_id.update(row);
    } else {
      ctx.db.playerState.insert(row);
    }
  }
);

// update_orientation — store the client's already-computed transform.
// Pure setter: no physics, no integration. SpacetimeDB broadcasts the delta.
export const update_orientation = spacetimedb.reducer(
  {
    player_id: t.string(),
    position_x: t.f32(),
    position_y: t.f32(),
    position_z: t.f32(),
    pitch: t.f32(),
    roll: t.f32(),
    yaw: t.f32(),
    mode: t.string(),
  },
  (ctx, p) => {
    const me = ctx.db.playerState.player_id.find(p.player_id);
    if (!me) return; // ignore updates for players that never joined

    ctx.db.playerState.player_id.update({
      ...me,
      position_x: p.position_x,
      position_y: p.position_y,
      position_z: p.position_z,
      pitch: p.pitch,
      roll: p.roll,
      yaw: p.yaw,
      mode: p.mode,
      updated_at: ctx.timestamp,
    });
  }
);
