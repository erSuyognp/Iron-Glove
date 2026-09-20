// IRON GLOVE — SpacetimeDB module (Phase 2 + drone combat)
//
// Written in TypeScript (runs on V8) because this machine has no Rust toolchain.
// It is a faithful port of the Rust schema in IRON_GLOVE_PROJECT.md to the
// SpacetimeDB 2.10 TypeScript module API.
//
// Design contract for Phase 2 (see the project plan):
//   * ALL flight physics live in the client. The Phase 1 flight model is
//     untouched.
//   * For players the server is a dumb store: it persists PlayerState rows and
//     lets SpacetimeDB broadcast the deltas to every subscriber. No movement,
//     integration, or game logic runs here.
//   * The sentinel drones are the exception: they have no client, so
//     tick_sentinels flies them here every 100 ms and clients interpolate
//     between ticks (see the drone section at the bottom of this file).
//     There are no drones until a pilot calls activate_mission, which also
//     says where in the world the fight is.
//
// Tables and reducers keep the exact names/fields from the plan. The one
// deviation from the plan's `update_orientation(pitch, roll, yaw, mode)`
// signature: it also carries position_x/y/z. That is required by the two
// constraints above — with no physics on the server, the client is the only
// thing that can produce a position, so it sends its already-computed position
// and the reducer simply stores it. This is what makes "position written to
// SpacetimeDB and read back" work.

import { schema, table, t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import { commandSentinel, missionSiteId, missionUsesRl } from "./sentinelPolicy";

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

// Sentinel drones. Same position convention as player_state (x = longitude,
// y = altitude, z = latitude) but f64: an f32 longitude only resolves ~0.6 m,
// which shows up as jitter on something the client interpolates every frame.
// Velocity is metres/second in the local frame (x = east, y = up, z = north);
// the client dead-reckons with it and missiles lead their target with it.
const sentinelState = table(
  { name: "sentinel_state", public: true },
  {
    sentinel_id: t.u32().primaryKey(),
    drone_type: t.string(), // "attacker" | "fleeing"
    behavior: t.string(), //   "PATROL" | "CHASE" | "ENGAGE" | "FLEE"
    position_x: t.f64(),
    position_y: t.f64(),
    position_z: t.f64(),
    velocity_x: t.f32(),
    velocity_y: t.f32(),
    velocity_z: t.f32(),
    health: t.f32(),
    target_player_id: t.string(),
    patrol_index: t.u32(),
    last_fired_at: t.timestamp(),
    updated_at: t.timestamp(),
  }
);

// A missile an attacker fired. Immutable: it flies a straight line from
// `origin` along `velocity`, so clients simulate it from this one row and the
// pilot it reaches reports the hit through apply_damage. Rows are swept by
// tick_sentinels once the missile has burnt out.
const missile = table(
  { name: "missile", public: true },
  {
    missile_id: t.u64().primaryKey().autoInc(),
    sentinel_id: t.u32(),
    target_player_id: t.string(),
    origin_x: t.f64(),
    origin_y: t.f64(),
    origin_z: t.f64(),
    velocity_x: t.f32(),
    velocity_y: t.f32(),
    velocity_z: t.f32(),
    fired_at: t.timestamp(),
  }
);

// Where a phone pilot's suit actually is. A phone in PHONE_CTRL only sends
// stick inputs through player_state (the laptop flies its suit), so the laptop
// reports the suit's position here and the drones can find and fight it.
const pilotPosition = table(
  { name: "pilot_position" },
  {
    player_id: t.string().primaryKey(),
    position_x: t.f64(),
    position_y: t.f64(),
    position_z: t.f64(),
    heading: t.f32(), // degrees, 0 = north
    updated_at: t.timestamp(),
  }
);

// Destroyed drones waiting to come back (private).
const sentinelRespawn = table(
  { name: "sentinel_respawn" },
  {
    sentinel_id: t.u32().primaryKey(),
    drone_type: t.string(),
    respawn_at: t.timestamp(),
  }
);

// The mission in progress (private; at most one row, id 0). Drones only exist
// while it is active. It records where the pilots are flying — the client lets
// them pick a site anywhere in the world — as the origin of the drones' local
// frame and the airspace they must stay inside.
const mission = table(
  { name: "mission" },
  {
    mission_id: t.u32().primaryKey(),
    site: t.string(), //      "jhu" keeps the Homewood polygon; anything else is a circle
    center_lon: t.f64(),
    center_lat: t.f64(),
    alt_offset: t.f64(), //   metres added to every drone altitude (0 at Homewood)
    radius_m: t.f64(), //     airspace radius for circular sites
    started_at: t.timestamp(),
  }
);

// Schedule row that drives tick_sentinels (private).
const sentinelTick = table(
  { name: "sentinel_tick" },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    idle_since: t.timestamp(), // last tick that saw a live pilot
  }
);

const spacetimedb = schema({
  playerState,
  gameEvent,
  sentinelState,
  missile,
  pilotPosition,
  sentinelRespawn,
  sentinelTick,
  mission,
});
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
    ensureTick(ctx);
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
    // The drone tick parks itself when nobody is flying; a pilot wakes it.
    ensureTick(ctx);
  }
);

// report_position — the client flying a phone pilot's suit says where it is.
// Pure setter, like update_orientation.
export const report_position = spacetimedb.reducer(
  {
    player_id: t.string(),
    position_x: t.f64(),
    position_y: t.f64(),
    position_z: t.f64(),
    heading: t.f32(),
  },
  (ctx, p) => {
    const row = { ...p, updated_at: ctx.timestamp };
    if (ctx.db.pilotPosition.player_id.find(p.player_id)) ctx.db.pilotPosition.player_id.update(row);
    else ctx.db.pilotPosition.insert(row);
  }
);

// apply_damage — deduct suit health. Called by the client that flies the suit
// when an attacker's missile reaches it (that client is authoritative for the
// suit's position, so it is the only one that can judge the hit fairly).
// At zero the suit crashes and reboots at full health, as in Phase 1.
export const apply_damage = spacetimedb.reducer(
  { target_id: t.string(), amount: t.f32() },
  (ctx, { target_id, amount }) => {
    const target = ctx.db.playerState.player_id.find(target_id);
    if (!target || !(amount > 0)) return;
    const dealt = Math.min(amount, 100);
    const health = Math.max(0, target.suit_health - dealt);
    logEvent(ctx, "DAMAGE", target_id, `-${dealt} HP -> ${health}`);
    if (health <= 0) logEvent(ctx, "CRASH", target_id, "suit integrity lost; rebooting");
    ctx.db.playerState.player_id.update({
      ...target,
      suit_health: health <= 0 ? 100.0 : health,
    });
  }
);

// destroy_sentinel — a pilot's missile reached the drone. Removes it and
// queues a replacement at a random waypoint so the fight keeps going.
export const destroy_sentinel = spacetimedb.reducer(
  { sentinel_id: t.u32(), player_id: t.string() },
  (ctx, { sentinel_id, player_id }) => {
    const drone = ctx.db.sentinelState.sentinel_id.find(sentinel_id);
    if (!drone) return; // someone else got there first
    ctx.db.sentinelState.sentinel_id.delete(sentinel_id);
    logEvent(ctx, "KILL", player_id, `${drone.drone_type} sentinel ${sentinel_id} destroyed`);
    if (!ctx.db.sentinelRespawn.sentinel_id.find(sentinel_id)) {
      ctx.db.sentinelRespawn.insert({
        sentinel_id,
        drone_type: drone.drone_type,
        respawn_at: after(ctx.timestamp, RESPAWN_S),
      });
    }
  }
);

// activate_mission — "ACTIVATE MISSION" on the HUD. Launches a fresh fleet
// around the site the pilot is flying at; calling it again restarts the fight
// there. `alt_offset` lifts every drone altitude (tuned for Homewood) to the
// site's own ground level, `radius_m` bounds the airspace of any site but
// "jhu", which keeps its campus polygon.
export const activate_mission = spacetimedb.reducer(
  { site: t.string(), center_lon: t.f64(), center_lat: t.f64(), alt_offset: t.f64(), radius_m: t.f64() },
  (ctx, p) => {
    if (!Number.isFinite(p.center_lon) || !Number.isFinite(p.center_lat) || !Number.isFinite(p.alt_offset)) return;
    clearFleet(ctx);
    const row = {
      mission_id: 0,
      site: p.site,
      center_lon: p.center_lon,
      center_lat: Math.max(-85, Math.min(85, p.center_lat)),
      alt_offset: p.alt_offset,
      radius_m: Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, p.radius_m || 0)),
      started_at: ctx.timestamp,
    };
    ctx.db.mission.insert(row);
    const area = areaOf(row);
    FLEET.forEach((slot, id) => spawnSentinel(ctx, area, id, slot.drone_type, slot.waypoint));
    ensureTick(ctx);
    logEvent(ctx, "MISSION", "", `activated at ${p.site}`);
    // `site` may be tagged `id|rl` (see client AI_FEATURES.rlSentinel). That is
    // an extension point only — no new tables. missionSiteId() strips the tag
    // for campus geometry; missionUsesRl() selects the exported attacker policy.
  }
);

// end_mission — stand the drones down. The flying client also calls this when
// it connects, so every session starts with a clear sky.
export const end_mission = spacetimedb.reducer({}, (ctx) => {
  clearFleet(ctx);
});

// ---------------------------------------------------------------------------
// Sentinel drones
//
// All drone maths runs in a flat local frame in metres around the mission's
// centre (east, north, up) — the same 111 320 m/deg approximation the client
// flies with, around the same point — and is converted back to lon/lat for
// storage.
// ---------------------------------------------------------------------------

const PLAYER_MAX_SPEED = 60; // m/s — keep in step with MAX_SPEED in client/src/main.js
const ATTACK_SPEED = PLAYER_MAX_SPEED * 0.6;
const FLEE_SPEED = PLAYER_MAX_SPEED * 1.2;
const PATROL_SPEED = PLAYER_MAX_SPEED * 0.3;
const STEER_RATE = 2.5; // 1/s: how quickly velocity swings to a new heading

const REPOSITION_SPEED = PLAYER_MAX_SPEED * 1.5; // an attacker caught behind its pilot hurries back round
const ENGAGE_AHEAD_M = 110; // attackers hold station this far off the pilot's nose
const ENGAGE_OFFSET_DEG = 14; // ...to one side of it (wingmen take opposite sides)
const ENGAGE_SWAY_DEG = 7; //   ...drifting slowly across it
const ENGAGE_HEIGHT_M = 12; //  ...a little above eye level
const ENGAGE_SETTLED_M = 30; // this close to the station counts as holding it
const FRONT_ARC_DEG = 50; // attackers only fire from inside this arc off the nose
const FIRE_INTERVAL_S = 4;
const FIRE_RANGE_M = 250;
const MISSILE_SPEED = 120; // m/s, straight line
const MISSILE_LIFE_S = 4;

const FLEE_ENTER_M = 120; // fleeing drones bolt inside this range...
const FLEE_EXIT_M = 220; // ...and calm down beyond this one

const COLLIDE_M = 9; // suit + drone radii; contact is a shove, never damage
const RESPAWN_S = 8;
const PLAYER_LIVE_S = 3; // a pilot row older than this is not flying
const IDLE_PARK_S = 60; // stop ticking after this long without a pilot
const TICK_MICROS = 100_000n;

// Altitudes here are Homewood's; a mission's alt_offset moves them to its site.
const MIN_ALT = 70; // clear of the rooftops: the server cannot see buildings
const MAX_ALT = 380;
const MIN_RADIUS_M = 300;
const MAX_RADIUS_M = 5000;
const RING_WAYPOINT_SHARE = 0.45; // patrol ring of a circular site, as a share of its radius
const RING_EDGE_SHARE = 0.97; // the client's perimeter is a polygon inscribed in the circle
const WAYPOINT_REACHED_M = 15;
const LOOKAHEAD_M = 80; // perimeter avoidance probe

const M_PER_LAT = 111320;

// Sentinel patrol waypoints from the project plan.
const WAYPOINTS = [
  { lon: -76.6218, lat: 39.3302, alt: 140 }, // Gilman Hall
  { lon: -76.6205, lat: 39.3299, alt: 165 }, // Keyser Quad
  { lon: -76.6201, lat: 39.3308, alt: 150 }, // Levering Hall
  { lon: -76.6189, lat: 39.329, alt: 135 }, //  Bloomberg Center
  { lon: -76.6225, lat: 39.3315, alt: 155 }, // Shriver Hall
];

// The four drones: slot -> type and the waypoint it first appears over. The
// quad itself is skipped at start-up because pilots spawn there.
const FLEET = [
  { drone_type: "attacker", waypoint: 4 },
  { drone_type: "attacker", waypoint: 3 },
  { drone_type: "fleeing", waypoint: 0 },
  { drone_type: "fleeing", waypoint: 2 },
];

// Homewood flight perimeter — keep in step with client/src/cesium/homewood-boundary.js.
const HOMEWOOD = [
  [-76.6282, 39.3338],
  [-76.6229, 39.3367],
  [-76.6174, 39.3362],
  [-76.6148, 39.3328],
  [-76.6158, 39.3268],
  [-76.6191, 39.3249],
  [-76.6254, 39.3255],
  [-76.6284, 39.3292],
];

type Vec = { e: number; n: number; u: number };
type Pilot = { id: string; pos: Vec; vel: Vec; heading: number; health: number }; // heading in radians, 0 = north

// Player velocity is not a column — estimate it from the last tick's position
// so the RL observation has dv* without a schema change.
const lastPilotSample = new Map<string, { pos: Vec; micros: bigint }>();

function estimatePilotVel(id: string, pos: Vec, nowMicros: bigint): Vec {
  const prev = lastPilotSample.get(id);
  lastPilotSample.set(id, { pos: { e: pos.e, n: pos.n, u: pos.u }, micros: nowMicros });
  if (!prev) return { e: 0, n: 0, u: 0 };
  const dt = Number(nowMicros - prev.micros) / 1e6;
  if (!(dt > 0.02) || dt > 1) return { e: 0, n: 0, u: 0 };
  return {
    e: (pos.e - prev.pos.e) / dt,
    n: (pos.n - prev.pos.n) / dt,
    u: (pos.u - prev.pos.u) / dt,
  };
}

// A mission's airspace: the local frame around its centre, the perimeter and
// the patrol route, all in that frame's metres.
type Area = {
  lon: number;
  lat: number;
  mPerLon: number;
  minAlt: number;
  maxAlt: number;
  polygon: number[][] | null; // [east, north] corners, or null for a circle
  radius: number;
  waypoints: Vec[];
};

function areaOf(m: {
  site: string;
  center_lon: number;
  center_lat: number;
  alt_offset: number;
  radius_m: number;
}): Area {
  const mPerLon = M_PER_LAT * Math.cos((m.center_lat * Math.PI) / 180);
  const local = (lon: number, lat: number, alt: number): Vec => ({
    e: (lon - m.center_lon) * mPerLon,
    n: (lat - m.center_lat) * M_PER_LAT,
    u: alt + m.alt_offset,
  });
  const campus = missionSiteId(m.site) === "jhu";
  return {
    lon: m.center_lon,
    lat: m.center_lat,
    mPerLon,
    minAlt: MIN_ALT + m.alt_offset,
    maxAlt: MAX_ALT + m.alt_offset,
    polygon: campus
      ? HOMEWOOD.map(([lon, lat]) => [(lon - m.center_lon) * mPerLon, (lat - m.center_lat) * M_PER_LAT])
      : null,
    radius: m.radius_m * RING_EDGE_SHARE,
    waypoints: campus
      ? WAYPOINTS.map((w) => local(w.lon, w.lat, w.alt))
      : // The same five heights, on a ring round the landmark.
        WAYPOINTS.map((w, i) => {
          const a = (i / WAYPOINTS.length) * 2 * Math.PI;
          const r = m.radius_m * RING_WAYPOINT_SHARE;
          return { e: Math.sin(a) * r, n: Math.cos(a) * r, u: w.alt + m.alt_offset };
        }),
  };
}

function insideArea(area: Area, e: number, n: number): boolean {
  if (!area.polygon) return Math.hypot(e, n) < area.radius;
  let inside = false;
  const poly = area.polygon;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function toLocal(area: Area, lon: number, lat: number, alt: number): Vec {
  return { e: (lon - area.lon) * area.mPerLon, n: (lat - area.lat) * M_PER_LAT, u: alt };
}

function sub(a: Vec, b: Vec): Vec {
  return { e: a.e - b.e, n: a.n - b.n, u: a.u - b.u };
}

function len(v: Vec): number {
  return Math.hypot(v.e, v.n, v.u);
}

// `v` scaled to length `l` (zero stays zero).
function withLength(v: Vec, l: number): Vec {
  const m = len(v);
  return m > 1e-6 ? { e: (v.e / m) * l, n: (v.n / m) * l, u: (v.u / m) * l } : { e: 0, n: 0, u: 0 };
}

function after(ts: Timestamp, seconds: number): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + BigInt(Math.round(seconds * 1e6)));
}

function secondsBetween(later: Timestamp, earlier: Timestamp): number {
  return Number(later.microsSinceUnixEpoch - earlier.microsSinceUnixEpoch) / 1e6;
}

function logEvent(ctx: any, event_type: string, player_id: string, detail: string) {
  ctx.db.gameEvent.insert({ event_id: 0n, event_type, player_id, detail, timestamp: ctx.timestamp });
}

function spawnSentinel(ctx: any, area: Area, sentinel_id: number, drone_type: string, waypoint: number) {
  const w = area.waypoints[waypoint];
  ctx.db.sentinelState.insert({
    sentinel_id,
    drone_type,
    behavior: "PATROL",
    position_x: area.lon + w.e / area.mPerLon,
    position_y: w.u,
    position_z: area.lat + w.n / M_PER_LAT,
    velocity_x: 0,
    velocity_y: 0,
    velocity_z: 0,
    health: 100.0,
    target_player_id: "",
    patrol_index: (waypoint + 1) % area.waypoints.length,
    last_fired_at: ctx.timestamp,
    updated_at: ctx.timestamp,
  });
}

// Make sure the drone tick is running while a mission is on. Cheap enough to
// call from every player reducer, which is how a pilot wakes a parked tick.
function ensureTick(ctx: any) {
  if (!ctx.db.mission.mission_id.find(0)) return;
  for (const _tick of ctx.db.sentinelTick.iter()) return;
  ctx.db.sentinelTick.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(TICK_MICROS),
    idle_since: ctx.timestamp,
  });
}

// End the mission: every drone, pending respawn and missile goes, and the tick
// with them.
function clearFleet(ctx: any) {
  for (const d of ctx.db.sentinelState.iter()) ctx.db.sentinelState.sentinel_id.delete(d.sentinel_id);
  for (const r of ctx.db.sentinelRespawn.iter()) ctx.db.sentinelRespawn.sentinel_id.delete(r.sentinel_id);
  for (const m of ctx.db.missile.iter()) ctx.db.missile.missile_id.delete(m.missile_id);
  for (const tick of ctx.db.sentinelTick.iter()) ctx.db.sentinelTick.scheduled_id.delete(tick.scheduled_id);
  ctx.db.mission.mission_id.delete(0);
}

// Swing a desired direction away from the perimeter: probe ahead and take the
// nearest heading (alternating left/right) that stays over campus.
function avoidPerimeter(area: Area, pos: Vec, want: Vec): Vec {
  const flat = Math.hypot(want.e, want.n);
  if (flat < 1e-6) return want;
  for (const deg of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
    const a = (deg * Math.PI) / 180;
    const e = want.e * Math.cos(a) - want.n * Math.sin(a);
    const n = want.e * Math.sin(a) + want.n * Math.cos(a);
    if (insideArea(area, pos.e + (e / flat) * LOOKAHEAD_M, pos.n + (n / flat) * LOOKAHEAD_M)) {
      return { e, n, u: want.u };
    }
  }
  return { e: -pos.e, n: -pos.n, u: want.u }; // boxed in: head for the centre
}

// tick_sentinels — scheduled every 100 ms. Flies every drone one step,
// fires attackers' missiles, sweeps spent missiles and respawns the fallen.
export const tick_sentinels = spacetimedb.reducer(
  { onSchedule: sentinelTick },
  { tick: sentinelTick.rowType },
  (ctx, { tick }) => {
    const now = ctx.timestamp;

    // No mission, no drones: a tick left over from one that ended retires.
    const current = ctx.db.mission.mission_id.find(0);
    if (!current) {
      ctx.db.sentinelTick.scheduled_id.delete(tick.scheduled_id);
      return;
    }
    const area = areaOf(current);

    // Pilots who are actually flying, in a stable order. Phones in PHONE_CTRL
    // send stick inputs, not positions; theirs comes from pilot_position.
    const pilots: Pilot[] = [];
    for (const p of ctx.db.playerState.iter()) {
      if (!p.is_connected || secondsBetween(now, p.updated_at) > PLAYER_LIVE_S) continue;
      if (p.mode === "PHONE_CTRL") {
        const at = ctx.db.pilotPosition.player_id.find(p.player_id);
        if (!at || secondsBetween(now, at.updated_at) > PLAYER_LIVE_S) continue;
        pilots.push({
          id: p.player_id,
          pos: toLocal(area, at.position_x, at.position_z, at.position_y),
          heading: (at.heading * Math.PI) / 180,
          health: p.suit_health,
          vel: { e: 0, n: 0, u: 0 },
        });
      } else {
        pilots.push({
          id: p.player_id,
          pos: toLocal(area, p.position_x, p.position_z, p.position_y),
          heading: (p.yaw * Math.PI) / 180,
          health: p.suit_health,
          vel: { e: 0, n: 0, u: 0 },
        });
      }
    }
    pilots.sort((a, b) => (a.id < b.id ? -1 : 1));
    const nowMicros = now.microsSinceUnixEpoch;
    const liveIds = new Set<string>();
    for (const p of pilots) {
      p.vel = estimatePilotVel(p.id, p.pos, nowMicros);
      liveIds.add(p.id);
    }
    for (const id of lastPilotSample.keys()) {
      if (!liveIds.has(id)) lastPilotSample.delete(id);
    }

    // Stand the mission down when the sky has been empty for a while, so the
    // next session starts clear.
    if (pilots.length > 0) {
      ctx.db.sentinelTick.scheduled_id.update({ ...tick, idle_since: now });
    } else if (secondsBetween(now, tick.idle_since) > IDLE_PARK_S) {
      clearFleet(ctx);
      return;
    }

    for (const m of ctx.db.missile.iter()) {
      if (secondsBetween(now, m.fired_at) > MISSILE_LIFE_S) ctx.db.missile.missile_id.delete(m.missile_id);
    }

    for (const r of ctx.db.sentinelRespawn.iter()) {
      if (secondsBetween(now, r.respawn_at) < 0) continue;
      ctx.db.sentinelRespawn.sentinel_id.delete(r.sentinel_id);
      if (!ctx.db.sentinelState.sentinel_id.find(r.sentinel_id)) {
        spawnSentinel(ctx, area, r.sentinel_id, r.drone_type, ctx.random.integerInRange(0, area.waypoints.length - 1));
      }
    }

    for (const d of ctx.db.sentinelState.iter()) {
      const dt = Math.min(0.3, Math.max(0.01, secondsBetween(now, d.updated_at)));
      const pos = toLocal(area, d.position_x, d.position_z, d.position_y);
      let vel: Vec = { e: d.velocity_x, n: d.velocity_z, u: d.velocity_y };

      let nearest: Pilot | null = null;
      let range = Infinity;
      for (const p of pilots) {
        const r = len(sub(p.pos, pos));
        if (r < range) {
          range = r;
          nearest = p;
        }
      }

      let behavior = "PATROL";
      let patrol_index = d.patrol_index;
      let last_fired_at = d.last_fired_at;
      let want: Vec;

      if (nearest && d.drone_type === "attacker") {
        // With two pilots up the attackers split, one each, instead of both
        // mobbing whoever is closer.
        if (pilots.length > 1) {
          nearest = pilots[d.sentinel_id % pilots.length];
          range = len(sub(nearest.pos, pos));
        }
        const toPilot = sub(nearest.pos, pos);
        const flat = Math.hypot(toPilot.e, toPilot.n) || 1;
        const ahead = (-toPilot.e * Math.sin(nearest.heading) - toPilot.n * Math.cos(nearest.heading)) / flat;
        const inFront = ahead >= Math.cos((FRONT_ARC_DEG * Math.PI) / 180);

        if (missionUsesRl(current.site)) {
          // Offline-trained policy (or explicit heuristic artifact). Fire is a
          // candidate only; cooldown, range and the player's frontal arc still
          // gate the missile row. Health is never written here.
          const cmd = commandSentinel(
            pos,
            vel,
            d.health,
            nearest.pos,
            nearest.vel,
            nearest.heading,
            nearest.health,
            secondsBetween(now, last_fired_at),
          );
          want = cmd.want;
          behavior = inFront && range <= FIRE_RANGE_M ? "ENGAGE" : "CHASE";
          if (
            cmd.fire &&
            inFront &&
            range <= FIRE_RANGE_M &&
            secondsBetween(now, last_fired_at) >= FIRE_INTERVAL_S
          ) {
            last_fired_at = now;
            const shot = withLength(toPilot, MISSILE_SPEED);
            ctx.db.missile.insert({
              missile_id: 0n,
              sentinel_id: d.sentinel_id,
              target_player_id: nearest.id,
              origin_x: d.position_x,
              origin_y: d.position_y,
              origin_z: d.position_z,
              velocity_x: shot.e,
              velocity_y: shot.u,
              velocity_z: shot.n,
              fired_at: now,
            });
          }
        } else {
          // Attackers fight face to face. Each takes up station ahead of the
          // pilot's nose — a little to one side so wingmen don't stack, swaying
          // slowly so it is a live target — and only shoots from inside the
          // pilot's frontal arc. A drone that ends up behind (the pilot turned,
          // or flew past it) sprints back round to the front, holding fire.
          const side = d.sentinel_id % 2 === 0 ? 1 : -1;
          const seconds = Number(now.microsSinceUnixEpoch % 3_600_000_000n) / 1e6;
          const sway = Math.sin(seconds * 0.7 + d.sentinel_id) * ENGAGE_SWAY_DEG;
          const bearing = nearest.heading + ((side * ENGAGE_OFFSET_DEG + sway) * Math.PI) / 180;
          const station: Vec = {
            e: nearest.pos.e + Math.sin(bearing) * ENGAGE_AHEAD_M,
            n: nearest.pos.n + Math.cos(bearing) * ENGAGE_AHEAD_M,
            u: nearest.pos.u + ENGAGE_HEIGHT_M,
          };
          const toStation = sub(station, pos);
          const offStation = len(toStation);

          behavior = inFront && offStation < ENGAGE_SETTLED_M ? "ENGAGE" : "CHASE";
          const top = inFront ? ATTACK_SPEED : REPOSITION_SPEED;
          want = withLength(toStation, Math.min(top, offStation * 1.5));

          if (inFront && range <= FIRE_RANGE_M && secondsBetween(now, last_fired_at) >= FIRE_INTERVAL_S) {
            last_fired_at = now;
            const shot = withLength(toPilot, MISSILE_SPEED);
            ctx.db.missile.insert({
              missile_id: 0n,
              sentinel_id: d.sentinel_id,
              target_player_id: nearest.id,
              origin_x: d.position_x,
              origin_y: d.position_y,
              origin_z: d.position_z,
              velocity_x: shot.e,
              velocity_y: shot.u,
              velocity_z: shot.n,
              fired_at: now,
            });
          }
        }
      } else if (
        nearest &&
        d.drone_type === "fleeing" &&
        range < (d.behavior === "FLEE" ? FLEE_EXIT_M : FLEE_ENTER_M)
      ) {
        // Break away along the inverse of the pilot's approach vector.
        behavior = "FLEE";
        want = withLength(sub(pos, nearest.pos), FLEE_SPEED);
      } else {
        let w = area.waypoints[patrol_index % area.waypoints.length];
        if (len(sub(w, pos)) < WAYPOINT_REACHED_M) {
          patrol_index = (patrol_index + 1) % area.waypoints.length;
          w = area.waypoints[patrol_index];
        }
        want = withLength(sub(w, pos), PATROL_SPEED);
      }

      const speed = len(want);
      want = withLength(avoidPerimeter(area, pos, want), speed);
      if ((pos.u <= area.minAlt && want.u < 0) || (pos.u >= area.maxAlt && want.u > 0)) want.u = 0;

      const k = Math.min(1, STEER_RATE * dt);
      vel = { e: vel.e + (want.e - vel.e) * k, n: vel.n + (want.n - vel.n) * k, u: vel.u + (want.u - vel.u) * k };

      let next: Vec = { e: pos.e + vel.e * dt, n: pos.n + vel.n * dt, u: pos.u + vel.u * dt };
      if (!insideArea(area, next.e, next.n)) {
        next = { e: pos.e, n: pos.n, u: next.u };
        vel = { e: 0, n: 0, u: vel.u };
      }

      // Flying into a drone is a shove, not damage: the drone gives way here
      // and the pilot's own client pushes the suit back the other way.
      for (const p of pilots) {
        const apart = sub(next, p.pos);
        const gap = len(apart);
        if (gap >= COLLIDE_M) continue;
        const push = gap > 0.01 ? withLength(apart, 1) : { e: 0, n: 0, u: 1 };
        const overlap = COLLIDE_M - gap;
        if (insideArea(area, next.e + push.e * overlap, next.n + push.n * overlap)) {
          next.e += push.e * overlap;
          next.n += push.n * overlap;
        }
        next.u += push.u * overlap;
        vel = { e: vel.e + push.e * 12, n: vel.n + push.n * 12, u: vel.u + push.u * 12 };
      }
      next.u = Math.max(area.minAlt, Math.min(area.maxAlt, next.u));

      ctx.db.sentinelState.sentinel_id.update({
        ...d,
        behavior,
        position_x: area.lon + next.e / area.mPerLon,
        position_y: next.u,
        position_z: area.lat + next.n / M_PER_LAT,
        velocity_x: vel.e,
        velocity_y: vel.u,
        velocity_z: vel.n,
        target_player_id: nearest && behavior !== "PATROL" ? nearest.id : "",
        patrol_index,
        last_fired_at,
        updated_at: now,
      });
    }
  }
);
