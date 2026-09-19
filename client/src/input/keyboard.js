const keys = {};

export function initKeyboard() {
  window.addEventListener('keydown', (e) => (keys[e.code] = true));
  window.addEventListener('keyup',   (e) => (keys[e.code] = false));
}

export function getKeyboardControl() {
  return {
    up:     keys.Space  ? 1 : keys.KeyC ? -0.6 : 0,
    thrust: keys.KeyW   ? 1 : 0,
    brake:  keys.KeyS   ? 1 : 0,
    fire:   keys.KeyF   || false,
    yawL:   keys.ArrowLeft  || false,
    yawR:   keys.ArrowRight || false,
  };
}

export function isKeyDown(code) {
  return !!keys[code];
}
