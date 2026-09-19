// Environmental evidence panel: shows the selected observation field by
// field, its OBSERVATION PRIORITY with the reasons behind it, and where the
// data came from. Every value shown is read from the observation; anything
// the source didn't report is shown as N/A, never estimated.
//
// Actions (Stage 7: INSPECT HOTSPOT) go in #evidence-actions via `setActions`.

import { dataStatus } from './observations.js';
import { compassPoint, formatDistance } from './geo.js';

const NA = 'N/A';

const TYPE_LABELS = {
  ACTIVE_FIRE_DETECTION: 'Satellite thermal anomaly / active-fire detection',
};

function fmtTime(iso) {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : null;
}

function fmtConfidence(obs) {
  if (obs.confidence === null || obs.confidence === undefined) return null;
  if (obs.confidenceScale === 'class') return { main: obs.confidence.toUpperCase(), sub: 'FIRMS class (low / nominal / high)' };
  if (obs.confidenceScale === 'percent') return { main: `${obs.confidence} %`, sub: 'detection confidence' };
  return { main: String(obs.confidence), sub: 'as reported' };
}

function fmtSensor(obs) {
  const bits = [obs.instrument, obs.satellite].filter(Boolean);
  if (!bits.length) return null;
  const sub = obs.instrumentFrom === 'product' ? 'instrument from feed product, satellite from row' : null;
  return { main: bits.join(' / '), sub };
}

function fmtLocation(obs) {
  const lat = `${Math.abs(obs.latitude).toFixed(4)}° ${obs.latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(obs.longitude).toFixed(4)}° ${obs.longitude >= 0 ? 'E' : 'W'}`;
  return { main: `${lat}  ${lon}`, sub: 'pixel centre, ~375 m footprint' };
}

// Field list for one observation. `context` = { distanceM, bearingDeg } or null.
function fields(obs, context, now) {
  const status = dataStatus(obs.observedAt, now);
  const conf = fmtConfidence(obs);
  const sensor = fmtSensor(obs);
  const loc = fmtLocation(obs);
  const range =
    context && Number.isFinite(context.distanceM)
      ? {
          main: formatDistance(context.distanceM),
          sub: Number.isFinite(context.bearingDeg)
            ? `${compassPoint(context.bearingDeg)} · bearing ${Math.round(context.bearingDeg).toString().padStart(3, '0')}°`
            : null,
        }
      : null;
  return [
    ['TYPE', TYPE_LABELS[obs.type] ?? obs.type ?? null],
    ['SOURCE', obs.source ?? null],
    ['SENSOR', sensor],
    ['OBSERVED', fmtTime(obs.observedAt)],
    ['CONFIDENCE', conf],
    ['FIRE RADIATIVE POWER', Number.isFinite(obs.frp) ? { main: `${obs.frp.toFixed(1)} MW`, sub: null } : null],
    ['BRIGHTNESS (I-4)', Number.isFinite(obs.brightnessK) ? `${obs.brightnessK.toFixed(1)} K` : null],
    ['DAY / NIGHT', obs.dayNight === 'D' ? 'Day' : obs.dayNight === 'N' ? 'Night' : (obs.dayNight ?? null)],
    ['LOCATION', loc],
    ['RANGE FROM SUIT', range],
    ['DATA STATUS', { main: status, status }],
  ];
}

function renderField(dl, key, value) {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  if (value === null || value === undefined) {
    dd.textContent = NA;
    dd.classList.add('na');
  } else if (typeof value === 'object') {
    dd.append(value.main);
    if (value.status) dd.dataset.status = value.status;
    if (value.sub) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = value.sub;
      dd.append(sub);
    }
  } else {
    dd.textContent = String(value);
  }
  dl.append(dt, dd);
}

/**
 * @param opts.onClose  called when the operator dismisses the panel
 */
export function createEvidencePanel({ onClose } = {}) {
  const root = document.getElementById('evidence');
  const els = {
    fields: document.getElementById('evidence-fields'),
    level: document.getElementById('evidence-priority'),
    reasons: document.getElementById('evidence-reasons'),
    actions: document.getElementById('evidence-actions'),
    provenance: document.getElementById('evidence-provenance'),
    close: document.getElementById('evidence-close'),
  };
  let current = null; // { observation, priority }

  function hide() {
    if (!root || root.hidden) return;
    root.hidden = true;
    current = null;
    // Drop focus so Space (boost) doesn't re-press whichever button was clicked.
    document.activeElement?.blur?.();
    onClose?.();
  }

  els.close?.addEventListener('click', hide);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !root?.hidden) hide();
  });

  /**
   * @param observation  normalized observation
   * @param priority     assessPriority() result
   * @param dataset      providers.js dataset (for provenance)
   * @param context      { distanceM, bearingDeg } from the suit, or null
   */
  function show(observation, { priority, dataset, context = null, now = Date.now() }) {
    if (!root) return;
    els.fields.replaceChildren();
    for (const [k, v] of fields(observation, context, now)) renderField(els.fields, k, v);

    els.level.textContent = priority.level;
    els.level.dataset.level = priority.level;
    els.reasons.replaceChildren();
    for (const r of priority.reasons) {
      const li = document.createElement('li');
      li.textContent = r;
      els.reasons.append(li);
    }
    for (const c of priority.cautions) {
      const li = document.createElement('li');
      li.className = 'caution';
      li.textContent = c;
      els.reasons.append(li);
    }
    if (!priority.reasons.length && !priority.cautions.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'no priority factors present in this record';
      els.reasons.append(li);
    }

    const p = dataset?.provenance ?? {};
    const lines = [
      [dataset?.label, p.source, p.product].filter(Boolean).join(' · '),
      p.acquired?.from && p.acquired?.to ? `Acquired ${p.acquired.from} → ${p.acquired.to} UTC` : null,
      p.acquired?.days ? `Last ${p.acquired.days} day(s) of detections` : null,
      p.fetchedAt ? `Fetched ${fmtTime(p.fetchedAt)}` : p.downloadedAt ? `Downloaded ${fmtTime(p.downloadedAt)}` : null,
      dataset?.fallbackReason ? `Live feed unavailable: ${dataset.fallbackReason}` : null,
      p.credit ?? null,
    ].filter(Boolean);
    els.provenance.replaceChildren(...lines.map((t) => Object.assign(document.createElement('div'), { textContent: t })));

    current = { observation, priority };
    root.hidden = false;
  }

  /** Replace the action buttons (Stage 7). `buttons` = [{ label, className?, onClick }]. */
  function setActions(buttons = []) {
    els.actions.replaceChildren();
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `hud-btn ${b.className ?? ''}`.trim();
      btn.textContent = b.label;
      btn.disabled = !!b.disabled;
      btn.addEventListener('click', (e) => {
        btn.blur();
        b.onClick?.(e);
      });
      els.actions.append(btn);
    }
  }

  return {
    show,
    hide,
    setActions,
    get current() {
      return current;
    },
    get visible() {
      return !!root && !root.hidden;
    },
  };
}
