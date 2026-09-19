// SpacetimeDB link for IRON GLOVE (Phase 2).
//
// Thin wrapper over the generated bindings. The client stays authoritative for
// all flight physics; this module only:
//   1. connects to the module and subscribes to the other pilots' rows in
//      `player_state` (not our own, which would only echo what we push),
//   2. calls join_game once on connect,
//   3. pushes the client-computed transform via update_orientation, and
//   4. hands every other pilot's row to the caller via a callback.
//
// It fails soft: if the module is unreachable the game keeps running on local
// physics and just reports an offline status.

import { DbConnection } from '../module_bindings';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST || 'ws://127.0.0.1:3000';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME || 'iron-glove';

// SpacetimeDB speaks WebSocket; accept http(s) hosts and upgrade the scheme.
function toWs(host) {
  if (host.startsWith('ws')) return host;
  if (host.startsWith('https://')) return 'wss://' + host.slice('https://'.length);
  if (host.startsWith('http://')) return 'ws://' + host.slice('http://'.length);
  return host;
}

// opts: { playerId, mode, onStatus(status), onPlayer(row, live), onPlayerLeave(row) }
//
// `playerId` is only our own identity (used for join_game / pushTransform).
// `onPlayer` is fired for EVERY player_state row — ours and every other pilot
// (e.g. the judge phone) — so the caller can render all suits. `live` is true
// for a row that just changed on the server and false for a row delivered by
// the initial subscription, which may be a leftover from an earlier session.
// `onPlayerLeave` fires when a row is deleted.
export function createStdbClient({
  playerId = 'suyog',
  mode = 'KEYBOARD',
  onStatus,
  onPlayer,
  onPlayerLeave,
} = {}) {
  let conn = null;
  let connected = false; // socket open
  let subscribed = false; // initial rows applied + join sent

  const status = (s) => {
    if (onStatus) onStatus(s);
  };

  // Reducer calls return promises; a failure (e.g. a dropped link) is logged
  // once per reducer rather than surfacing as an unhandled rejection per call.
  const reported = new Set();
  const reducerFailed = (name) => (err) => {
    if (reported.has(name)) return;
    reported.add(name);
    console.warn(`[stdb] ${name} failed:`, err?.message ?? err);
  };

  function handleRow(row, live) {
    if (onPlayer) onPlayer(row, live);
  }

  function start() {
    status('connecting');
    try {
      DbConnection.builder()
        .withUri(toWs(HOST))
        .withDatabaseName(DB_NAME)
        .onConnect((c) => {
          conn = c;
          connected = true;
          status('connected');

          // Read rows back whenever the server broadcasts a delta — every
          // player, not just ours, so remote suits (the judge) render too.
          c.db.playerState.onInsert((_ctx, row) => handleRow(row, subscribed));
          c.db.playerState.onUpdate((_ctx, _old, row) => handleRow(row, true));
          c.db.playerState.onDelete((_ctx, row) => {
            if (onPlayerLeave) onPlayerLeave(row);
          });

          const onApplied = () => {
            if (subscribed) return;
            subscribed = true;
            // Insert (or reset) our row at the spawn point.
            c.reducers.joinGame({ playerId, mode }).catch(reducerFailed('join_game'));
            status('online');
          };
          // Only other pilots' rows: our own would just echo every transform
          // we push straight back to us. Falls back to the whole table if the
          // server rejects the filter.
          const others = `SELECT * FROM player_state WHERE player_id != '${playerId.replace(/'/g, "''")}'`;
          c.subscriptionBuilder()
            .onApplied(onApplied)
            .onError(() => {
              console.warn('[stdb] filtered subscription rejected — subscribing to all players');
              c.subscriptionBuilder().onApplied(onApplied).subscribe(['SELECT * FROM player_state']);
            })
            .subscribe([others]);
        })
        .onDisconnect(() => {
          connected = false;
          subscribed = false;
          conn = null;
          status('offline');
        })
        .onConnectError((_ctx, err) => {
          connected = false;
          subscribed = false;
          conn = null;
          status('error');
          console.warn('[stdb] connect error:', err?.message ?? err);
        })
        .build();
    } catch (err) {
      status('error');
      console.warn('[stdb] failed to start:', err?.message ?? err);
    }
  }

  // Push the client-computed transform. No-op until we're fully online so we
  // never fire update_orientation before join_game has created the row.
  function pushTransform(t) {
    if (!conn || !subscribed) return;
    conn.reducers
      .updateOrientation({
        playerId,
        positionX: t.positionX,
        positionY: t.positionY,
        positionZ: t.positionZ,
        pitch: t.pitch,
        roll: t.roll,
        yaw: t.yaw,
        mode: t.mode,
      })
      .catch(reducerFailed('update_orientation'));
  }

  return {
    start,
    pushTransform,
    get connected() {
      return connected;
    },
    get online() {
      return subscribed;
    },
  };
}
