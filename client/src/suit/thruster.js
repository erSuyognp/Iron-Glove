import * as Cesium from 'cesium';

// Afterburner trail: a glowing polyline of the suit's recent positions that
// widens and shifts from its cool colour toward a hot one as throttle climbs
// (cyan -> orange by default; a second pilot's trail burns amber -> red).

const MAX_POINTS = 45;

export function initTrail(viewer, { cool: coolCss = '#22ccff', hot: hotCss = '#ff7a1a' } = {}) {
  const points = [];
  let width = 3;
  const cool = Cesium.Color.fromCssColorString(coolCss);
  const hot = Cesium.Color.fromCssColorString(hotCss);
  const color = cool.clone();

  const entity = viewer.entities.add({
    name: 'Afterburner trail',
    polyline: {
      positions: new Cesium.CallbackProperty(() => points, false),
      width: new Cesium.CallbackProperty(() => width, false),
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.32,
        taperPower: 0.4, // fade the tail to a point
        color: new Cesium.CallbackProperty(() => color, false),
      }),
    },
  });

  return {
    // Append a world position (the boot jets); ratio 0..1 drives width + heat.
    push(position, ratio) {
      points.push(Cesium.Cartesian3.clone(position));
      if (points.length > MAX_POINTS) points.shift();
      const r = Math.max(0, Math.min(1, ratio));
      width = 3 + r * 13;
      Cesium.Color.lerp(cool, hot, r, color);
    },
    // Let the tail shrink when nearly stopped, so it doesn't blob in place.
    decay() {
      if (points.length > 0) points.shift();
    },
    clear() {
      points.length = 0;
    },
    destroy() {
      viewer.entities.remove(entity);
    },
    entity,
  };
}
