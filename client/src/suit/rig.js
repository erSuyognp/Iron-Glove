import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Flight rig — procedural flight poses and ion thrusters for the suit skeleton.
//
// Everything here is solved in the suit's BODY frame: +X chest/forward,
// +Y left, +Z head/up. Those are the axes Cesium's heading/pitch/roll use, so
// the body attitude computed in main.js and the limb poses here agree on what
// "forward" means.
//
// The asset is a UE4-style skeleton whose bone-local axes point in arbitrary
// directions (the foot's local Z points sideways, the hand's points backward),
// so nothing is posed with local Euler offsets. Each joint instead gets a
// body-space rotation that aims its limb at a target direction, which is then
// converted back into the bone's local frame. The jets are aimed the same way:
// palms exhaust along the palm normal and boots down the line of the leg, so
// every flame points opposite the force it is making.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// glTF is Y-up and faces +Z. Tipping +Y up onto +Z, then a quarter turn about
// Z, puts the chest on +X and the left hand on +Y.
const MODEL_UP_FIX = Math.PI / 2;
const MODEL_YAW_FIX = Math.PI / 2;

// Lower-cased node names in the Iron Man UCM skeleton.
const BONE_PATTERNS = {
  pelvis: /^pelvis_/,
  neck: /^neck_01_/,
  upperArmL: /^upperarm_l_/,
  upperArmR: /^upperarm_r_/,
  forearmL: /^lowerarm_l_/,
  forearmR: /^lowerarm_r_/,
  handL: /^hand_l_\d+$/,
  handR: /^hand_r_\d+$/,
  middleL: /^middle_01_l_/, // middle knuckle, for the palm centre
  middleR: /^middle_01_r_/,
  palmL: /^fx_hand_l_\d+$/, // repulsor socket in front of the palm
  palmR: /^fx_hand_r_\d+$/,
  thighL: /^thigh_l_/,
  thighR: /^thigh_r_/,
  calfL: /^calf_l_/,
  calfR: /^calf_r_/,
  footL: /^foot_l_/,
  footR: /^foot_r_/,
  soleL: /^fx_ball_l_\d+$/, // boot-jet socket under the arch
  soleR: /^fx_ball_r_\d+$/,
};

// Key poses for the LEFT limbs; the right side mirrors them. Limb entries are
// [flex, abd] in degrees (see limbDir): flex swings a hanging limb forward,
// abd swings it out to its own side. `palm` is where the palm faces, which is
// also where its repulsor exhausts. `foot` is extra toe point.
const POSES = {
  // Upright hover: arms out, palms pressing down, boots under the hips.
  hover: { upperArm: [-12, 30], forearm: [4, 45], palm: [0, -4], thigh: [2, 6], calf: [-6, 6], foot: 14 },
  // Sinking: arms spread wide to steady the fall.
  descend: { upperArm: [-6, 48], forearm: [6, 58], palm: [0, 6], thigh: [6, 9], calf: [-10, 9], foot: 8 },
  // Climbing: arms drive down along the body, legs straight, toes down.
  climb: { upperArm: [-10, 17], forearm: [-6, 21], palm: [4, 12], thigh: [0, 3], calf: [-3, 3], foot: 34 },
  // Cruise: streamlined. Arms swept back with the palms aimed down the body
  // at the feet, boots in line with it.
  cruise: { upperArm: [-15, 13], forearm: [-11, 15], palm: [14, 6], thigh: [-5, 2], calf: [-5, 2], foot: 48 },
  // Braking / reversing: arms out front, palms pushing forward, knees up.
  brake: { upperArm: [25, 32], forearm: [30, 40], palm: [45, 5], thigh: [26, 8], calf: [4, 8], foot: 0 },
};
const LIMBS = ['upperArm', 'forearm', 'palm', 'thigh', 'calf'];

const POSE_RESPONSE = 7; // 1/s — how quickly the limbs follow a new flight state
const FOREARM_TWIST = 0.7; // share of palm roll the forearm carries (the wrist only bends)
const TURN_SPREAD = 20; // deg the outer arm swings wide in a turn
const TURN_TUCK = 8; // deg the inner arm tucks in
const NECK_LEAN_SHARE = 0.5; // head lifts to look along the flight path
const BOOT_ALONG_LEG = 0.8; // boot exhaust: mostly down the shin, a little off the sole

// Flame colours: outer plume, white-hot core, nozzle glow. Player 1 burns
// ion-blue; a second pilot burns amber so the two suits read apart.
const JET_PALETTES = {
  ion: { outer: 0x3ecbff, core: 0xd8f4ff, glow: 0x9fe6ff },
  amber: { outer: 0xff9a2e, core: 0xfff0d2, glow: 0xffc27a },
};

// Jet output. Boots always carry the suit's weight, so they idle at a hover
// burn instead of switching off; the palms trim balance and steer.
const HOVER_BOOT = 0.24;
const HOVER_PALM = 0.12;
const JET_RESPONSE = 12; // 1/s — ignition/throttle-down speed of the flames
const PALM_STANDOFF = 0.1; // m in front of the palm the flame starts

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Unit direction of a limb hanging from its joint, for side +1 (left) or -1.
function limbDir(out, [flexDeg, abdDeg], side, extraAbd = 0) {
  const f = flexDeg * DEG;
  const a = (abdDeg + extraAbd) * DEG;
  return out.set(Math.sin(f) * Math.cos(a), side * Math.sin(a), -Math.cos(f) * Math.cos(a));
}

function makePose() {
  return { upperArm: [0, 0], forearm: [0, 0], palm: [0, 0], thigh: [0, 0], calf: [0, 0], foot: 0 };
}

function copyPose(out, p) {
  for (const k of LIMBS) {
    out[k][0] = p[k][0];
    out[k][1] = p[k][1];
  }
  out.foot = p.foot;
  return out;
}

// out = lerp(out, p, t)
function mixPose(out, p, t) {
  if (t <= 0) return out;
  for (const k of LIMBS) {
    out[k][0] += (p[k][0] - out[k][0]) * t;
    out[k][1] += (p[k][1] - out[k][1]) * t;
  }
  out.foot += (p.foot - out.foot) * t;
  return out;
}

// Blend the key poses for the current flight state. `d` holds normalized
// drivers: forward (1 = cruise speed, >1 boosting, <0 reversing), climb
// (-1..1 of max vertical rate), accel (-1..1), turn (-1 left .. 1 right).
function targetPose(out, d) {
  const forward = d.forward || 0;
  const climb = clamp(d.climb || 0, -1, 1);
  const accel = clamp(d.accel || 0, -1, 1);
  const cruise = smoothstep(0.03, 0.8, forward);
  const brake = clamp(Math.max(-forward * 1.6, -accel * 0.75), 0, 1);
  copyPose(out, POSES.hover);
  mixPose(out, POSES.descend, Math.max(0, -climb) * (1 - cruise));
  mixPose(out, POSES.climb, Math.max(0, climb) * (1 - 0.6 * cruise));
  mixPose(out, POSES.cruise, cruise);
  mixPose(out, POSES.brake, brake);
  return { cruise, brake };
}

// Thrust per jet channel, 0..~1.3. Boots lift and drive; palms brake, trim,
// and push the yaw (the outer palm fires harder in a turn).
function thrustLevels(d, w) {
  const forward = d.forward || 0;
  const climb = clamp(d.climb || 0, -1, 1);
  const accel = clamp(d.accel || 0, -1, 1);
  const turn = clamp(d.turn || 0, -1, 1);
  const boost = clamp((forward - 1) / 1.2, 0, 1);
  const moving = Math.min(1, Math.abs(forward));
  const boot =
    HOVER_BOOT +
    0.42 * moving +
    0.35 * boost +
    0.34 * Math.max(0, climb) -
    0.16 * Math.max(0, -climb) +
    0.22 * Math.max(0, accel);
  const palm =
    HOVER_PALM + 0.2 * clamp(forward, 0, 1) + 0.18 * boost + 0.6 * w.brake + 0.08 * Math.max(0, climb);
  return {
    boot: clamp(boot, 0, 1.3),
    palmL: clamp(palm + 0.34 * Math.max(0, turn) - 0.1 * Math.max(0, -turn), 0, 1.3),
    palmR: clamp(palm + 0.34 * Math.max(0, -turn) - 0.1 * Math.max(0, turn), 0, 1.3),
  };
}

// Swing-twist split: the part of rotation `q` about unit `axis`.
function twistAbout(out, q, axis) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  return out.set(axis.x * d, axis.y * d, axis.z * d, q.w).normalize();
}

function findNode(root, pattern) {
  let found = null;
  root.traverse((o) => {
    if (!found && pattern.test((o.name || '').toLowerCase())) found = o;
  });
  return found;
}

/**
 * Scale a freshly loaded suit to `targetHeight` metres and orient it into the
 * body frame (+X forward, +Y left, +Z up) with its pelvis on the origin, so it
 * leans and banks about its centre of mass rather than swinging around its
 * boots. Parent the returned `mount` under a body-frame node.
 */
export function mountSuit(model, targetHeight) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetHeight / (size.y || 1);
  const pelvis = findNode(model, BONE_PATTERNS.pelvis);
  const pivot = pelvis
    ? pelvis.getWorldPosition(new THREE.Vector3())
    : box.getCenter(new THREE.Vector3());

  model.scale.setScalar(scale);
  model.position.copy(pivot).multiplyScalar(-scale);
  const upFix = new THREE.Group();
  upFix.rotation.x = MODEL_UP_FIX; // glTF +Y (up) -> body +Z
  upFix.add(model);
  const mount = new THREE.Group();
  mount.rotation.z = MODEL_YAW_FIX; // glTF front -> body +X
  mount.add(upFix);

  return {
    mount,
    height: size.y * scale,
    // Metres from the soles up to the pivot when standing upright.
    pivotHeight: (pivot.y - box.min.y) * scale,
  };
}

// ---- Jet visuals ----

let flameAssets = null;

// Open cone from the nozzle (y = 0) to the tip (y = 1), brightness fading
// toward the tip through vertex colours (black is invisible when additive).
function flameGeometry(radialSegments, falloff) {
  const geo = new THREE.ConeGeometry(1, 1, radialSegments, 8, true);
  geo.translate(0, 0.5, 0); // wide end at the nozzle, point at the tip
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.pow(1 - pos.getY(i), falloff);
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function glowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Neutral falloff; the sprite material's colour supplies the hue.
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function getFlameAssets() {
  if (!flameAssets) {
    flameAssets = {
      outer: flameGeometry(18, 1.1),
      core: flameGeometry(12, 2.2),
      glow: glowTexture(),
    };
  }
  return flameAssets;
}

function flameMaterial(color, side) {
  return new THREE.MeshBasicMaterial({
    color,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side,
  });
}

/**
 * Build the flight rig for a mounted suit.
 * @param {THREE.Object3D} model  the loaded glTF scene (already mounted)
 * @param {THREE.Object3D} body   node whose local frame is the body frame
 * @param {{ soleZ?: number, jets?: 'ion'|'amber' }} opts  body-frame height
 *   of the boot soles, and the flame palette
 * @returns {{ update(drive, lean, dt):void, bootOrigin(out):THREE.Vector3|null,
 *   stats:{ arms:number, legs:number, jets:number } }}
 */
export function createFlightRig(model, body, { soleZ = 0, jets: palette = 'ion' } = {}) {
  const colors = JET_PALETTES[palette] || JET_PALETTES.ion;
  const bones = {};
  model.traverse((o) => {
    const name = (o.name || '').toLowerCase();
    for (const key in BONE_PATTERNS) {
      if (!bones[key] && BONE_PATTERNS[key].test(name)) bones[key] = o;
    }
  });

  // Measure the rest pose once, in the body frame.
  body.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const restCache = new Map();
  function rest(node) {
    let r = restCache.get(node);
    if (!r) {
      const matrix = new THREE.Matrix4().multiplyMatrices(toBody, node.matrixWorld);
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      matrix.decompose(pos, quat, scale);
      r = { matrix, pos, quat, scale: scale.x };
      restCache.set(node, r);
    }
    return r;
  }
  const restDir = (from, to) => rest(to).pos.clone().sub(rest(from).pos).normalize();
  const inverseOf = (node) => rest(node).quat.clone().invert();

  function makeArm(side, s) {
    const upper = bones[`upperArm${side}`];
    const fore = bones[`forearm${side}`];
    const hand = bones[`hand${side}`];
    if (!upper || !fore || !hand || fore.parent !== upper || hand.parent !== fore) return null;
    // The palm faces along the hand's local ±Y; take the sign pointing at the
    // repulsor socket (or, without one, toward the body's midline).
    const palm = Y_AXIS.clone().applyQuaternion(rest(hand).quat);
    const socket = bones[`palm${side}`];
    const toward = socket
      ? rest(socket).pos.clone().sub(rest(hand).pos)
      : new THREE.Vector3(0, -s, 0);
    if (palm.dot(toward) < 0) palm.negate();
    const knuckle = bones[`middle${side}`];
    const palmCentre = knuckle
      ? rest(hand).pos.clone().lerp(rest(knuckle).pos, 0.5)
      : rest(hand).pos.clone();
    return {
      s,
      upper,
      fore,
      hand,
      parentInv: inverseOf(upper.parent),
      upperQ: rest(upper).quat,
      foreQ: rest(fore).quat,
      handQ: rest(hand).quat,
      upperDir: restDir(upper, fore),
      foreDir: restDir(fore, hand),
      palm,
      jetNode: hand,
      jetAnchor: palmCentre,
      jetStandoff: PALM_STANDOFF,
      cum: new THREE.Quaternion(), // body-space rotation the hand carries now
      exhaust: new THREE.Vector3(),
    };
  }

  function makeLeg(side, s) {
    const thigh = bones[`thigh${side}`];
    const calf = bones[`calf${side}`];
    const foot = bones[`foot${side}`];
    if (!thigh || !calf || !foot || calf.parent !== thigh || foot.parent !== calf) return null;
    const jetNode = bones[`sole${side}`] || foot;
    return {
      s,
      thigh,
      calf,
      foot,
      parentInv: inverseOf(thigh.parent),
      thighQ: rest(thigh).quat,
      calfQ: rest(calf).quat,
      footQ: rest(foot).quat,
      thighDir: restDir(thigh, calf),
      calfDir: restDir(calf, foot),
      jetNode,
      jetAnchor: null,
      // The socket sits inside the boot; start the flame at the sole.
      jetStandoff: Math.max(0, rest(jetNode).pos.z - soleZ),
      cum: new THREE.Quaternion(), // body-space rotation the foot carries now
      exhaust: new THREE.Vector3(),
      nozzle: new THREE.Vector3(), // body-space nozzle position (trail anchor)
    };
  }

  const arms = [makeArm('L', 1), makeArm('R', -1)].filter(Boolean);
  const legs = [makeLeg('L', 1), makeLeg('R', -1)].filter(Boolean);
  const neck = bones.neck
    ? { bone: bones.neck, parentInv: inverseOf(bones.neck.parent), restQ: rest(bones.neck).quat }
    : null;

  // ---- Jets ----
  const assets = getFlameAssets();
  const jets = [];
  function addJet(limb, kind, channel) {
    const r = rest(limb.jetNode);
    const group = new THREE.Group();
    group.scale.setScalar(1 / r.scale); // children are sized in metres
    const outer = new THREE.Mesh(assets.outer, flameMaterial(colors.outer, THREE.DoubleSide));
    const core = new THREE.Mesh(assets.core, flameMaterial(colors.core, THREE.FrontSide));
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: assets.glow,
        color: colors.glow,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    for (const o of [outer, core, glow]) o.frustumCulled = false;
    group.add(outer, core, glow);
    group.visible = false;
    limb.jetNode.add(group);
    const anchor = limb.jetAnchor
      ? limb.jetAnchor.clone().applyMatrix4(r.matrix.clone().invert())
      : new THREE.Vector3();
    jets.push({
      limb,
      kind,
      channel,
      group,
      outer,
      core,
      glow,
      restQ: r.quat,
      scale: r.scale,
      anchor,
      seed: jets.length * 1.7,
      level: 0,
    });
  }
  for (const arm of arms) addJet(arm, 'palm', arm.s > 0 ? 'palmL' : 'palmR');
  for (const leg of legs) addJet(leg, 'boot', 'boot');

  // ---- Solvers (scratch objects reused every frame) ----
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const dA = new THREE.Quaternion();
  const dB = new THREE.Quaternion();
  const dC = new THREE.Quaternion();
  const twist = new THREE.Quaternion();
  const qA = new THREE.Quaternion();
  const qB = new THREE.Quaternion();
  const qC = new THREE.Quaternion();

  function poseArm(arm, pose, turn) {
    const s = arm.s;
    // In a turn the outer arm (left for a right turn) swings wide and its palm
    // pushes the yaw; the inner arm tucks in.
    const spread = TURN_SPREAD * Math.max(0, s * turn) - TURN_TUCK * Math.max(0, -s * turn);

    // Shoulder: swing the upper arm from rest onto its target.
    limbDir(vA, pose.upperArm, s, spread);
    dA.setFromUnitVectors(arm.upperDir, vA);
    qA.multiplyQuaternions(dA, arm.upperQ);
    arm.upper.quaternion.multiplyQuaternions(arm.parentInv, qA);

    // Elbow: swing the (already carried) forearm onto its target.
    vB.copy(arm.foreDir).applyQuaternion(dA);
    limbDir(vA, pose.forearm, s, spread);
    dB.setFromUnitVectors(vB, vA);
    dB.multiply(dA); // forearm's total body rotation

    // Palm: aim the palm normal. The component of that rotation about the
    // forearm axis is roll the forearm carries (pronation/supination), so the
    // wrist itself only bends.
    vB.copy(arm.palm).applyQuaternion(dB);
    limbDir(vC, pose.palm, s);
    dC.setFromUnitVectors(vB, vC);
    twistAbout(twist, dC, vA);
    twist.slerp(qC.identity(), 1 - FOREARM_TWIST);
    dB.premultiply(twist);
    qB.multiplyQuaternions(dB, arm.foreQ);
    arm.fore.quaternion.copy(qA).invert().multiply(qB);

    dC.multiply(twist.invert()); // what's left for the wrist
    arm.cum.multiplyQuaternions(dC, dB);
    qC.multiplyQuaternions(arm.cum, arm.handQ);
    arm.hand.quaternion.copy(qB).invert().multiply(qC);
    arm.exhaust.copy(arm.palm).applyQuaternion(arm.cum);
  }

  function poseLeg(leg, pose) {
    const s = leg.s;
    // Hip.
    limbDir(vA, pose.thigh, s);
    dA.setFromUnitVectors(leg.thighDir, vA);
    qA.multiplyQuaternions(dA, leg.thighQ);
    leg.thigh.quaternion.multiplyQuaternions(leg.parentInv, qA);

    // Knee.
    vB.copy(leg.calfDir).applyQuaternion(dA);
    limbDir(vC, pose.calf, s);
    dB.setFromUnitVectors(vB, vC);
    dB.multiply(dA); // shin's total body rotation
    qB.multiplyQuaternions(dB, leg.calfQ);
    leg.calf.quaternion.copy(qA).invert().multiply(qB);

    // Ankle: point the toes about the shin's own lateral axis.
    vB.copy(Y_AXIS).applyQuaternion(dB);
    dC.setFromAxisAngle(vB, pose.foot * DEG);
    leg.cum.multiplyQuaternions(dC, dB);
    qC.multiplyQuaternions(leg.cum, leg.footQ);
    leg.foot.quaternion.copy(qB).invert().multiply(qC);

    // Boot exhaust: mostly straight down the shin, a little off the sole.
    vB.set(0, 0, -1).applyQuaternion(leg.cum);
    leg.exhaust.copy(vC).multiplyScalar(BOOT_ALONG_LEG).addScaledVector(vB, 1 - BOOT_ALONG_LEG).normalize();

    // Forward kinematics for the nozzle, so the afterburner trail can start
    // exactly at the boots whatever the body is doing.
    const hip = rest(leg.thigh).pos;
    const knee = rest(leg.calf).pos;
    const ankle = rest(leg.foot).pos;
    const socket = rest(leg.jetNode).pos;
    leg.nozzle.copy(knee).sub(hip).applyQuaternion(dA).add(hip);
    leg.nozzle.add(vA.copy(ankle).sub(knee).applyQuaternion(dB));
    leg.nozzle.add(vA.copy(socket).sub(ankle).applyQuaternion(leg.cum));
    leg.nozzle.addScaledVector(leg.exhaust, leg.jetStandoff);
  }

  function poseNeck(lean) {
    // Lift the head as the body lies down, so the suit looks where it flies.
    const lift = clamp(lean * NECK_LEAN_SHARE, -8, 40);
    dA.setFromAxisAngle(Y_AXIS, -lift * DEG);
    qA.multiplyQuaternions(dA, neck.restQ);
    neck.bone.quaternion.multiplyQuaternions(neck.parentInv, qA);
  }

  function driveJet(jet, target, dt, time) {
    jet.level += (target - jet.level) * (1 - Math.exp(-JET_RESPONSE * dt));
    const level = jet.level;
    jet.group.visible = level > 0.02;
    if (!jet.group.visible) return;

    // Orient the flame (+Y) along the limb's exhaust, expressed in the local
    // frame of the node it hangs from, and push it out to the nozzle.
    qA.multiplyQuaternions(jet.limb.cum, jet.restQ).invert();
    qB.setFromUnitVectors(Y_AXIS, jet.limb.exhaust);
    jet.group.quaternion.multiplyQuaternions(qA, qB);
    vA.copy(jet.limb.exhaust)
      .applyQuaternion(qA)
      .multiplyScalar(jet.limb.jetStandoff / jet.scale);
    jet.group.position.copy(jet.anchor).add(vA);

    const heat = Math.min(level, 1);
    const flicker =
      1 + 0.07 * Math.sin(time * 43 + jet.seed) + 0.04 * Math.sin(time * 71 + jet.seed * 2.3);
    const boot = jet.kind === 'boot';
    const length = (boot ? 0.8 + 7.2 * level : 0.4 + 3.4 * level) * flicker;
    const radius = boot ? 0.3 + 0.22 * heat : 0.18 + 0.12 * heat;
    jet.outer.scale.set(radius, length, radius);
    jet.core.scale.set(radius * 0.5, length * 0.62, radius * 0.5);
    jet.outer.material.opacity = 0.25 + 0.45 * heat;
    jet.core.material.opacity = 0.5 + 0.45 * heat;
    const glow = (boot ? 1.4 + 1.8 * heat : 0.9 + 1.1 * heat) * (0.96 + 0.04 * flicker);
    jet.glow.scale.set(glow, glow, 1);
    jet.glow.material.opacity = 0.35 + 0.5 * heat;
  }

  const target = makePose();
  const current = makePose();
  let settled = false;
  let clock = 0;

  /**
   * Pose the skeleton and throttle the jets for this frame.
   * @param {object} drive  normalized drivers (see targetPose)
   * @param {number} lean   visual body lean in degrees (for the head)
   * @param {number} dt     seconds since the last update
   */
  function update(drive = {}, lean = 0, dt = 1 / 60) {
    clock += dt;
    const weights = targetPose(target, drive);
    if (settled) {
      mixPose(current, target, 1 - Math.exp(-POSE_RESPONSE * dt));
    } else {
      copyPose(current, target);
      settled = true;
    }

    const turn = clamp(drive.turn || 0, -1, 1);
    for (const arm of arms) poseArm(arm, current, turn);
    for (const leg of legs) poseLeg(leg, current);
    if (neck) poseNeck(lean);

    const levels = thrustLevels(drive, weights);
    for (const jet of jets) driveJet(jet, levels[jet.channel], dt, clock);
  }

  // Body-frame midpoint between the boot nozzles (after the last update).
  function bootOrigin(out) {
    if (!legs.length) return null;
    out.set(0, 0, 0);
    for (const leg of legs) out.add(leg.nozzle);
    return out.multiplyScalar(1 / legs.length);
  }

  return {
    update,
    bootOrigin,
    stats: { arms: arms.length, legs: legs.length, jets: jets.length },
  };
}
