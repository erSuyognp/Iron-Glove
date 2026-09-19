import * as Cesium from 'cesium';

const CESIUM_TOKEN = import.meta.env.VITE_CESIUM_TOKEN;

export async function initWorld() {
  Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;

  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: await Cesium.createWorldTerrainAsync(),
    timeline: false,
    animation: false,
    baseLayerPicker: false,
  });

  const tileset = await Cesium.createGooglePhotorealistic3DTilesAsync();
  viewer.scene.primitives.add(tileset);

  viewer.scene.light = new Cesium.DirectionalLight({
    direction: new Cesium.Cartesian3(0.5, 0.5, -1.0),
    intensity: 1.2,
  });

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(-76.6205, 39.3299, 150),
    orientation: { heading: 0, pitch: -0.3, roll: 0 },
    duration: 0,
  });

  return viewer;
}
