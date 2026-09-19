import * as THREE from 'three';

// JHU Homewood landmark patrol waypoints (Three.js local coords, not geo)
const WAYPOINTS = [
  { x: -30, y: 25, z: -20 },   // Hodson
  { x:  50, y: 28, z: -70 },   // Gilman
  { x: -90, y: 20, z:  40 },   // Dorm slab
  { x:  20, y: 22, z:  90 },   // Long lab
  { x: 120, y: 30, z:  10 },   // East building
];

export function createSentinel(scene, id = 0) {
  const mesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(2.0),
    new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x550000, metalness: 0.7 })
  );
  mesh.position.set(WAYPOINTS[0].x, WAYPOINTS[0].y, WAYPOINTS[0].z);

  const sentinel = {
    id,
    mesh,
    hp: 100,
    patrolIndex: 0,
    targetPlayerId: null,
    speed: 8,

    update(dt, playerPos) {
      if (this.hp <= 0) {
        mesh.visible = false;
        return;
      }

      mesh.rotation.y += dt * 1.5;

      const target = this.targetPlayerId
        ? playerPos
        : WAYPOINTS[this.patrolIndex];

      const dir = new THREE.Vector3(
        target.x - mesh.position.x,
        target.y - mesh.position.y,
        target.z - mesh.position.z,
      );

      if (dir.length() < 3) {
        this.patrolIndex = (this.patrolIndex + 1) % WAYPOINTS.length;
      } else {
        dir.normalize().multiplyScalar(this.speed * dt);
        mesh.position.add(dir);
      }
    },

    takeDamage(amount) {
      this.hp = Math.max(0, this.hp - amount);
      return this.hp <= 0;
    },
  };

  scene.add(mesh);
  return sentinel;
}
