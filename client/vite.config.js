import { defineConfig, loadEnv } from 'vite';
import cesium from 'vite-plugin-cesium';

// ---------------------------------------------------------------------------
// FIRMS dev proxy (local development only).
//
// NASA FIRMS's area API needs a MAP_KEY in the URL and sends no CORS headers,
// so the browser can neither call it directly nor be trusted with the key.
// During `vite dev` this middleware answers
//
//     GET /api/firms/area/csv/<PRODUCT>/<west>,<south>,<east>,<north>/<days>[/<YYYY-MM-DD>]
//
// by fetching
//
//     https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/<PRODUCT>/<bbox>/<days>[/<date>]
//
// with FIRMS_MAP_KEY read from the environment / .env on the dev server. The
// key is not a VITE_ variable, so Vite never bundles it and the client never
// sees it; the upstream URL is not echoed back either.
//
// This is NOT a production solution: `vite build` output has no server. A
// deployed live mode needs a real server-side proxy (Vercel Function,
// Cloudflare Worker, app backend) doing the same thing.
// ---------------------------------------------------------------------------

const FIRMS_HOST = 'https://firms.modaps.eosdis.nasa.gov';
const FIRMS_ROUTE = /^\/area\/csv\/([A-Z0-9_]{3,40})\/(-?\d{1,3}(?:\.\d+)?(?:,-?\d{1,3}(?:\.\d+)?){3})\/(\d{1,2})(?:\/(\d{4}-\d{2}-\d{2}))?\/?(?:\?.*)?$/;
const UPSTREAM_TIMEOUT_MS = 20000;

function firmsDevProxy(mapKey) {
  return {
    name: 'iron-glove-firms-dev-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/firms', async (req, res) => {
        const send = (status, body, type = 'application/json') => {
          res.statusCode = status;
          res.setHeader('Content-Type', type);
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        };

        if (req.method !== 'GET') return send(405, JSON.stringify({ error: 'GET only' }));
        const m = FIRMS_ROUTE.exec(req.url || '');
        if (!m) {
          return send(
            400,
            JSON.stringify({
              error: 'expected /api/firms/area/csv/<PRODUCT>/<west>,<south>,<east>,<north>/<days>[/<YYYY-MM-DD>]',
            }),
          );
        }
        const [, product, bbox, days, date] = m;
        if (Number(days) < 1 || Number(days) > 10) {
          return send(400, JSON.stringify({ error: 'days must be 1–10' }));
        }
        if (!mapKey) {
          return send(503, JSON.stringify({ error: 'FIRMS_MAP_KEY is not set on the dev server (see .env.example)' }));
        }
        const upstream = `${FIRMS_HOST}/api/area/csv/${encodeURIComponent(mapKey)}/${product}/${bbox}/${days}${date ? `/${date}` : ''}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
        try {
          const r = await fetch(upstream, { signal: controller.signal, headers: { Accept: 'text/csv' } });
          const text = await r.text();
          server.config.logger.info(`[firms proxy] ${product} ${bbox} ${days}d -> ${r.status} (${text.length} bytes)`);
          send(r.status, text, r.headers.get('content-type') || 'text/csv; charset=utf-8');
        } catch (err) {
          server.config.logger.warn(`[firms proxy] upstream failed: ${err?.message ?? err}`);
          send(502, JSON.stringify({ error: `FIRMS upstream request failed: ${err?.name === 'AbortError' ? 'timeout' : err?.message ?? err}` }));
        } finally {
          clearTimeout(timer);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Third argument '' loads every variable from .env files into this object
  // for the config only; Vite still exposes just VITE_* to client code.
  const env = loadEnv(mode, process.cwd(), '');
  const mapKey = process.env.FIRMS_MAP_KEY || env.FIRMS_MAP_KEY || '';

  return {
    plugins: [cesium(), firmsDevProxy(mapKey)],
    server: {
      port: 5173,
      host: true,
    },
  };
});
