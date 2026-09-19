import * as THREE from 'three';
import { createWorldLayer, toLocal, nudgeGeo } from './space.js';
import { createAutolock, createCombatAudio, LOCK } from './autolock.js';
import { createMissiles } from './missiles.js';
import { createSentinelFleet, DRONE_RADIUS } from '../sentinel/sentinel.js';

// ---------------------------------------------------------------------------
// Drone combat, wired together for main.js.
//
// The server owns the drones (SentinelState, moved by tick_sentinels) and
// decides when attackers fire. This client draws them between ticks, runs the
// autolock and our missiles, and is the judge of anything that touches a suit
// it flies: enemy missile hits (-> apply_damage) and drone contact, which is
// physics only — a shove apart, never health.
// ---------------------------------------------------------------------------

const MAX_AMMO = 6;
const RELOAD_SECONDS = 10; // one missile back per interval
const MISSILE_DAMAGE = 20; // HP per enemy missile
const SUIT_MID = 5.5; // m above the boots: mid-body, where hits and contact are judged
const SUIT_RADIUS = 5;
const CONTACT_M = SUIT_RADIUS + DRONE_RADIUS;
const DRONE_GLB = '/drone.glb';

/**
 * @param opts.viewer   Cesium viewer
 * @param opts.overlay  suit overlay (initSuitOverlay)
 * @param opts.getLink  () => the SpacetimeDB client, or null while offline
 */
export function createCombat({ viewer, overlay, getLink }) {
  const world = createWorldLayer(overlay, viewer);
  const audio = createCombatAudio();
  const fleet = createSentinelFleet(world, DRONE_GLB);
  const missiles = createMissiles(world);
  const autolock = createAutolock(world, audio);

  let ammo = MAX_AMMO;
  let reload = 0; // seconds into the current reload

  const mids = []; // reused [{ id, state, mid }]
  const apart = new THREE.Vector3();
  const muzzle = new THREE.Vector3();

  function suitMids(suits) {
    mids.length = suits.length;
    suits.forEach((suit, i) => {
      const entry = (mids[i] ??= { mid: new THREE.Vector3() });
      entry.id = suit.id;
      entry.state = suit.state;
      toLocal(suit.state, entry.mid, SUIT_MID);
    });
    return mids;
  }

  // Suits and drones are solid to each other. The server moves the drone out
  // of the way on its next tick; here the suit gives way too.
  function shove(suits) {
    const bumped = [];
    for (const suit of suits) {
      for (const drone of fleet.alive()) {
        apart.subVectors(suit.mid, drone.pos);
        const gap = apart.length();
        if (gap >= CONTACT_M) continue;
        if (gap > 0.01) apart.divideScalar(gap);
        else apart.set(0, 0, 1);
        nudgeGeo(suit.state, apart.multiplyScalar(CONTACT_M - gap));
        suit.mid.add(apart);
        suit.state.speed *= 0.6;
        bumped.push(suit.id);
      }
    }
    return bumped;
  }

  /**
   * One frame of combat. Call after the chase camera has been placed.
   *
   * @param frame.dt
   * @param frame.suits    [{ id, state }] flight states this client flies; [0] is ours
   * @param frame.ownView  true while the camera is on our own suit
   * @param frame.fire     a fire command arrived this frame (Space / glove)
   * @returns {{
   *   lock: string, drones: number, ammo: number, maxAmmo: number, reload: number,
   *   fired: boolean, dry: boolean,   // dry: fire command with a lock but no missiles
   *   kills: object[],                // drones we destroyed this frame
   *   hits: {id: string, damage: number}[],
   *   bumped: string[],
   * }}
   */
  function update({ dt, suits, ownView, fire }) {
    const now = performance.now();
    fleet.update(dt, now);

    const bodies = suitMids(suits);
    const bumped = shove(bodies);

    const lock = autolock.update(fleet.alive(), dt, ownView);

    if (ammo < MAX_AMMO) {
      reload += dt;
      if (reload >= RELOAD_SECONDS) {
        reload = 0;
        ammo++;
      }
    } else {
      reload = 0;
    }

    let fired = false;
    let dry = false;
    if (fire && lock.state === LOCK.LOCKED) {
      if (ammo > 0) {
        ammo--;
        fired = true;
        missiles.launch(muzzle.copy(bodies[0].mid), lock.drone);
        audio.launch();
      } else {
        dry = true;
      }
    }

    const result = missiles.update(dt, bodies);
    const link = getLink();
    for (const drone of result.kills) {
      fleet.kill(drone.id, now);
      link?.destroySentinel(drone.id);
      if (lock.drone === drone) autolock.clear();
      audio.explosion();
    }
    const hits = result.hits.map((id) => {
      link?.applyDamage(id, MISSILE_DAMAGE);
      audio.hit();
      return { id, damage: MISSILE_DAMAGE };
    });

    return {
      lock: lock.state,
      drones: fleet.remaining,
      ammo,
      maxAmmo: MAX_AMMO,
      reload: ammo < MAX_AMMO ? reload / RELOAD_SECONDS : 0,
      fired,
      dry,
      kills: result.kills,
      hits,
      bumped,
    };
  }

  return {
    update,
    // SpacetimeDB feeds.
    onSentinel: (row) => fleet.receive(row),
    onSentinelGone: (row) => fleet.remove(row.sentinelId),
    onMissile: (row, live) => {
      if (live) missiles.incoming(row);
    },
    /** Full rack again (after a respawn). */
    rearm() {
      ammo = MAX_AMMO;
      reload = 0;
    },
    fleet,
  };
}
