// Environmental data entry point for the app: the FIRMS provider wired to the
// bundled demo dataset and to the client-side configuration.
//
//   VITE_FIRMS_MODE        'demo' (default) | 'live'
//   VITE_FIRMS_PROXY_URL   same-origin proxy base, default '/api/firms'
//   VITE_FIRMS_DAYS        day range for live requests, 1–10, default 2
//
// The FIRMS MAP_KEY is never read here: it lives in FIRMS_MAP_KEY on the dev
// server (vite.config.js) and is added to the upstream request there.

import demoCsv from './data/firms-demo-california.csv?raw';
import demoMeta from './data/firms-demo-california.meta.json';
import { createFirmsProvider } from './providers.js';

export const FIRMS_MODE = import.meta.env.VITE_FIRMS_MODE === 'live' ? 'live' : 'demo';

const provider = createFirmsProvider({
  demo: { csv: demoCsv, meta: demoMeta },
  proxyUrl: import.meta.env.VITE_FIRMS_PROXY_URL || '/api/firms',
  days: import.meta.env.VITE_FIRMS_DAYS || 2,
});

/** Observations for `world` (a registry entry). See providers.js `load`. */
export function loadFirmsObservations(world) {
  return provider.load(world, FIRMS_MODE);
}

export { DATASET_KIND } from './providers.js';
