import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let suitMesh = null;
let bones = {};

export async function loadSuit(scene) {
  const loader = new GLTFLoader();

  // Fallback capsule until GLTF is available
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.6, 1.2, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0xb11212, metalness: 0.6, roughness: 0.3 })
  );
  const arc = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x7ee0ff })
  );
  arc.position.set(0, 0.2, 0.5);
  group.add(body);
  group.add(arc);
  scene.add(group);
  suitMesh = group;
  return group;
}

export function getSuit() { return suitMesh; }

export function applyBonePose(pitch, roll) {
  if (!bones.wrist) return;
  bones.wrist.rotation.x = pitch * Math.PI / 180 * 0.5;
  bones.wrist.rotation.z = roll  * Math.PI / 180 * 0.5;
}
