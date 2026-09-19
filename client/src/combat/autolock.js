import * as THREE from 'three';
import { DRONE_RADIUS } from '../sentinel/sentinel.js';

// ---------------------------------------------------------------------------
// Autolock — every frame, find the drone nearest the camera's forward vector
// inside a 15° cone. While one is in the cone a soft white reticle pulses
// around it (TRACKING); hold it there for 2 continuous seconds and the lock
// confirms: the reticle snaps tight and red, the HUD reads LOCKED and the lock
// tone sounds. Leaving the cone while TRACKING starts over; a confirmed lock
// is stickier and holds until the drone leaves the wider HOLD_CONE, so an
// orbiting attacker sweeping past the edge doesn't shake it off instantly.
// ---------------------------------------------------------------------------

const CONE = THREE.MathUtils.degToRad(15);
const HOLD_CONE = THREE.MathUtils.degToRad(30); // a confirmed lock survives out to here
const LOCK_SECONDS = 2;
const MAX_RANGE = 1200; // m from the camera

const RETICLE_FIT = 2.2; // reticle radius, in drone radii, while tracking
const RETICLE_TIGHT = 0.6; // ...times this once locked
const RETICLE_MIN_PX = 22;
const RETICLE_MAX_PX = 130;

export const LOCK = { CLEAR: 'CLEAR', TRACKING: 'TRACKING', LOCKED: 'LOCKED' };

/**
 * @param world  world layer from createWorldLayer
 * @param audio  lock tones from createCombatAudio
 */
export function createAutolock(world, audio) {
  const els = {
    root: document.getElementById('reticle'),
    status: document.getElementById('reticle-status'),
    range: document.getElementById('reticle-range'),
  };

  let target = null; // drone in the cone
  let held = 0; // seconds it has stayed there
  let state = LOCK.CLEAR;
  let shownState = null;
  let shownRange = '';

  const cam = new THREE.Vector3();
  const screen = new THREE.Vector3();

  // Angle between the camera's forward vector and the drone's centre.
  function offAxis(drone) {
    world.toCamera(drone.pos, cam);
    const range = cam.length();
    if (cam.z >= 0 || range > MAX_RANGE) return Infinity;
    return Math.acos(Math.min(1, -cam.z / range));
  }

  /**
   * @param drones   iterable of live drones
   * @param enabled  false while the camera is on another pilot
   * @returns {{ state: string, drone: object|null }}
   */
  function update(drones, dt, enabled = true) {
    let best = null;
    if (enabled) {
      // A drone being tracked keeps the reticle as long as it stays in the
      // cone; otherwise take whichever is closest to the centre of the view.
      if (target?.alive && offAxis(target) <= (state === LOCK.LOCKED ? HOLD_CONE : CONE)) best = target;
      else {
        let bestAngle = CONE;
        for (const drone of drones) {
          const angle = offAxis(drone);
          if (angle <= bestAngle) {
            bestAngle = angle;
            best = drone;
          }
        }
      }
    }

    if (best !== target) {
      target = best;
      held = 0;
    } else if (target) {
      held += dt;
    }

    const next = !target ? LOCK.CLEAR : held >= LOCK_SECONDS ? LOCK.LOCKED : LOCK.TRACKING;
    if (next !== state) {
      state = next;
      if (state === LOCK.LOCKED) audio.lockConfirmed();
    }
    if (state === LOCK.TRACKING) audio.tracking(dt, held / LOCK_SECONDS);
    else if (state === LOCK.LOCKED) audio.locked(dt);

    place();
    return { state, drone: target };
  }

  function place() {
    if (!els.root) return;
    const visible = Boolean(target) && world.project(target.pos, screen);
    if (els.root.hidden === visible) els.root.hidden = !visible;
    if (!visible) return;

    if (state !== shownState) {
      shownState = state;
      els.root.dataset.state = state;
      els.status.textContent = state;
    }
    const range = `${Math.round(screen.z)} m`;
    if (range !== shownRange) {
      shownRange = range;
      els.range.textContent = range;
    }
    const fit = DRONE_RADIUS * RETICLE_FIT * world.pxPerMetre(screen.z);
    const radius =
      Math.max(RETICLE_MIN_PX, Math.min(RETICLE_MAX_PX, fit)) * (state === LOCK.LOCKED ? RETICLE_TIGHT : 1);
    els.root.style.setProperty('--r', `${radius.toFixed(1)}px`);
    els.root.style.transform = `translate3d(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px, 0)`;
  }

  return {
    update,
    /** Drop the lock (e.g. the drone was destroyed). */
    clear() {
      target = null;
      held = 0;
    },
  };
}

/**
 * Small WebAudio tone set for the weapon system. Browsers only allow audio
 * after a user gesture, so the context is created on the first key or click;
 * until then (or without WebAudio) every call is a no-op.
 */
export function createCombatAudio() {
  let ctx = null;
  let since = 0; // seconds since the last repeating blip

  function arm() {
    if (ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
      ctx = new AudioCtx();
    } catch {
      ctx = null;
    }
  }
  for (const type of ['keydown', 'pointerdown']) {
    window.addEventListener(type, arm, { once: true, capture: true });
  }

  function tone(freq, duration, { gain = 0.05, type = 'sine', slideTo = 0, delay = 0 } = {}) {
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function every(seconds, dt, play) {
    since += dt;
    if (since < seconds) return;
    since = 0;
    play();
  }

  return {
    // Blips quicken as the lock builds (progress 0..1).
    tracking: (dt, progress) => every(0.5 - 0.3 * progress, dt, () => tone(880, 0.05, { gain: 0.03 })),
    lockConfirmed() {
      since = 0;
      tone(1320, 0.09, { gain: 0.07, type: 'square' });
      tone(1760, 0.22, { gain: 0.07, type: 'square', delay: 0.1 });
    },
    locked: (dt) => every(0.32, dt, () => tone(1760, 0.04, { gain: 0.03, type: 'square' })),
    launch: () => tone(520, 0.45, { gain: 0.08, type: 'sawtooth', slideTo: 90 }),
    explosion: () => tone(140, 0.7, { gain: 0.16, type: 'sawtooth', slideTo: 28 }),
    hit: () => tone(220, 0.3, { gain: 0.12, type: 'square', slideTo: 60 }),
  };
}
