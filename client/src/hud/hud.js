// HUD overlay — reads the DOM once, then updates cheap text nodes each frame.

const els = {};

const HELP_KEYBOARD =
  `<span class="key">W</span> thrust
      <span class="key">S</span> brake
      <span class="key">A</span>/<span class="key">D</span> yaw
      <span class="key">↑</span>/<span class="key">↓</span> climb / dive
      <span class="key">Q</span>/<span class="key">E</span> roll
      <span class="key">Space</span> boost
      <span class="key">R</span> reset`;

const HELP_GLOVE =
  `roll 160 climb · roll 0 dive · roll −120 thrust · pitch lean · fist blast
      <span class="key">R</span> reset`;

export function initHUD() {
  els.alt = document.getElementById('hud-alt');
  els.spd = document.getElementById('hud-spd');
  els.pitch = document.getElementById('hud-pitch');
  els.roll = document.getElementById('hud-roll');
  els.hdg = document.getElementById('hud-hdg');
  els.mode = document.getElementById('hud-mode');
  els.net = document.getElementById('hud-net');
  els.hp = document.getElementById('hud-suit-hp');
  els.hpBar = document.getElementById('hud-suit-bar');
  els.jarvis = document.getElementById('jarvis-ticker');
  els.speedBlur = document.getElementById('speed-blur');
  els.speedVignette = document.getElementById('speed-vignette');
  els.connectGlove = document.getElementById('btn-connect-glove');
  els.help = document.getElementById('hud-help');
  els.repulsor = document.getElementById('repulsor-flash');
  els.pov = document.getElementById('hud-pov');
  els.povBtn = document.getElementById('btn-pov');
  els.gfx = document.getElementById('hud-gfx');
}

// Whose suit the camera is following.
export function setPov(name) {
  if (els.pov) els.pov.textContent = name;
}

// Show the POV switch (only while another pilot is airborne) labelled with the
// suit it would switch to; `attention` pulses it when a new pilot arrives.
export function setPovButton(visible, nextName, attention = false) {
  const btn = els.povBtn;
  if (!btn) return;
  btn.hidden = !visible;
  btn.innerHTML = `POV ▸ ${nextName} <span class="key">V</span>`;
  if (attention) {
    btn.classList.remove('pulse');
    void btn.offsetWidth;
    btn.classList.add('pulse');
  }
}

export function onPovButton(handler) {
  if (!els.povBtn || !handler) return;
  els.povBtn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    handler();
  });
}

// Render tier + GPU, so it's obvious whether the discrete card is in use.
export function setGfx(text, detail = '') {
  if (!els.gfx) return;
  els.gfx.textContent = text;
  els.gfx.title = detail;
}

export function onConnectGlove(handler) {
  if (!els.connectGlove || !handler) return;
  els.connectGlove.addEventListener('click', (e) => {
    e.currentTarget.blur();
    handler();
  });
}

export function setGloveButton(connected, serialAvailable = true) {
  const btn = els.connectGlove;
  if (!btn) return;
  if (!serialAvailable) {
    btn.disabled = true;
    btn.classList.remove('live');
    btn.textContent = 'GLOVE N/A';
    btn.title = 'Web Serial requires Chrome.';
    return;
  }
  btn.disabled = false;
  btn.title = '';
  btn.classList.toggle('live', connected);
  btn.textContent = connected ? 'GLOVE LIVE' : 'CONNECT GLOVE';
}

export function setInputHint(mode) {
  if (!els.help) return;
  els.help.innerHTML = mode === 'GLOVE' ? HELP_GLOVE : HELP_KEYBOARD;
}

export function flashRepulsor() {
  if (!els.repulsor) return;
  els.repulsor.classList.remove('fire');
  void els.repulsor.offsetWidth;
  els.repulsor.classList.add('fire');
}

// ratio: 0 (still) .. 1 (max speed). Ramps edge blur + vignette.
export function updateSpeedFx(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  const px = (r * r * 12).toFixed(2); // ease-in, up to ~12px of edge blur
  if (els.speedBlur) {
    els.speedBlur.style.backdropFilter = `blur(${px}px)`;
    els.speedBlur.style.webkitBackdropFilter = `blur(${px}px)`;
  }
  if (els.speedVignette) {
    els.speedVignette.style.opacity = (r * 0.7).toFixed(3);
  }
}

// state: { altitude, speed, pitch, roll, heading, mode, health }
export function updateHUD(state) {
  if (els.alt) els.alt.textContent = state.altitude.toFixed(1);
  if (els.spd) els.spd.textContent = state.speed.toFixed(1);
  if (els.pitch) els.pitch.textContent = Math.round(state.pitch);
  if (els.roll) els.roll.textContent = Math.round(state.roll);
  if (els.hdg) els.hdg.textContent = Math.round(state.heading);
  if (els.mode) els.mode.textContent = state.mode;

  if (els.hp) els.hp.textContent = Math.round(state.health);
  if (els.hpBar) els.hpBar.style.width = `${Math.max(0, Math.min(100, state.health))}%`;
}

// SpacetimeDB link status shown in the HUD (e.g. "ONLINE", "OFFLINE").
export function setNet(text) {
  if (els.net) els.net.textContent = text;
}

export function setJarvis(line) {
  if (els.jarvis && line) els.jarvis.textContent = line;
}

export function setGpws(active) {
  const el = document.getElementById('gpws');
  if (el) el.classList.toggle('active', active);
}

export function showBanner(message, isError = false) {
  const banner = document.getElementById('boot-banner');
  if (!banner) return;
  banner.innerHTML = message;
  banner.classList.remove('hidden');
  banner.classList.toggle('error', isError);
}

export function hideBanner() {
  const banner = document.getElementById('boot-banner');
  if (banner) banner.classList.add('hidden');
}
