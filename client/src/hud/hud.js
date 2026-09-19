// HUD overlay — reads the DOM once, then updates cheap text nodes each frame.

const els = {};

// What each element currently shows. Writing a text node or a style dirties
// layout and repaints its glow even when the value is the same, and most
// readouts hold still for many frames, so every per-frame write goes through
// these and only touches the DOM on a change.
const shownText = {};
function setText(key, text) {
  if (shownText[key] === text) return;
  shownText[key] = text;
  if (els[key]) els[key].textContent = text;
}

const HELP_KEYBOARD =
  `<span class="key">W</span> thrust
      <span class="key">S</span> brake
      <span class="key">A</span>/<span class="key">D</span> yaw
      <span class="key">↑</span>/<span class="key">↓</span> climb / dive
      <span class="key">Q</span>/<span class="key">E</span> roll
      <span class="key">Shift</span> boost
      <span class="key">Space</span> boost · fire when locked
      <span class="key">M</span> mission
      <span class="key">R</span> reset`;

const HELP_GLOVE =
  `roll 160 climb · roll 0 nose dive · roll −120 thrust · pitch lean · fist blast · flick to fire when locked
      <span class="key">M</span> mission
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
  els.gpws = document.getElementById('gpws');
  els.site = document.getElementById('hud-site');
  els.missionBtn = document.getElementById('btn-mission');
  els.changeSite = document.getElementById('btn-change-site');
}

// Name of the site being flown, under the title.
export function setSiteName(name) {
  if (els.site) els.site.textContent = name;
}

// The mission control: ACTIVATE MISSION launches the drones, END MISSION
// stands them down. Disabled until the suit has arrived at the site.
export function setMissionButton(active, enabled = true) {
  const btn = els.missionBtn;
  if (!btn) return;
  btn.disabled = !enabled;
  btn.classList.toggle('live', active);
  btn.innerHTML = `${active ? 'END MISSION' : 'ACTIVATE MISSION'} <span class="key">M</span>`;
}

export function onMissionButton(handler) {
  if (!els.missionBtn || !handler) return;
  els.missionBtn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    handler();
  });
}

export function onChangeSite(handler) {
  if (!els.changeSite || !handler) return;
  els.changeSite.addEventListener('click', handler);
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
const BLUR_STEP_PX = 0.25; // finer steps than this can't be seen
let shownBlur = -1;
let shownVignette = '';
export function updateSpeedFx(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  // Ease-in, up to ~12px of edge blur.
  const px = Math.round((r * r * 12) / BLUR_STEP_PX) * BLUR_STEP_PX;
  if (els.speedBlur && px !== shownBlur) {
    // A backdrop filter re-filters the whole screen every frame for as long as
    // the element exists, even at blur(0px), so it is taken out of the page
    // entirely while there is nothing to blur.
    if (px === 0 || shownBlur <= 0) els.speedBlur.style.display = px === 0 ? 'none' : 'block';
    shownBlur = px;
    els.speedBlur.style.backdropFilter = `blur(${px}px)`;
    els.speedBlur.style.webkitBackdropFilter = `blur(${px}px)`;
  }
  const opacity = (r * 0.7).toFixed(2);
  if (els.speedVignette && opacity !== shownVignette) {
    shownVignette = opacity;
    els.speedVignette.style.opacity = opacity;
  }
}

// state: { altitude, speed, pitch, roll, heading, mode, health }
export function updateHUD(state) {
  setText('alt', state.altitude.toFixed(1));
  setText('spd', state.speed.toFixed(1));
  setText('pitch', String(Math.round(state.pitch)));
  setText('roll', String(Math.round(state.roll)));
  setText('hdg', String(Math.round(state.heading)));
  setText('mode', state.mode);

  setText('hp', String(Math.round(state.health)));
  const hpWidth = `${Math.max(0, Math.min(100, state.health))}%`;
  if (els.hpBar && shownText.hpBar !== hpWidth) {
    shownText.hpBar = hpWidth;
    els.hpBar.style.width = hpWidth;
  }
}

// SpacetimeDB link status shown in the HUD (e.g. "ONLINE", "OFFLINE").
export function setNet(text) {
  if (els.net) els.net.textContent = text;
}

export function setJarvis(line) {
  if (els.jarvis && line) els.jarvis.textContent = line;
}

let gpwsShown = false;
export function setGpws(active) {
  if (active === gpwsShown) return;
  gpwsShown = active;
  const el = els.gpws ?? document.getElementById('gpws');
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
