import * as Cesium from 'cesium';
import { encodeObservation } from './encoding.js';

// Cesium rendering of active-fire detections. One CustomDataSource holds a
// point per observation, so the layer is added and removed as a unit and a
// reload never leaves a second copy behind. Nothing here knows where the
// observations came from (live or historical): it draws what encoding.js says.
//
// Heights: the Google tiles hide Cesium's globe, so ground height under each
// detection is sampled from the terrain provider directly (one batched
// request per TERRAIN_BATCH points at TERRAIN_LEVEL). Markers float
// MARKER_LIFT_M above that and skip the depth test, so a hotspot behind a
// ridge is still visible from the chase camera.

const TERRAIN_LEVEL = 11; // ~10 km tiles: fast for ~1000 points, ±tens of metres in steep terrain
const TERRAIN_BATCH = 250;
const TERRAIN_TIMEOUT_MS = 20000;
const MARKER_LIFT_M = 40;
// Markers shrink and thin out with distance so a statewide dataset doesn't
// wallpaper the horizon, while the nearby cluster stays readable.
const SCALE_BY_DISTANCE = new Cesium.NearFarScalar(2000, 1.0, 80000, 0.4);
const FADE_BY_DISTANCE = new Cesium.NearFarScalar(20000, 1.0, 150000, 0.35);
const SELECTED_OUTLINE = Cesium.Color.fromCssColorString('#37e7ff');
const SELECTED_OUTLINE_WIDTH = 4;

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Ground height (m, ellipsoid) under each observation, in order; null for any
// that couldn't be sampled.
async function sampleGround(terrainProvider, observations) {
  const heights = new Array(observations.length).fill(null);
  if (!terrainProvider) return heights;
  const batches = [];
  for (let i = 0; i < observations.length; i += TERRAIN_BATCH) {
    const slice = observations.slice(i, i + TERRAIN_BATCH);
    const cartos = slice.map((o) => Cesium.Cartographic.fromDegrees(o.longitude, o.latitude));
    batches.push(
      Cesium.sampleTerrain(terrainProvider, TERRAIN_LEVEL, cartos).then((sampled) => {
        sampled.forEach((c, j) => {
          if (Number.isFinite(c.height)) heights[i + j] = c.height;
        });
      }),
    );
  }
  await withTimeout(Promise.all(batches), TERRAIN_TIMEOUT_MS, 'terrain sampling');
  return heights;
}

/**
 * @param viewer            Cesium viewer
 * @param opts.onSelect     (observation) => void, when the operator clicks a marker
 * @returns {{
 *   load(dataset): Promise<{ count, grounded }>,  // grounded = markers with a terrain height
 *   entities: Cesium.Entity[],                     // for collision-sensor exclusion
 *   observationFor(entity): object|undefined,
 *   entityFor(observation): Cesium.Entity|undefined,
 *   select(entity), clearSelection(),               // highlight ring
 *   count: number,
 *   destroy(): void,
 * }}
 */
export function createWildfireLayer(viewer, { onSelect } = {}) {
  const dataSource = new Cesium.CustomDataSource('firms-active-fire');
  viewer.dataSources.add(dataSource);
  const byEntityId = new Map(); // entity.id -> observation
  const entities = [];

  // Selection. The Viewer installs a double-click handler that starts
  // tracking whatever entity is under the cursor; with the chase camera
  // driving viewer.camera every frame that would fight it, so it goes.
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    if (!onSelect) return;
    const picked = viewer.scene.pick(click.position);
    const entity = picked?.id;
    if (!entity || !(entity instanceof Cesium.Entity)) return;
    const obs = byEntityId.get(entity.id);
    if (obs) onSelect(obs, entity);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Selected marker: cyan ring, drawn on top. The original point style is
  // kept so deselecting restores the data-driven encoding exactly.
  let selected = null; // { entity, outlineColor, outlineWidth }
  function clearSelection() {
    if (!selected) return;
    const { entity, outlineColor, outlineWidth } = selected;
    if (entity.point) {
      entity.point.outlineColor = outlineColor;
      entity.point.outlineWidth = outlineWidth;
    }
    selected = null;
  }
  function select(entity) {
    clearSelection();
    if (!entity?.point) return;
    selected = { entity, outlineColor: entity.point.outlineColor, outlineWidth: entity.point.outlineWidth };
    entity.point.outlineColor = SELECTED_OUTLINE;
    entity.point.outlineWidth = SELECTED_OUTLINE_WIDTH;
  }

  function clear() {
    selected = null;
    dataSource.entities.removeAll();
    byEntityId.clear();
    entities.length = 0;
  }

  // Draw a dataset (providers.js shape). Replaces anything drawn before, so
  // calling it twice never duplicates markers.
  async function load(dataset) {
    clear();
    const observations = dataset?.observations ?? [];
    let heights;
    try {
      heights = await sampleGround(viewer.terrainProvider, observations);
    } catch (err) {
      console.warn('[wildfire] ground heights unavailable, placing markers at sea level:', err?.message ?? err);
      heights = new Array(observations.length).fill(null);
    }

    const now = Date.now();
    let grounded = 0;
    dataSource.entities.suspendEvents();
    observations.forEach((obs, i) => {
      const ground = heights[i];
      if (ground !== null) grounded++;
      const enc = encodeObservation(obs, now);
      const color = Cesium.Color.fromCssColorString(enc.tone).withAlpha(enc.alpha);
      const entity = dataSource.entities.add({
        id: `firms-${i}`,
        name: `${obs.source} ${obs.type}`,
        position: Cesium.Cartesian3.fromDegrees(obs.longitude, obs.latitude, (ground ?? 0) + MARKER_LIFT_M),
        point: {
          pixelSize: enc.size,
          color,
          outlineColor: Cesium.Color.fromCssColorString(enc.outline.css).withAlpha(enc.alpha),
          outlineWidth: enc.outline.width,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: SCALE_BY_DISTANCE,
          translucencyByDistance: FADE_BY_DISTANCE,
        },
      });
      byEntityId.set(entity.id, obs);
      entities.push(entity);
    });
    dataSource.entities.resumeEvents();
    return { count: observations.length, grounded };
  }

  function destroy() {
    handler.destroy();
    clear();
    viewer.dataSources.remove(dataSource, true);
  }

  return {
    load,
    entities,
    select,
    clearSelection,
    observationFor: (entity) => byEntityId.get(entity?.id),
    entityFor: (observation) => entities.find((e) => byEntityId.get(e.id)?.id === observation?.id),
    get count() {
      return entities.length;
    },
    destroy,
  };
}
