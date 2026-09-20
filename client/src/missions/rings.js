import * as Cesium from 'cesium';
import { site } from '../sites.js';

// ---------------------------------------------------------------------------
// DOWNTOWN RUN — a timed gate course laid low over the site. The gates hug the
// real surface (rooftops, canyon walls, the bridge deck), each a fixed height
// above whatever is underneath it, so the line threads the city instead of
// floating over it. Fly through them in order; the best time per site is kept.
// ---------------------------------------------------------------------------

const GATES = 12;
const GATE_RADIUS = 30; // m (the suit is 11 m tall)
const PASS_RADIUS = GATE_RADIUS * 1.12; // a little grace at the rim
const CLEARANCE = [38, 70]; // m above the sampled surface, varied gate to gate
const LOOP_INNER = 0.3; // the course weaves between these shares of the site radius
const LOOP_OUTER = 0.58;
const POLYGON_RADIUS = 360; // m, for a site with a polygon instead of a radius
const LOOK_AHEAD = 150; // m in front of the pilot: the course starts on that side of the landmark
const SUIT_CENTRE = 5.5; // m above the boots: the point that has to pass through
const AHEAD_SHOWN = 3; // gates drawn beyond the next one
const SEGMENTS = 40;
const BEST_KEY = 'ironglove.run.';

const NEXT_COLOR = Cesium.Color.fromCssColorString('#ffcf5a');
const AHEAD_COLOR = Cesium.Color.fromCssColorString('#4fdcff').withAlpha(0.55);

export function createRingMission({ viewer, sensorExclude }, suit) {
  const gates = []; // { x, y, z, nx, ny, nz, entity, halo }
  const added = [];
  let next = 0;
  let ready = false;
  let cancelled = false;
  let startedAt = 0;
  let last = null; // the suit's previous local position, for the crossing test
  let best = null;
  try {
    const stored = Number(localStorage.getItem(BEST_KEY + site.id));
    best = Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    /* storage unavailable */
  }

  const radius = site.radius ?? POLYGON_RADIUS;
  const localOf = (s) => ({
    x: (s.longitude - site.longitude) * site.mPerLon,
    y: (s.latitude - site.latitude) * site.mPerLat,
    z: s.altitude + SUIT_CENTRE,
  });

  async function build() {
    // A loop round the landmark that swings in and out, so consecutive gates
    // are never in a straight line. It starts at the part of the loop nearest
    // the point just ahead of the pilot and runs the way they are facing.
    const from = localOf(suit);
    const h = Cesium.Math.toRadians(suit.heading);
    const ahead = { x: from.x + Math.sin(h) * LOOK_AHEAD, y: from.y + Math.cos(h) * LOOK_AHEAD };
    const start = Math.atan2(ahead.x, ahead.y);
    // Clockwise (bearing increasing) if that is the way the pilot's heading turns about the centre.
    const direction = ahead.y * Math.sin(h) - ahead.x * Math.cos(h) >= 0 ? 1 : -1;
    const phase = Math.random() * Math.PI * 2;
    const points = [];
    for (let i = 0; i < GATES; i++) {
      const a = start + direction * (i / GATES) * 2 * Math.PI;
      const wave = 0.5 + 0.5 * Math.sin(i * 1.9 + phase);
      const r = radius * (LOOP_INNER + (LOOP_OUTER - LOOP_INNER) * wave);
      points.push({ x: Math.sin(a) * r, y: Math.cos(a) * r, clear: CLEARANCE[0] + (CLEARANCE[1] - CLEARANCE[0]) * (0.5 + 0.5 * Math.sin(i * 2.7 + phase)) });
    }

    let heights = [];
    try {
      const measured = await viewer.scene.sampleHeightMostDetailed(
        points.map((p) => Cesium.Cartographic.fromDegrees(site.longitude + p.x / site.mPerLon, site.latitude + p.y / site.mPerLat)),
        sensorExclude,
      );
      heights = measured.map((c) => c.height);
    } catch {
      /* no surface data: fall back below */
    }
    if (cancelled) return;

    points.forEach((p, i) => {
      const ground = Number.isFinite(heights[i]) ? heights[i] : site.altitude - 140;
      // Never below the flight floor, never above the ceiling.
      p.z = Math.min(site.maxAlt - 40, Math.max(site.minAlt + 30, ground + p.clear));
    });

    points.forEach((p, i) => {
      // A gate faces along the course: from the gate before it to the one after.
      const a = points[(i + GATES - 1) % GATES];
      const b = points[(i + 1) % GATES];
      const first = i === 0 ? p : a;
      const onward = i === GATES - 1 ? p : b;
      let nx = onward.x - first.x;
      let ny = onward.y - first.y;
      let nz = (onward.z - first.z) * 0.5; // mostly upright, tipped a little with the slope
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      gates.push({ ...p, nx, ny, nz, ...draw(p, nx, ny, nz) });
    });

    ready = true;
    restyle();
  }

  // A circle of radius GATE_RADIUS in the plane whose normal is n.
  function circle(p, nx, ny, nz, r) {
    // Two unit vectors spanning the plane: one horizontal, one "up the gate".
    const h = Math.hypot(nx, ny) || 1;
    const ux = -ny / h;
    const uy = nx / h;
    const vx = -nz * (nx / h);
    const vy = -nz * (ny / h);
    const vz = h;
    const coords = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * 2 * Math.PI;
      const c = Math.cos(t) * r;
      const s = Math.sin(t) * r;
      coords.push(
        site.longitude + (p.x + ux * c + vx * s) / site.mPerLon,
        site.latitude + (p.y + uy * c + vy * s) / site.mPerLat,
        p.z + vz * s,
      );
    }
    return Cesium.Cartesian3.fromDegreesArrayHeights(coords);
  }

  function draw(p, nx, ny, nz) {
    const material = new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.3, color: AHEAD_COLOR });
    const entity = viewer.entities.add({
      show: false,
      polyline: { positions: circle(p, nx, ny, nz, GATE_RADIUS), width: 10, material },
    });
    const halo = viewer.entities.add({
      show: false,
      polyline: {
        positions: circle(p, nx, ny, nz, GATE_RADIUS * 0.62),
        width: 3,
        material: AHEAD_COLOR.withAlpha(0.35),
      },
    });
    sensorExclude.push(entity, halo);
    added.push(entity, halo);
    return { entity, halo, material };
  }

  // Show the next gate in gold and the few after it in dim cyan.
  function restyle() {
    gates.forEach((g, i) => {
      const ahead = i - next;
      const shown = ahead >= 0 && ahead <= AHEAD_SHOWN;
      g.entity.show = shown;
      g.halo.show = shown && ahead === 0;
      if (!shown) return;
      g.material.color = ahead === 0 ? NEXT_COLOR : AHEAD_COLOR.withAlpha(0.6 - ahead * 0.12);
      g.material.glowPower = ahead === 0 ? 0.45 : 0.22;
      g.entity.polyline.width = ahead === 0 ? 14 : 8;
    });
  }

  function update({ suit: s }) {
    const events = [];
    if (!ready || next >= gates.length) return events;
    const now = localOf(s);
    const g = gates[next];
    if (last) {
      // Did the suit cross the gate's plane this frame, inside the hoop?
      const d0 = (last.x - g.x) * g.nx + (last.y - g.y) * g.ny + (last.z - g.z) * g.nz;
      const d1 = (now.x - g.x) * g.nx + (now.y - g.y) * g.ny + (now.z - g.z) * g.nz;
      if (d0 * d1 <= 0 && d0 !== d1) {
        const t = d0 / (d0 - d1);
        const miss = Math.hypot(
          last.x + (now.x - last.x) * t - g.x,
          last.y + (now.y - last.y) * t - g.y,
          last.z + (now.z - last.z) * t - g.z,
        );
        if (miss <= PASS_RADIUS) {
          if (next === 0) startedAt = performance.now(); // the clock starts at gate 1
          next += 1;
          restyle();
          if (next >= gates.length) {
            const seconds = (performance.now() - startedAt) / 1000;
            const record = best === null || seconds < best;
            if (record) {
              best = seconds;
              try {
                localStorage.setItem(BEST_KEY + site.id, String(seconds));
              } catch {
                /* storage unavailable */
              }
            }
            events.push({ type: 'complete', seconds, record });
          } else {
            events.push({ type: 'gate', passed: next, total: gates.length });
          }
        } else if (miss <= GATE_RADIUS * 3) {
          events.push({ type: 'missed' });
        }
      }
    }
    last = now;
    return events;
  }

  function target() {
    const g = gates[next];
    if (!ready || !g) return null;
    return {
      name: `GATE ${next + 1}`,
      view: {
        longitude: site.longitude + g.x / site.mPerLon,
        latitude: site.latitude + g.y / site.mPerLat,
        altitude: g.z - SUIT_CENTRE,
      },
    };
  }

  function hud() {
    if (!ready) return { title: 'DOWNTOWN RUN', objective: 'PLOTTING COURSE…', count: '', gauge: null };
    return {
      title: 'DOWNTOWN RUN',
      objective: next === 0 ? 'CLOCK STARTS AT GATE 1' : best === null ? 'THREAD EVERY GATE' : `BEST ${formatTime(best)}`,
      count: `GATE ${Math.min(next + 1, gates.length)} / ${gates.length}`,
      gauge: { label: 'COURSE', value: next / gates.length, low: false },
      seconds: startedAt ? (performance.now() - startedAt) / 1000 : 0,
    };
  }

  function dispose() {
    cancelled = true;
    for (const g of gates) {
      viewer.entities.remove(g.entity);
      viewer.entities.remove(g.halo);
    }
    for (const item of added) {
      const i = sensorExclude.indexOf(item);
      if (i >= 0) sensorExclude.splice(i, 1);
    }
  }

  build();
  return { kind: 'run', update, target, hud, dispose, isSpraying: () => false };
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
