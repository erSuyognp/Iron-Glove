import * as THREE from 'three';
import * as Cesium from 'cesium';

// ---------------------------------------------------------------------------
// Pilot tracker — a blue 3D arrow floating over the suit on camera that points
// at the other pilot (the friend flying from the phone controller), with their
// name, distance and height difference beside it.
//
// The arrow is drawn in the suit overlay (player.js) and placed
// camera-relative each frame exactly like the suits. It follows the true 3D
// direction to the target, but is shown as if seen from LIFT higher than the
// chase camera: from just behind and above, an arrow aimed at a target dead
// ahead would otherwise foreshorten to a sliver. Lifted like this, "ahead"
// reads up the screen, "behind" down it, and left/right stay left/right, the
// way a satnav arrow does.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const X_AXIS = new THREE.Vector3(1, 0, 0);

// The overlay's ACES tone mapping washes a saturated blue out to pale sky, so
// the arrow skips it; the albedo is kept dark enough that lit faces stay in
// range instead of clipping toward cyan.
const BODY_BLUE = 0x1a5ec4;
const GLOW_BLUE = 0x1f6fff;
const EDGE_BLUE = 0x9fd0ff;

// Shape, in metres (the suit is 11 m tall); ARROW_LENGTH sizes all of it. A
// shaft behind the head keeps the direction unambiguous even when the arrow
// points back toward the camera, where a plain dart's far wing can pass for
// its tip.
const ARROW_LENGTH = 5.4; // tip to tail
const HEAD_LENGTH = 0.49 * ARROW_LENGTH; // tip to the barbs
const HEAD_WIDTH = 0.71 * ARROW_LENGTH; // across the barbs
const BARB_SWEEP = 0.1 * ARROW_LENGTH; // how far the barbs sweep back past the throat
const SHAFT_WIDTH = 0.24 * ARROW_LENGTH;
const ARROW_THICKNESS = 0.1 * ARROW_LENGTH; // plus the bevel
const BEVEL = 0.033 * ARROW_LENGTH;

const RIDE_HEIGHT = 20; // m above the boots of the suit it rides: clear of the head and name tag
const AIM_HEIGHT = 5.5; // m above a suit's boots: mid-suit, where distances are measured
const LIFT = 35 * DEG; // extra viewing elevation that keeps the arrow readable
const FACE_TO_LENS = 0.35; // how far the face leans toward the camera (keeps it off edge-on)

// Right beside the target the arrow only gets in the way. Phone pilots spawn
// 30 m away, so they are tracked from the moment they appear.
const FADE_NEAR = 15; // m: hidden
const FADE_FAR = 30; // m: fully shown
const FADE_RATE = 6; // 1/s
const PULSE_RATE = 4; // rad/s of the glow's "tracking" pulse

const LABEL_GAP = 12; // px between the arrow and its readout

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

// Height of the target relative to us: ▲ above, ▼ below.
function formatClimb(dAlt) {
  if (Math.abs(dAlt) < 3) return 'LEVEL';
  return `${dAlt > 0 ? '▲' : '▼'} ${Math.round(Math.abs(dAlt))} m`;
}

// An arrow lying flat: tip on +X, face normal +Y.
function arrowGeometry() {
  const half = ARROW_LENGTH / 2;
  const barbX = half - HEAD_LENGTH;
  const throatX = barbX + BARB_SWEEP;
  const shape = new THREE.Shape();
  shape.moveTo(half, 0);
  shape.lineTo(barbX, HEAD_WIDTH / 2);
  shape.lineTo(throatX, SHAFT_WIDTH / 2);
  shape.lineTo(-half, SHAFT_WIDTH / 2);
  shape.lineTo(-half, -SHAFT_WIDTH / 2);
  shape.lineTo(throatX, -SHAFT_WIDTH / 2);
  shape.lineTo(barbX, -HEAD_WIDTH / 2);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: ARROW_THICKNESS,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -ARROW_THICKNESS / 2);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * Create the tracker in the suit overlay. Hidden until it has a target.
 * @param {{ addObject(object:THREE.Object3D, prepare:Function):void }} overlay
 * @returns {{ update(from:object, target:{name:string, view:object}|null, dt:number):void }}
 */
export function createTracker(overlay) {
  const geometry = arrowGeometry();
  // Drawn back to front: a glow shell around the arrow, the body, then its outline.
  const glowMat = new THREE.MeshBasicMaterial({
    color: GLOW_BLUE,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    toneMapped: false,
  });
  const bodyMat = new THREE.MeshStandardMaterial({
    color: BODY_BLUE,
    emissive: GLOW_BLUE,
    emissiveIntensity: 0.3,
    metalness: 0.1,
    roughness: 0.45,
    transparent: true,
    opacity: 0,
    toneMapped: false,
  });
  const edgeMat = new THREE.LineBasicMaterial({
    color: EDGE_BLUE,
    transparent: true,
    opacity: 0,
    toneMapped: false,
  });

  const glow = new THREE.Mesh(geometry, glowMat);
  glow.scale.set(1.14, 1.8, 1.14);
  const body = new THREE.Mesh(geometry, bodyMat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), edgeMat);
  glow.renderOrder = 0;
  body.renderOrder = 1;
  edges.renderOrder = 2;

  const arrow = new THREE.Group();
  arrow.visible = false;
  for (const o of [glow, body, edges]) {
    o.frustumCulled = false;
    arrow.add(o);
  }

  const els = {
    root: document.getElementById('tracker'),
    name: document.getElementById('tracker-name'),
    dist: document.getElementById('tracker-dist'),
    alt: document.getElementById('tracker-alt'),
  };
  const shown = {};
  function show(key, el, text) {
    if (!el || shown[key] === text) return;
    shown[key] = text;
    el.textContent = text;
  }

  // World (ECEF) state from update(); prepare() turns it into this frame's
  // camera-relative pose.
  const anchor = new Cesium.Cartesian3(); // where the arrow floats
  const up = new Cesium.Cartesian3(); // local vertical there
  const dir = new Cesium.Cartesian3(); // unit vector toward the target
  const fromMid = new Cesium.Cartesian3();
  const aim = new Cesium.Cartesian3();
  const toAim = new Cesium.Cartesian3();
  let aimed = false; // has a direction ever been set
  let fade = 0;

  /**
   * Point the arrow for this frame.
   * @param from    view of the suit on camera, which the arrow rides
   * @param target  { name, view } of the pilot to point at, or null to fade out
   */
  function update(from, target, dt) {
    // The arrow keeps riding the suit while it fades, so it never lingers
    // where a target dropped off.
    const floor = from.altitude + (from.hover || 0);
    Cesium.Cartesian3.fromDegrees(from.longitude, from.latitude, floor + RIDE_HEIGHT, Cesium.Ellipsoid.WGS84, anchor);
    Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(anchor, up);

    let goal = 0;
    if (target) {
      const t = target.view;
      Cesium.Cartesian3.fromDegrees(
        t.longitude,
        t.latitude,
        t.altitude + (t.hover || 0) + AIM_HEIGHT,
        Cesium.Ellipsoid.WGS84,
        aim,
      );
      // Keep the last direction if the target sits right on the anchor.
      Cesium.Cartesian3.subtract(aim, anchor, toAim);
      const length = Cesium.Cartesian3.magnitude(toAim);
      if (length > 1e-3) {
        Cesium.Cartesian3.divideByScalar(toAim, length, dir);
        aimed = true;
      }
      Cesium.Cartesian3.fromDegrees(from.longitude, from.latitude, floor + AIM_HEIGHT, Cesium.Ellipsoid.WGS84, fromMid);
      const distance = Cesium.Cartesian3.distance(fromMid, aim);
      goal = smoothstep(FADE_NEAR, FADE_FAR, distance);
      show('name', els.name, target.name);
      show('dist', els.dist, formatDistance(distance));
      show('alt', els.alt, formatClimb(t.altitude - from.altitude));
    }
    fade += (goal - fade) * (1 - Math.exp(-FADE_RATE * dt));
  }

  let labelShown = false;
  let labelOpacity = '';
  function placeLabel(visible, x = 0, y = 0) {
    if (!els.root) return;
    if (visible !== labelShown) {
      labelShown = visible;
      els.root.hidden = !visible;
    }
    if (!visible) return;
    els.root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translateY(-50%)`;
    const opacity = fade.toFixed(2);
    if (opacity !== labelOpacity) {
      labelOpacity = opacity;
      els.root.style.opacity = opacity;
    }
  }

  const scratch = new Cesium.Cartesian3();
  const pos = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const face = new THREE.Vector3();
  const toLens = new THREE.Vector3();
  const side = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const ndc = new THREE.Vector3();

  // Camera-relative pose for the frame being drawn (the overlay camera sits
  // at the origin looking down -Z, +X right, +Y up).
  function prepare(viewMatrix, camera, width, height) {
    if (!aimed || fade < 0.01) {
      arrow.visible = false;
      placeLabel(false);
      return;
    }
    Cesium.Matrix4.multiplyByPoint(viewMatrix, anchor, scratch);
    pos.set(scratch.x, scratch.y, scratch.z);
    if (pos.z > -1) {
      // Behind the lens (never with the chase camera, but be safe).
      arrow.visible = false;
      placeLabel(false);
      return;
    }
    arrow.visible = true;

    // Tip along the lifted direction to the target.
    Cesium.Matrix4.multiplyByPointAsVector(viewMatrix, dir, scratch);
    axis.set(scratch.x, scratch.y, scratch.z).applyAxisAngle(X_AXIS, LIFT).normalize();
    // Face up in the same lifted view, so it lies like a real arrow seen from
    // above. Leaning it toward the lens as well keeps it from turning edge-on
    // when the target is straight above or below.
    Cesium.Matrix4.multiplyByPointAsVector(viewMatrix, up, scratch);
    face.set(scratch.x, scratch.y, scratch.z).applyAxisAngle(X_AXIS, LIFT);
    face.addScaledVector(axis, -face.dot(axis));
    toLens.copy(pos).negate().normalize();
    toLens.addScaledVector(axis, -toLens.dot(axis));
    face.addScaledVector(toLens, FACE_TO_LENS).normalize();
    side.crossVectors(axis, face);
    basis.makeBasis(axis, face, side);
    quat.setFromRotationMatrix(basis);

    // Grows in as it fades in.
    const size = 0.7 + 0.3 * fade;
    scale.setScalar(size);
    arrow.matrix.compose(pos, quat, scale);
    arrow.matrixWorldNeedsUpdate = true;

    const pulse = 0.5 + 0.5 * Math.sin((performance.now() / 1000) * PULSE_RATE);
    bodyMat.opacity = 0.94 * fade;
    bodyMat.emissiveIntensity = 0.22 + 0.16 * pulse;
    edgeMat.opacity = fade;
    glowMat.opacity = (0.25 + 0.25 * pulse) * fade;

    // The readout sits beside the arrow, clear of its tip whichever way it points.
    ndc.copy(pos).applyMatrix4(camera.projectionMatrix);
    const x = (ndc.x + 1) * 0.5 * width;
    const y = (1 - ndc.y) * 0.5 * height;
    const pxPerMetre = height / (2 * Math.tan((camera.fov * DEG) / 2) * -pos.z);
    placeLabel(true, x + (ARROW_LENGTH / 2) * size * pxPerMetre + LABEL_GAP, y);
  }

  overlay.addObject(arrow, prepare);
  return { update };
}
