import * as THREE from 'three';
import * as Cesium from 'cesium';
import { arrowGeometry, liftedAxis, arrowFacing } from './tracker.js';
import { localToEcef } from '../combat/space.js';

// ---------------------------------------------------------------------------
// Drone pointers — a small red arrow for every hostile drone in the air, set
// around the suit on camera and pointing at its drone, so the pilot can tell
// where the fight is without hunting for specks against the skyline (or for
// the ones behind them).
//
// They are the pilot tracker's arrow (tracker.js) at a little over half its
// size, in red, and read the same way: each follows the true 3D direction to
// its drone, shown as if from higher than the chase camera, so ahead is up the
// screen, behind is down it, and left and right are left and right. An arrow
// also sits out from the suit along that same direction, so where it is and
// which way it points agree, and two drones never share one. They are HUD
// marks: drawn over everything, never hidden behind a building or the suit.
// ---------------------------------------------------------------------------

// The overlay skips tone mapping for these, as for the tracker: ACES would wash
// a saturated red toward orange.
const BODY_RED = 0xc4161a;
const GLOW_RED = 0xff2a1f;
// At this size the outline is half the arrow's pixels: a pale one (as on the
// tracker) turns the whole thing salmon, so this one is red too, just lighter.
const EDGE_RED = 0xff4a3d;

const POINTER_LENGTH = 3.4; // m tip to tail (the pilot tracker's arrow is 5.4)
const RING_RADIUS = 12; // m out from the suit's middle: clear of its arms, under the tracker
const SUIT_MID = 5.5; // m above the boots: where the ring is centred and ranges are measured
// Right on top of a drone the arrow says nothing the pilot can't see.
const FADE_NEAR = 25; // m: hidden
const FADE_FAR = 60; // m: fully shown
const FADE_RATE = 6; // 1/s
// Nearer drones get the bigger arrow.
const NEAR = 150; // m: full size up to here
const FAR = 700; // m: smallest from here on
const FAR_SIZE = 0.7;
const PULSE_RATE = 5; // rad/s of the glow
const WARM_POOL = 4; // a drone strike launches four: their arrows are built (and compiled) up front

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Create the pointers in the suit overlay. Nothing shows until there are drones.
 * @param {{ addObject(object:THREE.Object3D, prepare:Function):void, warm(object):void }} overlay
 * @returns {{ update(from:object, drones:Iterable<{id, pos:THREE.Vector3}>, dt:number):void, count:number }}
 */
export function createDronePointers(overlay) {
  const geometry = arrowGeometry(POINTER_LENGTH);
  const outline = new THREE.EdgesGeometry(geometry, 30);
  const root = new THREE.Group();

  function material(Type, options) {
    return new Type({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false, ...options });
  }

  function build() {
    const glowMat = material(THREE.MeshBasicMaterial, { color: GLOW_RED, blending: THREE.AdditiveBlending, side: THREE.BackSide });
    const bodyMat = material(THREE.MeshStandardMaterial, { color: BODY_RED, emissive: GLOW_RED, emissiveIntensity: 0.45, metalness: 0.1, roughness: 0.45 });
    const edgeMat = material(THREE.LineBasicMaterial, { color: EDGE_RED });
    const glow = new THREE.Mesh(geometry, glowMat);
    glow.scale.set(1.18, 1.9, 1.18);
    const body = new THREE.Mesh(geometry, bodyMat);
    const edges = new THREE.LineSegments(outline, edgeMat);
    const arrow = new THREE.Group();
    arrow.matrixAutoUpdate = false;
    arrow.visible = false;
    // Drawn back to front, and after everything else in the overlay.
    [glow, body, edges].forEach((o, i) => {
      o.renderOrder = 20 + i;
      o.frustumCulled = false;
      arrow.add(o);
    });
    root.add(arrow);
    return { arrow, glowMat, bodyMat, edgeMat, dir: new Cesium.Cartesian3(), distance: 0, fade: 0, goal: 0, drone: null };
  }

  // Arrows are kept and handed from one drone to the next: a fight's worth of
  // them exists from the start, so none is compiled in the middle of it.
  const spare = [];
  const inUse = new Map(); // drone id -> pointer
  for (let i = 0; i < WARM_POOL; i++) spare.push(build());
  overlay.warm(root);

  // World (ECEF) state from update(); prepare() turns it into this frame's
  // camera-relative poses.
  const centre = new Cesium.Cartesian3(); // the middle of the suit on camera
  const up = new Cesium.Cartesian3(); // local vertical there
  const aim = new Cesium.Cartesian3();
  const toAim = new Cesium.Cartesian3();

  /**
   * Point an arrow at every drone for this frame.
   * @param from    view of the suit on camera, which the arrows surround
   * @param drones  the drones in the air: { id, pos } with pos in combat space (combat/space.js)
   */
  function update(from, drones, dt) {
    Cesium.Cartesian3.fromDegrees(from.longitude, from.latitude, from.altitude + (from.hover || 0) + SUIT_MID, Cesium.Ellipsoid.WGS84, centre);
    Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(centre, up);

    for (const pointer of inUse.values()) pointer.goal = 0; // until its drone shows up below
    for (const drone of drones) {
      let pointer = inUse.get(drone.id);
      if (!pointer) {
        pointer = spare.pop() ?? build();
        pointer.fade = 0;
        inUse.set(drone.id, pointer);
      }
      localToEcef(drone.pos, aim);
      Cesium.Cartesian3.subtract(aim, centre, toAim);
      pointer.distance = Cesium.Cartesian3.magnitude(toAim);
      // Keep the last direction if the drone sits right on the suit.
      if (pointer.distance > 1e-3) Cesium.Cartesian3.divideByScalar(toAim, pointer.distance, pointer.dir);
      pointer.goal = smoothstep(FADE_NEAR, FADE_FAR, pointer.distance);
    }

    // A drone that is gone takes its arrow with it, once that has faded out.
    const k = 1 - Math.exp(-FADE_RATE * dt);
    for (const [id, pointer] of inUse) {
      pointer.fade += (pointer.goal - pointer.fade) * k;
      if (pointer.goal === 0 && pointer.fade < 0.01) {
        pointer.arrow.visible = false;
        inUse.delete(id);
        spare.push(pointer);
      }
    }
  }

  const scratch = new Cesium.Cartesian3();
  const middle = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  // Camera-relative poses for the frame being drawn (the overlay camera sits at
  // the origin looking down -Z, +X right, +Y up).
  function prepare(viewMatrix) {
    if (!inUse.size) return;
    Cesium.Matrix4.multiplyByPoint(viewMatrix, centre, scratch);
    middle.set(scratch.x, scratch.y, scratch.z);
    const pulse = 0.5 + 0.5 * Math.sin((performance.now() / 1000) * PULSE_RATE);

    for (const pointer of inUse.values()) {
      const { arrow, fade } = pointer;
      liftedAxis(viewMatrix, pointer.dir, axis);
      pos.copy(middle).addScaledVector(axis, RING_RADIUS);
      // Hidden while faded out, and behind the lens (never with the chase camera, but be safe).
      arrow.visible = fade >= 0.01 && pos.z < -1;
      if (!arrow.visible) continue;

      arrowFacing(viewMatrix, up, axis, pos, quat);
      const size = (1 - (1 - FAR_SIZE) * smoothstep(NEAR, FAR, pointer.distance)) * (0.7 + 0.3 * fade);
      arrow.matrix.compose(pos, quat, scale.setScalar(size));
      arrow.matrixWorldNeedsUpdate = true;

      pointer.bodyMat.opacity = 0.95 * fade;
      pointer.bodyMat.emissiveIntensity = 0.35 + 0.25 * pulse;
      pointer.edgeMat.opacity = fade;
      pointer.glowMat.opacity = (0.3 + 0.3 * pulse) * fade;
    }
  }

  overlay.addObject(root, prepare);
  return {
    update,
    /** How many arrows are up (fading ones included). */
    get count() {
      return inUse.size;
    },
  };
}
