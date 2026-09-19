import * as Cesium from 'cesium';
import { site, settleSite } from '../sites.js';
import { updateChaseCamera } from '../cesium/camera.js';
import { siteArt } from './art.js';

// ---------------------------------------------------------------------------
// The loading screen between DEPLOY and the first frame of flight. Behind it
// the real Cesium scene renders from the arrival camera, so the photogrammetry
// the pilot is about to see is streamed, decoded and on the GPU before the
// overlay lifts, instead of resolving out of a blur in front of them.
//
// Google's tiles stream by view, at a detail set by distance: there is no way
// to ask for "everything within a mile", and that much full-detail data would
// not fit the tile cache anyway. So this loads what matters, in order:
//   1. the ground under the landmark and the arrival point, which is measured
//      to settle the arrival height (sites.js settleSite),
//   2. the arrival view itself, until every tile it needs has loaded,
//   3. the views to the right, behind and left of it, so the first turn in any
//      direction is already in the cache.
// Every step has its own time limit and the whole thing has a hard one: a slow
// connection gets a rougher start, never a stuck screen.
// ---------------------------------------------------------------------------

const TOTAL_LIMIT_MS = 25000;
const MEASURE_LIMIT_MS = 9000;
const ARRIVAL_LIMIT_MS = 12000;
const SWEEP_LIMIT_MS = 3500; // per direction
const SWEEP_HEADINGS = [90, 180, 270]; // relative to the arrival heading
// A view counts as loaded once the tileset has had nothing left to fetch for
// this long: refinement arrives in waves, and a single idle frame is often
// just the gap between two of them.
const SETTLED_MS = 500;

// Share of the progress bar given to each step.
const SHARE = { world: 0.1, measure: 0.15, arrival: 0.45, sweep: 0.3 };

function findTileset(viewer) {
  const { primitives } = viewer.scene;
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives.get(i);
    if (p instanceof Cesium.Cesium3DTileset) return p;
  }
  return null;
}

/**
 * Show the loading screen and stream the chosen site in behind it.
 * @param {Promise<Cesium.Viewer|null>} worldPromise  initWorld(), already running
 * @param {() => object} spawnState  the suit's state at the arrival point
 * @returns {Promise<void>} resolves when the overlay has been taken down
 */
export async function loadSite(worldPromise, spawnState) {
  const root = document.getElementById('loading');
  if (!root) return;
  const bar = document.getElementById('loading-bar');
  const percent = document.getElementById('loading-percent');
  const status = document.getElementById('loading-status');
  const skip = document.getElementById('loading-skip');
  const hud = document.getElementById('hud');

  const art = document.getElementById('loading-art');
  if (art) art.innerHTML = siteArt(site.id);
  const title = document.getElementById('loading-title');
  if (title) title.textContent = site.name.toUpperCase();
  const place = document.getElementById('loading-place');
  if (place) place.textContent = site.place.toUpperCase();

  root.hidden = false;
  if (hud) hud.inert = true;

  const startedAt = performance.now();
  let shown = 0;
  function progress(value, text) {
    // The bar only ever moves forward, whatever the tile counts do.
    shown = Math.max(shown, Math.min(1, value));
    if (bar) bar.style.transform = `scaleX(${shown.toFixed(3)})`;
    if (percent) percent.textContent = `${Math.round(shown * 100)}%`;
    if (text && status) status.textContent = text;
  }
  progress(0.02, 'WAKING FLIGHT SYSTEMS');

  let done = false;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    done = true;
    finish();
  };
  skip?.addEventListener('click', stop, { once: true });
  const hardLimit = setTimeout(stop, TOTAL_LIMIT_MS);

  let frame = null;
  let removeProgressListener = null;

  async function run() {
    const viewer = await worldPromise;
    if (!viewer || done) return; // main.js reports a failed world itself
    const tileset = findTileset(viewer);
    progress(SHARE.world, `STREAMING ${site.short}`);

    // Outstanding tile work for the current view, straight from the tileset.
    let outstanding = 0;
    if (tileset) {
      removeProgressListener = tileset.loadProgress.addEventListener((pending, processing) => {
        outstanding = pending + processing;
      });
    }

    let view = spawnState();
    let onFrame = null;
    const render = () => {
      if (done) return;
      frame = requestAnimationFrame(render);
      updateChaseCamera(viewer, view);
      viewer.resize();
      viewer.render();
      onFrame?.();
    };
    frame = requestAnimationFrame(render);

    // Render `view` until it has nothing left to load, or `limit` runs out.
    // `from`..`to` is this step's stretch of the progress bar.
    function settle(limit, from, to) {
      return new Promise((resolve) => {
        let idleSince = null;
        let peak = 1;
        const timer = setTimeout(end, limit);
        function end() {
          clearTimeout(timer);
          onFrame = null;
          progress(to);
          resolve();
        }
        onFrame = () => {
          const loaded = tileset ? tileset.tilesLoaded && outstanding === 0 : viewer.scene.globe.tilesLoaded;
          peak = Math.max(peak, outstanding);
          progress(from + (to - from) * (1 - outstanding / peak) * 0.95);
          if (!loaded) idleSince = null;
          else if (idleSince === null) idleSince = performance.now();
          else if (performance.now() - idleSince >= SETTLED_MS) end();
        };
      });
    }

    // 1. Measure the ground and settle the arrival height.
    let at = SHARE.world;
    if (!site.measured) {
      progress(at, 'SCANNING TERRAIN');
      const under = [site, site.spawn].map((p) => Cesium.Cartographic.fromDegrees(p.longitude, p.latitude));
      const measured = await Promise.race([
        viewer.scene.sampleHeightMostDetailed(under).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), MEASURE_LIMIT_MS)),
        finished.then(() => null),
      ]);
      if (done) return;
      if (measured) {
        settleSite(Math.max(...measured.map((c) => c.height).filter(Number.isFinite), -Infinity));
        view = spawnState();
      }
    }
    at += SHARE.measure;

    // 2. The arrival view.
    progress(at, `STREAMING ${site.short}`);
    await Promise.race([settle(ARRIVAL_LIMIT_MS, at, at + SHARE.arrival), finished]);
    if (done) return;
    at += SHARE.arrival;

    // 3. A look around from the arrival point.
    const arrival = view;
    for (let i = 0; i < SWEEP_HEADINGS.length; i++) {
      progress(at, 'MAPPING SURROUNDING AIRSPACE');
      view = { ...arrival, heading: (arrival.heading + SWEEP_HEADINGS[i]) % 360 };
      const step = SHARE.sweep / (SWEEP_HEADINGS.length + 1);
      await Promise.race([settle(SWEEP_LIMIT_MS, at, at + step), finished]);
      if (done) return;
      at += step;
    }

    // Back to the arrival view, so it is the freshest thing in the cache and
    // the frame the overlay lifts on.
    view = arrival;
    progress(at, 'CLEARED FOR FLIGHT');
    await Promise.race([settle(SWEEP_LIMIT_MS, at, 1), finished]);
  }

  try {
    await Promise.race([run(), finished]);
  } catch (err) {
    console.warn('[loading] preload cut short:', err);
  }

  console.log(`[loading] ${site.name}: ${Math.round(shown * 100)}% after ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
  done = true;
  clearTimeout(hardLimit);
  if (frame !== null) cancelAnimationFrame(frame);
  removeProgressListener?.();
  skip?.removeEventListener('click', stop);
  progress(1);

  // Lift the overlay; main.js starts the flight loop underneath the fade.
  if (hud) hud.inert = false;
  root.classList.add('leaving');
  setTimeout(() => {
    root.hidden = true;
    root.classList.remove('leaving');
  }, 700);
}
