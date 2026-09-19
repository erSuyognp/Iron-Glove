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

// Which world this page is flying: the top-bar subtitle, the browser tab, and
// a data-world-mode attribute on the HUD root that the stylesheet uses to hide
// readouts that don't apply to this world (e.g. drone combat outside JHU).
// world: a registry entry (worlds/registry.js).
export function setWorld(world) {
  const sub = document.getElementById('hud-world-sub');
  if (sub && world.hudLabel) sub.textContent = world.hudLabel;
  if (world.title) document.title = world.title;
  const hud = document.getElementById('hud');
  if (hud) hud.dataset.worldMode = world.environmentMode;
  const name = document.getElementById('hud-world');
  if (name && world.hudLabel) name.textContent = world.hudLabel;
  const ops = document.getElementById('hud-ops');
  if (ops && world.modeLabel) ops.textContent = world.modeLabel;
}

// Fill the world selector from the registry and mark the active world.
// worlds: registry entries with { id, selectorLabel }.
export function populateWorldSelect(worlds, activeId) {
  const sel = document.getElementById('world-select');
  if (!sel) return;
  sel.innerHTML = '';
  for (const w of worlds) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.selectorLabel ?? w.name;
    opt.selected = w.id === activeId;
    sel.appendChild(opt);
  }
}

// Environmental data status block. `status` = null hides it; otherwise
// { badge, tone: 'loading'|'live'|'historical'|'error', source, range, title }.
export function setEnvData(status) {
  const root = document.getElementById('hud-env');
  if (!root) return;
  root.hidden = !status;
  if (!status) return;
  const badge = document.getElementById('hud-env-badge');
  if (badge) {
    badge.textContent = status.badge ?? '';
    badge.dataset.tone = status.tone ?? 'loading';
    badge.title = status.title ?? '';
  }
  const source = document.getElementById('hud-env-source');
  if (source) source.textContent = status.source ?? '';
  const range = document.getElementById('hud-env-range');
  if (range) range.textContent = status.range ?? '';
}

// Inspection mission readout. `mission` = null hides it; otherwise
// { status, title, source, target, distance, turn, onCourse }. Strings are
// pre-formatted by the caller so this stays a dumb view.
export function setMission(mission) {
  const root = document.getElementById('hud-mission');
  if (!root) return;
  root.hidden = !mission;
  if (!mission) return;
  root.dataset.status = mission.status;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text ?? '—';
  };
  set('mission-status', mission.status);
  set('mission-title', mission.title);
  set('mission-dist', mission.distance);
  set('mission-turn', mission.turn);
  set('mission-source', mission.source);
  set('mission-target', mission.target);
  document.getElementById('mission-turn')?.classList.toggle('on-course', !!mission.onCourse);
  const abort = document.getElementById('mission-abort');
  const clear = document.getElementById('mission-clear');
  if (abort) abort.hidden = mission.status !== 'ACTIVE';
  if (clear) clear.hidden = mission.status === 'ACTIVE';
}

// System recommendation awaiting the operator. `rec` = null hides it;
// otherwise { text, why }.
export function setRecommendation(rec) {
  const root = document.getElementById('hud-recommend');
  if (!root) return;
  root.hidden = !rec;
  if (!rec) return;
  const text = document.getElementById('recommend-text');
  if (text) text.textContent = rec.text ?? '';
  const why = document.getElementById('recommend-why');
  if (why) why.textContent = rec.why ?? '';
}

// Mission / recommendation buttons → handlers { accept, ignore, abort, clear }.
// Buttons blur after a click so Space (boost) doesn't re-press them.
export function onMissionAction(handlers) {
  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (!el || !fn) return;
    el.addEventListener('click', (e) => {
      e.currentTarget.blur();
      fn();
    });
  };
  wire('recommend-accept', handlers.accept);
  wire('recommend-ignore', handlers.ignore);
  wire('mission-abort', handlers.abort);
  wire('mission-clear', handlers.clear);
}

// handler(worldId) when the operator picks a world. The control is blurred
// first so the flight keys don't keep steering the dropdown.
export function onWorldSelect(handler) {
  const sel = document.getElementById('world-select');
  if (!sel || !handler) return;
  sel.addEventListener('change', (e) => {
    const id = e.currentTarget.value;
    e.currentTarget.blur();
    handler(id);
  });
}
