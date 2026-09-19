import * as Cesium from 'cesium';

// Third-person camera that follows the suit entity
export function updateCamera(viewer, suitPosition, yaw) {
  const offset = new Cesium.Cartesian3(
    Math.sin(yaw) * -8,
    Math.cos(yaw) * -8,
    3
  );

  const camPos = Cesium.Cartesian3.add(suitPosition, offset, new Cesium.Cartesian3());
  viewer.camera.position = camPos;
  viewer.camera.lookAt(suitPosition, new Cesium.HeadingPitchRange(yaw, -0.2, 10));
}
