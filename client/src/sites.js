// ---------------------------------------------------------------------------
// Flight sites — where in the world the suit flies. The landing page
// (landing/landing.js) offers these; main.js boots the game at the chosen one.
//
// Each site is centred on its landmark. That centre is the origin of the flat
// local frame combat runs in (combat/space.js) and, through activate_mission,
// of the frame the server flies the drones in, so both must use these exact
// numbers. The pilot arrives `approach` metres short of the landmark, facing
// it along `heading`, so the first thing on screen is the thing they came for.
//
// `altitude` is the arrival height above the WGS84 ellipsoid (what Cesium and
// the photogrammetry use, tens of metres off sea level). For the landmarks it is
// a deliberately generous estimate: main.js replaces it with a measured one
// once the ground there has streamed in (settleSite), and too high is the safe
// way to be wrong until then.
// ---------------------------------------------------------------------------

const M_PER_LAT = 111320;
const ARRIVAL_AGL = 140; // m above the ground the pilot arrives at, once measured
// The flight envelope and the drones' altitudes are tuned around Homewood's
// 150 m arrival height; other sites shift them by the difference.
const HOMEWOOD_ALTITUDE = 150;
// Safety floor under the arrival height. The sampled terrain is the real floor;
// this only catches a suit over ground that hasn't streamed in. Homewood is
// flat, but a landmark on a summit or rim has ground far below the arrival point.
const MIN_ALT_BELOW = 1000;
const HOMEWOOD_MIN_ALT_BELOW = 120;
const MAX_ALT_ABOVE = 750;

export const SITES = [
  {
    id: 'jhu',
    name: 'Johns Hopkins University',
    short: 'HOMEWOOD',
    spoken: ['Hopkins', 'Baltimore', 'campus'], // what a pilot might call it out loud (jarvis/assistant.js)
    place: 'Baltimore, Maryland · USA',
    era: 'EST. 1876',
    blurb: 'Home airspace. Keyser Quad, Gilman Hall and the full Homewood campus perimeter.',
    longitude: -76.6205,
    latitude: 39.3299,
    altitude: HOMEWOOD_ALTITUDE,
    heading: 0,
    approach: 0,
    measured: true, // hand-tuned: keep the arrival height as it is
    minAltBelow: HOMEWOOD_MIN_ALT_BELOW,
    // The campus envelope, [longitude, latitude]; other sites fly inside a circle.
    polygon: [
      [-76.6282, 39.3338],
      [-76.6229, 39.3367],
      [-76.6174, 39.3362],
      [-76.6148, 39.3328],
      [-76.6158, 39.3268],
      [-76.6191, 39.3249],
      [-76.6254, 39.3255],
      [-76.6284, 39.3292],
    ],
  },
  {
    id: 'statue-of-liberty',
    name: 'Statue of Liberty',
    short: 'LIBERTY ISLAND',
    spoken: ['Liberty', 'New York'],
    place: 'New York, New York · USA',
    era: '1886',
    blurb: 'Copper and torch over the Upper Bay. Come in off the harbor with Manhattan behind her.',
    longitude: -74.0445,
    latitude: 40.6892,
    altitude: 220,
    heading: 325, // she faces south-east: arrive looking at her, not her back
    approach: 500,
    radius: 1300,
  },
  {
    id: 'national-mall',
    name: 'The National Mall',
    short: 'NATIONAL MALL',
    spoken: ['Washington', 'the Capitol', 'D.C.'],
    place: 'Washington, DC · USA',
    era: '1791',
    blurb: 'Lincoln at your back, the Monument dead ahead and the Capitol dome closing the axis.',
    // Centred on the Washington Monument, which stands 169 m: taller than the
    // arrival height, so the approach keeps well short of it.
    longitude: -77.0353,
    latitude: 38.8895,
    altitude: 240,
    heading: 90,
    approach: 650,
    radius: 1700,
  },
  {
    id: 'golden-gate',
    name: 'Golden Gate Bridge',
    short: 'GOLDEN GATE',
    spoken: ['San Francisco'],
    place: 'San Francisco, California · USA',
    era: '1937',
    blurb: 'International orange across the strait. The towers top out above you: thread them.',
    longitude: -122.4783,
    latitude: 37.8199,
    altitude: 320,
    heading: 300,
    approach: 750,
    radius: 1700,
  },
  {
    id: 'grand-canyon',
    name: 'Grand Canyon',
    short: 'GRAND CANYON',
    spoken: ['canyon', 'Arizona'],
    place: 'South Rim · Arizona, USA',
    era: '6 MILLION YRS',
    blurb: 'Off the South Rim at Mather Point and a mile of open air down to the Colorado.',
    longitude: -112.1077,
    latitude: 36.0617,
    altitude: 2500,
    heading: 0,
    approach: 400,
    radius: 2200,
    minAltBelow: 1700, // the river is ~1400 m under the rim
  },
  {
    id: 'santa-monica-pier',
    name: 'Santa Monica Pier',
    short: 'SANTA MONICA',
    spoken: ['the pier'],
    place: 'Santa Monica, California · USA',
    era: '1909',
    blurb: 'In low off the Pacific: the Ferris wheel, the boardwalk and the end of Route 66.',
    longitude: -118.4986,
    latitude: 34.0086,
    altitude: 220,
    heading: 45,
    approach: 450,
    radius: 1100,
  },
  {
    id: 'griffith-observatory',
    name: 'Griffith Observatory',
    short: 'GRIFFITH',
    spoken: ['observatory', 'Los Angeles', 'Hollywood'],
    place: 'Los Angeles, California · USA',
    era: '1935',
    blurb: 'Three copper domes on the shoulder of Mount Hollywood, with all of Los Angeles below.',
    // Arrive from the high ground to the north: every other side falls away,
    // and an arrival height measured down there is level with the domes.
    longitude: -118.3004,
    latitude: 34.1184,
    altitude: 620,
    heading: 185,
    approach: 400,
    radius: 1200,
  },
];

export function findSite(id) {
  return SITES.find((s) => s.id === id) ?? null;
}

// The site being flown. Filled in by chooseSite before the world boots; every
// module reads it live, so nothing should copy fields out of it at import time.
export const site = {};

function setAltitude(altitude) {
  site.altitude = altitude;
  site.spawn.altitude = altitude;
  site.minAlt = altitude - (site.minAltBelow ?? MIN_ALT_BELOW);
  site.maxAlt = altitude + MAX_ALT_ABOVE;
  site.altOffset = altitude - HOMEWOOD_ALTITUDE;
}

export function chooseSite(id) {
  const chosen = findSite(id) ?? SITES[0];
  for (const key of Object.keys(site)) delete site[key];
  Object.assign(site, chosen);
  site.mPerLat = M_PER_LAT;
  site.mPerLon = M_PER_LAT * Math.cos((chosen.latitude * Math.PI) / 180);

  // Arrive `approach` metres short of the landmark, facing it.
  const h = (chosen.heading * Math.PI) / 180;
  site.spawn = {
    longitude: chosen.longitude - (Math.sin(h) * chosen.approach) / site.mPerLon,
    latitude: chosen.latitude - (Math.cos(h) * chosen.approach) / M_PER_LAT,
    altitude: chosen.altitude,
    heading: chosen.heading,
  };
  setAltitude(chosen.altitude);
  return site;
}

/** The ground under the arrival point has been measured: arrive ARRIVAL_AGL above it. */
export function settleSite(groundHeight) {
  if (site.measured || !Number.isFinite(groundHeight)) return;
  site.measured = true;
  setAltitude(groundHeight + ARRIVAL_AGL);
}

/** The site's flight perimeter as [longitude, latitude] corners. */
export function sitePerimeter(s = site) {
  if (s.polygon) return s.polygon;
  const corners = [];
  const SIDES = 32;
  for (let i = 0; i < SIDES; i++) {
    const a = (i / SIDES) * 2 * Math.PI;
    corners.push([
      s.longitude + (Math.sin(a) * s.radius) / s.mPerLon,
      s.latitude + (Math.cos(a) * s.radius) / s.mPerLat,
    ]);
  }
  return corners;
}
