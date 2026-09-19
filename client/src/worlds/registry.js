// World registry — the one place that knows where a world is and how it
// behaves. main.js reads the active world from here instead of carrying
// JHU-specific literals; adding a world is a new entry in WORLDS, not a new
// conditional in the game loop.
//
// The active world is chosen with `?world=<id>` and fixed for the life of the
// page: switching worlds is a controlled reload, not an in-place teardown of
// the Cesium scene, the Three overlay and the SpacetimeDB link.

// JHU Homewood campus center (Keyser Quad). Also the origin of the combat
// frame (combat/space.js) and the server's spawn (server/src/index.ts), which
// stay at JHU regardless of the active world.
export const JHU_HOMEWOOD = {
  longitude: -76.6205,
  latitude: 39.3299,
  altitude: 150, // meters above ground
};

export const DEFAULT_WORLD_ID = 'jhu';

// Each world:
//   spawn        longitude/latitude/heading plus an altitude. With
//                altitudeMode 'agl' the altitude is metres above the terrain
//                sampled at boot (fallbackAltitude, absolute, if terrain can't
//                be sampled); otherwise it is absolute, as JHU always was.
//   flight       absolute altitude clamps for the flight model.
//   boundary     'homewood' draws the campus perimeter and confines flight to
//                it; null is open flight.
//   environmental  { bbox, firms } for worlds with environmental layers: the
//                data extent and the FIRMS product descriptor (environmental/).
//   features     capability flags. `combat: false` currently only hides the
//                combat HUD: the drone/missile control flow keeps running
//                untouched in the background (the server's drones are at JHU
//                either way). Gating that flow on this flag is a known cleanup
//                item for a later world-capabilities pass.
//   jarvis       world-flavoured lines; `perimeter` is only spoken by worlds
//                with a boundary.
export const WORLDS = [
  {
    id: 'jhu',
    name: 'JHU Homewood',
    category: 'TRAINING',
    description: 'Urban operator training',
    // Top-bar subtitle and browser tab, exactly as the app has always shown them.
    hudLabel: 'HOMEWOOD',
    modeLabel: 'URBAN OPERATOR TRAINING',
    selectorLabel: 'JHU TRAINING',
    title: 'IRON GLOVE — Homewood',
    spawn: { ...JHU_HOMEWOOD, heading: 0 },
    flight: {
      // Campus sits near sea level, so these double as a safety floor and ceiling.
      minAlt: 30,
      maxAlt: 900,
    },
    boundary: 'homewood',
    environmentMode: 'urban',
    imageryMode: 'photorealistic',
    environmentalLayers: [],
    features: { combat: true },
    jarvis: {
      online: 'Suit online. Homewood airspace is clear, sir.',
      perimeter: 'Homewood perimeter engaged. Keeping you inside campus airspace, sir.',
      pilotJoined: (name) =>
        `A second suit has entered Homewood airspace, sir. ${name} is airborne — press V to take their view.`,
    },
  },
  {
    id: 'california-wildfire',
    name: 'California Wildfire Intelligence',
    category: 'ENVIRONMENTAL_INTELLIGENCE',
    description: 'Satellite-informed wildfire observation',
    hudLabel: 'CALIFORNIA WILDFIRE',
    modeLabel: 'ENVIRONMENTAL INTELLIGENCE',
    selectorLabel: 'WILDFIRE INTELLIGENCE',
    title: 'IRON GLOVE — California Wildfire Intelligence',
    // Sierra Nevada, Yosemite region: ~11 km WSW of the densest cluster of
    // NASA FIRMS VIIRS active-fire detections in California for 12–19 Sep 2026
    // (cluster centroid 37.596 N, 119.609 W), heading toward it. Terrain at
    // the spawn is ~1624 m (USGS EPQS), so the fallback puts the suit 150 m
    // over it if Cesium World Terrain can't be sampled at boot.
    spawn: {
      longitude: -119.72,
      latitude: 37.55,
      heading: 60,
      altitude: 150,
      altitudeMode: 'agl',
      fallbackAltitude: 1780,
    },
    flight: {
      minAlt: 30,
      maxAlt: 5000, // the Sierra crest tops out near 4400 m
    },
    boundary: null,
    environmentMode: 'wildfire',
    imageryMode: 'photorealistic',
    environmentalLayers: ['firms'],
    // Data extent and the FIRMS product used for live requests (the area API's
    // source id). The bundled demo dataset is cut to the same bbox.
    environmental: {
      bbox: { west: -124.5, south: 32.5, east: -114.0, north: 42.0 },
      firms: { product: 'VIIRS_SNPP_NRT', instrument: 'VIIRS', label: 'VIIRS 375 m · Suomi NPP · NRT' },
    },
    features: { combat: false },
    jarvis: {
      online: 'Suit online over the Sierra Nevada, sir. Environmental intelligence mode.',
      perimeter: null,
      pilotJoined: (name) =>
        `A second suit has entered California airspace, sir. ${name} is airborne — press V to take their view.`,
    },
  },
];

export function getWorldById(id) {
  return WORLDS.find((w) => w.id === id);
}

// The world this page runs in: `?world=<id>`, falling back to the default when
// the parameter is missing or names a world we don't have.
export function resolveActiveWorld(search = window.location.search) {
  const id = new URLSearchParams(search).get('world');
  return getWorldById(id) ?? getWorldById(DEFAULT_WORLD_ID);
}

// The query string that selects world `id`, keeping every other parameter
// (e.g. ?quality=) as it is. The world selector navigates to this, which
// reloads the page into the new world.
export function withWorldParam(id, search = window.location.search) {
  const params = new URLSearchParams(search);
  params.set('world', id);
  return `?${params.toString()}`;
}
