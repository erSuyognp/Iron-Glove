// Observation providers: where FIRMS detections come from.
//
//   demo  — a real FIRMS CSV bundled with the app (see data/), labelled
//           HISTORICAL DEMO. Always available, never fabricated.
//   live  — the FIRMS area API, reached through a same-origin proxy that holds
//           the MAP_KEY (the Vite dev middleware in vite.config.js; production
//           needs a real server-side proxy). If it fails for any reason the
//           provider falls back to the demo dataset and says so.
//
// Both paths run through parseFirmsCsv, so a live and a historical detection
// are the same object to everything downstream.
//
// This module has no environment or asset imports; environmental/index.js
// wires it to import.meta.env and the bundled files. That keeps the logic
// checkable in plain Node.

import { parseFirmsCsv } from './firms.js';
import { filterToBounds, summarize } from './observations.js';

export const DATASET_KIND = Object.freeze({
  HISTORICAL_DEMO: 'HISTORICAL_DEMO',
  LIVE: 'LIVE',
});

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_AREA_DAYS = 10; // FIRMS area API limit

function bboxParam(b) {
  return `${b.west},${b.south},${b.east},${b.north}`;
}

/**
 * @param config.demo       { csv, meta } — bundled CSV text and its descriptor
 * @param config.proxyUrl   base of the FIRMS proxy, e.g. '/api/firms'
 * @param config.days       day range for live requests (1–10)
 * @param config.fetchImpl  fetch (injectable for tests)
 * @param config.timeoutMs  live request timeout
 */
export function createFirmsProvider({
  demo,
  proxyUrl = '/api/firms',
  days = 2,
  fetchImpl = typeof fetch === 'function' ? fetch : undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const liveDays = Math.min(MAX_AREA_DAYS, Math.max(1, Math.round(Number(days) || 1)));

  // Bundled historical data, cut to the world's bounds.
  function loadDemo(bbox) {
    if (!demo?.csv) throw new Error('no demo dataset bundled');
    const product = { instrument: demo.meta?.instrument ?? null, name: demo.meta?.product ?? null };
    const observations = filterToBounds(parseFirmsCsv(demo.csv, product), bbox);
    return {
      kind: DATASET_KIND.HISTORICAL_DEMO,
      label: demo.meta?.label ?? 'HISTORICAL DEMO',
      observations,
      summary: summarize(observations),
      provenance: {
        source: demo.meta?.source ?? 'NASA FIRMS',
        sourceUrl: demo.meta?.sourceUrl ?? null,
        product: demo.meta?.product ?? null,
        instrument: demo.meta?.instrument ?? null,
        satellite: demo.meta?.satellite ?? null,
        acquired: demo.meta?.acquired ?? null,
        downloadedAt: demo.meta?.downloadedAt ?? null,
        credit: demo.meta?.credit ?? null,
      },
    };
  }

  // FIRMS area API via the proxy. `product` is a registry descriptor:
  // { product: 'VIIRS_SNPP_NRT', instrument: 'VIIRS', label }.
  async function loadLive(bbox, product) {
    if (!fetchImpl) throw new Error('fetch is not available');
    if (!bbox) throw new Error('live FIRMS needs a bounding box');
    if (!/^[A-Z0-9_]+$/.test(product?.product ?? '')) throw new Error('invalid FIRMS product id');
    const url = `${proxyUrl.replace(/\/$/, '')}/area/csv/${product.product}/${bboxParam(bbox)}/${liveDays}`;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url, { signal: controller?.signal, headers: { Accept: 'text/csv' } });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      // The proxy answers 503 with a JSON reason when the key is missing.
      let reason = text.slice(0, 200);
      try {
        reason = JSON.parse(text).error ?? reason;
      } catch {
        /* plain text from upstream */
      }
      throw new Error(`FIRMS proxy ${response.status}: ${reason}`);
    }
    // FIRMS reports quota/key problems as a 200 with a text message.
    if (!/^latitude\s*,/i.test(text)) {
      throw new Error(`FIRMS returned no CSV: ${text.trim().slice(0, 120) || '(empty)'}`);
    }
    const fetchedAt = new Date().toISOString();
    const observations = filterToBounds(parseFirmsCsv(text, { instrument: product.instrument }), bbox);
    return {
      kind: DATASET_KIND.LIVE,
      label: 'LIVE',
      observations,
      summary: summarize(observations),
      provenance: {
        source: 'NASA FIRMS',
        sourceUrl: url, // proxy path; the keyed upstream URL never reaches the client
        product: product.label ?? product.product,
        productId: product.product,
        instrument: product.instrument ?? null,
        satellite: null, // per-observation; see summary.satellites
        acquired: { days: liveDays },
        fetchedAt,
        credit: 'NASA FIRMS, LANCE/EOSDIS',
      },
    };
  }

  /**
   * Observations for a world.
   * @param world   registry entry with `environmental: { bbox, firms }`
   * @param mode    'demo' | 'live'
   * @returns dataset { kind, label, observations, summary, provenance, mode,
   *          fallbackReason? } — never throws for live failures; the demo
   *          dataset is returned with `fallbackReason` set instead. Throws only
   *          if even the bundled data can't be read.
   */
  async function load(world, mode = 'demo') {
    const env = world?.environmental ?? {};
    if (mode === 'live') {
      try {
        return { ...(await loadLive(env.bbox, env.firms)), mode };
      } catch (err) {
        const dataset = loadDemo(env.bbox);
        return { ...dataset, mode, fallbackReason: err?.message ?? String(err) };
      }
    }
    return { ...loadDemo(env.bbox), mode: 'demo' };
  }

  return { load, loadDemo, loadLive };
}
