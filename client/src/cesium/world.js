import * as Cesium from 'cesium';

const CESIUM_TOKEN = import.meta.env.VITE_CESIUM_TOKEN;
// Optional: a direct Google Maps Platform key. Not required — the tiles are the
// same either way — but supported in case you prefer Google billing over Ion.
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// JHU Homewood campus center (Keyser Quad) — the spawn point.
export const JHU_HOMEWOOD = {
  longitude: -76.6205,
  latitude: 39.3299,
  altitude: 150, // meters above ground
};

export function hasValidToken() {
  return (
    typeof CESIUM_TOKEN === 'string' &&
    CESIUM_TOKEN.length > 20 &&
    CESIUM_TOKEN !== 'your_cesium_ion_token'
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

  // --- Adaptive render quality ---
  // Detect the actual GPU the canvas landed on. On an integrated GPU, rendering
  // at the display's 2x device-pixel-ratio (4x the pixels) tanks the framerate,
  // so we render at 1x with MSAA off. On a discrete NVIDIA/RTX/Arc GPU we crank
  // resolution and MSAA back up automatically — no code change needed once the
  // OS assigns this app to the discrete card.
  let gpuName = '';
  try {
    const gl = viewer.scene.canvas.getContext('webgl2') || viewer.scene.canvas.getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) gpuName = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
  } catch (e) {
    /* renderer info unavailable */
  }
  const isDiscrete = /nvidia|geforce|rtx|radeon rx|intel arc/i.test(gpuName);

  if (isDiscrete) {
    viewer.useBrowserRecommendedResolution = false; // full device-pixel-ratio
    viewer.resolutionScale = 1.0;
    viewer.scene.msaaSamples = 4;
  } else {
    viewer.useBrowserRecommendedResolution = true; // ignore the 2x DPR
    viewer.resolutionScale = 1.0;
    viewer.scene.msaaSamples = 1;
  }
  viewer.scene.postProcessStages.fxaa.enabled = true;
  console.log(`[IRON GLOVE] GPU: ${gpuName || 'unknown'} — ${isDiscrete ? 'HIGH' : 'LEAN'} quality`);

  // Load real JHU Homewood photogrammetry (Google Photorealistic 3D Tiles).
  // Two ways to get the exact same tiles:
  //   - with a Google Maps key: stream directly from Google (Google billing)
  //   - without one (default): pull through Cesium Ion's public asset 2275207,
  //     brokered by the Ion token we already have.
  const GOOGLE_3D_TILES_ION_ASSET = 2275207;
  try {
    // Tuning: progressive refinement (show coarse fast, sharpen up), a large
    // cache so revisited areas don't re-stream, and detail focused where you
    // look. maximumScreenSpaceError up = fewer tiles = faster + smoother.
    const tuning = {
      maximumScreenSpaceError: 16,
      cacheBytes: 1536 * 1024 * 1024, // ~1.5 GB
      maximumCacheOverflowBytes: 1024 * 1024 * 1024,
      skipLevelOfDetail: true,
      baseScreenSpaceError: 1024,
      skipScreenSpaceErrorFactor: 16,
      skipLevels: 1,
      preloadWhenHidden: true,
      foveatedScreenSpaceError: true,
      foveatedConeSize: 0.2,
    };
    let tileset;
    if (typeof GOOGLE_MAPS_API_KEY === 'string' && GOOGLE_MAPS_API_KEY.length > 10) {
      tileset = await Cesium.createGooglePhotorealistic3DTileset(
        { key: GOOGLE_MAPS_API_KEY, onlyUsingWithGoogleGeocoder: true },
        tuning,
      );
    } else {
      tileset = await Cesium.Cesium3DTileset.fromIonAssetId(GOOGLE_3D_TILES_ION_ASSET, tuning);
    }
    viewer.scene.primitives.add(tileset);
    if (import.meta.env.DEV) window.__tileset = tileset;
  } catch (err) {
    console.warn('Google 3D Tiles unavailable, falling back to terrain only:', err);
  }

  // Dusk-ish lighting to match the Iron Man aesthetic.
  viewer.scene.light = new Cesium.DirectionalLight({
    direction: new Cesium.Cartesian3(0.5, 0.5, -1.0),
    intensity: 1.2,
  });
  viewer.scene.globe.enableLighting = true;

  // Atmosphere polish.
  viewer.scene.skyAtmosphere.show = true;
  viewer.scene.fog.enabled = true;

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
