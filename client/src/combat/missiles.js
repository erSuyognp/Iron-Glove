import * as THREE from 'three';
import { toLocal, distanceToSegment } from './space.js';
import { makeGlow, getGlowTexture } from '../sentinel/sentinel.js';

// ---------------------------------------------------------------------------
// Missiles and explosions.
//
//   ours   — cyan, guided. Leaves the suit toward the locked drone's current
//            position, then steers for where the drone will be when it gets
//            there, projected along the drone's last known velocity.
//   theirs — orange, unguided. The server inserts one `missile` row when an
//            attacker fires; it flies the straight line in that row and the
//            client flying the suit it reaches reports the hit.
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0); // the missile meshes point along +Y

const PLAYER_MISSILE = {
  color: 0x37e7ff,
  speed: 160, // m/s — has to run down a fleeing drone at 72 m/s
  life: 6, // s of fuel
  boost: 0.25, // s flown at the drone's current position before leading it
  turnRate: THREE.MathUtils.degToRad(200), // rad/s
  hitRadius: 6, // m
  length: 5,
};
const ENEMY_MISSILE = {
  color: 0xff7a1a,
  life: 4,
  hitRadius: 8,
  length: 4,
};

const SPARKS = 90;
const EXPLOSION_LIFE = 1.3; // s

// Hull geometry and the white core material are the same for every missile of
// a kind, so they are built once and shared (`userData.shared` keeps the world
// layer from disposing them with the first missile that burns out).
const hulls = new Map(); // length -> { core, shell }
function hullFor(length) {
  let hull = hulls.get(length);
  if (!hull) {
    hull = {
      core: new THREE.CapsuleGeometry(0.28, length, 4, 10),
      shell: new THREE.CapsuleGeometry(0.7, length * 1.15, 4, 10),
    };
    hull.core.userData.shared = hull.shell.userData.shared = true;
    hulls.set(length, hull);
  }
  return hull;
}
const coreMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
coreMaterial.userData.shared = true;

function sparkMaterial(color) {
  return new THREE.PointsMaterial({
    map: getGlowTexture(),
    color,
    size: 5,
    sizeAttenuation: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

function missileMesh({ color, length }) {
  const group = new THREE.Group();
  const hull = hullFor(length);
  const core = new THREE.Mesh(hull.core, coreMaterial);
  const shell = new THREE.Mesh(
    hull.shell,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const halo = makeGlow(color, length * 2.2, 0.9);
  const exhaust = makeGlow(color, length * 1.4, 0.7);
  exhaust.position.y = -length * 0.8;
  for (const o of [core, shell]) o.frustumCulled = false;
  group.add(shell, core, halo, exhaust);
  return group;
}

/**
 * @param world  world layer from createWorldLayer
 */
export function createMissiles(world) {
  const ours = new Set();
  const theirs = new Map(); // missile_id -> missile
  const blasts = new Set();

  const aim = new THREE.Vector3();
  const want = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const prev = new THREE.Vector3();

  // `owner` is the id of the pilot who fired; it comes back with the kill.
  function launch(from, drone, owner, color = PLAYER_MISSILE.color) {
    const pos = from.clone();
    const dir = aim.copy(drone.pos).sub(pos).normalize().clone();
    const mesh = missileMesh({ ...PLAYER_MISSILE, color });
    const missile = { pos, dir, drone, owner, age: 0, item: world.add(mesh, pos), mesh };
    mesh.quaternion.setFromUnitVectors(UP, dir);
    ours.add(missile);
  }

  // A `missile` row (camelCased by the bindings): an attacker just fired.
  const rowGeo = { longitude: 0, latitude: 0, altitude: 0 };
  function incoming(row) {
    const key = String(row.missileId);
    if (theirs.has(key)) return;
    rowGeo.longitude = row.originX;
    rowGeo.altitude = row.originY;
    rowGeo.latitude = row.originZ;
    const pos = toLocal(rowGeo);
    const vel = new THREE.Vector3(row.velocityX, row.velocityZ, row.velocityY);
    const mesh = missileMesh(ENEMY_MISSILE);
    mesh.quaternion.setFromUnitVectors(UP, aim.copy(vel).normalize());
    theirs.set(key, { pos, vel, age: 0, item: world.add(mesh, pos), mesh });
  }

  function explode(at, color = 0xffb347) {
    const positions = new Float32Array(SPARKS * 3);
    const velocities = new Float32Array(SPARKS * 3);
    for (let i = 0; i < SPARKS; i++) {
      // Uniform directions, uneven speeds: a ragged fireball rather than a shell.
      const z = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const speed = 12 + Math.random() * Math.random() * 70;
      velocities[i * 3] = r * Math.cos(a) * speed;
      velocities[i * 3 + 1] = r * Math.sin(a) * speed;
      velocities[i * 3 + 2] = z * speed + 8;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const sparks = new THREE.Points(geometry, sparkMaterial(color));
    sparks.frustumCulled = false;
    const fireball = makeGlow(0xfff1c4, 10);
    const group = new THREE.Group();
    group.add(sparks, fireball);
    blasts.add({ age: 0, sparks, fireball, velocities, item: world.add(group, at.clone()) });
  }

  // Shaders compile on first use, and Three frees a program when the last
  // material using it is disposed. Missiles and blasts come and go, so without
  // this the first launch, the first explosion, and the first of each after
  // any lull would stall a frame mid-fight. One missile and one spark cloud,
  // compiled now, never drawn and never disposed, keep those programs resident.
  const resident = new THREE.Group();
  const residentSparks = new THREE.BufferGeometry();
  residentSparks.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  resident.add(missileMesh(PLAYER_MISSILE), new THREE.Points(residentSparks, sparkMaterial(0xffffff)));
  world.warm(resident);

  function stepBlasts(dt) {
    for (const blast of blasts) {
      blast.age += dt;
      const t = blast.age / EXPLOSION_LIFE;
      if (t >= 1) {
        blast.item.remove();
        blast.sparks.geometry.dispose();
        blasts.delete(blast);
        continue;
      }
      const p = blast.sparks.geometry.attributes.position;
      const drag = Math.exp(-2.2 * dt);
      for (let i = 0; i < SPARKS * 3; i += 3) {
        blast.velocities[i] *= drag;
        blast.velocities[i + 1] *= drag;
        blast.velocities[i + 2] = blast.velocities[i + 2] * drag - 14 * dt; // embers fall
        p.array[i] += blast.velocities[i] * dt;
        p.array[i + 1] += blast.velocities[i + 1] * dt;
        p.array[i + 2] += blast.velocities[i + 2] * dt;
      }
      p.needsUpdate = true;
      blast.sparks.material.opacity = 1 - t * t;
      blast.sparks.material.size = 5 * (1 - 0.5 * t);
      // The fireball swells fast and is gone in the first third.
      const f = Math.min(1, t * 3);
      blast.fireball.scale.setScalar(10 + 70 * Math.sqrt(f));
      blast.fireball.material.opacity = 1 - f;
    }
  }

  /**
   * Advance everything one frame.
   * @param suits  [{ id, mid: THREE.Vector3 }] suits this client flies (mid-body, local metres)
   * @returns {{ kills: {drone, owner}[], hits: string[] }} drones destroyed (and by whom), suit ids struck
   */
  function update(dt, suits) {
    const kills = [];
    const hits = [];

    for (const m of ours) {
      m.age += dt;
      const drone = m.drone;
      if (drone?.alive) {
        // Boost phase flies at where the drone is; after that, lead it:
        // aim at its position projected along its last known velocity for
        // the time we still need to get there.
        aim.copy(drone.pos);
        if (m.age > PLAYER_MISSILE.boost) {
          const timeToGo = aim.distanceTo(m.pos) / PLAYER_MISSILE.speed;
          aim.addScaledVector(drone.vel, Math.min(timeToGo, 3));
        }
        want.copy(aim).sub(m.pos).normalize();
        const angle = m.dir.angleTo(want);
        const step = PLAYER_MISSILE.turnRate * dt;
        if (angle <= step) m.dir.copy(want);
        else if (axis.crossVectors(m.dir, want).lengthSq() > 1e-10) {
          m.dir.applyAxisAngle(axis.normalize(), step).normalize();
        }
      }
      prev.copy(m.pos);
      m.pos.addScaledVector(m.dir, PLAYER_MISSILE.speed * dt);
      m.mesh.quaternion.setFromUnitVectors(UP, m.dir);

      const struck = drone?.alive && distanceToSegment(drone.pos, prev, m.pos) <= PLAYER_MISSILE.hitRadius;
      if (struck) {
        explode(drone.pos);
        drone.alive = false; // a second missile already in the air flies on past
        kills.push({ drone, owner: m.owner });
      }
      if (struck || m.age >= PLAYER_MISSILE.life) {
        if (!struck) explode(m.pos, PLAYER_MISSILE.color);
        m.item.remove();
        ours.delete(m);
      }
    }

    for (const [key, m] of theirs) {
      m.age += dt;
      prev.copy(m.pos);
      m.pos.addScaledVector(m.vel, dt);
      let struck = null;
      for (const suit of suits) {
        if (distanceToSegment(suit.mid, prev, m.pos) <= ENEMY_MISSILE.hitRadius) {
          struck = suit;
          break;
        }
      }
      if (struck) {
        explode(struck.mid, ENEMY_MISSILE.color);
        hits.push(struck.id);
      }
      if (struck || m.age >= ENEMY_MISSILE.life) {
        m.item.remove();
        theirs.delete(key);
      }
    }

    stepBlasts(dt);
    return { kills, hits };
  }

  return {
    launch,
    incoming,
    explode,
    update,
    get inbound() {
      return theirs.size;
    },
  };
}
