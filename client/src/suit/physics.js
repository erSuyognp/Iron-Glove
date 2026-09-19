import * as THREE from 'three';

// 0.06 = heavy/sluggish, 0.08 = sweet spot, 0.12 = twitchy
const LERP_FACTOR = 0.08;

export function updateSuitPhysics(suitMesh, currentPos, targetPos, currentVel) {
  currentPos.lerp(targetPos, LERP_FACTOR);

  const lateralSpeed = Math.abs(currentVel.x);
  suitMesh.rotation.z = -currentVel.x * 0.4;
  suitMesh.rotation.x = -currentVel.z * 0.3;
}

export function orientationToVelocity(pitch, roll, yaw, throttle) {
  return {
    x: Math.sin(roll  * Math.PI / 180) * throttle,
    y: Math.sin(pitch * Math.PI / 180) * throttle * -1,
    z: Math.cos(pitch * Math.PI / 180) * throttle,
  };
}
