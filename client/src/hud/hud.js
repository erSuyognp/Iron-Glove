// HUD overlay — reads the DOM once, then updates cheap text nodes each frame.

const els = {};

const HELP_KEYBOARD =
  `<span class="key">W</span> thrust
      <span class="key">S</span> brake
      <span class="key">A</span>/<span class="key">D</span> yaw
      <span class="key">↑</span>/<span class="key">↓</span> climb / dive
      <span class="key">Q</span>/<span class="key">E</span> roll
      <span class="key">Shift</span> boost
      <span class="key">Space</span> boost · fire when locked
      <span class="key">R</span> reset`;

const HELP_GLOVE =
  `roll 160 climb · roll 0 nose dive · roll −120 thrust · pitch lean · fist blast · flick to fire when locked
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
  els.drones = document.getElementById('hud-drones');
  els.ammo = document.getElementById('hud-ammo');
  els.ammoPips = document.getElementById('hud-ammo-pips');
  els.lock = document.getElementById('hud-lock');
  els.combatFlash = document.getElementById('combat-flash');
}

// Drone combat readouts. c: { drones, ammo, maxAmmo, reload (0..1), lock }
const combatShown = {};
export function updateCombatHud(c) {
  if (els.drones && combatShown.drones !== c.drones) {
    combatShown.drones = c.drones;
    els.drones.textContent = c.drones;
  }
  if (els.lock && combatShown.lock !== c.lock) {
    combatShown.lock = c.lock;
    els.lock.textContent = c.lock;
    els.lock.dataset.state = c.lock;
  }
  if (els.ammo && combatShown.ammo !== c.ammo) {
    combatShown.ammo = c.ammo;
    els.ammo.textContent = c.ammo;
    els.ammo.classList.toggle('empty', c.ammo === 0);
  }
  if (els.ammoPips) {
    // One pip per missile; the next one to reload fills up as it arrives.
    if (els.ammoPips.childElementCount !== c.maxAmmo) {
      els.ammoPips.innerHTML = '<i><b></b></i>'.repeat(c.maxAmmo);
    }
    const reloadPct = Math.round(c.reload * 100);
    if (combatShown.pips !== c.ammo || combatShown.reload !== reloadPct) {
      combatShown.pips = c.ammo;
      combatShown.reload = reloadPct;
      [...els.ammoPips.children].forEach((pip, i) => {
        pip.firstChild.style.height = i < c.ammo ? '100%' : i === c.ammo ? `${reloadPct}%` : '0%';
        pip.classList.toggle('full', i < c.ammo);
      });
    }
  }
}

// kind: 'kill' (we destroyed a drone) | 'hit' (a missile struck the suit)
export function flashCombat(kind) {
  const el = els.combatFlash;
  if (!el) return;
  el.className = '';
  void el.offsetWidth;
  el.className = kind;
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
