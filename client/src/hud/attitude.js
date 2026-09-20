// Animated HUD avionics: an artificial horizon / pitch ladder that pitches and
// rolls with the suit, a bank-angle indicator, and a scrolling heading tape.
// Pure SVG so it composites over the Cesium canvas with no extra 3D cost.

const PITCH_PX = 4; // screen px per degree of pitch on the ladder
const HDG_PX = 4; // screen px per degree on the heading tape
const ARC_R = 138; // radius of the bank-angle tick arc

let adiPitch; // inner group translated by pitch
let adiRoll; // outer group rotated by -roll
let htMarks; // heading-tape tick group
let htReadout; // heading numeric readout
let shownTape = ''; // last transform / readout written, to skip no-op DOM writes
let shownReadout = '';

function buildLadder() {
  let s = '';
  // Faint sky / ground wash so the horizon reads at a glance.
  s += `<rect x="-400" y="-3800" width="1200" height="4000" fill="#0091ff" opacity="0.06"/>`;
  s += `<rect x="-400" y="200" width="1200" height="4000" fill="#ff9e2c" opacity="0.06"/>`;

  for (let a = -40; a <= 40; a += 5) {
    const y = 200 - a * PITCH_PX;
    if (a === 0) {
      // Horizon line, full width.
      s += `<line x1="60" y1="${y}" x2="340" y2="${y}" stroke="#6fe3ff" stroke-width="2"/>`;
    } else if (a % 10 === 0) {
      const half = 66;
      s += `<line x1="${200 - half}" y1="${y}" x2="${200 - 22}" y2="${y}" stroke="#6fe3ff" stroke-width="1.5"/>`;
      s += `<line x1="${200 + 22}" y1="${y}" x2="${200 + half}" y2="${y}" stroke="#6fe3ff" stroke-width="1.5"/>`;
      s += `<text x="${200 - half - 6}" y="${y + 4}" fill="#6fe3ff" font-size="11" text-anchor="end" font-family="monospace">${Math.abs(a)}</text>`;
      s += `<text x="${200 + half + 6}" y="${y + 4}" fill="#6fe3ff" font-size="11" text-anchor="start" font-family="monospace">${Math.abs(a)}</text>`;
    } else {
      s += `<line x1="${200 - 34}" y1="${y}" x2="${200 - 22}" y2="${y}" stroke="#6fe3ff" stroke-width="1" opacity="0.7"/>`;
      s += `<line x1="${200 + 22}" y1="${y}" x2="${200 + 34}" y2="${y}" stroke="#6fe3ff" stroke-width="1" opacity="0.7"/>`;
    }
  }
  return s;
}

// Bank-angle ticks arranged on an arc; they rotate with the horizon so the
// fixed top index reads the current roll.
function buildBankArc() {
  let s = '';
  const marks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
  for (const b of marks) {
    const rad = (b * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const outer = ARC_R;
    const inner = ARC_R - (b % 30 === 0 ? 12 : 7);
    const x1 = 200 + outer * sin;
    const y1 = 200 - outer * cos;
    const x2 = 200 + inner * sin;
    const y2 = 200 - inner * cos;
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#8fe9ff" stroke-width="1.5"/>`;
  }
  return s;
}

export function initAttitude() {
  const host = document.getElementById('attitude');
  if (host) {
    host.innerHTML = `
      <svg viewBox="0 0 400 400" width="100%" height="100%">
        <defs>
          <clipPath id="adi-clip"><circle cx="200" cy="200" r="150"/></clipPath>
        </defs>
        <circle cx="200" cy="200" r="150" fill="none" stroke="#6fe3ff" stroke-width="1" opacity="0.35"/>
        <g clip-path="url(#adi-clip)">
          <g id="adi-roll">
            <g id="adi-pitch">${buildLadder()}</g>
            ${buildBankArc()}
          </g>
        </g>
        <!-- Fixed top index for the bank arc -->
        <polygon points="200,54 194,42 206,42" fill="#ffc857"/>
        <!-- Fixed waterline / aircraft reference -->
        <g stroke="#ffc857" stroke-width="2.5" fill="none">
          <line x1="150" y1="200" x2="182" y2="200"/>
          <polyline points="182,200 191,209 200,200 209,209 218,200"/>
          <line x1="218" y1="200" x2="250" y2="200"/>
        </g>
        <circle cx="200" cy="200" r="2.5" fill="#ffc857"/>
      </svg>`;
    adiPitch = document.getElementById('adi-pitch');
    adiRoll = document.getElementById('adi-roll');
  }

  const ht = document.getElementById('heading-tape');
  if (ht) {
    ht.innerHTML = `
      <svg viewBox="0 0 340 48" width="100%" height="100%">
        <g id="ht-marks">${buildHeadingMarks()}</g>
        <polygon points="170,30 164,42 176,42" fill="#ffc857"/>
        <line x1="170" y1="14" x2="170" y2="32" stroke="#ffc857" stroke-width="1.5"/>
        <rect x="150" y="34" width="40" height="14" fill="rgba(10,14,26,0.7)" stroke="#6fe3ff" stroke-width="0.75"/>
        <text id="ht-readout" x="170" y="45" fill="#6fe3ff" font-size="11" text-anchor="middle" font-family="monospace">000</text>
      </svg>`;
    htMarks = document.getElementById('ht-marks');
    htReadout = document.getElementById('ht-readout');
  }
}

// The whole tape, built once: a tick every 5 degrees at x = degrees * HDG_PX,
// running half a window past 0 and 360 so it never shows an end. Scrolling it
// is then a single transform instead of re-parsing the marks as the heading
// changes.
function buildHeadingMarks() {
  let s = '';
  for (let d = -45; d <= 405; d += 5) {
    const x = d * HDG_PX;
    const dd = ((d % 360) + 360) % 360;
    if (dd % 10 === 0) {
      s += `<line x1="${x}" y1="30" x2="${x}" y2="16" stroke="#6fe3ff" stroke-width="1.5"/>`;
      let label;
      if (dd === 0) label = 'N';
      else if (dd === 90) label = 'E';
      else if (dd === 180) label = 'S';
      else if (dd === 270) label = 'W';
      else label = String(dd / 10).padStart(2, '0');
      s += `<text x="${x}" y="12" fill="#6fe3ff" font-size="10" text-anchor="middle" font-family="monospace">${label}</text>`;
    } else {
      s += `<line x1="${x}" y1="30" x2="${x}" y2="23" stroke="#6fe3ff" stroke-width="1" opacity="0.6"/>`;
    }
  }
  return s;
}

export function updateAttitude(pitch, roll, heading) {
  if (adiPitch) adiPitch.setAttribute('transform', `translate(0 ${(pitch * PITCH_PX).toFixed(2)})`);
  if (adiRoll) adiRoll.setAttribute('transform', `rotate(${(-roll).toFixed(2)} 200 200)`);

  // Heading tape: slide the prebuilt marks under the fixed centre index (x = 170).
  const hdg = ((heading % 360) + 360) % 360;
  const tape = `translate(${(170 - hdg * HDG_PX).toFixed(1)} 0)`;
  if (htMarks && tape !== shownTape) {
    shownTape = tape;
    htMarks.setAttribute('transform', tape);
  }
  const readout = String(Math.round(hdg) % 360).padStart(3, '0');
  if (htReadout && readout !== shownReadout) {
    shownReadout = readout;
    htReadout.textContent = readout;
  }
}
