import { SITES } from '../sites.js';
import { siteArt } from './art.js';
import { startHeroSuit } from './hero.js';
import { sfx } from '../audio/sound.js';

const SUIT_GLB = '/iron_man_ucm.glb'; // the suit the game flies (main.js)

// This is presentation-only: sites.js remains the single source of truth for
// every destination's name, coordinates, and flight setup.

function formatCoord(value, positive, negative) {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}

function tileHtml(site, index) {
  return `
    <button
      type="button"
      class="destination-tile"
      data-site="${site.id}"
      aria-pressed="false"
      tabindex="-1"
    >
      <span class="destination-tile-number">${String(index + 1).padStart(2, '0')}</span>
      <span class="destination-tile-image" aria-hidden="true">${siteArt(site.id)}</span>
      <span class="destination-tile-name">${site.short}</span>
      <span class="destination-tile-place">${site.place}</span>
    </button>`;
}

function findInitialSite(initialSite) {
  if (typeof initialSite === 'string') return SITES.find((site) => site.id === initialSite) ?? SITES[0];
  return SITES.find((site) => site.id === initialSite?.id) ?? SITES[0];
}

/**
 * Show the boot screen, then resolve with the selected original SITES entry.
 * The active game canvas is intentionally never removed by this UI.
 */
export function pickSite(initialSite = SITES[0]) {
  const boot = document.getElementById('boot');
  const dest = document.getElementById('dest');
  const start = document.getElementById('btnStart');
  const strip = document.getElementById('dest-filmstrip');
  const preview = document.getElementById('dest-preview');
  const previewName = document.getElementById('dest-title');
  const previewPlace = document.getElementById('dest-place');
  const previewCoords = document.getElementById('dest-coords');
  // Optional dressing: the screen works without any of these.
  const previewArt = document.getElementById('dest-art');
  const previewIndex = document.getElementById('dest-index');
  const previewBlurb = document.getElementById('dest-blurb');
  const previewEra = document.getElementById('dest-era');
  const launchButton = document.getElementById('dest-launch');
  const bootSites = document.getElementById('boot-sites');
  const hud = document.getElementById('hud');

  if (!boot || !dest || !start || !strip || !preview || !previewName || !previewPlace || !previewCoords) {
    return Promise.resolve(findInitialSite(initialSite));
  }

  boot.hidden = false;
  dest.hidden = true;
  const heroCanvas = document.getElementById('boot-suit');
  const hero = heroCanvas ? startHeroSuit(heroCanvas, SUIT_GLB) : null;
  if (hud) {
    hud.inert = true;
    hud.setAttribute('aria-hidden', 'true');
  }
  strip.innerHTML = SITES.map(tileHtml).join('');
  strip.style.setProperty('--tile-count', SITES.length);
  if (bootSites) bootSites.innerHTML = SITES.map((site) => `<li>${site.short}</li>`).join('');

  const tiles = [...strip.querySelectorAll('.destination-tile')];
  let selectedIndex = Math.max(0, SITES.indexOf(findInitialSite(initialSite)));
  let launched = false;

  function select(index, { focus = false, scroll = false } = {}) {
    selectedIndex = (index + SITES.length) % SITES.length;
    const selected = SITES[selectedIndex];
    preview.dataset.site = selected.id;
    previewName.textContent = selected.name.toUpperCase();
    previewPlace.textContent = selected.place.toUpperCase();
    previewCoords.textContent = `${formatCoord(selected.latitude, 'N', 'S')} · ${formatCoord(selected.longitude, 'E', 'W')}`;
    const count = String(SITES.length).padStart(2, '0');
    if (previewIndex) previewIndex.textContent = `DESTINATION ${String(selectedIndex + 1).padStart(2, '0')} / ${count}`;
    if (previewBlurb) previewBlurb.textContent = selected.blurb;
    if (previewEra) previewEra.textContent = selected.era;
    if (previewArt) {
      // A fresh node each time restarts the fade-in.
      const art = document.createElement('div');
      art.className = 'destination-art-layer';
      art.innerHTML = siteArt(selected.id);
      previewArt.replaceChildren(art);
    }

    tiles.forEach((tile, tileIndex) => {
      const active = tileIndex === selectedIndex;
      tile.classList.toggle('selected', active);
      tile.setAttribute('aria-pressed', String(active));
      tile.tabIndex = active ? 0 : -1;
    });

    const tile = tiles[selectedIndex];
    if (focus) sfx('select');
    if (scroll) tile?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    if (focus) tile?.focus({ preventScroll: true });
  }

  select(selectedIndex);

  return new Promise((resolve) => {
    function cleanUp() {
      start.removeEventListener('click', showDest);
      launchButton?.removeEventListener('click', launch);
      window.removeEventListener('keydown', onKey);
    }

    function launch() {
      if (launched) return;
      launched = true;
      sfx('deploy');
      cleanUp();
      if (hud) {
        hud.inert = false;
        hud.removeAttribute('aria-hidden');
      }
      dest.hidden = true;
      resolve(SITES[selectedIndex]);
    }

    function showDest() {
      if (launched) return;
      boot.hidden = true;
      dest.hidden = false;
      hero?.dispose(); // frees its WebGL context well before the game needs the GPU
      select(selectedIndex, { focus: true, scroll: true });
    }

    function onKey(event) {
      if (dest.hidden || launched) return;
      if (event.code === 'ArrowRight' || event.code === 'ArrowDown') {
        event.preventDefault();
        select(selectedIndex + 1, { focus: true, scroll: true });
      } else if (event.code === 'ArrowLeft' || event.code === 'ArrowUp') {
        event.preventDefault();
        select(selectedIndex - 1, { focus: true, scroll: true });
      } else if (event.code === 'Enter') {
        event.preventDefault();
        launch();
      }
    }

    start.addEventListener('click', showDest);
    launchButton?.addEventListener('click', launch);
    window.addEventListener('keydown', onKey);
    start.focus({ preventScroll: true });
    tiles.forEach((tile, index) => {
      tile.addEventListener('click', () => {
        if (launched || dest.hidden) return;
        if (index === selectedIndex) launch();
        else select(index, { focus: true, scroll: true });
      });
    });
  });
}
