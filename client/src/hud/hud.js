export function updateHUD(playerState, jarvisLine) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  set('hud-alt',   playerState.altitude?.toFixed(1) ?? '0');
  set('hud-spd',   playerState.speed?.toFixed(1) ?? '0');
  set('hud-pitch', Math.round(playerState.pitch ?? 0));
  set('hud-roll',  Math.round(playerState.roll ?? 0));
  set('hud-mode',  playerState.mode ?? 'KEYBOARD');
  set('hud-hp',    Math.max(0, Math.round(playerState.suitHealth ?? 100)));

  if (jarvisLine) {
    set('jarvis-ticker', `"${jarvisLine}"`);
  }
}

export function flashHUD(element, color = '#ff3300', duration = 500) {
  const el = document.getElementById(element);
  if (!el) return;
  el.style.color = color;
  setTimeout(() => el.style.color = '', duration);
}
