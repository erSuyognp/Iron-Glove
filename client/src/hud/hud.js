// HUD overlay — reads the DOM once, then updates cheap text nodes each frame.

const els = {};

export function initHUD() {
  els.alt = document.getElementById('hud-alt');
  els.spd = document.getElementById('hud-spd');
  els.pitch = document.getElementById('hud-pitch');
  els.roll = document.getElementById('hud-roll');
  els.hdg = document.getElementById('hud-hdg');
  els.mode = document.getElementById('hud-mode');
  els.hp = document.getElementById('hud-suit-hp');
  els.hpBar = document.getElementById('hud-suit-bar');
  els.jarvis = document.getElementById('jarvis-ticker');
  els.speedBlur = document.getElementById('speed-blur');
  els.speedVignette = document.getElementById('speed-vignette');
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
