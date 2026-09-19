// SpacetimeDB link for IRON GLOVE (Phase 2).
//
// Thin wrapper over the generated bindings. The client stays authoritative for
// all flight physics; this module only:
//   1. connects to the module and subscribes to the other pilots' rows in
//      `player_state` (not our own, which would only echo what we push),
//   2. calls join_game once on connect,
//   3. pushes the client-computed transform via update_orientation,
//   4. hands every other pilot's row to the caller via a callback, and
//   5. streams the server-flown sentinel drones and their missiles, and
//      reports hits back (apply_damage / destroy_sentinel).
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
//
// Drones: `onSentinel(row)` fires for every sentinel_state insert/update (one
// per drone per 100 ms tick) and `onSentinelGone(row)` when one is destroyed.
// `onMissile(row, live)` fires when an attacker launches; `live` is false for
// missiles already in flight when we subscribed.
export function createStdbClient({
  playerId = 'suyog',
  mode = 'KEYBOARD',
  onStatus,
  onPlayer,
  onPlayerLeave,
  onSentinel,
  onSentinelGone,
  onMissile,
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

          // Sentinel drones and their missiles. A module published before the
          // drones existed rejects this; the game then simply has no drones.
          let combatApplied = false;
          c.db.sentinelState.onInsert((_ctx, row) => onSentinel?.(row));
          c.db.sentinelState.onUpdate((_ctx, _old, row) => onSentinel?.(row));
          c.db.sentinelState.onDelete((_ctx, row) => onSentinelGone?.(row));
          c.db.missile.onInsert((_ctx, row) => onMissile?.(row, combatApplied));
          c.subscriptionBuilder()
            .onApplied(() => {
              combatApplied = true;
            })
            .onError(() => console.warn('[stdb] no sentinel tables on this module — drones offline'))
            .subscribe(['SELECT * FROM sentinel_state', 'SELECT * FROM missile']);
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

  // An attacker's missile reached a suit this client flies.
  function applyDamage(targetId, amount) {
    if (!conn || !subscribed) return;
    conn.reducers.applyDamage({ targetId, amount }).catch(reducerFailed('apply_damage'));
  }

  // A missile from a suit this client flies reached a drone: remove it (the
  // server respawns one later). `by` is the pilot credited with the kill.
  function destroySentinel(sentinelId, by = playerId) {
    if (!conn || !subscribed) return;
    conn.reducers.destroySentinel({ sentinelId, playerId: by }).catch(reducerFailed('destroy_sentinel'));
  }

  // Where a phone pilot's suit is. Phones only send stick inputs and we fly
  // their suit, so we are the only ones who can tell the drones where it is.
  function reportPosition(pilotId, s) {
    if (!conn || !subscribed) return;
    conn.reducers
      .reportPosition({
        playerId: pilotId,
        positionX: s.longitude,
        positionY: s.altitude,
        positionZ: s.latitude,
        heading: s.heading,
      })
      .catch(reducerFailed('report_position'));
  }

  return {
    start,
    pushTransform,
    applyDamage,
    destroySentinel,
    reportPosition,
    get connected() {
      return connected;
    },
    get online() {
      return subscribed;
    },
  };
}
