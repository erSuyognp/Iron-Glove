// NASA FIRMS -> normalized observations.
//
// FIRMS distributes active-fire / thermal-anomaly detections as CSV, both from
// the keyed area API and as public per-region files. This module turns either
// into the app's one observation shape (see normalizeFirmsRow) so nothing
// downstream — analysis, rendering, the evidence panel — knows or cares which
// feed a detection came from.
//
// Rules: nothing is invented. A field the row doesn't carry is null; the only
// values not read straight off the row are the satellite's name (decoded from
// FIRMS's documented code) and, when the file has no `instrument` column, the
// instrument of the product the file belongs to, which the caller supplies.
//
// Attribute definitions (satellite codes, confidence classes, UTC times):
//   https://www.earthdata.nasa.gov/data/instruments/viirs/viirs-i-band-375-m-active-fire-data
//   https://www.earthdata.nasa.gov/data/instruments/modis/mcd14dl-nrt

export const SOURCE = 'NASA FIRMS';
export const OBSERVATION_TYPE = 'ACTIVE_FIRE_DETECTION';

// FIRMS `satellite` codes. Anything else is passed through as the raw code.
const SATELLITES = {
  N: 'Suomi NPP',
  N20: 'NOAA-20',
  N21: 'NOAA-21',
  T: 'Terra',
  A: 'Aqua',
};

// FIRMS VIIRS confidence classes come as a letter in API data and as a word in
// the public files; MODIS confidence is a 0–100 percentage.
const CONFIDENCE_CLASSES = { l: 'low', n: 'nominal', h: 'high', low: 'low', nominal: 'nominal', high: 'high' };

// Minimal RFC 4180-ish CSV: FIRMS files are plain comma-separated numbers and
// short codes, but quoted fields are handled in case a header ever grows one.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((values) => {
    const record = {};
    header.forEach((key, i) => {
      record[key] = values[i] === undefined ? '' : values[i].trim();
    });
    return record;
  });
}

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// acq_date (YYYY-MM-DD) + acq_time (UTC, HHMM, not always zero-padded: FIRMS
// writes 00:03 UTC as "3") -> ISO 8601 string, or null if either is unusable.
export function firmsTimestamp(acqDate, acqTime) {
  const date = str(acqDate);
  const time = str(acqTime);
  if (!date || time === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,4}$/.test(time)) return null;
  const hhmm = time.padStart(4, '0');
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2));
  if (hours > 23 || minutes > 59) return null;
  const iso = `${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export function decodeSatellite(code) {
  const c = str(code);
  if (!c) return null;
  return SATELLITES[c] ?? c;
}

// -> { value, scale } where scale is 'class' (low/nominal/high) or 'percent'.
export function decodeConfidence(raw) {
  const s = str(raw);
  if (s === null) return { value: null, scale: null };
  const cls = CONFIDENCE_CLASSES[s.toLowerCase()];
  if (cls) return { value: cls, scale: 'class' };
  const n = num(s);
  if (n !== null && n >= 0 && n <= 100) return { value: n, scale: 'percent' };
  return { value: s, scale: null };
}

/**
 * One FIRMS CSV record -> normalized observation, or null if the row has no
 * usable position.
 *
 * @param row      object keyed by lower-cased CSV header
 * @param product  { instrument, name } of the feed the row came from; only
 *                 `instrument` is used, and only when the row lacks the column
 */
export function normalizeFirmsRow(row, product = {}) {
  const latitude = num(row.latitude);
  const longitude = num(row.longitude);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const observedAt = firmsTimestamp(row.acq_date, row.acq_time);
  const satelliteCode = str(row.satellite);
  const instrumentColumn = str(row.instrument);
  const confidence = decodeConfidence(row.confidence);
  const frp = num(row.frp);
  // VIIRS brightness lives in bright_ti4 (I-4 band); MODIS in `brightness`.
  const brightness = num(row.bright_ti4) ?? num(row.brightness);

  return {
    // FIRMS assigns no identifiers; position + time is unique per pixel per pass.
    id: `firms:${satelliteCode ?? '?'}:${row.acq_date ?? '?'}:${str(row.acq_time) ?? '?'}:${latitude}:${longitude}`,
    type: OBSERVATION_TYPE,
    latitude,
    longitude,
    observedAt,
    source: SOURCE,
    satellite: decodeSatellite(satelliteCode),
    satelliteCode,
    instrument: instrumentColumn ?? product.instrument ?? null,
    instrumentFrom: instrumentColumn ? 'row' : product.instrument ? 'product' : null,
    confidence: confidence.value,
    confidenceScale: confidence.scale,
    frp, // Fire Radiative Power, MW
    brightnessK: brightness,
    dayNight: str(row.daynight),
    version: str(row.version),
    raw: row,
  };
}

/** Whole FIRMS CSV text -> normalized observations (rows without a position dropped). */
export function parseFirmsCsv(text, product = {}) {
  const out = [];
  for (const row of parseCsv(text)) {
    const obs = normalizeFirmsRow(row, product);
    if (obs) out.push(obs);
  }
  return out;
}
