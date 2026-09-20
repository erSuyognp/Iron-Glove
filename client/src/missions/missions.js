import { site } from '../sites.js';
import { createParticles } from './particles.js';
import { createFireMission } from './fire.js';
import { createRingMission, formatTime } from './rings.js';

export { formatTime };

// ---------------------------------------------------------------------------
// Client-side missions: FIRE RESPONSE and DOWNTOWN RUN. Unlike the drones,
// which the server flies, these run entirely in the browser. One at a time;
// main.js owns which mission (if any) is on and announces what happens.
//
// Each mission is { update(frame) -> events[], target(suit), hud(), dispose() }.
// ---------------------------------------------------------------------------

const MAKERS = { fire: createFireMission, run: createRingMission };

/**
 * @param ctx { viewer, sensorExclude }  sensorExclude: scene objects the suit's
 *   collision sensors look through; mission markers are added to it.
 */
export function createMissions({ viewer, sensorExclude }) {
  let active = null;
  let particles = null;

  // Flames, smoke and water share one pool, made the first time it is needed.
  function effects() {
    if (!particles) {
      particles = createParticles(viewer, site, 520);
      sensorExclude.push(particles.primitive);
    }
    return particles;
  }

  function start(kind, suit) {
    stop();
    active = MAKERS[kind]({ viewer, sensorExclude, particles: effects() }, suit);
  }

  function stop() {
    active?.dispose();
    active = null;
  }

  /** Step the mission and its effects. Returns what happened this frame. */
  function update(frame) {
    const events = active ? active.update(frame) : [];
    particles?.update(frame.dt);
    return events;
  }

  return {
    start,
    stop,
    update,
    target: (suit) => active?.target(suit) ?? null,
    hud: () => active?.hud() ?? null,
    isSpraying: () => active?.isSpraying() ?? false,
  };
}
