import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { toLocal } from '../combat/space.js';

// ---------------------------------------------------------------------------
// Sentinel drones — rendered here, flown on the server.
//
// tick_sentinels moves every drone in SpacetimeDB at 10 Hz (SentinelState).
// This module turns those rows into smooth motion: each tick's position is
// dead-reckoned forward along the row's velocity until the next one lands and
// the drawn drone eases toward that, the same netcode smoothing the remote
// pilots use. The drone GLB loads once through the same GLTFLoader path as the
// suit and every drone is a clone of it; until it loads (or if it is missing)
// a built-in quadcopter stands in.
// ---------------------------------------------------------------------------

const DRONE_SPAN = 8; // metres across, whatever the GLB's native scale
export const DRONE_RADIUS = DRONE_SPAN / 2;

const MAX_LEAD_S = 0.3; // how far past a tick we dead-reckon before holding
const NET_LERP = 0.35; // per-frame ease toward the dead-reckoned spot (at 60 fps)
const TURN_LERP = 0.12;
const MAX_TILT = THREE.MathUtils.degToRad(28); // nose-down lean at full speed
const TILT_SPEED = 72; // m/s that earns MAX_TILT
const KILL_HOLD_MS = 3000; // ignore ticks for a drone we just shot down

export const DRONE_COLORS = { attacker: 0xff3b30, fleeing: 0xffc233 };

// glTF models face +Z with +Y up; the local frame is north = +Y, up = +Z.
const MOUNT = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)
  .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));

let glowTexture = null;
// Soft radial sprite shared by every glow in the combat layer.
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

export function makeGlow(color, size, opacity = 1) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color,
      opacity,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  sprite.scale.setScalar(size);
  sprite.frustumCulled = false;
  return sprite;
}

// Stand-in quadcopter in glTF convention (+Z forward, +Y up), about 1 unit wide.
function buildFallbackDrone() {
  const drone = new THREE.Group();
  // Low metalness: the overlay has no environment map, so a mirror-like
  // metal would render black.
  const hull = new THREE.MeshStandardMaterial({ color: 0x8a94a3, metalness: 0.35, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a414c, metalness: 0.3, roughness: 0.6 });
  const disc = new THREE.MeshBasicMaterial({
    color: 0x9fb6c8,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 14), hull);
  body.scale.set(1, 0.45, 1.35);
  drone.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 12), dark);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.3;
  drone.add(nose);

  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.035, 0.06), dark);
    arm.position.set(sx * 0.2, 0, sz * 0.2);
    arm.rotation.y = -Math.atan2(sz, sx);
    drone.add(arm);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.09, 12), hull);
    pod.position.set(sx * 0.38, 0.02, sz * 0.38);
    drone.add(pod);
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.008, 24), disc);
    rotor.position.set(sx * 0.38, 0.08, sz * 0.38);
    drone.add(rotor);
  }
  return drone;
}

// Centre a model on its bounds and scale its widest side to DRONE_SPAN.
function normalize(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const holder = new THREE.Group();
  model.position.sub(centre);
  holder.add(model);
  holder.scale.setScalar(DRONE_SPAN / Math.max(size.x, size.y, size.z, 1e-6));
  return holder;
}

/**
 * @param world   world layer from createWorldLayer
 * @param glbUrl  served URL of the drone model (e.g. '/drone.glb')
 */
export function createSentinelFleet(world, glbUrl) {
  const drones = new Map(); // sentinel_id -> drone
  let template = null; // { scene, animations } once the GLB (or fallback) is ready

  function adopt(scene, animations = []) {
    // Every drone is a clone sharing the template's geometry and materials, so
    // a drone that is removed must leave them alone (see world.add's remove).
    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      o.geometry.userData.shared = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.userData.shared = true;
    });
    world.warm(scene);
    template = { scene, animations };
    for (const drone of drones.values()) dress(drone);
  }

  new GLTFLoader().load(
    glbUrl,
    (gltf) => {
      console.log(`[sentinel] drone model loaded from ${glbUrl}`);
      adopt(gltf.scene, gltf.animations);
    },
    undefined,
    () => {
      console.warn(`[sentinel] ${glbUrl} not found — using the built-in drone. Drop the GLB into client/public/.`);
      adopt(buildFallbackDrone());
    },
  );

  // Give a drone its model (a clone of the template).
  function dress(drone) {
    if (drone.model || !template) return;
    const model = SkeletonUtils.clone(template.scene);
    drone.model = normalize(model);
    drone.model.quaternion.copy(MOUNT);
    drone.body.add(drone.model);
    if (template.animations.length) {
      drone.mixer = new THREE.AnimationMixer(model);
      for (const clip of template.animations) drone.mixer.clipAction(clip).play();
    }
  }

  function create(id, type) {
    // body: yaw, then nose-down tilt, then bank — about up, right, forward.
    const body = new THREE.Group();
    body.rotation.order = 'ZXY';
    const color = DRONE_COLORS[type] ?? DRONE_COLORS.attacker;
    // Type beacon: red attackers, amber runners. It shines through the hull
    // so the colour reads from any angle, even when the drone is a speck.
    const beacon = makeGlow(color, DRONE_SPAN * 0.9, 0.85);
    beacon.material.depthTest = false;
    beacon.renderOrder = 3;
    body.add(beacon);

    const drone = {
      id,
      type,
      behavior: 'PATROL',
      alive: true,
      pos: new THREE.Vector3(), // drawn position, local metres
      vel: new THREE.Vector3(), // last known velocity, m/s
      sample: null, // newest tick: { pos, receivedAt }
      heading: 0, // radians clockwise from north
      deadUntil: 0,
      body,
      beacon,
      model: null,
      mixer: null,
      item: null,
    };
    drone.item = world.add(body, drone.pos);
    dress(drone);
    drones.set(id, drone);
    return drone;
  }

  // A sentinel_state row (camelCased by the bindings) arrived.
  const rowGeo = { longitude: 0, latitude: 0, altitude: 0 };
  function receive(row, now = performance.now()) {
    let drone = drones.get(row.sentinelId);
    if (!drone) drone = create(row.sentinelId, row.droneType);
    if (now < drone.deadUntil) return;

    rowGeo.longitude = row.positionX;
    rowGeo.altitude = row.positionY;
    rowGeo.latitude = row.positionZ;
    const first = !drone.sample || !drone.alive;
    drone.sample ??= { pos: new THREE.Vector3(), receivedAt: 0 };
    toLocal(rowGeo, drone.sample.pos);
    drone.sample.receivedAt = now;
    drone.vel.set(row.velocityX, row.velocityZ, row.velocityY);
    drone.behavior = row.behavior;
    drone.type = row.droneType;
    if (first) {
      drone.pos.copy(drone.sample.pos);
      if (drone.vel.lengthSq() > 1) drone.heading = Math.atan2(drone.vel.x, drone.vel.y);
    }
    drone.alive = true;
    drone.item.root.visible = true;
  }

  // The row was deleted: the drone is gone until the server respawns it.
  function remove(id) {
    const drone = drones.get(id);
    if (!drone) return;
    drone.item.remove();
    drones.delete(id);
  }

  // We shot it down: vanish now rather than a round-trip later.
  function kill(id, now = performance.now()) {
    const drone = drones.get(id);
    if (!drone) return;
    drone.alive = false;
    drone.deadUntil = now + KILL_HOLD_MS;
    drone.item.root.visible = false;
  }

  const target = new THREE.Vector3();
  // `suits`: [{ mid: THREE.Vector3 }] — the pilots in the fight, for facing.
  function update(dt, now = performance.now(), suits = []) {
    const k = 1 - Math.pow(1 - NET_LERP, dt * 60);
    const turn = 1 - Math.pow(1 - TURN_LERP, dt * 60);
    for (const drone of drones.values()) {
      if (!drone.alive || !drone.sample) continue;
      const lead = Math.min(MAX_LEAD_S, (now - drone.sample.receivedAt) / 1000);
      target.copy(drone.sample.pos).addScaledVector(drone.vel, lead);
      drone.pos.lerp(target, k);

      // Face the way it flies and lean into it like a real quadcopter — except
      // an attacker holding station, which squares up to the pilot it is
      // fighting (the nearest one) however it happens to be drifting.
      const ground = Math.hypot(drone.vel.x, drone.vel.y);
      let foe = null;
      if (drone.behavior === 'ENGAGE') {
        for (const suit of suits) {
          if (!foe || suit.mid.distanceToSquared(drone.pos) < foe.distanceToSquared(drone.pos)) foe = suit.mid;
        }
      }
      if (foe || ground > 2) {
        const want = foe
          ? Math.atan2(foe.x - drone.pos.x, foe.y - drone.pos.y)
          : Math.atan2(drone.vel.x, drone.vel.y);
        const delta = Math.atan2(Math.sin(want - drone.heading), Math.cos(want - drone.heading));
        drone.heading += delta * turn;
        drone.body.rotation.y += (THREE.MathUtils.clamp(delta * 1.2, -0.6, 0.6) - drone.body.rotation.y) * turn;
      } else {
        drone.body.rotation.y *= 1 - turn;
      }
      drone.body.rotation.z = -drone.heading;
      const tilt = foe ? 0 : -MAX_TILT * Math.min(1, ground / TILT_SPEED);
      drone.body.rotation.x += (tilt - drone.body.rotation.x) * turn;

      drone.mixer?.update(dt);
      drone.beacon.material.opacity = 0.6 + 0.3 * Math.sin(now / 180 + drone.id);
    }
  }

  return {
    receive,
    remove,
    kill,
    update,
    get: (id) => drones.get(id),
    /** Drones currently in the air. */
    *alive() {
      for (const drone of drones.values()) if (drone.alive && drone.sample) yield drone;
    },
    get remaining() {
      let n = 0;
      for (const drone of drones.values()) if (drone.alive && drone.sample) n++;
      return n;
    },
  };
}
