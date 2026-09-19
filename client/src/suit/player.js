import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import * as Cesium from 'cesium';
import { mountSuit, createFlightRig } from './rig.js';

// ---------------------------------------------------------------------------
// Suit rendering — Three.js GLTF on an overlay canvas above the Cesium viewer.
//
// Cesium renders the photoreal campus; a transparent Three.js <canvas> is
// stacked directly on top of Cesium's canvas. Every frame we copy Cesium's
// camera into the Three camera (they share the same ECEF world space), so each
// suit is drawn at the right screen position, size, and perspective as if it
// lived inside the Cesium scene. This is the "overlay canvas" approach from the
// project plan (Character rendering = Three.js overlay).
//
// One overlay hosts every pilot: the GLB loads once and each suit is a skinned
// clone with its own flight rig, so a phone pilot animates exactly like the
// local one.
//
// The suit's body frame is +X chest/forward, +Y left, +Z up: the axes of
// Cesium's heading/pitch/roll, anchored to a north-west-up local frame so a
// heading of 0 faces north like the chase camera. Limb poses and thrusters are
// solved in that same frame by rig.js; main.js supplies the attitude and the
// flight-state drivers.
// ---------------------------------------------------------------------------

// Visual height of the suit in meters (the model is normalized to this).
const TARGET_HEIGHT = 11;

// Local frame whose +X is north: with it, Cesium's heading/pitch/roll act on
// a body that faces +X (heading 0 = north, +pitch = nose up, +roll = right
// side down), exactly as the chase camera interprets them.
const northWestUpToFixedFrame = Cesium.Transforms.localFrameToFixedFrameGenerator('north', 'west');

// Reused scratch so we don't allocate a Matrix4 / array every frame. Suits
// are posed one after another, so they can share it. A suit's own pose is in
// Cesium's ECEF coordinates (~6.4 million metres from the origin). We never
// give that large translation to Three/WebGL directly: a 32-bit GPU matrix
// loses sub-metre precision at that scale and makes the suit visibly shimmer
// against the campus. `cameraPoseM` is the same pose expressed relative to the
// active camera, where its translation is only a few metres.
const cameraPoseM = new Cesium.Matrix4();
const scratchArr = new Array(16);
const scratchPos = new Cesium.Cartesian3();
const scratchBody = new Cesium.Cartesian3();
const qHeading = new Cesium.Quaternion();
const qRoll = new Cesium.Quaternion();
const qLean = new Cesium.Quaternion();
const qBody = new Cesium.Quaternion();
const bodyRotation = new Cesium.Matrix3();
const bootBody = new THREE.Vector3();

/**
 * Create the Three.js overlay and start loading the GLB.
 * @param {Cesium.Viewer} viewer
 * @param {string} glbUrl  served URL of the .glb (e.g. '/iron_man.glb')
 * @returns {{ createSuit(opts?):SuitHandle, addObject(object, prepare):void, render():void, setVisible(b):void }}
 */
export function initSuitOverlay(viewer, glbUrl) {
  const cesiumCanvas = viewer.scene.canvas;

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    depth: true,
    powerPreference: 'high-performance',
    precision: 'highp',
  });
  renderer.setClearColor(0x000000, 0); // transparent — only the suits are drawn
  // A 2x cap keeps a 4K/Retina screen sharp without creating an unnecessarily
  // huge second render target alongside Cesium.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  const canvas = renderer.domElement;
  canvas.id = 'suit-overlay';
  Object.assign(canvas.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '5', // above Cesium's canvas, below the speed FX (10) and HUD (20)
  });
  document.body.appendChild(canvas);

  const scene = new THREE.Scene();

  // Matrix updates are manual. The Three camera stays at the origin while each
  // suit is transformed into camera-relative space immediately before drawing.
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 1e7);
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;

  // Lighting: warm dusk key, cool rim, and a soft ambient so the metal reads.
  scene.add(new THREE.AmbientLight(0x8fa3c8, 1.2));
  const key = new THREE.DirectionalLight(0xfff1de, 2.8);
  key.position.set(0.6, 1.0, 0.7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x3fa9ff, 1.35);
  rim.position.set(-0.7, 0.25, -0.8);
  scene.add(rim);

  let template = null; // the loaded glTF scene; every suit is a clone of it
  let hidden = false;
  const suits = [];
  const extras = []; // prepare() of each other overlay object (e.g. the pilot tracker)

  const loader = new GLTFLoader();
  loader.load(
    glbUrl,
    (gltf) => {
      template = gltf.scene;
      template.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false; // the suit is always our subject; never cull
          o.castShadow = false;
          // Preserve authored PBR materials while making metallic highlights
          // survive the transparent overlay's cinematic tone mapping.
          const materials = Array.isArray(o.material) ? o.material : [o.material];
          for (const material of materials) {
            if (material && 'envMapIntensity' in material) material.envMapIntensity = 1.35;
          }
        }
      });
      for (const suit of suits) suit.build();
    },
    undefined,
    (err) => console.error('[suit] GLTF load failed:', err),
  );

  /**
   * Add a suit to the overlay. Safe to call before the GLB has loaded.
   * @param {{ name?: string, jets?: 'ion'|'amber' }} opts
   */
  function createSuit({ name = 'suit', jets = 'ion' } = {}) {
    // Scene graph:
    //   root  — the body frame, placed at the suit's camera-relative pose each
    //           frame (position + heading/roll/lean).
    //   mount — rig.js orientation fixes + scale, pelvis on the origin.
    //   model — a skinned clone of the GLB, posed each frame by the flight rig.
    const root = new THREE.Object3D();
    root.matrixAutoUpdate = false;
    root.visible = false;
    scene.add(root);

    const poseM = new Cesium.Matrix4();
    let rig = null;
    let pivotHeight = 0; // metres from the soles up to the pelvis pivot
    let lastPoseAt = 0;
    let posed = false;
    let visible = true;

    function build() {
      if (rig || !template) return;
      const model = SkeletonUtils.clone(template);
      // Scale to TARGET_HEIGHT and orient into the body frame with the pelvis
      // on the origin, then measure the rig in that pose.
      const mounted = mountSuit(model, TARGET_HEIGHT);
      root.add(mounted.mount);
      pivotHeight = mounted.pivotHeight;
      rig = createFlightRig(model, root, { soleZ: -pivotHeight, jets });
      console.log(
        `[suit] ${name} ready — ${mounted.height.toFixed(1)}m tall, ` +
          `${rig.stats.arms} arms / ${rig.stats.legs} legs rigged, ${rig.stats.jets} ${jets} jets online`,
      );
    }

    // Place the suit at its geodetic pose and pose the rig for this frame.
    // `view` carries longitude/latitude/altitude and heading/roll, plus the
    // visual-only extras from main.js: bank (turn lean), lean (thrust-line tilt
    // into the motion), hover/sway (idle float) and `thrust` (rig drivers).
    function setTransform(view) {
      // The mesh pivots at its pelvis; lift it so the boots stay at `altitude`
      // while standing upright, exactly where the physics and camera expect.
      const pos = Cesium.Cartesian3.fromDegrees(
        view.longitude,
        view.latitude,
        view.altitude + (view.hover || 0) + pivotHeight,
        Cesium.Ellipsoid.WGS84,
        scratchPos,
      );
      northWestUpToFixedFrame(pos, Cesium.Ellipsoid.WGS84, poseM);

      // Attitude, composed right to left: lean the body about its lateral axis
      // (chest down into the motion), bank/roll about the direction of travel,
      // then turn to the heading. Rolling after leaning keeps a barrel roll or
      // bank spinning about the flight path even when the suit is lying flat.
      Cesium.Quaternion.fromAxisAngle(
        Cesium.Cartesian3.UNIT_Y,
        Cesium.Math.toRadians((view.lean || 0) - (view.swayPitch || 0)),
        qLean,
      );
      Cesium.Quaternion.fromAxisAngle(
        Cesium.Cartesian3.UNIT_X,
        Cesium.Math.toRadians((view.roll || 0) + (view.bank || 0) + (view.swayRoll || 0)),
        qRoll,
      );
      Cesium.Quaternion.fromAxisAngle(
        Cesium.Cartesian3.UNIT_Z,
        -Cesium.Math.toRadians(view.heading),
        qHeading,
      );
      Cesium.Quaternion.multiply(qHeading, qRoll, qBody);
      Cesium.Quaternion.multiply(qBody, qLean, qBody);
      Cesium.Matrix3.fromQuaternion(qBody, bodyRotation);
      Cesium.Matrix4.multiplyByMatrix3(poseM, bodyRotation, poseM);
      posed = true;

      const now = performance.now();
      const dt = lastPoseAt ? Math.min(0.1, (now - lastPoseAt) / 1000) : 1 / 60;
      lastPoseAt = now;
      rig?.update(view.thrust, view.lean || 0, dt);
    }

    // World (ECEF) position between the two boot nozzles for the current pose,
    // or undefined until the suit has loaded. Anchors the afterburner trail.
    function bootAnchor(result) {
      if (!rig?.bootOrigin(bootBody)) return undefined;
      Cesium.Cartesian3.fromElements(bootBody.x, bootBody.y, bootBody.z, scratchBody);
      return Cesium.Matrix4.multiplyByPoint(poseM, scratchBody, result);
    }

    function dispose() {
      scene.remove(root);
      const i = suits.indexOf(handle);
      if (i >= 0) suits.splice(i, 1);
    }

    // Camera-relative placement for this frame; false when not drawable.
    function prepare(viewMatrix) {
      root.visible = Boolean(visible && rig && posed);
      if (!root.visible) return false;
      Cesium.Matrix4.multiply(viewMatrix, poseM, cameraPoseM);
      Cesium.Matrix4.toArray(cameraPoseM, scratchArr);
      root.matrix.fromArray(scratchArr);
      root.matrixWorldNeedsUpdate = true;
      return true;
    }

    const handle = {
      build,
      prepare,
      setTransform,
      bootAnchor,
      dispose,
      setVisible(v) {
        visible = v;
      },
      isReady: () => Boolean(rig),
    };
    suits.push(handle);
    build();
    return handle;
  }

  /**
   * Draw another object in the overlay (e.g. the pilot tracker). Like the
   * suits it lives in camera-relative space: `prepare(viewMatrix, camera,
   * width, height)` runs every frame before drawing and sets `object.matrix`.
   */
  function addObject(object, prepare) {
    object.matrixAutoUpdate = false;
    scene.add(object);
    extras.push(prepare);
  }

  // Match the Three canvas resolution to the Cesium canvas (CSS pixels).
  function syncSize() {
    const w = cesiumCanvas.clientWidth || window.innerWidth;
    const h = cesiumCanvas.clientHeight || window.innerHeight;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      renderer.setSize(w, h, false);
    }
    return { w, h };
  }

  // Draw from Cesium's camera. The important detail is that each suit is first
  // multiplied by the Cesium view matrix, keeping coordinates near (0,0,0).
  // This eliminates globe-scale float precision jitter and means both engines
  // consume the exact same camera pose for the current frame.
  function render() {
    if (hidden || !template) return;
    const { w, h } = syncSize();
    const cam = viewer.camera;

    // Projection: Cesium's vertical FOV (fovy already accounts for the speed
    // FOV punch main.js applies to frustum.fov) + the live aspect ratio.
    camera.fov = Cesium.Math.toDegrees(cam.frustum.fovy);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // Convert each ECEF pose into camera-relative coordinates before it enters
    // Three's float matrix pipeline. Keeping the camera at identity avoids a
    // second enormous ECEF transform and its accompanying shimmer.
    for (const suit of suits) suit.prepare(cam.viewMatrix);
    for (const prepare of extras) prepare(cam.viewMatrix, camera, w, h);

    camera.matrix.identity();
    camera.matrixWorld.identity();
    camera.matrixWorldInverse.identity();

    // Propagate the poses we set on each root down to its model subtree.
    scene.updateMatrixWorld(true);

    renderer.render(scene, camera);
  }

  function setVisible(v) {
    hidden = !v;
    canvas.style.display = v ? 'block' : 'none';
  }

  const ro = new ResizeObserver(() => syncSize());
  ro.observe(cesiumCanvas);
  syncSize();

  return { createSuit, addObject, render, setVisible };
}
