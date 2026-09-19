import * as Cesium from 'cesium';
import { site } from '../sites.js';

const CESIUM_TOKEN = import.meta.env.VITE_CESIUM_TOKEN;
// Optional: a direct Google Maps Platform key. Not required — the tiles are the
// same either way — but supported in case you prefer Google billing over Ion.
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

export function hasValidToken() {
  return (
    typeof CESIUM_TOKEN === 'string' &&
    CESIUM_TOKEN.length > 20 &&
    CESIUM_TOKEN !== 'your_cesium_ion_token'
  );
}

// ---- Render quality tiers ----
// The OS decides which GPU the browser runs on, so we detect the adapter we
// actually got and scale detail to it. Force a tier with ?quality=lean|high|ultra.
//   sse          tile screen-space error (lower = sharper campus, more streaming)
//   foveated     relax detail away from screen centre
//   supersample  render above device resolution when the display is low-DPI
const QUALITY = {
  lean: { label: 'LEAN', sse: 16, foveated: true, msaa: 1, fullRes: false, supersample: 1, hdr: false, cacheMB: 1536 },
  high: { label: 'HIGH', sse: 8, foveated: false, msaa: 4, fullRes: true, supersample: 1, hdr: true, cacheMB: 2048 },
  ultra: { label: 'ULTRA', sse: 6, foveated: false, msaa: 4, fullRes: true, supersample: 1.5, hdr: true, cacheMB: 4096 },
};

// Late afternoon wherever the pilot flies: a warm sun low in the west, long
// enough light to read the ground, with real sky and haze colour. It is kept
// in local solar time so every site gets the same light — over Baltimore this
// is 21:00 UTC (5 pm EDT), as it always was.
const SUN_SOLAR_HOUR = 15.9;

let renderQuality = { tier: 'lean', ...QUALITY.lean, gpu: '' };

// Which tier initWorld() picked and the GPU it detected, for the HUD.
export function getRenderQuality() {
  return renderQuality;
}

function pickTier(gpuName) {
  const forced = new URLSearchParams(window.location.search).get('quality');
  if (forced && QUALITY[forced]) return forced;
  if (/rtx\s*(30|40|50)\d\d|radeon rx\s*[79]\d\d\d|arc\s*b\d\d\d/i.test(gpuName)) return 'ultra';
  if (/nvidia|geforce|rtx|radeon rx|intel arc/i.test(gpuName)) return 'high';
  return 'lean';
}

/** Put the fixed late-afternoon sun over `place` (anything with a longitude). */
export function setSunFor(viewer, place) {
  const now = new Date();
  const sunUtcMinutes = Math.round((SUN_SOLAR_HOUR - place.longitude / 15) * 60);
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, sunUtcMinutes)),
  );
}

export async function initWorld() {
  Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;

  // Stream more tiles in parallel so the world fills in faster.
  Cesium.RequestScheduler.maximumRequests = 64;
  Cesium.RequestScheduler.maximumRequestsPerServer = 18;

  const viewer = new Cesium.Viewer('cesiumContainer', {
    // Terrain from Cesium World Terrain.
    terrainProvider: await Cesium.createWorldTerrainAsync(),
    // Ask the browser for the discrete/high-performance GPU (e.g. the RTX).
    contextOptions: {
      requestWebgl2: true,
      webgl: {
        powerPreference: 'high-performance',
        antialias: true,
      },
    },
    // Strip UI chrome — the HUD is our interface.
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    selectionIndicator: false,
    infoBox: false,
  });

  // The game owns a single requestAnimationFrame loop in main.js. Rendering
  // Cesium from that loop, immediately before the Three suit overlay, prevents
  // the two WebGL canvases from ever presenting adjacent frames with different
  // camera poses (the other common source of visible suit jitter).
  viewer.useDefaultRenderLoop = false;

  // --- Adaptive render quality ---
  // Detect the actual GPU the canvas landed on. On an integrated GPU, rendering
  // at the display's 2x device-pixel-ratio (4x the pixels) tanks the framerate,
  // so we render at 1x with MSAA off. On a discrete GPU (e.g. the RTX) we crank
  // resolution, MSAA, HDR and tile detail back up automatically — no code
  // change needed once the OS assigns this app to the discrete card.
  let gpuName = '';
  try {
    const gl = viewer.scene.canvas.getContext('webgl2') || viewer.scene.canvas.getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) gpuName = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
  } catch (e) {
    /* renderer info unavailable */
  }
  const tier = pickTier(gpuName);
  const q = QUALITY[tier];
  renderQuality = { tier, ...q, gpu: gpuName };
  const scene = viewer.scene;

  // useBrowserRecommendedResolution=true renders at 1x on 2x displays.
  viewer.useBrowserRecommendedResolution = !q.fullRes;
  viewer.resolutionScale = (window.devicePixelRatio || 1) < 1.5 ? q.supersample : 1.0;
  scene.msaaSamples = q.msaa;
  // MSAA already handles edges; FXAA on top would only soften the imagery.
  scene.postProcessStages.fxaa.enabled = q.msaa <= 1;
  // HDR + Cesium's default PBR-neutral tonemapper keep the photographic
  // colours of the tiles while giving the sun and sky real range. Bloom and
  // ambient occlusion stay off: bloom hazes the whole frame, and AO combined
  // with MSAA renders the photogrammetry black on some GPUs.
  scene.highDynamicRange = q.hdr;
  scene.postProcessStages.bloom.enabled = false;
  scene.postProcessStages.ambientOcclusion.enabled = false;
  console.log(`[IRON GLOVE] GPU: ${gpuName || 'unknown'} — ${q.label} quality`);

  // Load real JHU Homewood photogrammetry (Google Photorealistic 3D Tiles).
  // Two ways to get the exact same tiles:
  //   - with a Google Maps key: stream directly from Google (Google billing)
  //   - without one (default): pull through Cesium Ion's public asset 2275207,
  //     brokered by the Ion token we already have.
  const GOOGLE_3D_TILES_ION_ASSET = 2275207;
  let tileset;
  try {
    // Tuning: a large cache so revisited areas don't re-stream, and detail
    // scaled to the GPU tier. Every level of detail is refined in order:
    // skipping levels leaves the coarsest ancestor tiles standing in the
    // distance, which read as a dark wall across the horizon.
    const tuning = {
      maximumScreenSpaceError: q.sse,
      cacheBytes: q.cacheMB * 1024 * 1024,
      maximumCacheOverflowBytes: 1024 * 1024 * 1024,
      skipLevelOfDetail: false,
      preloadWhenHidden: true,
      foveatedScreenSpaceError: q.foveated,
      foveatedConeSize: 0.2,
    };
    if (typeof GOOGLE_MAPS_API_KEY === 'string' && GOOGLE_MAPS_API_KEY.length > 10) {
      tileset = await Cesium.createGooglePhotorealistic3DTileset(
        { key: GOOGLE_MAPS_API_KEY, onlyUsingWithGoogleGeocoder: true },
        tuning,
      );
    } else {
      tileset = await Cesium.Cesium3DTileset.fromIonAssetId(GOOGLE_3D_TILES_ION_ASSET, tuning);
    }
    scene.primitives.add(tileset);
    if (import.meta.env.DEV) window.__tileset = tileset;
  } catch (err) {
    console.warn('Google 3D Tiles unavailable, falling back to terrain only:', err);
  }

  // The Google tiles cover the whole planet, terrain included. Cesium's own
  // globe underneath only adds lower-resolution imagery that z-fights with the
  // photogrammetry ground and pokes through gaps, so keep it for the fallback.
  scene.globe.show = !tileset;

  // Real sunlight at a fixed late-afternoon time. The sun drives the sky, the
  // aerial haze on distant tiles, and the suit's key light (player.js).
  setSunFor(viewer, site);
  viewer.clock.shouldAnimate = false;
  scene.light = new Cesium.SunLight();
  scene.globe.enableLighting = true;

  // Atmosphere: sky and haze coloured by the sun, with enough aerial
  // perspective that distance reads like real air instead of a flat backdrop.
  scene.skyAtmosphere.show = true;
  scene.skyAtmosphere.perFragmentAtmosphere = tier !== 'lean';
  scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.SUNLIGHT;
  scene.fog.enabled = true;
  scene.fog.visualDensityScalar = 0.4;
  scene.sun.show = true;
  scene.sunBloom = q.hdr;

  // Surface real render errors in the console during development.
  viewer.scene.renderError.addEventListener((scene, err) => {
    console.error('Cesium render error:', err);
  });

  // Disable default camera controls — we drive the camera ourselves.
  const controller = viewer.scene.screenSpaceCameraController;
  controller.enableRotate = false;
  controller.enableTranslate = false;
  controller.enableZoom = false;
  controller.enableTilt = false;
  controller.enableLook = false;

  if (import.meta.env.DEV) window.__viewer = viewer;
  return viewer;
}
