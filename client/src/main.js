// Entry point — wires all modules together.
// Phase 1: keyboard + Three.js blockout + HUD
// Phase 2: SpacetimeDB multiplayer
// Phase 3: glove input + GLTF suit
// Phase 4: Grok JARVIS
// Phase 5: sentinels + particles

import * as THREE from 'three';
import { initKeyboard, getKeyboardControl } from './input/keyboard.js';
import { connectGlove, setGloveHandler } from './input/glove.js';
import { loadSuit } from './suit/player.js';
import { updateSuitPhysics, orientationToVelocity } from './suit/physics.js';
import { createThrusterEmitter } from './suit/thruster.js';
import { updateHUD } from './hud/hud.js';
import { createSentinel } from './sentinel/sentinel.js';
import { jarvisComment, GAME_EVENTS } from './grok/jarvis.js';
import { scanCampusThreats, setThreatHandler } from './grok/threats.js';
import { createIronGloveStdb } from './spacetimedb/client.js';

// ── Scene ──────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x87b8d8, 80, 420);
scene.background = new THREE.Color(0x87b8d8);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('cesiumContainer')?.appendChild(renderer.domElement)
  || document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x334422, 1.1));
const sun = new THREE.DirectionalLight(0xfff2d0, 1.2);
sun.position.set(40, 80, 20);
scene.add(sun);

// ── Suit ───────────────────────────────────────────────────────────────
const suit = await loadSuit(scene);
const thruster = createThrusterEmitter(scene);

// ── Sentinels ──────────────────────────────────────────────────────────
const sentinels = [createSentinel(scene, 0)];

// ── State ──────────────────────────────────────────────────────────────
const state = {
  pos: new THREE.Vector3(0, 8, 30),
  vel: new THREE.Vector3(),
  pitch: 0, roll: 0,
  p0: 0, r0: 0,
  mode: 'KEYBOARD',
  hp: 100,
  poseAcc: 0,
};

const look = { x: 0, y: 0 };
window.addEventListener('mousemove', (e) => {
  if (e.buttons === 1) {
    look.y -= e.movementX * 0.005;
    look.x -= e.movementY * 0.005;
    look.x = Math.max(-1.1, Math.min(0.35, look.x));
  }
});

initKeyboard();

setGloveHandler((d) => {
  state.pitch = d.pitch;
  state.roll  = d.roll;
  state.mode  = 'GLOVE';
});

// ── SpacetimeDB ────────────────────────────────────────────────────────
const stdb = createIronGloveStdb({
  host: import.meta.env.VITE_SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com',
  dbName: 'iron-glove-suyog',
});
stdb.onStatus((msg) => {
  const el = document.getElementById('stdbStatus');
  if (el) el.textContent = msg;
});

// ── JARVIS ─────────────────────────────────────────────────────────────
let lastJarvis = '';
setThreatHandler((line) => { lastJarvis = line; });

// ── Game loop ──────────────────────────────────────────────────────────
function gloveControl() {
  const p = state.pitch - state.p0;
  const r = state.roll  - state.r0;
  return {
    up:     p < -18 ? Math.min(1, (-p - 18) / 25) : p > 18 ? -0.5 : 0,
    thrust: r >  16 ? Math.min(1, (r  - 16) / 25) : 0,
    brake:  r < -16 ? Math.min(1, (-r - 16) / 25) : 0,
  };
}

function tick(dt) {
  const c = state.mode === 'GLOVE' ? gloveControl() : getKeyboardControl();
  const yaw = look.y;
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));

  state.vel.addScaledVector(fwd, c.thrust * 28 * dt);
  state.vel.multiplyScalar(1 - c.brake * 1.8 * dt);
  state.vel.y += (c.up * 22 - 8) * dt;
  state.vel.multiplyScalar(0.985);
  state.pos.addScaledVector(state.vel, dt);
  state.pos.y = Math.max(2, Math.min(80, state.pos.y));

  updateSuitPhysics(suit, state.pos, state.pos.clone(), state.vel);
  suit.position.copy(state.pos);

  camera.position.copy(state.pos)
    .add(new THREE.Vector3(0, 2.2, 8).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  camera.lookAt(state.pos.x, state.pos.y + 1, state.pos.z);

  const thrusting = c.thrust > 0.1;
  thruster.update(state.pos, thrusting);

  sentinels.forEach((s) => s.update(dt, state.pos));

  if (stdb.connected) {
    state.poseAcc += dt;
    if (state.poseAcc >= 0.1) {
      state.poseAcc = 0;
      stdb.updatePose(state.pos.x, state.pos.y, state.pos.z, yaw, thrusting);
    }
  }

  scanCampusThreats();

  updateHUD({
    altitude: state.pos.y,
    speed: state.vel.length(),
    pitch: state.pitch,
    roll: state.roll,
    mode: state.mode,
    suitHealth: state.hp,
  }, lastJarvis);
}

let last = performance.now();
function loop(now) {
  tick((now - last) / 1000);
  last = now;
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── UI buttons ─────────────────────────────────────────────────────────
document.getElementById('connectGlove')?.addEventListener('click', () => connectGlove());
document.getElementById('calibrate')?.addEventListener('click', () => {
  state.p0 = state.pitch;
  state.r0 = state.roll;
});
document.getElementById('goOnline')?.addEventListener('click', () => {
  const name = prompt('Pilot name', 'Suyog') || 'Suyog';
  stdb.connect(name);
});
