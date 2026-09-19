import * as THREE from 'three';

const PARTICLE_COUNT = 80;

export function createThrusterEmitter(scene, offsetY = -1.0) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const velocities = [];

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    velocities.push(new THREE.Vector3(
      (Math.random() - 0.5) * 0.3,
      -(Math.random() * 0.8 + 0.2),
      (Math.random() - 0.5) * 0.3
    ));
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xff6600, size: 0.18, transparent: true, opacity: 0.8 });
  const emitter = new THREE.Points(geo, mat);
  scene.add(emitter);

  return {
    update(suitPos, active) {
      emitter.visible = active;
      if (!active) return;
      const pos = geo.attributes.position.array;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const base = i * 3;
        pos[base]     += velocities[i].x;
        pos[base + 1] += velocities[i].y;
        pos[base + 2] += velocities[i].z;
        // reset particle near suit boot position when it drifts far
        if (Math.abs(pos[base + 1] - suitPos.y) > 3) {
          pos[base]     = suitPos.x + (Math.random() - 0.5) * 0.2;
          pos[base + 1] = suitPos.y + offsetY;
          pos[base + 2] = suitPos.z + (Math.random() - 0.5) * 0.2;
        }
      }
      geo.attributes.position.needsUpdate = true;
    }
  };
}
