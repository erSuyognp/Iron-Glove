import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mountSuit, createFlightRig } from '../suit/rig.js';

// ---------------------------------------------------------------------------
// The boot screen's hero: the game's own suit, hovering on its jets. It is the
// same GLB, mounted and posed by the same flight rig as in flight (suit/rig.js),
// on a small renderer of its own that is torn down before the game starts, so
// the flight overlay never shares the GPU with it.
//
// The scene uses the rig's body frame: +X chest/forward, +Y left, +Z up.
// ---------------------------------------------------------------------------

// The game's suit height in metres. The rig's jet flames are sized for it, so
// the hero keeps the scale and the camera below is framed around it.
const SUIT_HEIGHT = 11;
const FACING = -0.42; // rad: resting turn, a three-quarter view towards the copy

/**
 * Start the hovering suit on `canvas`.
 * @returns {{ dispose(): void }}
 */
export function startHeroSuit(canvas, glbUrl) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (err) {
    console.warn('[landing] no WebGL for the hero suit:', err);
    return { dispose() {} };
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 400);
  camera.up.set(0, 0, 1);
  camera.position.set(33, 0, 1);
  camera.lookAt(0, 0, -1.6); // a little low, leaving room for the boot jets

  // The page's palette: warm gold key, reactor-red rim, cool fill from below.
  scene.add(new THREE.AmbientLight(0x8a93b0, 1.1));
  const key = new THREE.DirectionalLight(0xffe2b0, 3.2);
  key.position.set(4, 3, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff3a24, 3.4);
  rim.position.set(-4, -3, 1.5);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0x4aa8ff, 1.1);
  fill.position.set(1, -2, -4);
  scene.add(fill);

  const body = new THREE.Object3D();
  scene.add(body);

  let rig = null;
  let disposed = false;
  let frame = null;
  let last = 0;

  new GLTFLoader().load(
    glbUrl,
    (gltf) => {
      if (disposed) return;
      const mounted = mountSuit(gltf.scene, SUIT_HEIGHT);
      body.add(mounted.mount);
      rig = createFlightRig(gltf.scene, body, { soleZ: -mounted.pivotHeight, jets: 'ion' });
      canvas.classList.add('ready');
    },
    undefined,
    (err) => console.error('[landing] hero suit failed to load:', err),
  );

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    return true;
  }

  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (!rig || !resize()) return;
    const t = now / 1000;
    const dt = last ? Math.min(0.1, t - last) : 1 / 60;
    last = t;

    // Idle float: a slow bob, a slower drift of the heading, and a breath of
    // pitch and roll, each on its own period so the loop never reads as one.
    const bob = Math.sin(t * 1.1);
    body.position.z = bob * 0.35;
    body.rotation.set(Math.sin(t * 0.7) * 0.035, Math.sin(t * 0.9 + 1) * 0.03, FACING + Math.sin(t * 0.35) * 0.22);
    // The rising half of the bob is the jets pushing.
    rig.update({ climb: Math.cos(t * 1.1) * 0.35 }, 0, dt);
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(tick);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      scene.traverse((o) => {
        if (!o.isMesh && !o.isSprite) return;
        o.geometry?.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const v of Object.values(m ?? {})) if (v?.isTexture) v.dispose();
          m?.dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
