// Shove Off: one fighter's movement for one tick, shared by the browser (local
// play and online prediction) and the room server (authority). Everything one
// player's own input decides lives here; anything involving both players or the
// floe (hits, clashes, ring-outs, sinking tiles) is in rules.js.
//
// Keep this file pure and deterministic: no DOM, no Date.now(), no Math.random(),
// and only + - * /, comparisons, Math.sqrt and Math.round in the step, because a
// Safari client and a Node server must compute identical numbers. Values snap to
// a 1/8 grid after every step (facing to 1/256), so replays are exact.
//
// The sim.js contract the netcode relies on (js/net/session.js):
//   TUNING.tickHz, TUNING.snapshotHz, TUNING.inputSendHz
//   stepPlayer(self, input) -> new self       one tick of one fighter
//   isNeutral(input), atRest(self)            a neutral input at rest changes nothing
//   encodeInput / sanitizeInput               [seq, mx, my, b], validated on the server
//   encodeSelf / decodeSelf                   the fighter's whole state
//   encodeRemote                              what the other player sees

export const TUNING = {
  // Network and tick (the server and local play run the same 60 Hz step)
  tickHz: 60,
  snapshotHz: 30,
  inputSendHz: 30,
  maxInputsPerTick: 2,
  inputBurst: 30,
  maxQueuedInputs: 64,
  graceMs: 20000,

  // Body
  radius: 26,

  // Movement on ice
  accel: 1400, // units/s^2 (1000-2000)
  maxSpeed: 260, // self-propelled cap, units/s (200-320)
  iceDamp: 3.0, // per second (2-5): low is slidey
  restSpeed: 6, // below this with no input, a fighter stops dead, so rest is reachable

  // Charge and dash
  chargeMaxMs: 700, // (500-900)
  chargeSlow: 0.45, // speed cap while charging (0.3-0.6)
  tapMs: 100, // released inside this: a quick jab at zero power
  dashSpeedMin: 520,
  dashSpeedMax: 900,
  dashMs: 160, // (120-220)
  dashCarry: 0.45, // share of dash speed kept when the dash ends
  endlagMs: 220, // (150-300)
  endlagJabMs: 300, // a jab (a power-0 dash) recovers slower than a charged dash: mashing has a cost
  endlagAccel: 0.3, // you recover slowly after a dash
  dashBufferMs: 120, // (80-150)

  // Hits
  knockMin: 380,
  knockMax: 950, // was 820: a full-charge hit from mid-floe can now ring someone out
  recoil: 0.25,
  hitTolerance: 8, // the server's hit test is this much more generous than the bodies
  clashMargin: 0.25, // one dash must be 25% stronger to win a clash
  jabOnCharge: 0.6, // a jab that breaks someone's charge knocks them back this much of a jab's usual
  hitFacing: 0.3, // a dash only lands on someone in front of it: cos of about 73 degrees
  stunMinMs: 220,
  stunMaxMs: 320,
  stunDamp: 3.0, // per second while stunned (you just can't steer yet)
  hitstopMs: 70,
  bigHitstopMs: 140,
  bigPower: 0.85, // a dash at or above this power is a "big" hit

  // Arena
  hexSize: 34,
  rings: 5,
  edgeGraceMs: 110, // (80-150)
  crumbleStartS: 10, // (10-20); was 15: novice rounds ran 40 s with long gaps before the floe forced a fight
  crumbleEveryS: 5, // (3-7)
  warnMs: 1500,
  spawnX: 140,

  // Match
  roundsToWin: 3,
  countdownMs: 1500,
  outroMs: 2200,
  loserHeadStart: 0, // 0-0.5 of a full charge, banked for the round loser (?v=comeback)
};

export const PH = { IDLE: 0, CHARGE: 1, DASH: 2, ENDLAG: 3, FROZEN: 4, STUN: 5, FALL: 6 };
export const PHASE_NAMES = ['idle', 'charge', 'dash', 'endlag', 'frozen', 'stun', 'fall'];

export const ticksOf = (ms) => Math.max(1, Math.round((ms * TUNING.tickHz) / 1000));

// Derived constants, in ticks. Recomputed by setTuning() (the local ?debug panel only;
// online, client and server must share the shipped values).
export const K = {};
function derive() {
  const T = TUNING;
  K.dt = 1 / T.tickHz;
  K.chargeMax = ticksOf(T.chargeMaxMs);
  K.tap = ticksOf(T.tapMs);
  K.dash = ticksOf(T.dashMs);
  K.endlag = ticksOf(T.endlagMs);
  K.endlagJab = ticksOf(T.endlagJabMs);
  K.buffer = ticksOf(T.dashBufferMs);
  K.stunMin = ticksOf(T.stunMinMs);
  K.stunMax = ticksOf(T.stunMaxMs);
  K.hitstop = ticksOf(T.hitstopMs);
  K.bigHitstop = ticksOf(T.bigHitstopMs);
  K.grace = ticksOf(T.edgeGraceMs);
  K.warn = ticksOf(T.warnMs);
  K.countdown = ticksOf(T.countdownMs);
  K.outro = ticksOf(T.outroMs);
  // Per-tick damping factors from plain arithmetic, never Math.exp (engines may
  // round exp differently, and the client must match the server bit for bit).
  K.damp = 1 - T.iceDamp / T.tickHz;
  K.stunDamp = 1 - T.stunDamp / T.tickHz;
  K.fallDamp = 1 - 4 / T.tickHz;
  K.accel = T.accel / T.tickHz;
}
derive();

export function setTuning(patch) {
  for (const [k, v] of Object.entries(patch)) if (k in TUNING && Number.isFinite(v)) TUNING[k] = v;
  derive();
}

const q8 = (v) => Math.round(v * 8) / 8;
const q256 = (v) => Math.round(v * 256) / 256;
export const quantize = q8;

export const dashSpeed = (pw) => TUNING.dashSpeedMin + (TUNING.dashSpeedMax - TUNING.dashSpeedMin) * pw;
export const knockFor = (pw) => TUNING.knockMin + (TUNING.knockMax - TUNING.knockMin) * pw;
export const stunFor = (pw) => Math.round(K.stunMin + (K.stunMax - K.stunMin) * pw);
// The recovery after a dash of power pw: a jab costs more than a charged dash.
export const endlagFor = (pw) => (pw > 0 ? K.endlag : K.endlagJab);

// Charge ticks -> dash power 0..1 (1/64 grid). A tap is a jab at zero power.
export function powerOf(ch) {
  if (ch <= K.tap) return 0;
  const p = (ch - K.tap) / (K.chargeMax - K.tap);
  return p >= 1 ? 1 : Math.round(p * 64) / 64;
}

// --- input --------------------------------------------------------------
// mx, my: integers -100..100 (a percentage of a full push; keyboard diagonals
// arrive as 71). b: bit 0 dash held, bit 1 dash pressed this tick (the edge).
export const NEUTRAL = Object.freeze({ mx: 0, my: 0, b: 0 });
export const encodeInput = (i) => [i.seq, i.mx, i.my, i.b];
export function sanitizeInput(row) {
  if (!Array.isArray(row) || row.length !== 4) return null;
  const [seq, mx, my, b] = row;
  if (!Number.isInteger(seq) || seq < 1) return null;
  if (!Number.isInteger(mx) || !Number.isInteger(my) || mx < -100 || mx > 100 || my < -100 || my > 100) return null;
  if (!Number.isInteger(b) || b < 0 || b > 3) return null;
  return { seq, mx, my, b };
}
export const isNeutral = (i) => i.mx === 0 && i.my === 0 && i.b === 0;

// The one way a device becomes an input: a stick (x, y, its length capped at 1), the
// dash button held, and whether it went down since the last tick. The keyboard, pads,
// touch (js/controls.js) and the CPU's pad (js/game/cpu.js) all come through here, so
// the CPU can only ever press what a person can.
export function deviceInput(x, y, held, pressed) {
  let mx = 0;
  let my = 0;
  const m = Math.sqrt(x * x + y * y);
  if (m >= 1e-6) {
    const k = m > 1 ? 1 / m : 1;
    mx = Math.round(x * k * 100);
    my = Math.round(y * k * 100);
  }
  return { mx, my, b: (held ? 1 : 0) | (pressed ? 2 : 0) };
}

// Seeded PRNG (mulberry32), shared by the rules and the CPU so every match replays.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- state --------------------------------------------------------------
// x, y        position (floe centre is 0,0)
// vx, vy      velocity
// fx, fy      facing, a unit vector (the dash goes this way)
// ph, t       phase and ticks left in it (dash, endlag, frozen, stun)
// ch          charge ticks while charging
// pw          power of the current or last dash, 0..1
// buf         dash buffer: ticks left on a press that couldn't fire yet
// kx, ky      launch velocity waiting for the end of a hit freeze
// nx, nt      the phase (and its length) that follows the freeze
// lock        countdown ticks: no movement until it reaches 0
// head        banked charge ticks for the first charge of a round (comeback option)
// warp, rev   bumped by the server on a teleport / on any change outside this step
export function spawnState(side, prev = null) {
  const s = side === 0 ? -1 : 1;
  return {
    x: s * TUNING.spawnX,
    y: 0,
    vx: 0,
    vy: 0,
    fx: -s,
    fy: 0,
    ph: PH.IDLE,
    t: 0,
    ch: 0,
    pw: 0,
    buf: 0,
    kx: 0,
    ky: 0,
    nx: 0,
    nt: 0,
    lock: 0,
    head: 0,
    warp: prev ? prev.warp + 1 : 0,
    rev: prev ? prev.rev + 1 : 0,
  };
}

const FIELDS = ['x', 'y', 'vx', 'vy', 'fx', 'fy', 'ph', 't', 'ch', 'pw', 'buf', 'kx', 'ky', 'nx', 'nt', 'lock', 'head', 'warp', 'rev'];
export const encodeSelf = (s) => FIELDS.map((k) => s[k]);
export function decodeSelf(row) {
  const s = {};
  for (let i = 0; i < FIELDS.length; i++) s[FIELDS[i]] = row[i];
  return s;
}
export const isFiniteSelf = (s) => FIELDS.every((k) => Number.isFinite(s[k]));

// What the other player sees: [pid, x, y, warp, phase, charge 0..100, facing, flags].
// Facing is degrees for drawing only (atan2 is fine here: it never feeds the step).
// flags: bit 0 teetering on an edge.
export function encodeRemote(pid, s, flags = 0) {
  const charge = s.ph === PH.CHARGE ? Math.round(Math.min(1, s.ch / K.chargeMax) * 100) : s.ph === PH.DASH ? Math.round(s.pw * 100) : 0;
  const deg = Math.round((Math.atan2(s.fy, s.fx) * 180) / Math.PI);
  return [pid, s.x, s.y, s.warp, s.ph, charge, deg, flags];
}

// Nothing a neutral input could change: standing still, nothing buffered or counting.
export const atRest = (s) =>
  (s.ph === PH.IDLE || s.ph === PH.FALL) && s.vx === 0 && s.vy === 0 && s.buf === 0 && s.lock === 0;

// --- the step -----------------------------------------------------------
function startDash(o) {
  const pw = powerOf(o.ch);
  const sp = dashSpeed(pw);
  o.pw = pw;
  o.ph = PH.DASH;
  o.t = K.dash;
  o.ch = 0;
  o.vx = o.fx * sp;
  o.vy = o.fy * sp;
}

function accelerate(o, mx, my, mult, cap) {
  const bx = o.vx;
  const by = o.vy;
  o.vx += mx * K.accel * mult;
  o.vy += my * K.accel * mult;
  if (mx !== 0 || my !== 0) {
    // Input can't push you past the cap, but it doesn't brake a faster slide either:
    // knockback and dash momentum keep their speed and decay with the ice.
    const sp2 = o.vx * o.vx + o.vy * o.vy;
    if (sp2 > cap * cap) {
      const before = Math.sqrt(bx * bx + by * by);
      const limit = before > cap ? before : cap;
      const sp = Math.sqrt(sp2);
      if (sp > limit) {
        o.vx = (o.vx * limit) / sp;
        o.vy = (o.vy * limit) / sp;
      }
    }
  }
}

export function stepPlayer(s, input) {
  const T = TUNING;
  const o = { ...s };
  const held = (input.b & 1) !== 0;
  const pressed = (input.b & 2) !== 0;
  let mx = input.mx / 100;
  let my = input.my / 100;
  const m2 = mx * mx + my * my;
  if (m2 > 1) {
    const k = 1 / Math.sqrt(m2);
    mx *= k;
    my *= k;
  }
  const aims = m2 >= 0.09; // a 30% push turns you
  const aim = () => {
    if (!aims) return;
    const k = 1 / Math.sqrt(mx * mx + my * my);
    o.fx = q256(mx * k);
    o.fy = q256(my * k);
  };

  if (o.ph === PH.FALL) {
    o.vx = q8(o.vx * K.fallDamp);
    o.vy = q8(o.vy * K.fallDamp);
    if (o.vx * o.vx + o.vy * o.vy < T.restSpeed * T.restSpeed) o.vx = o.vy = 0;
    o.x = q8(o.x + o.vx * K.dt);
    o.y = q8(o.y + o.vy * K.dt);
    return o;
  }

  if (o.lock > 0) {
    // Countdown: you can turn to face them, but not move or charge. Holding dash
    // through GO starts the charge on the first free tick.
    o.lock--;
    o.vx = o.vy = 0;
    aim();
    if (o.lock === 0 && held) o.buf = K.buffer;
    return o;
  }

  if (o.buf > 0) o.buf--;
  if (pressed) o.buf = K.buffer;

  let cap = T.maxSpeed;
  let mult = 1;
  let damp = K.damp;
  let move = true;

  switch (o.ph) {
    case PH.FROZEN:
      // A hit freeze (hitstop). Nothing moves; then the stored launch happens.
      o.t--;
      if (o.t <= 0) {
        o.ph = o.nx;
        o.t = o.nt;
        o.vx = o.kx;
        o.vy = o.ky;
        o.kx = o.ky = 0;
        o.nx = o.nt = 0;
      }
      o.vx = q8(o.vx);
      o.vy = q8(o.vy);
      return o;
    case PH.STUN:
      o.t--;
      damp = K.stunDamp;
      mult = 0;
      if (o.t <= 0) o.ph = PH.IDLE;
      break;
    case PH.DASH:
      // Committed: no steering, no friction.
      o.t--;
      damp = 1;
      mult = 0;
      if (o.t <= 0) {
        o.ph = PH.ENDLAG;
        o.t = endlagFor(o.pw);
        o.vx *= T.dashCarry;
        o.vy *= T.dashCarry;
      }
      break;
    case PH.ENDLAG:
      o.t--;
      mult = T.endlagAccel;
      aim();
      if (o.t <= 0) o.ph = PH.IDLE;
      break;
    case PH.CHARGE:
      aim();
      if (!held) {
        startDash(o);
        move = false;
        damp = 1;
      } else {
        if (o.ch < K.chargeMax) o.ch++;
        cap = T.maxSpeed * T.chargeSlow;
      }
      break;
    default: {
      // IDLE
      aim();
      if (o.buf > 0) {
        o.buf = 0;
        o.ph = PH.CHARGE;
        o.ch = Math.min(K.chargeMax, o.head);
        o.head = 0;
        if (!held) {
          startDash(o); // a tap shorter than one tick, or a buffered tap: a jab now
          move = false;
          damp = 1;
        } else cap = T.maxSpeed * T.chargeSlow;
      }
    }
  }

  // Friction first, then your push, so the cap is the real top speed.
  if (damp !== 1) {
    o.vx *= damp;
    o.vy *= damp;
  }
  if (move && mult > 0) accelerate(o, mx, my, mult, cap);
  if (o.ph !== PH.DASH && !aims && o.vx * o.vx + o.vy * o.vy < T.restSpeed * T.restSpeed) o.vx = o.vy = 0;
  o.vx = q8(o.vx);
  o.vy = q8(o.vy);
  o.x = q8(o.x + o.vx * K.dt);
  o.y = q8(o.y + o.vy * K.dt);
  return o;
}

// --- the floe -----------------------------------------------------------
// Pointy-top hexes in rings around a centre tile. Tiles are indexed in a fixed
// ring-walk order so every machine builds the same list.
const SQRT3 = Math.sqrt(3);
const DIRS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

export function buildFloe(rings = TUNING.rings, size = TUNING.hexSize) {
  const tiles = [{ q: 0, r: 0, ring: 0, idx: 0, x: 0, y: 0 }];
  for (let k = 1; k <= rings; k++) {
    let q = DIRS[4][0] * k;
    let r = DIRS[4][1] * k;
    let idx = 0;
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < k; step++) {
        tiles.push({ q, r, ring: k, idx: idx++, x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r });
        q += DIRS[side][0];
        r += DIRS[side][1];
      }
    }
  }
  const span = rings * 2 + 1;
  const grid = new Int16Array(span * span).fill(-1);
  tiles.forEach((t, i) => (grid[(t.q + rings) * span + (t.r + rings)] = i));
  return { tiles, rings, size, span, grid };
}

// Which tile a point is over (nearest hex by cube rounding), or -1 off the floe.
export function tileAt(floe, x, y) {
  const qf = ((SQRT3 / 3) * x - y / 3) / floe.size;
  const rf = ((2 / 3) * y) / floe.size;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  const R = floe.rings;
  if (q < -R || q > R || r < -R || r > R) return -1;
  return floe.grid[(q + R) * floe.span + (r + R)];
}

// The sinking schedule, in ticks after GO, from the round seed. The outer rings go
// half at a time (which half is seeded), every crumbleEveryS from crumbleStartS;
// ring 1 goes whole, and the centre goes last, so every round ends.
export function sinkSchedule(floe, seed, { crumbleStartS = TUNING.crumbleStartS, crumbleEveryS = TUNING.crumbleEveryS } = {}) {
  const at = new Int32Array(floe.tiles.length);
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const tick = (s) => Math.round(s * TUNING.tickHz);
  let event = 0;
  const when = () => tick(crumbleStartS + crumbleEveryS * event++);
  for (let k = floe.rings; k >= 1; k--) {
    const n = 6 * k;
    if (k === 1) {
      const t = when();
      for (const [i, tile] of floe.tiles.entries()) if (tile.ring === 1) at[i] = t;
      continue;
    }
    const start = rnd() % n;
    const first = when();
    const second = when();
    for (const [i, tile] of floe.tiles.entries()) {
      if (tile.ring !== k) continue;
      at[i] = (tile.idx - start + n) % n < n / 2 ? first : second;
    }
  }
  at[0] = tick(crumbleStartS + crumbleEveryS * event);
  return at;
}
