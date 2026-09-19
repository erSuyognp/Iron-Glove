import * as Cesium from 'cesium';

// 3D waypoint for the active inspection mission: a glowing vertical beacon
// rising from the observation with a distance label at its tip, so the
// target is findable from kilometres away and from behind terrain.

const BEACON_HEIGHT_M = 900;
const ACTIVE = Cesium.Color.fromCssColorString('#c8a020');
const COMPLETE = Cesium.Color.fromCssColorString('#37e7ff');

/**
 * @param viewer  Cesium viewer
 * @returns {{ set(position, { getLabel, complete }), clear(), setComplete(bool), entities }}
 *   position  Cartesian3 of the marker base (the layer's terrain-lifted point)
 *   getLabel  () => string, evaluated every frame for the tip label
 */
export function createMissionMarker(viewer) {
  const dataSource = new Cesium.CustomDataSource('environmental-mission');
  viewer.dataSources.add(dataSource);
  const entities = []; // for collision-sensor exclusion
  let color = ACTIVE;
  let labelFn = () => '';

  const beacon = dataSource.entities.add({
    id: 'mission-beacon',
    show: false,
    polyline: {
      positions: [],
      width: 14,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.25,
        taperPower: 0.6,
        color: new Cesium.CallbackProperty(() => color.withAlpha(0.9), false),
      }),
      arcType: Cesium.ArcType.NONE,
    },
  });
  const tip = dataSource.entities.add({
    id: 'mission-tip',
    show: false,
    point: {
      pixelSize: 12,
      color: new Cesium.CallbackProperty(() => color, false),
      outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: new Cesium.CallbackProperty(() => labelFn(), false),
      font: '13px "Courier New", ui-monospace, monospace',
      fillColor: new Cesium.CallbackProperty(() => color, false),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -14),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: new Cesium.Color(0.04, 0.055, 0.1, 0.7),
    },
  });
  entities.push(beacon, tip);

  function set(position, { getLabel, complete = false } = {}) {
    const carto = Cesium.Cartographic.fromCartesian(position);
    const top = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height + BEACON_HEIGHT_M);
    beacon.polyline.positions = [position, top];
    tip.position = top;
    labelFn = getLabel ?? (() => '');
    color = complete ? COMPLETE : ACTIVE;
    beacon.show = true;
    tip.show = true;
  }

  function setComplete(complete) {
    color = complete ? COMPLETE : ACTIVE;
  }

  function clear() {
    beacon.show = false;
    tip.show = false;
    labelFn = () => '';
  }

  function destroy() {
    viewer.dataSources.remove(dataSource, true);
    entities.length = 0;
  }

  return { set, setComplete, clear, destroy, entities };
}
