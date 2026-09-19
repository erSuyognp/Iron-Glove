import * as THREE from 'three';
import { createWorldLayer, toLocal, nudgeGeo } from './space.js';
import { createAutolock, createCombatAudio, LOCK } from './autolock.js';
import { createMissiles } from './missiles.js';
import { createSentinelFleet, DRONE_RADIUS } from '../sentinel/sentinel.js';

// ---------------------------------------------------------------------------
// Drone combat, wired together for main.js.
//
// The server owns the drones (SentinelState, moved by tick_sentinels) and
// decides when attackers fire. This client draws them between ticks and runs
// the fight for every suit it flies — ours, and the phone pilots' (their phones
// only send stick inputs and a FIRE button). Each of those suits has its own
// autolock and missile rack here, and this client is the judge of anything
// that touches them: enemy missile hits (-> apply_damage) and drone contact,
// which is physics only — a shove apart, never health.
// ---------------------------------------------------------------------------

const MAX_AMMO = 6;
const RELOAD_SECONDS = 10; // one missile back per interval
const MISSILE_DAMAGE = 20; // HP per enemy missile
const SUIT_MID = 5.5; // m above the boots: mid-body, where hits and contact are judged
const SUIT_RADIUS = 5;
const CONTACT_M = SUIT_RADIUS + DRONE_RADIUS;
const DRONE_GLB = '/drone.glb';
const WINGMAN_MISSILE = 0xffb020; // phone pilots fire amber, like their jets

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

  // One weapon system per flown suit, made when the suit first shows up.
  const weapons = new Map(); // suit id -> { autolock, ammo, reload, mid }
  function weaponsFor(suit) {
    let w = weapons.get(suit.id);
    if (!w) {
      w = {
        autolock: createAutolock(world, audio, suit.local ? '' : suit.name),
        ammo: MAX_AMMO,
        reload: 0, // seconds into the current reload
        mid: new THREE.Vector3(),
      };
      weapons.set(suit.id, w);
    }
    return w;
  }

  const apart = new THREE.Vector3();
  const muzzle = new THREE.Vector3();

  // Suits and drones are solid to each other. The server moves the drone out
  // of the way on its next tick; here the suit gives way too.
  function shove(suit, mid) {
    let bumped = false;
    for (const drone of fleet.alive()) {
      apart.subVectors(mid, drone.pos);
      const gap = apart.length();
      if (gap >= CONTACT_M) continue;
      if (gap > 0.01) apart.divideScalar(gap);
      else apart.set(0, 0, 1);
      nudgeGeo(suit.state, apart.multiplyScalar(CONTACT_M - gap));
      mid.add(apart);
      suit.state.speed *= 0.6;
      bumped = true;
    }
    return bumped;
  }

  /**
   * One frame of combat.
   *
   * @param frame.dt
   * @param frame.suits  the suits this client flies:
   *        [{ id, name, state, local, onCamera, fire }] — `state` is the flight
   *        state, `local` marks our own suit, `onCamera` the one the chase
   *        camera follows, `fire` a fire command that arrived this frame.
   * @returns {{
   *   drones: number,
   *   pilots: Map<id, { lock, ammo, maxAmmo, reload, fired, dry, bumped }>,
   *   kills: { drone, owner }[],
   *   hits: { id, damage }[],
   * }}  `dry` = fire command with a lock but an empty rack
   */
  function update({ dt, suits }) {
    const now = performance.now();

    const bodies = [];
    const pilots = new Map();
    for (const suit of suits) {
      const w = weaponsFor(suit);
      toLocal(suit.state, w.mid, SUIT_MID);
      const bumped = shove(suit, w.mid);
      bodies.push({ id: suit.id, mid: w.mid });

      const lock = w.autolock.update(suit.state, fleet.alive(), dt, suit.onCamera);

      if (w.ammo < MAX_AMMO) {
        w.reload += dt;
        if (w.reload >= RELOAD_SECONDS) {
          w.reload = 0;
          w.ammo++;
        }
      } else {
        w.reload = 0;
      }

      let fired = false;
      let dry = false;
      if (suit.fire && lock.state === LOCK.LOCKED) {
        if (w.ammo > 0) {
          w.ammo--;
          fired = true;
          missiles.launch(muzzle.copy(w.mid), lock.drone, suit.id, suit.local ? undefined : WINGMAN_MISSILE);
          if (suit.onCamera) audio.launch();
        } else {
          dry = true;
        }
      }

      pilots.set(suit.id, {
        lock: lock.state,
        ammo: w.ammo,
        maxAmmo: MAX_AMMO,
        reload: w.ammo < MAX_AMMO ? w.reload / RELOAD_SECONDS : 0,
        fired,
        dry,
        bumped,
      });
    }

    // A pilot who dropped off takes their reticle with them.
    for (const [id, w] of weapons) {
      if (pilots.has(id)) continue;
      w.autolock.dispose();
      weapons.delete(id);
    }

    // Attackers on station face the pilot they are fighting.
    fleet.update(dt, now, bodies);

    const result = missiles.update(dt, bodies);
    const link = getLink();
    for (const { drone, owner } of result.kills) {
      fleet.kill(drone.id, now);
      link?.destroySentinel(drone.id, owner);
      for (const w of weapons.values()) w.autolock.clear(drone);
      audio.explosion();
    }
    const hits = result.hits.map((id) => {
      link?.applyDamage(id, MISSILE_DAMAGE);
      audio.hit();
      return { id, damage: MISSILE_DAMAGE };
    });

    return { drones: fleet.remaining, pilots, kills: result.kills, hits };
  }

  return {
    update,
    // SpacetimeDB feeds.
    onSentinel: (row) => fleet.receive(row),
    onSentinelGone: (row) => fleet.remove(row.sentinelId),
    onMissile: (row, live) => {
      if (live) missiles.incoming(row);
    },
    /** Full rack again for one pilot (after a respawn). */
    rearm(id) {
      const w = weapons.get(id);
      if (!w) return;
      w.ammo = MAX_AMMO;
      w.reload = 0;
    },
    fleet,
  };
}
