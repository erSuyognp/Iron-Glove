import { isGloveConnected, hasWebSerial, readGlove, readGloveAxes, setGloveHandler } from '../input/glove.js';
import { readAxes, isDown } from '../input/keyboard.js';
import { sfx } from '../audio/sound.js';

// ---------------------------------------------------------------------------
// The flight tutorial (H, or the HUD's TUTORIAL button): a short coached
// lesson in flying the suit, for whoever is on camera.
//
//   our own suit   -> GLOVE: where the palm has to face, and how to tip it
//   a phone pilot  -> PHONE: how to tip the phone
//   KEYS is the keyboard, and what our own suit gets without Web Serial
//
// So the pilot gets the glove lesson from their own view, and V (onto the
// judge's suit) turns it into the phone lesson. The tabs pick one by hand.
//
// The game keeps flying underneath. While the device being taught is live the
// picture mirrors it (the needle is the glove's roll, the phone tips as the
// judge's does), a step is ticked off by doing it, and the lesson moves on by
// itself, so it can be followed with both hands busy. With nothing connected
// the picture plays the pose as a demo and NEXT steps through. Nothing in here
// feeds back into the flight.
// ---------------------------------------------------------------------------

const HOLD_MS = 700; // a pose has to be held this long to count
const DWELL_MS = 3500; // a step stays up at least this long, however fast it was done
const DONE_PAUSE_MS = 1100; // the beat between the tick and the next step
const DEMO_PERIOD_S = 3.4; // one demo loop: ease in, hold, ease out, rest
const FOLLOW = 0.3; // how fast the picture chases a live reading (per frame at 60 fps)

// Where the glove's roll lobes sit and what trips its gestures. Kept in step
// with input/glove.js, which keeps these to itself.
const GLOVE = { climb: 160, dive: 0, thrust: -120, hover: 80, zoneHalf: 40, punchG: 1.5, flickG: 2.5 };
const G_SCALE = 4; // g at the far end of the punch / flick bars
// The phone's tilt feel, in degrees. Kept in step with phone-controller/index.html.
const PHONE = { deadzone: 5, full: 28, diveFull: 52 };

const DONE_LINE = 'That covers it. The sky is yours.';

const CHAPTERS = {
  glove: {
    offline: 'GLOVE OFFLINE · CONNECT GLOVE TO TRY EACH POSE LIVE',
    steps: [
      {
        title: 'PALM DOWN · CLIMB',
        text: 'Hold your gloved hand out flat, palm to the ground. The needle is your palm: park it in the CLIMB zone (roll 160°) and the suit rises.',
        say: 'Flight school, glove edition. Palm flat to the ground, and we climb.',
        cue: 'PALM TO THE GROUND · HOLD IT',
        view: 'dial',
        zone: 'climb',
        from: GLOVE.hover,
        axis: 'climb',
        check: (i) => i.climb >= 0.6,
      },
      {
        title: 'TURN THE PALM · FLY FORWARD',
        text: 'Turn your hand until the needle sits in the gold THRUST zone: roll −120°, about 60° round from palm-down. Deeper in is more throttle; at the HOVER mark the suit stops.',
        say: 'Now turn your hand until the needle sits in the gold. That is forward thrust.',
        cue: 'NEEDLE INTO THE GOLD · HOLD IT',
        view: 'dial',
        zone: 'thrust',
        from: GLOVE.climb,
        axis: 'throttle',
        check: (i) => i.throttle >= 0.6,
      },
      {
        title: 'PALM UP · NOSE DIVE',
        text: 'Turn your palm to the sky (roll 0°) and the suit goes head-down and fast. Ease into the pose for a shallow descent; turn back out of it to pull up.',
        say: 'Palm to the sky for a nose dive. Ease into it, unless you are fond of the ground.',
        cue: 'PALM TO THE SKY · HOLD IT',
        view: 'dial',
        zone: 'dive',
        from: GLOVE.thrust,
        axis: 'dive',
        check: (i) => i.dive >= 0.6,
      },
      {
        title: 'TIP THE GLOVE · TURN',
        text: 'Tipping the glove steers. Pitch it up and the suit banks left, pitch it down and it banks right. The first 8° are a dead zone; 45° is a full-rate turn.',
        say: 'Tip the glove to steer. The bar shows which way I think you mean.',
        cue: 'TIP IT UNTIL THE SUIT BANKS',
        view: 'turn',
        axis: 'yaw',
        check: (i) => Math.abs(i.yaw) >= 0.35,
      },
      {
        title: 'PUNCH & FLICK · WEAPONS',
        text: 'A sharp punch fires the repulsor blast, or the water cannon on a fire mission. With a drone LOCKED, a hard flick of the hand launches a missile. Shift on the keyboard still boosts.',
        say: 'Punch for a repulsor blast. With a drone locked, flick your hand to launch a missile.',
        cue: 'THROW A PUNCH',
        view: 'weapons',
        axis: 'boost',
        hold: 0,
        check: (i) => i.punch >= GLOVE.punchG || i.flick >= GLOVE.flickG,
      },
    ],
  },
  phone: {
    offline: 'NO PHONE PILOT YET · TAP ACTIVATE SUIT ON THE PHONE',
    steps: [
      {
        title: 'HOLD IT LEVEL · HOVER',
        text: 'Hold the phone flat in front of you, screen up, and tap ACTIVATE SUIT. However you hold it at that moment is neutral: keep it there and the suit hovers. ⊕ CALIBRATE re-centres it.',
        say: 'Flight school, phone edition. Hold it level and still. However you hold it when you activate is neutral.',
        cue: 'HOLD IT STILL',
        tilt: { fwd: 0, right: 0 },
        hold: 1200,
        check: (i) => !i.throttle && !i.yaw && !i.climb && !i.dive && !i.boost,
      },
      {
        title: 'TIP FORWARD · FLY',
        text: 'Tip the top edge of the phone away from you. 5° wakes the jets; 28° is full thrust. Bring it level again and the suit coasts to a hover.',
        say: 'Tip the top edge away from you to fly forward.',
        cue: 'TIP THE TOP EDGE AWAY',
        tilt: { fwd: 24, right: 0 },
        axis: 'throttle',
        check: (i) => i.throttle >= 0.5 && !i.dive,
      },
      {
        title: 'TIP FURTHER · NOSE DIVE',
        text: 'Keep tipping past full thrust, from 28° toward 52°, and the suit noses over: head down and fast. Level the phone to pull out.',
        say: 'Tip further still and the suit noses over into a dive.',
        cue: 'KEEP TIPPING FORWARD',
        tilt: { fwd: 50, right: 0 },
        axis: 'dive',
        check: (i) => i.dive >= 0.4,
      },
      {
        title: 'TIP BACK · CLIMB',
        text: 'Tip the top edge back toward you to climb. 28° back is a full-rate climb.',
        say: 'Tip it back toward you to climb.',
        cue: 'TIP THE TOP EDGE TOWARD YOU',
        tilt: { fwd: -24, right: 0 },
        axis: 'climb',
        check: (i) => i.climb >= 0.5,
      },
      {
        title: 'TILT LEFT / RIGHT · TURN',
        text: 'Roll the phone left or right, like a steering wheel lying flat. The suit banks into the turn; 28° is full rate.',
        say: 'Tilt left or right to turn.',
        cue: 'TILT IT TO ONE SIDE',
        tilt: { fwd: 0, right: 24 },
        sway: true,
        axis: 'yaw',
        check: (i) => Math.abs(i.yaw) >= 0.4,
      },
      {
        title: 'BOOST & FIRE',
        text: 'Hold BOOST for the afterburner. Keep a drone in your sights until this screen shows LOCKED, then tap FIRE to launch a missile.',
        say: 'Hold boost for the afterburner. When this screen shows locked, tap fire.',
        cue: 'HOLD BOOST OR TAP FIRE',
        tilt: { fwd: 12, right: 0 },
        buttons: true,
        axis: 'boost',
        hold: 0,
        check(i, memo) {
          memo.shots ??= i.shots;
          return i.boost || i.shots > memo.shots;
        },
      },
    ],
  },
  keys: {
    steps: [
      {
        title: 'THRUST & TURN',
        text: 'W is thrust; S brakes and backs the suit up. A / D, or ← / →, turn it. Let go of everything and the suit hovers in place.',
        say: 'W for thrust, S to brake, A and D to turn.',
        cue: 'HOLD W',
        caps: ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight'],
        axis: 'throttle',
        check: (i) => i.throttle > 0,
      },
      {
        title: 'CLIMB, DIVE & ROLL',
        text: '↑ climbs and ↓ descends. Q / E barrel-roll the suit, which levels itself when you let go.',
        say: 'Arrow up to climb, arrow down to descend. Q and E roll the suit.',
        cue: 'HOLD ↑ OR ↓',
        caps: ['ArrowUp', 'ArrowDown', 'KeyQ', 'KeyE'],
        axis: 'climb',
        check: (i) => i.climb > 0 || i.dive > 0,
      },
      {
        title: 'BOOST & WEAPONS',
        text: 'Shift, or Space, is the afterburner. With a drone LOCKED, Space launches a missile instead. F sprays water on a fire mission, R resets the suit, V takes another pilot’s view.',
        say: 'Shift boosts. Space fires once a drone is locked.',
        cue: 'HOLD SHIFT',
        caps: ['ShiftLeft', 'Space', 'KeyF', 'KeyR'],
        axis: 'boost',
        check: (i) => i.boost,
      },
    ],
  },
};

const CHIPS = [
  ['throttle', 'THRUST'],
  ['yaw', 'TURN'],
  ['climb', 'CLIMB'],
  ['dive', 'DIVE'],
  ['boost', 'BOOST'],
];

// ---- Small maths ----

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

const ease = (x) => x * x * (3 - 2 * x);

// 0..1 over one demo loop: ease in, hold, ease out, rest.
function envelope(t) {
  const p = (t % DEMO_PERIOD_S) / DEMO_PERIOD_S;
  if (p < 0.3) return ease(p / 0.3);
  if (p < 0.65) return 1;
  if (p < 0.9) return 1 - ease((p - 0.65) / 0.25);
  return 0;
}

// A per-frame follow factor tuned at 60 fps, remapped for the actual dt.
function follow(dt) {
  return 1 - Math.pow(1 - FOLLOW, dt * 60);
}

// The tilt that would have produced a phone's axes, in degrees.
function phoneTilt(c) {
  const span = PHONE.full - PHONE.deadzone;
  let fwd = 0;
  if (c.dive > 0) fwd = PHONE.full + c.dive * (PHONE.diveFull - PHONE.full);
  else if (c.throttle > 0) fwd = PHONE.deadzone + c.throttle * span;
  else if (c.climb > 0) fwd = -(PHONE.deadzone + c.climb * span);
  const right = c.yaw ? Math.sign(c.yaw) * (PHONE.deadzone + Math.abs(c.yaw) * span) : 0;
  return { fwd, right };
}

// ---- The pictures ----

const DIAL = { cx: 120, cy: 112, r: 72 };

// A point on the dial: degrees clockwise from the top, like the needle.
function onDial(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [(DIAL.cx + r * Math.sin(a)).toFixed(1), (DIAL.cy - r * Math.cos(a)).toFixed(1)];
}

function zoneArc(name, centre) {
  const from = onDial(centre - GLOVE.zoneHalf, DIAL.r).join(' ');
  const to = onDial(centre + GLOVE.zoneHalf, DIAL.r).join(' ');
  return `<path class="tut-zone" data-zone="${name}" d="M ${from} A ${DIAL.r} ${DIAL.r} 0 0 1 ${to}" />`;
}

// A radial mark across the ring, `half` either side of it.
function dialMark(cls, deg, half) {
  const [x1, y1] = onDial(deg, DIAL.r - half);
  const [x2, y2] = onDial(deg, DIAL.r + half);
  return `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
}

function dialLabel(text, deg, r, anchor = 'middle') {
  const [x, y] = onDial(deg, r);
  return `<text class="tut-dial-label" x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle">${text}</text>`;
}

// The glove: a dial of where the palm faces (up the dial is the sky), a bank
// glyph for steering, and two g bars for the gestures. One shows at a time.
function gloveStage() {
  let ticks = '';
  for (let d = 0; d < 360; d += 30) ticks += dialMark('tut-dial-tick', d, 5);
  return `
    <div class="tut-view" data-view="dial">
      <svg class="tut-dial" viewBox="0 0 240 224">
        <circle class="tut-dial-ring" cx="${DIAL.cx}" cy="${DIAL.cy}" r="${DIAL.r}" />
        ${ticks}
        ${zoneArc('dive', GLOVE.dive)}
        ${zoneArc('climb', GLOVE.climb)}
        ${zoneArc('thrust', GLOVE.thrust)}
        ${dialMark('tut-dial-hover', GLOVE.hover, 9)}
        ${dialLabel('DIVE · PALM UP', GLOVE.dive, DIAL.r + 20)}
        ${dialLabel('CLIMB · PALM DOWN', 168, DIAL.r + 24)}
        ${dialLabel('THRUST', GLOVE.thrust, DIAL.r + 27)}
        ${dialLabel('HOVER', GLOVE.hover, DIAL.r + 14, 'start')}
        <g data-ref="needle">
          <line class="tut-needle-beam" x1="${DIAL.cx}" y1="${DIAL.cy - 8}" x2="${DIAL.cx}" y2="${DIAL.cy - DIAL.r + 16}" />
          <path class="tut-needle-tip" d="M ${DIAL.cx} ${DIAL.cy - DIAL.r + 6} l -6 11 h 12 z" />
          <rect class="tut-needle-palm" x="${DIAL.cx - 25}" y="${DIAL.cy - 4}" width="50" height="10" rx="5" />
          <circle class="tut-needle-core" cx="${DIAL.cx}" cy="${DIAL.cy - 7}" r="4.5" />
        </g>
      </svg>
    </div>
    <div class="tut-view" data-view="turn">
      <svg class="tut-bank" viewBox="0 0 240 130">
        <text class="tut-dial-label" x="16" y="18">◀ PITCH UP</text>
        <text class="tut-dial-label" x="224" y="18" text-anchor="end">PITCH DOWN ▶</text>
        <line class="tut-bank-horizon" x1="24" y1="78" x2="216" y2="78" />
        <g data-ref="wing">
          <path class="tut-bank-wing" d="M 52 78 H 104 L 120 94 L 136 78 H 188" />
          <circle class="tut-needle-core" cx="120" cy="78" r="4" />
        </g>
      </svg>
      <div class="tut-bar">
        <span>LEFT</span>
        <div class="tut-bar-track"><i class="tut-bar-dead"></i><b data-ref="turnMark"></b></div>
        <span>RIGHT</span>
      </div>
    </div>
    <div class="tut-view" data-view="weapons">
      <div class="tut-g">
        <div class="tut-g-head"><b>PUNCH</b><span>REPULSOR · WATER</span></div>
        <div class="tut-g-track"><i style="left: ${(GLOVE.punchG / G_SCALE) * 100}%"></i><b data-ref="punch"></b></div>
        <div class="tut-g-head"><b>FLICK</b><span>MISSILE, ONCE LOCKED</span></div>
        <div class="tut-g-track"><i style="left: ${(GLOVE.flickG / G_SCALE) * 100}%"></i><b data-ref="flick"></b></div>
        <div class="tut-g-scale"><span>0 g</span><span>${GLOVE.punchG} g</span><span>${GLOVE.flickG} g</span><span>${G_SCALE} g</span></div>
      </div>
    </div>
    <div class="tut-readout" data-ref="readout"></div>`;
}

// The phone, seen as its pilot sees it: from above, top edge away. The dashed
// outline stays level, so the tilt reads against it.
function phoneStage() {
  return `
    <div class="tut-phone-scene">
      <div class="tut-phone-level"></div>
      <div class="tut-phone" data-ref="phone">
        <div class="tut-phone-face">
          <i class="tut-phone-notch"></i>
          <i class="tut-phone-reticle"></i>
          <span class="tut-phone-pad"><b data-ref="padBoost">BOOST</b><b data-ref="padFire" class="fire">FIRE</b></span>
        </div>
      </div>
      <span class="tut-phone-far">AWAY FROM YOU</span>
      <span class="tut-phone-near">TOWARD YOU</span>
    </div>
    <div class="tut-readout" data-ref="readout"></div>`;
}

function cap(codes, label, cls = '') {
  return `<span class="tut-cap ${cls}" data-codes="${codes}">${label}</span>`;
}

function keysStage() {
  return `
    <div class="tut-keys">
      <div class="tut-keys-cluster">
        <div class="tut-keys-grid">
          ${cap('KeyQ', 'Q')}${cap('KeyW', 'W')}${cap('KeyE', 'E')}
          ${cap('KeyA', 'A')}${cap('KeyS', 'S')}${cap('KeyD', 'D')}
        </div>
        <div class="tut-keys-grid">
          <span></span>${cap('ArrowUp', '↑')}<span></span>
          ${cap('ArrowLeft', '←')}${cap('ArrowDown', '↓')}${cap('ArrowRight', '→')}
        </div>
      </div>
      <div class="tut-keys-row">
        ${cap('ShiftLeft ShiftRight', 'SHIFT', 'wide')}${cap('Space', 'SPACE', 'wider')}${cap('KeyF', 'F')}${cap('KeyR', 'R')}
      </div>
    </div>
    <div class="tut-readout" data-ref="readout"></div>`;
}

const STAGES = { glove: gloveStage, phone: phoneStage, keys: keysStage };

/**
 * Wire the tutorial to its button and keys.
 * @param {object} deps
 * @param {(line: string, options?: object) => void} deps.say  JARVIS (hud.js setJarvis)
 * @param {() => string} deps.povName  name of the suit on camera
 * @param {() => object|null} deps.watchedPilot  the remote pilot on camera, or null on our own suit
 * @param {() => object[]} deps.phonePilots  phone pilots in the air
 * @returns {{ open(): void, close(): void, toggle(): void, isOpen(): boolean }}
 */
export function createTutorial({ say, povName, watchedPilot, phonePilots }) {
  const $ = (id) => document.getElementById(id);
  const els = {
    root: $('tutorial'),
    button: $('btn-tutorial'),
    pov: $('tut-pov'),
    tabs: [...document.querySelectorAll('.tut-tab[data-chapter]')],
    close: $('tut-close'),
    stage: $('tut-stage'),
    count: $('tut-count'),
    title: $('tut-title'),
    text: $('tut-text'),
    monitor: $('tut-monitor'),
    status: $('tut-status'),
    statusText: $('tut-status-text'),
    progress: $('tut-progress'),
    back: $('tut-back'),
    next: $('tut-next'),
    nextLabel: $('tut-next-label'),
    dots: $('tut-dots'),
  };
  const inert = { open() {}, close() {}, toggle() {}, isOpen: () => false };
  if (!els.root || !els.stage) return inert;

  const stillMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  let open = false;
  let frame = null;
  let last = 0;
  let followed = null; // the chapter the camera last asked for
  let chapterId = null;
  let index = 0;
  let refs = {}; // the live parts of the current picture
  let caps = [];
  let chips = [];
  let shownAt = 0; // when this step came up
  let heldSince = 0; // since when its pose has been held (0 = not held)
  let done = false;
  let doneAt = 0;
  let memo = {}; // a step's own notes (the FIRE count it started from)
  // The hardest punch / flick since the last frame. A gesture can be a single
  // 20 ms sample, which reading the glove once a frame could miss.
  const peak = { punch: 0, flick: 0 };
  function notePeak(sample) {
    peak.punch = Math.max(peak.punch, Math.abs(sample.ax));
    peak.flick = Math.max(peak.flick, sample.jerk ?? 0);
  }
  // What the picture currently shows, eased toward the reading.
  const shown = { roll: GLOVE.hover, bank: 0, fwd: 0, right: 0, punch: 0, flick: 0, fired: -Infinity };

  // Every per-frame write goes through these: most readouts hold still for many
  // frames, and a write dirties layout even when the value is the same.
  const written = new Map();
  function write(key, value, apply) {
    if (written.get(key) === value) return;
    written.set(key, value);
    apply(value);
  }
  const setText = (key, el, text) => write(key, text, (v) => (el.textContent = v));

  // ---- Who is being taught ----

  // The chapter for the suit on camera.
  function chapterOnCamera() {
    const watched = watchedPilot();
    if (watched) return watched.kind === 'sim' ? 'phone' : watched.mode === 'GLOVE' ? 'glove' : 'keys';
    return isGloveConnected() || hasWebSerial() ? 'glove' : 'keys';
  }

  // The phone pilot to mirror: the one on camera, else the first one airborne.
  function phonePilot() {
    const watched = watchedPilot();
    if (watched?.kind === 'sim') return watched;
    return watched ? null : (phonePilots()[0] ?? null);
  }

  // The live axes of the device a chapter teaches, or null with nothing to read.
  function readInput(id) {
    if (id === 'glove') {
      if (watchedPilot() || !isGloveConnected()) return null;
      const sample = readGlove();
      const axes = readGloveAxes(sample);
      notePeak(sample);
      const gesture = { ...peak };
      peak.punch = peak.flick = 0;
      return {
        throttle: axes.throttle,
        yaw: axes.yaw,
        climb: axes.climb,
        dive: axes.dive,
        boost: readAxes().boost,
        roll: sample.roll,
        pitch: sample.pitch,
        punch: gesture.punch,
        flick: gesture.flick,
      };
    }
    if (id === 'phone') {
      const pilot = phonePilot();
      if (!pilot?.active) return null;
      return { ...pilot.controls, shots: pilot.shots ?? 0, name: pilot.name };
    }
    if (watchedPilot()) return null;
    const keys = readAxes();
    return {
      throttle: keys.throttle,
      yaw: keys.yaw,
      climb: Math.max(0, keys.climb),
      dive: Math.max(0, -keys.climb),
      boost: keys.boost,
    };
  }

  // ---- The pictures, per frame ----

  function paintGlove(step, input, t, dt) {
    write('view', step.view, (v) => (els.stage.dataset.view = v));
    write('zone', step.zone ?? '', (v) => (els.stage.dataset.zone = v)); // the zone this step is after goes gold
    const k = follow(dt);
    const beat = stillMotion ? 1 : envelope(t);
    if (step.view === 'dial') {
      const target = input ? input.roll : step.from + wrapDeg(GLOVE[step.zone] - step.from) * beat;
      shown.roll = wrapDeg(shown.roll + wrapDeg(target - shown.roll) * (input ? k : 1));
      write('needle', shown.roll.toFixed(1), (v) => refs.needle.setAttribute('transform', `rotate(${v} ${DIAL.cx} ${DIAL.cy})`));
      for (const zone of refs.zones) {
        // A zone glows with how hard its lobe is pulling.
        const pull = input ? { climb: input.climb, dive: input.dive, thrust: input.throttle }[zone.dataset.zone] : 0;
        write(`zone:${zone.dataset.zone}`, (0.4 + 0.6 * pull).toFixed(2), (v) => (zone.style.opacity = v));
      }
    } else if (step.view === 'turn') {
      // The glyph banks as the suit does (its visual roll is the glove's pitch, flipped).
      const swing = stillMotion ? 1 : Math.sin((t / DEMO_PERIOD_S) * Math.PI * 2);
      const bank = input ? clamp(-input.pitch, -50, 50) : swing * 32;
      const yaw = input ? input.yaw : clamp((swing * 32) / 45, -1, 1);
      shown.bank += (bank - shown.bank) * (input ? k : 1);
      write('wing', shown.bank.toFixed(1), (v) => refs.wing.setAttribute('transform', `rotate(${v} 120 78)`));
      write('turnMark', `${(50 + yaw * 50).toFixed(1)}%`, (v) => (refs.turnMark.style.left = v));
    } else {
      // The demo throws a punch, then a flick (which a punch also shows up in).
      const p = stillMotion ? 0 : (t % DEMO_PERIOD_S) / DEMO_PERIOD_S;
      const punching = p > 0.2 && p < 0.26;
      const flicking = p > 0.6 && p < 0.66;
      const punch = input ? input.punch : punching ? 2.3 : 0.3;
      const flick = input ? input.flick : flicking ? 3.2 : punching ? 2.4 : 1;
      // Peak-hold: the real thing is over in a frame or two.
      shown.punch = Math.max(punch, shown.punch - dt * 3);
      shown.flick = Math.max(flick, shown.flick - dt * 3);
      for (const name of ['punch', 'flick']) {
        const g = shown[name];
        write(name, `${(clamp(g / G_SCALE, 0, 1) * 100).toFixed(0)}%`, (v) => (refs[name].style.width = v));
        write(`${name}:hot`, g >= GLOVE[`${name}G`], (v) => refs[name].classList.toggle('hot', v));
      }
    }
    const sign = (n) => `${n < 0 ? '−' : '+'}${Math.abs(Math.round(n))}°`;
    const legend = step.view === 'dial' ? 'DEMO · THE ARROW IS YOUR PALM' : 'DEMO';
    setText('readout', refs.readout, input ? `LIVE · ROLL ${sign(input.roll)} · PITCH ${sign(input.pitch)}` : legend);
  }

  function paintPhone(step, input, t, dt) {
    let tilt;
    if (input) {
      tilt = phoneTilt(input);
    } else {
      const beat = stillMotion ? 1 : envelope(t);
      // A turn is shown both ways, one side per loop.
      const side = step.sway && Math.floor(t / DEMO_PERIOD_S) % 2 ? -1 : 1;
      tilt = { fwd: step.tilt.fwd * beat, right: step.tilt.right * beat * side };
    }
    const k = input ? follow(dt) : 1;
    shown.fwd += (tilt.fwd - shown.fwd) * k;
    shown.right += (tilt.right - shown.right) * k;
    write('fwd', `${shown.fwd.toFixed(1)}deg`, (v) => refs.phone.style.setProperty('--fwd', v));
    write('right', `${shown.right.toFixed(1)}deg`, (v) => refs.phone.style.setProperty('--right', v));

    // The pad lights with the real buttons; in the demo it takes turns.
    const demoBeat = !input && step.buttons ? Math.floor((t / DEMO_PERIOD_S) * 2) % 2 : -1;
    if (input && input.shots > (memo.lastShots ?? input.shots)) shown.fired = t;
    if (input) memo.lastShots = input.shots;
    write('padBoost', input ? Boolean(input.boost) : demoBeat === 0, (v) => refs.padBoost.classList.toggle('down', v));
    write('padFire', input ? t - shown.fired < 0.35 : demoBeat === 1, (v) => refs.padFire.classList.toggle('down', v));

    const deg = (n) => `${Math.abs(Math.round(n))}°`;
    const fwd = Math.abs(shown.fwd) < 1 ? 'LEVEL' : `${deg(shown.fwd)} ${shown.fwd > 0 ? 'FORWARD' : 'BACK'}`;
    const side = Math.abs(shown.right) < 1 ? '' : ` · ${deg(shown.right)} ${shown.right > 0 ? 'RIGHT' : 'LEFT'}`;
    setText('readout', refs.readout, input ? `${input.name} · ${fwd}${side}` : 'DEMO');
  }

  function paintKeys(step) {
    for (const el of caps) {
      const codes = el.dataset.codes.split(' ');
      write(`cap:${codes[0]}`, codes.some(isDown), (v) => el.classList.toggle('down', v));
      write(`want:${codes[0]}`, codes.some((c) => step.caps.includes(c)), (v) => el.classList.toggle('target', v));
    }
    setText('readout', refs.readout, watchedPilot() ? 'DEMO' : 'LIVE · PRESS A KEY');
  }

  const PAINT = { glove: paintGlove, phone: paintPhone, keys: paintKeys };

  function paintMonitor(step, input) {
    for (const chip of chips) {
      let value = 0;
      let label = chip.label;
      if (input) {
        const raw = input[chip.axis];
        value = typeof raw === 'boolean' ? Number(raw) : Math.abs(raw || 0);
        if (chip.axis === 'yaw' && raw) label = raw < 0 ? 'TURN L' : 'TURN R';
        if (chip.axis === 'throttle' && raw < 0) label = 'BRAKE';
      }
      write(`chip:${chip.axis}`, `${Math.round(clamp(value, 0, 1) * 100)}%`, (v) => (chip.fill.style.width = v));
      write(`chip:${chip.axis}:label`, label, (v) => (chip.text.textContent = v));
      write(`chip:${chip.axis}:on`, value > 0.05, (v) => chip.el.classList.toggle('on', v));
      write(`chip:${chip.axis}:target`, step.axis === chip.axis, (v) => chip.el.classList.toggle('target', v));
    }
    write('monitor:off', !input, (v) => els.monitor.classList.toggle('off', v));
  }

  // ---- Marking ----

  function setStatus(state, text, progress = 0) {
    write('status', state, (v) => (els.status.dataset.state = v));
    setText('statusText', els.statusText, text);
    write('progress', `${Math.round(progress * 100)}%`, (v) => (els.progress.style.width = v));
  }

  // Why the picture is only a demo.
  function offlineReason() {
    const watched = watchedPilot();
    if (watched && (chapterId !== 'phone' || watched.kind !== 'sim')) return `ON ${watched.name}'S VIEW · DEMO ONLY`;
    return CHAPTERS[chapterId].offline ?? 'DEMO ONLY';
  }

  function grade(step, input, now) {
    if (!input) {
      heldSince = 0;
      if (!done) setStatus('demo', offlineReason());
      return;
    }
    if (done) {
      // Hands-free: once it has been done and read, move on.
      if (now - shownAt >= DWELL_MS && now - doneAt >= DONE_PAUSE_MS) advance();
      return;
    }
    if (!step.check(input, memo)) {
      heldSince = 0;
      setStatus('try', `YOUR TURN · ${step.cue}`);
      return;
    }
    heldSince ||= now;
    const hold = step.hold ?? HOLD_MS;
    const progress = hold ? Math.min(1, (now - heldSince) / hold) : 1;
    if (progress < 1) {
      setStatus('try', 'HOLD IT…', progress);
      return;
    }
    done = true;
    doneAt = now;
    sfx('ring');
    setStatus('done', index === steps().length - 1 ? '✓ GOT IT · THAT IS THE LOT' : '✓ GOT IT', 1);
  }

  // ---- Steps and chapters ----

  const steps = () => CHAPTERS[chapterId].steps;

  function go(to, speak = true) {
    index = clamp(to, 0, steps().length - 1);
    const step = steps()[index];
    shownAt = performance.now();
    heldSince = 0;
    done = false;
    memo = {};
    els.count.textContent = `STEP ${index + 1} / ${steps().length}`;
    els.title.textContent = step.title;
    els.text.textContent = step.text;
    els.back.disabled = index === 0;
    els.nextLabel.textContent = index === steps().length - 1 ? 'FINISH' : 'NEXT';
    els.dots.innerHTML = steps()
      .map((_, i) => `<i class="${i === index ? 'now' : i < index ? 'past' : ''}"></i>`)
      .join('');
    setStatus('demo', '');
    if (speak) say?.(step.say, { urgent: true });
  }

  function advance() {
    if (index < steps().length - 1) {
      sfx('select');
      go(index + 1);
    } else {
      say?.(DONE_LINE, { urgent: true });
      close();
    }
  }

  function showChapter(id) {
    chapterId = id;
    written.clear();
    els.stage.dataset.chapter = id;
    delete els.stage.dataset.view;
    delete els.stage.dataset.zone;
    els.stage.innerHTML = STAGES[id]();
    refs = { zones: [...els.stage.querySelectorAll('.tut-zone')] };
    for (const el of els.stage.querySelectorAll('[data-ref]')) refs[el.dataset.ref] = el;
    caps = [...els.stage.querySelectorAll('.tut-cap')];
    for (const tab of els.tabs) {
      const on = tab.dataset.chapter === id;
      tab.classList.toggle('on', on);
      tab.setAttribute('aria-selected', String(on));
    }
    go(0);
  }

  function tick(now) {
    if (!open) return;
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // The lesson follows the camera: V onto a phone pilot makes it theirs.
    const wanted = chapterOnCamera();
    if (wanted !== followed) {
      followed = wanted;
      if (wanted !== chapterId) showChapter(wanted);
    }
    setText('pov', els.pov, `POV · ${povName()}`);

    const step = steps()[index];
    const input = readInput(chapterId);
    PAINT[chapterId](step, input, now / 1000, dt);
    paintMonitor(step, input);
    grade(step, input, now);
  }

  function openTutorial() {
    if (open) return;
    open = true;
    els.root.hidden = false;
    els.button?.classList.add('live');
    followed = chapterOnCamera();
    showChapter(followed);
    setGloveHandler(notePeak); // every sample, while the lesson is up
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function close() {
    if (!open) return;
    open = false;
    els.root.hidden = true;
    els.button?.classList.remove('live');
    setGloveHandler(null);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  const toggle = () => (open ? close() : openTutorial());

  // ---- Controls ----

  els.monitor.innerHTML = CHIPS.map(([axis, label]) => `<span class="tut-chip" data-axis="${axis}"><i></i><b>${label}</b></span>`).join('');
  chips = [...els.monitor.children].map((el, i) => ({
    el,
    axis: CHIPS[i][0],
    label: CHIPS[i][1],
    fill: el.querySelector('i'),
    text: el.querySelector('b'),
  }));

  // Like the HUD's own buttons: drop focus, or Space (boost) would press it again.
  function onClick(el, handler) {
    el?.addEventListener('click', (e) => {
      e.currentTarget.blur();
      handler(e);
    });
  }
  onClick(els.button, toggle);
  onClick(els.close, close);
  onClick(els.back, () => go(index - 1));
  onClick(els.next, advance);
  for (const tab of els.tabs) onClick(tab, () => tab.dataset.chapter !== chapterId && showChapter(tab.dataset.chapter));

  // Not the arrows: those are flying the suit.
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyH') toggle();
    else if (!open) return;
    else if (e.code === 'Escape') close();
    else if (e.code === 'Enter') advance();
    else if (e.code === 'Backspace') go(index - 1);
  });

  return { open: openTutorial, close, toggle, isOpen: () => open };
}
