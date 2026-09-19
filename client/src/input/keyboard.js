// Keyboard fallback controller.
// Tracks which control keys are currently held; the flight model in main.js
// reads this state each frame. This keeps input decoupled from physics.

const held = new Set();

// Space does double duty: it boosts, but while a drone is LOCKED a press
// fires a missile instead (and that press never boosts). Shift always boosts.
let spaceFires = false;
let spaceFired = false; // the current Space press was a fire command
let fireQueued = false;

// Keys we own — prevent the page from scrolling on arrows / space.
const OWNED = new Set([
  'KeyW', 'KeyS', 'KeyA', 'KeyD',
  'KeyQ', 'KeyE', 'KeyR',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight',
]);

export function initKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (OWNED.has(e.code)) {
      if (e.code === 'Space' && !e.repeat && spaceFires) {
        spaceFired = true;
        fireQueued = true;
      }
      held.add(e.code);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    held.delete(e.code);
    if (e.code === 'Space') spaceFired = false;
  });
  // Drop all keys if the window loses focus so the suit doesn't fly off.
  window.addEventListener('blur', () => {
    held.clear();
    spaceFired = false;
  });
}

// Tell the keyboard whether Space currently means "fire" (a drone is locked).
export function setSpaceFires(value) {
  spaceFires = value;
}

// Spacebar fire command. True once per press.
export function consumeFireKey() {
  if (!fireQueued) return false;
  fireQueued = false;
  return true;
}

export function isDown(code) {
  return held.has(code);
}

// Snapshot of the intent axes derived from held keys.
// Each axis is normalized to [-1, 1].
export function readAxes() {
  return {
    throttle: (isDown('KeyW') ? 1 : 0) - (isDown('KeyS') ? 1 : 0),
    yaw: (isDown('KeyD') || isDown('ArrowRight') ? 1 : 0) - (isDown('KeyA') || isDown('ArrowLeft') ? 1 : 0),
    climb: (isDown('ArrowUp') ? 1 : 0) - (isDown('ArrowDown') ? 1 : 0),
    roll: (isDown('KeyE') ? 1 : 0) - (isDown('KeyQ') ? 1 : 0),
    boost: isDown('ShiftLeft') || isDown('ShiftRight') || (isDown('Space') && !spaceFired),
    reset: isDown('KeyR'),
  };
}
