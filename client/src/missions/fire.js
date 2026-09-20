import * as Cesium from 'cesium';
import { site } from '../sites.js';

// ---------------------------------------------------------------------------
// FIRE RESPONSE — fires break out on the ground and rooftops around the site.
// Fly to each one and hold the water cannon on it (F, or a fist on the glove)
// until it is out.
//
// The cannon throws water forward and down from the suit; where that arc
// meets a fire's height is where it lands, and a fire within SPLASH_RADIUS of
// the landing point is being doused. So: come in low and slow, or lead it.
// ---------------------------------------------------------------------------

const FIRE_COUNT = 5;
const CANDIDATES = 18; // sampled for ground height; the best FIRE_COUNT are used
const RING_INNER = 0.22; // fires sit between these shares of the site radius
const RING_OUTER = 0.62;
const POLYGON_RADIUS = 360; // m, for a site with no radius of its own (Homewood)
const MIN_SPACING = 120; // m between fires
const WATER_LEVEL_BAND = 2.5; // m above the lowest sample that still counts as open water

const JET_SPEED = 34; // m/s the water leaves the suit at, along its heading
const JET_DROP = 6; // m/s of initial downward velocity
const GRAVITY = 14; // m/s², light enough that the arc reads on screen
const NOZZLE_HEIGHT = 6; // m above the boots
const MAX_FALL_S = 4.5; // water that falls longer than this has dispersed
const SPLASH_RADIUS = 34; // m
const DOUSE_RATE = 0.34; // heat per second under the jet (about 3 s to put out)
const REGROW_RATE = 0.04; // heat per second a neglected, part-doused fire recovers

const TANK_DRAIN = 13; // % per second of spraying
const TANK_REFILL = 7; // % per second while the cannon is off
const TANK_RESTART = 12; // % needed before an emptied cannon fires again

const FLAME_HOT = Cesium.Color.fromCssColorString('#ffe9a8');
const FLAME_COOL = Cesium.Color.fromCssColorString('#ff4a12').withAlpha(0);
const EMBER = Cesium.Color.fromCssColorString('#ff9a3c');
const SMOKE_NEW = Cesium.Color.fromCssColorString('#3a332e').withAlpha(0.55);
const SMOKE_OLD = Cesium.Color.fromCssColorString('#8a8580').withAlpha(0);
const STEAM_NEW = Cesium.Color.fromCssColorString('#f2f6f8').withAlpha(0.6);
const STEAM_OLD = Cesium.Color.fromCssColorString('#ffffff').withAlpha(0);
const WATER_NEW = Cesium.Color.fromCssColorString('#d9f4ff').withAlpha(0.9);
const WATER_OLD = Cesium.Color.fromCssColorString('#6ec8ff').withAlpha(0);

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * @param ctx { viewer, particles, sensorExclude }
 */
export function createFireMission({ viewer, particles, sensorExclude }) {
  const fires = []; // { x, y, z, heat, out, beam, label, emit }
  const added = []; // everything pushed into sensorExclude, to take back out
  let tank = 100;
  let tankLocked = false; // emptied: locked out until it has refilled a little
  let spraying = false;
  let ready = false;
  let cancelled = false;
  let startedAt = 0;
  let waterEmit = 0;

  const radius = site.radius ?? POLYGON_RADIUS;

  function local(x, y) {
    return Cesium.Cartographic.fromDegrees(site.longitude + x / site.mPerLon, site.latitude + y / site.mPerLat);
  }

  // Scatter candidates round the landmark, measure the real surface under
  // each, and keep the ones on dry land, well apart.
  async function place() {
    const spots = [];
    for (let i = 0; i < CANDIDATES; i++) {
      const a = (i / CANDIDATES) * 2 * Math.PI + rand(-0.15, 0.15);
      const r = radius * rand(RING_INNER, RING_OUTER);
      spots.push({ x: Math.sin(a) * r, y: Math.cos(a) * r });
    }
    let heights = [];
    try {
      const measured = await viewer.scene.sampleHeightMostDetailed(
        spots.map((s) => local(s.x, s.y)),
        sensorExclude,
      );
      heights = measured.map((c) => c.height);
    } catch {
      /* no surface data: fall back to the arrival height below */
    }
    if (cancelled) return;

    spots.forEach((s, i) => {
      s.z = Number.isFinite(heights[i]) ? heights[i] : site.altitude - 140;
    });
    // Open water is the flat floor of the samples; a fire there looks wrong.
    const floor = Math.min(...spots.map((s) => s.z));
    const dry = spots.filter((s) => s.z > floor + WATER_LEVEL_BAND);
    const pool = (dry.length >= FIRE_COUNT ? dry : spots).sort(() => Math.random() - 0.5);

    for (const s of pool) {
      if (fires.length >= FIRE_COUNT) break;
      if (fires.some((f) => Math.hypot(f.x - s.x, f.y - s.y) < MIN_SPACING)) continue;
      fires.push(ignite(s));
    }
    // Too tightly packed to honour the spacing: take what is left.
    for (const s of pool) {
      if (fires.length >= FIRE_COUNT) break;
      if (!fires.some((f) => f.x === s.x && f.y === s.y)) fires.push(ignite(s));
    }
    ready = true;
    startedAt = performance.now();
  }

  function ignite({ x, y, z }) {
    const lon = site.longitude + x / site.mPerLon;
    const lat = site.latitude + y / site.mPerLat;
    // A beacon the pilot can find from across the site.
    const beam = viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([lon, lat, z, lon, lat, z + 320]),
        width: 5,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.35,
          taperPower: 0.6,
          color: Cesium.Color.fromCssColorString('#ff5a1f').withAlpha(0.75),
        }),
      },
    });
    const label = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, z + 70),
      label: {
        text: 'FIRE',
        font: '700 15px Bahnschrift, "Arial Narrow", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#ffd9c2'),
        outlineColor: Cesium.Color.fromCssColorString('#5a1200'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#2a0a00').withAlpha(0.7),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(150, 1.2, 2500, 0.6),
      },
    });
    sensorExclude.push(beam, label);
    added.push(beam, label);
    return { x, y, z, heat: 1, out: false, doused: false, beam, label, emit: 0, smoke: 0 };
  }

  // Where water leaving `s` now comes down at height z, or null if it never
  // gets there (the fire is above the suit) or falls too long.
  function landing(s, z) {
    const drop = s.altitude + NOZZLE_HEIGHT - z;
    if (drop < 0) return null;
    // drop = JET_DROP·t + ½·GRAVITY·t²
    const t = (-JET_DROP + Math.sqrt(JET_DROP * JET_DROP + 2 * GRAVITY * drop)) / GRAVITY;
    if (t > MAX_FALL_S) return null;
    const h = Cesium.Math.toRadians(s.heading);
    const forward = JET_SPEED + Math.max(0, s.speed);
    const x = (s.longitude - site.longitude) * site.mPerLon + Math.sin(h) * forward * t;
    const y = (s.latitude - site.latitude) * site.mPerLat + Math.cos(h) * forward * t;
    return { x, y };
  }

  function burn(f, dt) {
    const size = 0.35 + 0.65 * f.heat;
    f.emit += dt * 26 * size;
    while (f.emit >= 1) {
      f.emit -= 1;
      const spread = 9 * size;
      particles.emit({
        x: f.x + rand(-spread, spread),
        y: f.y + rand(-spread, spread),
        z: f.z + rand(0, 3),
        vx: rand(-1.5, 1.5),
        vy: rand(-1.5, 1.5),
        vz: rand(7, 15) * size,
        life: rand(0.7, 1.5),
        size0: rand(9, 15) * size,
        size1: 2,
        c0: Math.random() < 0.25 ? EMBER : FLAME_HOT,
        c1: FLAME_COOL,
      });
    }
    f.smoke += dt * (f.doused ? 9 : 5);
    while (f.smoke >= 1) {
      f.smoke -= 1;
      particles.emit({
        x: f.x + rand(-6, 6),
        y: f.y + rand(-6, 6),
        z: f.z + 10 * size,
        vx: rand(1, 4), // a light breeze, so the columns lean the same way
        vy: rand(-1, 1),
        vz: rand(7, 12),
        life: rand(3, 5.5),
        size0: 10,
        size1: rand(38, 60),
        c0: f.doused ? STEAM_NEW : SMOKE_NEW,
        c1: f.doused ? STEAM_OLD : SMOKE_OLD,
      });
    }
  }

  function spray(s, dt) {
    const h = Cesium.Math.toRadians(s.heading);
    const forward = JET_SPEED + Math.max(0, s.speed);
    waterEmit += dt * 70;
    while (waterEmit >= 1) {
      waterEmit -= 1;
      particles.emit({
        x: (s.longitude - site.longitude) * site.mPerLon + rand(-1, 1),
        y: (s.latitude - site.latitude) * site.mPerLat + rand(-1, 1),
        z: s.altitude + NOZZLE_HEIGHT,
        vx: Math.sin(h) * forward + rand(-3, 3),
        vy: Math.cos(h) * forward + rand(-3, 3),
        vz: -JET_DROP + rand(-2, 2) + (s.vspeed || 0),
        gravity: GRAVITY,
        life: rand(1.6, 2.6),
        size0: 1.6,
        size1: rand(7, 11),
        c0: WATER_NEW,
        c1: WATER_OLD,
      });
    }
  }

  /**
   * @param frame { dt, suit, spray: boolean }
   * @returns events: [{ type: 'extinguished'|'complete'|'tankEmpty', ... }]
   */
  function update({ dt, suit: s, spray: wantSpray }) {
    const events = [];
    if (!ready) return events;

    // The tank.
    if (tank <= 0 && !tankLocked) {
      tankLocked = true;
      events.push({ type: 'tankEmpty' });
    }
    if (tankLocked && tank >= TANK_RESTART) tankLocked = false;
    spraying = wantSpray && !tankLocked;
    tank = Math.max(0, Math.min(100, tank + (spraying ? -TANK_DRAIN : TANK_REFILL) * dt));
    if (spraying) spray(s, dt);

    for (const f of fires) {
      if (f.out) continue;
      const hit = spraying ? landing(s, f.z) : null;
      f.doused = Boolean(hit && Math.hypot(hit.x - f.x, hit.y - f.y) < SPLASH_RADIUS);
      f.heat = Math.max(0, Math.min(1, f.heat + (f.doused ? -DOUSE_RATE : REGROW_RATE) * dt));
      if (f.heat <= 0) {
        f.out = true;
        f.beam.show = false;
        f.label.show = false;
        events.push({ type: 'extinguished', left: fires.filter((o) => !o.out).length });
      } else {
        burn(f, dt);
      }
    }
    if (fires.length && fires.every((f) => f.out)) {
      events.push({ type: 'complete', seconds: (performance.now() - startedAt) / 1000 });
    }
    return events;
  }

  // The nearest fire still burning: what the HUD tracker points at.
  function target(s) {
    let best = null;
    let bestD = Infinity;
    const sx = (s.longitude - site.longitude) * site.mPerLon;
    const sy = (s.latitude - site.latitude) * site.mPerLat;
    for (const f of fires) {
      if (f.out) continue;
      const d = Math.hypot(f.x - sx, f.y - sy);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best) return null;
    return {
      name: 'FIRE',
      view: {
        longitude: site.longitude + best.x / site.mPerLon,
        latitude: site.latitude + best.y / site.mPerLat,
        altitude: best.z,
      },
    };
  }

  function hud() {
    if (!ready) return { title: 'FIRE RESPONSE', objective: 'LOCATING FIRES…', count: '', gauge: null };
    const left = fires.filter((f) => !f.out).length;
    const dousing = fires.find((f) => f.doused && !f.out);
    return {
      title: 'FIRE RESPONSE',
      objective: dousing ? `ON TARGET · ${Math.round(dousing.heat * 100)}% HEAT` : 'HOLD F OVER A FIRE',
      count: `${fires.length - left} / ${fires.length} OUT`,
      gauge: { label: 'WATER', value: tank / 100, low: tankLocked },
      seconds: (performance.now() - startedAt) / 1000,
    };
  }

  function dispose() {
    cancelled = true;
    for (const f of fires) {
      viewer.entities.remove(f.beam);
      viewer.entities.remove(f.label);
    }
    for (const item of added) {
      const i = sensorExclude.indexOf(item);
      if (i >= 0) sensorExclude.splice(i, 1);
    }
    particles.clear();
  }

  place();
  return { kind: 'fire', update, target, hud, dispose, isSpraying: () => spraying };
}
