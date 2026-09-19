// ---------------------------------------------------------------------------
// Destination posters. The project ships no photographs, so every site gets a
// small flat-colour SVG scene drawn here: a sky, a sun or moon, and the
// landmark in silhouette. The same drawing fills the big preview and the
// filmstrip tile (it is cropped, never stretched).
// ---------------------------------------------------------------------------

const W = 800;
const H = 450;

// Deterministic scatter, so stars and city lights don't move between renders.
function scatter(count, seed, x0, x1, y0, y1) {
  const points = [];
  let s = seed;
  const next = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < count; i++) points.push([x0 + next() * (x1 - x0), y0 + next() * (y1 - y0), next()]);
  return points;
}

function dots(points, fill, size = 1.4) {
  return points
    .map(([x, y, r]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.5 + r * size).toFixed(2)}" fill="${fill}" opacity="${(0.35 + r * 0.65).toFixed(2)}"/>`)
    .join('');
}

function treeLine(x0, x1, y, fill, seed) {
  return scatter(Math.round((x1 - x0) / 13), seed, x0, x1, y - 4, y + 3)
    .map(([x, cy, r]) => `<circle cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(8 + r * 9).toFixed(1)}" fill="${fill}"/>`)
    .join('');
}

function waterLines(y0, y1, stroke, seed) {
  return scatter(26, seed, 0, W, y0, y1)
    .map(([x, y, r]) => `<path d="M${x.toFixed(0)},${y.toFixed(0)}h${(20 + r * 70).toFixed(0)}" stroke="${stroke}" stroke-width="1.5" opacity="${(0.12 + r * 0.3).toFixed(2)}"/>`)
    .join('');
}

const SCENES = {
  // Gilman Hall and its clock tower, at dusk.
  jhu: {
    sky: ['#0d1b33', '#3d4a6b', '#e0955c'],
    sun: { x: 610, y: 318, r: 46, fill: '#ffd9a0' },
    draw: () => `
      <g fill="#23344d">${treeLine(0, 800, 322, '#23344d', 11)}</g>
      <g fill="#0a101d">
        <path d="M188,290h424l-18,-20h-388z"/>
        <rect x="200" y="288" width="400" height="62"/>
        <path d="M330,264h140l-70,-28z"/>
        <rect x="340" y="262" width="120" height="88"/>
        <rect x="374" y="200" width="52" height="40"/>
        <rect x="382" y="160" width="36" height="42"/>
        <path d="M380,162q20,-44 40,0z"/>
        <rect x="398.5" y="104" width="3" height="40"/>
      </g>
      <circle cx="400" cy="182" r="9" fill="#ffd9a0"/>
      <g fill="#e0955c" opacity="0.75">
        ${[350, 370, 390, 410, 430, 450].map((x) => `<rect x="${x - 3}" y="272" width="5" height="74"/>`).join('')}
      </g>
      <g fill="#ffd9a0" opacity="0.8">
        ${[216, 244, 272, 300, 488, 516, 544, 572].map((x) => `<rect x="${x}" y="304" width="9" height="16"/>`).join('')}
      </g>
      <rect y="346" width="800" height="104" fill="#070b14"/>
      <g fill="#0a101d">${treeLine(0, 180, 350, '#0a101d', 5)}${treeLine(620, 800, 350, '#0a101d', 8)}</g>`,
  },

  // Liberty from the harbor, lower Manhattan behind her.
  'statue-of-liberty': {
    sky: ['#0a2438', '#2f6f7d', '#f4b877'],
    sun: { x: 210, y: 300, r: 54, fill: '#ffe2ad' },
    draw: () => `
      <g fill="#1f4f5e">
        ${[[520, 262, 26], [550, 236, 22], [576, 270, 30], [610, 214, 20], [634, 250, 28], [666, 228, 24], [694, 266, 30], [728, 244, 22], [754, 276, 46], [0, 296, 60], [64, 306, 50]]
          .map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="${346 - y}"/>`)
          .join('')}
        <path d="M618,214l2,-34l2,34z"/>
      </g>
      <rect y="344" width="800" height="106" fill="#0b2c3a"/>
      ${waterLines(352, 440, '#f4b877', 3)}
      <g fill="#07181f">
        <path d="M250,366l28,-22h244l28,22z"/>
        <path d="M352,346h96l-12,-28h-72z"/>
        <path d="M368,320h64l-7,-62h-50z"/>
      </g>
      <g fill="#58b3a0">
        <path d="M377,258h46l-5,-78q-4,-22 -18,-24q-14,2 -18,24z"/>
        <circle cx="400" cy="146" r="10"/>
        <path d="M390,140l-13,-13l16,8l-4,-19l9,17l2,-21l2,21l9,-17l-4,19l16,-8l-13,13z"/>
        <path d="M384,176l-9,-6l-7,-74l10,-2l14,66z"/>
        <path d="M366,96h16l-2,-10h-12z"/>
        <path d="M414,186l16,6l-3,28l-15,-5z"/>
      </g>
      <path d="M374,86q-10,-14 0,-30q10,16 0,30z" fill="#ffd27a"/>`,
  },

  // The Monument over the Reflecting Pool, the Capitol closing the axis.
  'national-mall': {
    sky: ['#1f1638', '#7a4a7d', '#f7b0a1'],
    sun: { x: 400, y: 300, r: 70, fill: '#ffe6cf' },
    draw: () => `
      <g fill="#3a2650">
        <rect x="590" y="318" width="140" height="26"/>
        <rect x="630" y="306" width="60" height="14"/>
        <rect x="644" y="288" width="32" height="20"/>
        <path d="M642,290q18,-34 36,0z"/>
        <rect x="659" y="256" width="2" height="16"/>
      </g>
      <g>${treeLine(0, 350, 338, '#2a1a3c', 21)}${treeLine(450, 800, 338, '#2a1a3c', 22)}</g>
      <rect y="344" width="800" height="106" fill="#130c1f"/>
      <path d="M382,350h36l70,100h-176z" fill="#f7b0a1" opacity="0.55"/>
      <path d="M394,350h12l-4,100h-4z" fill="#130c1f" opacity="0.6"/>
      <path d="M389,350h22l-5,-238l-6,-16l-6,16z" fill="#0d0816"/>
      <path d="M400,96l6,16l5,238h-11z" fill="#3a2650" opacity="0.55"/>
      <g fill="#0d0816">${treeLine(0, 300, 372, '#0d0816', 31)}${treeLine(500, 800, 372, '#0d0816', 32)}</g>`,
  },

  // The bridge side-on across the strait, fog pouring under the deck.
  'golden-gate': {
    sky: ['#102a44', '#4d7a94', '#f8c891'],
    sun: { x: 400, y: 250, r: 60, fill: '#fff0cf' },
    draw: () => {
      const cable = (t) => 125 * (1 - t) ** 2 + 2 * 465 * t * (1 - t) + 125 * t ** 2;
      let hangers = '';
      for (let x = 265; x < 550; x += 15) hangers += `<path d="M${x},${cable((x - 250) / 300).toFixed(1)}V300"/>`;
      for (let x = 30; x < 250; x += 15) {
        const t = (250 - x) / 270;
        const y = 125 * (1 - t) ** 2 + 2 * 250 * t * (1 - t) + 292 * t ** 2;
        hangers += `<path d="M${x},${y.toFixed(1)}V300"/><path d="M${800 - x},${y.toFixed(1)}V300"/>`;
      }
      const tower = (x) => `
        <rect x="${x - 12}" y="112" width="7" height="268"/><rect x="${x + 5}" y="112" width="7" height="268"/>
        ${[116, 150, 192, 242].map((y) => `<rect x="${x - 12}" y="${y}" width="24" height="9"/>`).join('')}
        <rect x="${x - 15}" y="300" width="30" height="12"/>`;
      return `
        <path d="M0,450V262l70,-18l80,30l70,44l50,56h-270z" fill="#1d3a4f"/>
        <path d="M800,450V300l-70,8l-80,34l-50,32h200z" fill="#1d3a4f"/>
        <rect y="372" width="800" height="78" fill="#0c2233"/>
        ${waterLines(380, 445, '#f8c891', 7)}
        <g stroke="#e0492c" stroke-width="1" opacity="0.8">${hangers}</g>
        <g fill="none" stroke="#e0492c" stroke-width="3.5">
          <path d="M250,125Q400,465 550,125"/><path d="M250,125Q120,250 -20,292"/><path d="M550,125Q680,250 820,292"/>
        </g>
        <g fill="#e0492c">${tower(250)}${tower(550)}<rect x="0" y="298" width="800" height="7"/></g>
        <rect x="0" y="305" width="800" height="3" fill="#8f2a18"/>
        <g fill="#fff4e0">
          <rect x="-40" y="338" width="380" height="30" rx="15" opacity="0.2"/>
          <rect x="200" y="352" width="460" height="34" rx="17" opacity="0.26"/>
          <rect x="520" y="330" width="340" height="28" rx="14" opacity="0.18"/>
          <rect x="60" y="376" width="300" height="24" rx="12" opacity="0.16"/>
        </g>`;
    },
  },

  // Layered buttes falling away to the Colorado.
  'grand-canyon': {
    sky: ['#331530', '#9c4a4f', '#f9b872'],
    sun: { x: 560, y: 215, r: 50, fill: '#ffe3b0' },
    draw: () => `
      <path d="M0,262h90l20,-22h90l15,16h115l20,-26h100l20,20h130l20,-16h100l20,20h60V450H0z" fill="#cf6f4c"/>
      <path d="M0,302h60l20,-26h90l20,30h90l20,-20h80l15,26h105l20,-32h120l20,22h140V450H0z" fill="#a4452f"/>
      <g stroke="#cf6f4c" stroke-width="1.5" opacity="0.45"><path d="M80,288h90M300,296h80M520,292h120M0,318h800"/></g>
      <path d="M0,352h120l20,-30h110l25,40h85l40,44l40,-44h100l20,-30h130l20,26h90V450H0z" fill="#6c2925"/>
      <g stroke="#a4452f" stroke-width="1.5" opacity="0.5"><path d="M140,336h110M560,344h130M0,376h330M470,378h330"/></g>
      <path d="M400,408q-10,22 8,42" fill="none" stroke="#ffe3b0" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M0,408h190l70,20l80,22H0z" fill="#21090f"/>
      <path d="M800,398h-150l-70,26l-60,26h280z" fill="#21090f"/>
      <path d="M96,408v-26m-7,10h14m-7,-4v-8" stroke="#21090f" stroke-width="3" fill="none"/>`,
  },

  // Pacific Park's wheel and coaster at sunset.
  'santa-monica-pier': {
    sky: ['#1b1046', '#a1367a', '#ff9466'],
    sun: { x: 660, y: 332, r: 58, fill: '#ffe08a' },
    draw: () => {
      let spokes = '';
      let cars = '';
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * 2 * Math.PI;
        const x = 430 + Math.cos(a) * 78;
        const y = 212 + Math.sin(a) * 78;
        spokes += `<path d="M430,212L${x.toFixed(1)},${y.toFixed(1)}"/>`;
        cars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5"/>`;
      }
      let piles = '';
      for (let x = 8; x < 640; x += 22) piles += `<rect x="${x}" y="308" width="4" height="${44 + (x % 3) * 4}"/>`;
      return `
        <rect y="332" width="800" height="118" fill="#1a0d3a"/>
        ${waterLines(340, 445, '#ff9466', 13)}
        <g fill="#ffe08a" opacity="0.5">
          <rect x="620" y="344" width="80" height="3"/><rect x="632" y="356" width="56" height="3"/><rect x="644" y="370" width="32" height="3"/>
        </g>
        <g fill="none" stroke="#0e0724" stroke-width="2">${spokes}<circle cx="430" cy="212" r="78" stroke-width="4"/><circle cx="430" cy="212" r="52"/></g>
        <g fill="#ffd27a">${cars}</g>
        <g fill="none" stroke="#0e0724">
          <path d="M430,212L392,300M430,212L468,300" stroke-width="5"/>
          <path d="M150,300Q185,196 232,262T310,250T372,300" stroke-width="4"/>
          <path d="M178,246V300M205,224V300M232,262V300M262,268V300M292,246V300M322,256V300M350,282V300" stroke-width="2"/>
        </g>
        <g fill="#0e0724">
          <circle cx="430" cy="212" r="8"/>
          <rect x="0" y="298" width="640" height="11"/>
          ${piles}
          <path d="M40,298v-26l34,-14l34,14v26z"/>
          <path d="M510,298v-20h70v20zM504,280l41,-16l41,16z"/>
          <path d="M590,298v-34h3v34zM618,298v-34h3v34z"/>
        </g>
        <g fill="#ffd27a"><circle cx="591.5" cy="262" r="3"/><circle cx="619.5" cy="262" r="3"/><rect x="66" y="278" width="16" height="12"/></g>`;
    },
  },

  // The domes on their hill, Los Angeles glittering underneath.
  'griffith-observatory': {
    sky: ['#070b24', '#2a2460', '#8a4f9c'],
    sun: { x: 640, y: 110, r: 26, fill: '#f4ecff' },
    draw: () => `
      ${dots(scatter(90, 17, 0, 800, 0, 270), '#ffffff', 1.1)}
      <rect y="372" width="800" height="78" fill="#0b0a1f"/>
      ${dots(scatter(170, 29, 0, 800, 376, 448), '#ffc46b', 1.2)}
      <path d="M0,450V436Q200,340 400,324Q600,340 800,436V450z" fill="#05040f"/>
      <g fill="#ece3d0">
        <rect x="284" y="292" width="232" height="34"/>
        <rect x="362" y="268" width="76" height="58"/>
        <rect x="284" y="280" width="36" height="14"/><rect x="480" y="280" width="36" height="14"/>
      </g>
      <g fill="#b9ad97">
        ${[300, 322, 344, 450, 472, 494].map((x) => `<rect x="${x}" y="300" width="6" height="26"/>`).join('')}
        <rect x="392" y="290" width="16" height="36"/>
      </g>
      <g fill="#3b2f5c" stroke="#8a4f9c" stroke-width="1.5">
        <path d="M358,268q42,-66 84,0z"/><path d="M282,280q20,-32 40,0z"/><path d="M478,280q20,-32 40,0z"/>
      </g>
      <path d="M397,326h6l-1.5,-24h-3z" fill="#ece3d0"/>`,
  },
};

let artCount = 0;

/** An SVG poster for the site, cropped to fill whatever box it is put in. */
export function siteArt(id) {
  const scene = SCENES[id] ?? SCENES.jhu;
  const uid = `site-art-${artCount++}`;
  const [top, mid, low] = scene.sky;
  const { x, y, r, fill } = scene.sun;
  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" focusable="false">
      <defs>
        <linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${top}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="0.82" stop-color="${low}"/>
        </linearGradient>
        <radialGradient id="${uid}-glow">
          <stop offset="0" stop-color="${fill}" stop-opacity="0.55"/><stop offset="1" stop-color="${fill}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#${uid}-sky)"/>
      <circle cx="${x}" cy="${y}" r="${r * 3.2}" fill="url(#${uid}-glow)"/>
      <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>
      ${scene.draw()}
    </svg>`;
}
