import * as Cesium from 'cesium';

// Afterburner trail: a glowing polyline of the suit's recent positions that
// widens and shifts from cyan toward hot orange as throttle climbs.

const MAX_POINTS = 45;

export function initTrail(viewer) {
  const points = [];
  let width = 3;
  const color = Cesium.Color.fromCssColorString('#22ccff').clone();
  const cool = Cesium.Color.fromCssColorString('#22ccff');
  const hot = Cesium.Color.fromCssColorString('#ff7a1a');

  viewer.entities.add({
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
    // Append the current position; ratio 0..1 drives width + heat.
    push(longitude, latitude, altitude, ratio) {
      points.push(Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude));
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
  };
}
