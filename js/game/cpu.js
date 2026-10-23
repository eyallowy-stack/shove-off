// Shove Off: the computer opponent.
//
// The CPU is a player with eyes, a reaction time and two thumbs. Each tick it:
//   1. looks (perceive): its own fighter, the other fighter exactly as the other
//      screen draws it (position, phase, glow-ring charge, facing), and the floe's
//      tiles, including only the warnings that are visibly cracking;
//   2. remembers what it saw, and acts on a view that is `reaction` ticks old;
//   3. decides what a person would want to do, with that level's mistakes;
//   4. moves a virtual stick and presses a virtual button, and that pad goes through
//      sim.js's deviceInput, the same function the keyboard, gamepads and touch use.
// It returns an ordinary { mx, my, b } input. It never touches a fighter's state:
// local.js and the room server hand that input to the same stepPlayer as everyone
// else's, so it plays by exactly the same rules and physics. It runs once per fixed
// tick and draws every random number from its own seeded stream, so a match replays
// exactly and plays the same at any frame rate.
//
//   createCpu({ level, seed }) -> cpu(me, foe, world) -> { mx, my, b }
//   LEVELS                     the opponents on the title screen, easiest first
//   perceive(me, foe, world)   what a person at the screen could know
//   createBrain(kind, random)  the test bots (balanced, camper, spammer) on the same body

import { TUNING, K, PH, dashSpeed, deviceInput, rng } from './sim.js';

// ---- the opponents ------------------------------------------------------------
export const LEVELS = [
  { id: 'practice', name: 'Bumper', label: 'Practice', line: 'A sparring partner who never shoves back. Learn the charge.', record: false },
  { id: 'easy', name: 'Slush', label: 'Easy', line: 'Slow to react, holds a charge too long, forgets where the edge is.', record: true },
  { id: 'normal', name: 'Skipper', label: 'Normal', line: 'A fair fight. Loves a big shove, gets greedy when you’re near the water.', record: true },
  { id: 'hard', name: 'The Berg', label: 'Hard', line: 'Reads your glow, steps aside, punishes every miss, never leaves the middle.', record: true, unlockedBy: 'normal' },
];
export const levelInfo = (id) => LEVELS.find((l) => l.id === id) ?? LEVELS[1];

// How each one plays. Difficulty is only ever senses, timing and judgement:
//   reaction   [lo, hi] ticks between something happening and the CPU acting on it
//   lead       0..1, how far it leads a moving target to make up for that delay
//   leadCap    the most it will lead them by, in units
//   cadence    [lo, hi] ticks a stick direction is held before it's rethought
//   keys       an 8-way stick at full push, like a keyboard player
//   aim        ± radians of aim error on each dash
//   judge      ± share of distance misjudgement, redrawn every second or so
//   notice     ticks before a tile sinks that it notices the crack (the warning is 90)
//   anticipate knows the outer ring goes next, and keeps off it
//   margin     how much ice it wants between itself and the water
//   position   0..1, how much it lines up on the centre side, so its hits drive you out
//   comeBack   chance it charges back in when it's cornered near the water
//   reflex     chance it scrambles back when it finds itself teetering
//   dashBack   lets a charge go toward the middle to save itself
//   jab        chance it jabs a charge that isn't ready yet, when it's in reach
//   punish     chance it jabs a fighter still recovering from a dash
//   poke       chance it jabs someone standing at the tip of its jab range
//   spacing    0..1, how carefully it stays out of your jab until its own charge is up
//   read       chance it answers a big charge pointed at it, and how (answers)
//   bait       chance it feints in and out to draw a dash
//   greed      chance it goes all in when the other fighter is near the water
//   fumble     chance a charge is misjudged: held too long, or let go too early
//   hesitate   chance it pauses before committing
//   wander     chance per second it drifts off, thinking about something else
//   preCharge  chance it holds dash through GO
//   eager      chance it starts a charge when it's in a good spot
//   rest       [lo, hi] ticks between one attack decision and the next
//   patience   [lo, hi] ticks it will sit on a full charge before letting go
//   tapHold    ticks a jab press lasts (a finger can't be faster)
//   minGap     ticks between two presses (no inhuman mashing)
//   mashRead   jabs it has to see within 3 s before it reads you as a masher (0: never)
//   antiMash   chance it answers a masher: charges outside their jab and meets them with it
//   edgeBlind  lets a charge go without checking the dash stays on the ice (Slush)
//   wary       0..1, how much extra room it keeps from a bigger charge for its own slow reactions
// The shared starting point the other profiles are written against (the first build's
// Skipper). Skipper itself is retuned below.
const BASE = {
  attacks: true,
  reaction: [17, 23],
  lead: 0.5,
  leadCap: 30,
  cadence: [5, 8],
  keys: false,
  aim: 0.14,
  judge: 0.18,
  notice: 60,
  anticipate: false,
  margin: 50,
  position: 0,
  comeBack: 0.7,
  reflex: 0.85,
  dashBack: false,
  jab: 0.6,
  punish: 0.7,
  poke: 0.35,
  spacing: 0.6,
  read: 0.65,
  answers: { clash: 0.55, step: 0.45 },
  bait: 0.2,
  greed: 0.5,
  fumble: 0.25,
  hesitate: 0.2,
  wander: 0,
  preCharge: 0.25,
  eager: 0.6,
  rest: [10, 30],
  patience: [50, 90],
  tapHold: 3,
  minGap: 6,
  mashRead: 2,
  antiMash: 0.6,
  edgeBlind: false,
  wary: 1,
};
// Skipper, a real middle rung (re-measured 2026-10-23, tests/cpu.test.mjs): quick eyes, so
// the rush and mashing don't walk over it, but it attacks less often, misjudges more and
// is careless near the water, so a first-timer takes a fair share of matches.
const NORMAL = {
  ...BASE,
  reaction: [11, 15],
  lead: 0.8,
  leadCap: 50,
  notice: 36,
  margin: 30,
  comeBack: 0.5,
  reflex: 0.85,
  dashBack: true,
  jab: 0.25,
  punish: 0.4,
  poke: 0.1,
  spacing: 0.3,
  read: 0.85,
  answers: { clash: 0.5, hover: 0.5 },
  greed: 0.6,
  fumble: 0.35,
  hesitate: 0.3,
  eager: 0.4,
  rest: [18, 45],
  antiMash: 1,
};
export const PROFILES = {
  practice: { ...BASE, attacks: false, reaction: [18, 24], cadence: [8, 14], read: 0.3, hesitate: 0.25, wander: 0.5, margin: 70 },
  easy: {
    ...BASE,
    reaction: [20, 28],
    lead: 0,
    cadence: [7, 12],
    keys: true,
    aim: 0.2,
    judge: 0.25,
    notice: 24,
    margin: 40,
    position: 0,
    comeBack: 0.5,
    reflex: 0.5,
    jab: 0.25,
    punish: 0.35,
    poke: 0.15,
    spacing: 0,
    read: 0.3,
    answers: { clash: 0.6, step: 0.4 },
    bait: 0,
    greed: 0.35,
    fumble: 0.4,
    hesitate: 0.25,
    wander: 0.5,
    preCharge: 0,
    eager: 0.45,
    rest: [16, 40],
    patience: [80, 140],
    tapHold: 4,
    minGap: 8,
    mashRead: 0,
    edgeBlind: true,
    wary: 0,
  },
  normal: NORMAL,
  hard: {
    ...BASE,
    reaction: [10, 13],
    lead: 0.9,
    cadence: [2, 4],
    aim: 0.07,
    judge: 0.08,
    notice: 90,
    anticipate: true,
    margin: 80,
    position: 1,
    comeBack: 1,
    reflex: 1,
    dashBack: true,
    jab: 0.9,
    punish: 0.95,
    poke: 0.6,
    spacing: 1,
    read: 0.95,
    answers: { hover: 0.55, clash: 0.45 },
    bait: 0.5,
    greed: 0.25,
    fumble: 0.06,
    hesitate: 0.08,
    preCharge: 0.5,
    patience: [40, 70],
    tapHold: 2,
    minGap: 5,
    mashRead: 2,
    antiMash: 1,
  },
  // The balance-test bot: the first build's CPU. A steady robot, not a person.
  bot: {
    ...BASE,
    reaction: [8, 8],
    lead: 0,
    cadence: [1, 1],
    aim: 0.05,
    judge: 0,
    notice: 90,
    margin: 70,
    position: 1,
    comeBack: 1,
    reflex: 1,
    jab: 1,
    punish: 0.75,
    poke: 0.5,
    spacing: 1,
    read: 1,
    answers: { clash: 1 },
    bait: 0,
    greed: 0,
    fumble: 0,
    hesitate: 0,
    preCharge: 0,
    patience: [1e9, 1e9],
    tapHold: 2,
    minGap: 1,
    mashRead: 0,
  },
};

// ---- senses -------------------------------------------------------------------
const DEG = Math.PI / 180;
const chargeOf = (s) => (s.ph === PH.CHARGE ? Math.min(1, s.ch / K.chargeMax) : s.ph === PH.DASH ? s.pw ?? 0 : 0);

// What a person at the screen could know. The other fighter comes through the same
// rounding as the wire (js/game/sim.js encodeRemote: charge in whole percent, facing in
// whole degrees), so a CPU in local play sees exactly what an online opponent's screen
// shows. Its speed isn't included: the CPU works that out from where it saw it move.
// The floe can only be asked about the next K.warn ticks, because that's how early a
// tile visibly cracks; which half of a ring goes next isn't knowable before that.
export function perceive(me, foe, world) {
  const fd = Math.round(Math.atan2(foe.fy, foe.fx) / DEG) * DEG;
  const fc = Math.round(Math.min(1, Math.max(0, foe.charge ?? chargeOf(foe))) * 100) / 100;
  return {
    me: { x: me.x, y: me.y, vx: me.vx ?? 0, vy: me.vy ?? 0, ph: me.ph, charge: chargeOf(me), fx: me.fx, fy: me.fy, locked: (me.lock ?? 0) > 0 },
    foe: { x: foe.x, y: foe.y, ph: foe.ph, charge: fc, fx: Math.cos(fd), fy: Math.sin(fd) },
    floe: {
      elapsed: world.elapsed,
      tiles: world.floe.tiles,
      alive: (x, y, ahead = 0) => world.alive(x, y, Math.max(0, Math.min(K.warn, ahead))),
    },
  };
}

// ---- small geometry -------------------------------------------------------------
const len = (x, y) => Math.sqrt(x * x + y * y);
const ZERO = Object.freeze({ x: 0, y: 0 });
const unit = (x, y) => {
  const l = len(x, y);
  return l < 1e-6 ? ZERO : { x: x / l, y: y / l };
};
const rotate = (v, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};
// A keyboard: eight directions, always a full push.
const eightWay = (v) => {
  if (len(v.x, v.y) < 0.3) return ZERO;
  const a = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: Math.round(Math.cos(a) * 1000) / 1000, y: Math.round(Math.sin(a) * 1000) / 1000 };
};

// How far a dash at power pw reaches while it still counts as a hit, and how far it
// slides in all, with the dash's carry.
export const reachFor = (pw) => dashSpeed(pw) * (TUNING.dashMs / 1000) + 2 * TUNING.radius + TUNING.hitTolerance - 6;
const travelFor = (pw) => dashSpeed(pw) * (TUNING.dashMs / 1000) + (dashSpeed(pw) * TUNING.dashCarry) / TUNING.iceDamp;

// How far you can go from (x, y) along (ux, uy) before the ice runs out.
function freeRun(fl, x, y, ux, uy, max, ahead) {
  for (let s = 12; s <= max; s += 12) if (!fl.alive(x + ux * s, y + uy * s, ahead)) return s - 12;
  return max;
}

// ---- the CPU ------------------------------------------------------------------
export function createCpu({ level = 'normal', seed = 1, random = null, style = 'fighter', tweak = {}, onThink = null } = {}) {
  const P = { ...(PROFILES[level] ?? PROFILES.normal), ...tweak };
  const R = random ?? rng(seed);
  const between = ([lo, hi]) => lo + Math.floor(R() * (hi - lo + 1));
  const see = (ahead) => Math.min(ahead, P.notice);

  // Memory of the other fighter, newest last.
  const seen = [];
  let delay = between(P.reaction);
  let delayGoal = delay;
  let delayLeft = 0;
  function note(f) {
    const last = seen[seen.length - 1];
    f.still = last && last.ph === PH.IDLE && f.ph === PH.IDLE ? last.still + 1 : 0; // ticks seen standing
    if (last && len(f.x - last.x, f.y - last.y) > 70) seen.length = 0; // a new round's spawn
    seen.push(f);
    if (seen.length > 48) seen.shift();
    if (--delayLeft <= 0) {
      delayGoal = between(P.reaction);
      delayLeft = 45 + Math.floor(R() * 45);
    }
    if (delay < delayGoal) delay++;
    else if (delay > delayGoal) delay--;
  }
  // Jabs it has seen them throw (a dash with no glow), as its own tick numbers, for the
  // last 3 s: a few of those (mashRead) and it knows it's up against a masher.
  let clock = 0;
  let lastPh = -1;
  const jabsSeen = [];
  function watchJabs() {
    clock++;
    const f = seen[Math.max(0, seen.length - 1 - delay)];
    if (f.ph === PH.DASH && lastPh !== PH.DASH && f.charge < 0.1) jabsSeen.push(clock);
    lastPh = f.ph;
    while (jabsSeen.length && jabsSeen[0] < clock - 180) jabsSeen.shift();
  }
  // How fast they've been coming at (x, y), from where it saw them (units per tick).
  function closing(x, y) {
    const i = Math.max(0, seen.length - 1 - delay);
    if (i < 6) return 0;
    const f = seen[i];
    const g = seen[i - 6];
    return (len(g.x - x, g.y - y) - len(f.x - x, f.y - y)) / 6;
  }
  // The other fighter as seen `delay` ticks ago. A good player leads someone who's
  // walking or charging (where they're heading is readable); nobody can lead a dash
  // or a knockback, which happen faster than a reaction.
  function recall() {
    const i = Math.max(0, seen.length - 1 - delay);
    const f = seen[i];
    if (!P.lead || i < 4) return f;
    const g = seen[i - 4];
    if ((f.ph !== PH.IDLE && f.ph !== PH.CHARGE) || g.ph !== f.ph) return f;
    let lx = ((f.x - g.x) / 4) * delay * P.lead;
    let ly = ((f.y - g.y) / 4) * delay * P.lead;
    const l = len(lx, ly);
    if (l > P.leadCap) {
      lx *= P.leadCap / l;
      ly *= P.leadCap / l;
    }
    return { ...f, x: f.x + lx, y: f.y + ly };
  }

  // The hand: a stick that's rethought every few ticks, and a finger with limits.
  let stick = ZERO;
  let stickLeft = 0;
  let held = false;
  let holdMin = 0;
  let gap = 0;
  function hand(w, me) {
    let want = P.keys ? eightWay(w) : w;
    // Aim, then let go: a charge is released only once the stick points where it
    // means to go, so retargeting costs a tick, as it does for a person.
    if (held && !w.hold && me.ph === PH.CHARGE && len(want.x, want.y) > 0) {
      const dot = stick.x * want.x + stick.y * want.y;
      if (dot < 0.94 * len(stick.x, stick.y) * len(want.x, want.y) || len(stick.x, stick.y) < 0.3) {
        stick = want;
        stickLeft = between(P.cadence);
        return out(true, false);
      }
    }
    if (w.urgent || --stickLeft <= 0) {
      stick = want;
      stickLeft = between(P.cadence);
    }
    let pressed = false;
    if (w.hold && !held && gap <= 0) {
      held = true;
      pressed = true;
      holdMin = P.tapHold;
    } else if (!w.hold && held && holdMin <= 0) {
      held = false;
      gap = P.minGap;
    }
    holdMin--;
    gap--;
    return out(held, pressed);
  }
  const out = (h, pressed) => deviceInput(stick.x, stick.y, h, pressed);

  // ---- shared reading of the ice ----
  // The middle of the ice this CPU believes will still be there. Re-read every few
  // ticks, not every tick: the floe only changes every few seconds.
  let centreAt = NaN;
  let centre = ZERO;
  function safeCentre(fl) {
    const key = Math.floor(fl.elapsed / 6);
    if (key !== centreAt) {
      centreAt = key;
      centre = readCentre(fl);
    }
    return centre;
  }
  function readCentre(fl) {
    let outer = 0;
    for (const t of fl.tiles) if (t.ring > outer && fl.alive(t.x, t.y, 0)) outer = t.ring;
    const pass = (ringRule) => {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const t of fl.tiles) {
        if (ringRule && outer > 1 && t.ring >= outer) continue;
        if (!fl.alive(t.x, t.y, see(K.warn))) continue;
        sx += t.x;
        sy += t.y;
        n++;
      }
      return { x: n ? sx / n : 0, y: n ? sy / n : 0, n };
    };
    const c = P.anticipate ? pass(true) : null;
    return c && c.n >= 3 ? c : pass(false);
  }
  function safety(me, fl) {
    const c = safeCentre(fl);
    const toC = len(c.x - me.x, c.y - me.y);
    const outward = toC > 1 ? freeRun(fl, me.x, me.y, (me.x - c.x) / toC, (me.y - c.y) / toC, 120, see(K.warn / 2)) : 120;
    const teeter = !fl.alive(me.x, me.y, 0);
    const danger = teeter || !fl.alive(me.x, me.y, see(K.warn)) || outward < P.margin;
    return { c, toC, outward, danger, teeter };
  }
  // Arrive at (x, y) on ice: steer toward the velocity we want there, not the point,
  // so momentum doesn't carry us past it (into a jab, or off the edge).
  function toward(me, x, y) {
    const dx = x - me.x;
    const dy = y - me.y;
    const d = len(dx, dy);
    if (d < 6 && len(me.vx, me.vy) < 30) return ZERO;
    const sp = Math.min(TUNING.maxSpeed, d * 4);
    return unit((dx / d) * sp - me.vx, (dy / d) * sp - me.vy);
  }
  // A spot `want` from the foe, on the centre side of them (so a hit drives them
  // outward), leaning toward where we already are when they are the centre. With
  // position 0 it's just the near side of them: walk straight at them.
  function standOff(me, foe, c, want) {
    const cx = c.x - foe.x;
    const cy = c.y - foe.y;
    const cl = len(cx, cy);
    const mx = me.x - foe.x;
    const my = me.y - foe.y;
    const ml = len(mx, my) || 1;
    const w = Math.min(1, cl / 60) * P.position;
    const dir = unit((cl ? (cx / cl) * w : 0) + (mx / ml) * (1 - w * 0.6), (cl ? (cy / cl) * w : 0) + (my / ml) * (1 - w * 0.6));
    return { x: foe.x + dir.x * want, y: foe.y + dir.y * want };
  }
  const aimAt = (me, foe, off) => rotate(unit(foe.x - me.x, foe.y - me.y), off);
  // Go to a spot near them, but circle round outside their jab rather than cut
  // through it (careful levels; Slush just walks there).
  function around(me, foe, spot, fl) {
    const r = len(me.x - foe.x, me.y - foe.y);
    const safe = reachFor(0) + 30;
    const am = Math.atan2(me.y - foe.y, me.x - foe.x);
    const as = Math.atan2(spot.y - foe.y, spot.x - foe.x);
    let turn = as - am;
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    if (P.spacing <= 0 || r > safe + 40 || Math.abs(turn) < 0.5) return toward(me, spot.x, spot.y);
    const a = am + Math.sign(turn) * 0.6;
    const rr = Math.max(safe + 10, r);
    const x = foe.x + Math.cos(a) * rr;
    const y = foe.y + Math.sin(a) * rr;
    // An orbit over the water is no use: go straight instead.
    return fl.alive(x, y, see(K.warn / 2)) ? toward(me, x, y) : toward(me, spot.x, spot.y);
  }
  // A dash's reach, less what this CPU knows it misjudges (a person learns to let go a
  // little closer than the longest shove they could land).
  const sureReach = (pw) => reachFor(pw) * (1 - P.judge) - 4;

  // ---- the player ----
  let mode = 'free'; // tap | dodge | hover | pause | feint | wander | space
  let modeLeft = 0;
  let modeDir = ZERO;
  let side = 1;
  let wantPower = 0.5;
  let fumble = null; // 'over' | 'early'
  let aimOff = 0;
  let judge = 1;
  let judgeLeft = 0;
  let cooldown = 0;
  let threatAns = null;
  let calm = 0; // ticks since the last threat
  let greedRoll = null;
  let greedy = false;
  let teeterRoll = null;
  let fullFor = 0;
  let patience = between(P.patience);
  let preHold = false;
  let wasLocked = false;
  let baited = false;
  let cornered = null;
  let sinceStun = 99;
  let mashRoll = null;

  const set = (m, n) => {
    mode = m;
    modeLeft = n;
  };
  const go = (me, foe) => ({ ...aimAt(me, foe, aimOff), hold: false, urgent: true });
  function startCharge(power) {
    wantPower = power;
    aimOff = (R() * 2 - 1) * P.aim;
    judge = 1 + (R() * 2 - 1) * P.judge;
    judgeLeft = 60;
    fumble = R() < P.fumble ? (R() < 0.6 ? 'over' : 'early') : null;
    fullFor = 0;
    patience = between(P.patience);
  }
  function pickSide(me, fl, ux, uy) {
    const lx = -uy;
    const ly = ux;
    side = freeRun(fl, me.x, me.y, lx, ly, 120, see(K.warn / 2)) >= freeRun(fl, me.x, me.y, -lx, -ly, 120, see(K.warn / 2)) ? 1 : -1;
  }
  function answer(interrupt) {
    if (R() >= P.read) return 'ignore';
    if (interrupt) return 'rush';
    let r = R();
    for (const [k, w] of Object.entries(P.answers)) {
      if ((r -= w) < 0) return k;
    }
    return 'clash';
  }
  function newRound() {
    mode = 'free';
    cooldown = 0;
    threatAns = null;
    greedRoll = null;
    greedy = false;
    fumble = null;
    preHold = R() < P.preCharge;
    if (preHold) startCharge(0.5 + R() * 0.5);
  }

  function fighter(me, foe, fl) {
    if (me.locked) {
      if (!wasLocked) newRound();
      wasLocked = true;
      // The countdown: face them, and maybe hold dash through GO.
      return { ...aimAt(me, foe, 0), hold: preHold && P.attacks, urgent: false };
    }
    wasLocked = false;
    if (me.ph === PH.FALL) return { ...ZERO, hold: false };

    const dx = foe.x - me.x;
    const dy = foe.y - me.y;
    const d = len(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    if (--judgeLeft <= 0) {
      judge = 1 + (R() * 2 - 1) * P.judge;
      judgeLeft = 40 + Math.floor(R() * 50);
    }
    const dj = d * judge; // the distance as it looks to this CPU
    const S = safety(me, fl);
    const foeCh = foe.ph === PH.CHARGE ? foe.charge : 0;
    const pointed = foe.fx * -ux + foe.fy * -uy > 0.7;
    // A glow under 15% could still be a jab on its way (a tap shows a glimmer of glow
    // before it fires), so a charge only reads as a threat once it's clearly building.
    const threat = foe.ph === PH.CHARGE && foeCh >= 0.15 && pointed && d < 260;
    // Recovering from a dash is an opening. So is being stunned, unless we were just
    // stunned too (a bounce): then they get up when we do, and a jab meets a jab.
    if (me.ph === PH.FROZEN || me.ph === PH.STUN) sinceStun = 0;
    else sinceStun++;
    const open = foe.ph === PH.ENDLAG || ((foe.ph === PH.STUN || foe.ph === PH.FROZEN) && sinceStun > 20);
    const runOut = (pw) => freeRun(fl, me.x, me.y, ux, uy, travelFor(pw) + 30, 0) >= travelFor(pw) * 0.85;
    // Every release checks the dash stays on the ice, except Slush's: it forgets the edge.
    const safeGo = (pw) => P.edgeBlind || runOut(pw);
    const home = () => ({ ...toward(me, S.c.x, S.c.y), hold: false });
    // A masher: it has seen them jab again and again. Some answer it (antiMash): charge
    // outside their jab, then meet the next one with it (0.34+ beats a jab in a clash).
    const jabby = P.mashRead > 0 && jabsSeen.length >= P.mashRead;
    if (!jabby) mashRoll = null;
    else if (mashRoll === null) mashRoll = R() < P.antiMash;
    const counter = jabby && mashRoll;
    const jabbedLately = jabsSeen.length > 0;
    const nearJab = reachFor(0) * 1.3;
    // Out of their jab: straight back, leaning toward the middle, or sideways if that's water.
    const backOff = () => {
      const bx = foe.x - ux * (nearJab + 40);
      const by = foe.y - uy * (nearJab + 40);
      const tx = bx + (S.c.x - bx) * 0.3;
      const ty = by + (S.c.y - by) * 0.3;
      if (fl.alive(tx, ty, see(K.warn / 2))) return toward(me, tx, ty);
      return unit(-uy * side - ux * 0.3, ux * side - uy * 0.3);
    };

    if (me.ph === PH.FROZEN || me.ph === PH.STUN || me.ph === PH.DASH) {
      if (mode !== 'free') set('free', 0);
      // Against a masher, stay in their face (walking away just eats the next jab).
      return counter && !S.danger ? { ...toward(me, foe.x, foe.y), hold: false } : home();
    }
    if (cooldown > 0) cooldown--;
    if (threat) calm = 0;
    else if (++calm > 10) threatAns = null;

    // Finding yourself over the water: scramble back (if you notice in time).
    if (S.teeter) {
      if (teeterRoll === null) teeterRoll = R() < P.reflex;
      if (teeterRoll) {
        if (me.ph === PH.CHARGE && P.dashBack) return { ...unit(S.c.x - me.x, S.c.y - me.y), hold: false, urgent: true };
        if (mode !== 'tap') set('free', 0);
        return { ...toward(me, S.c.x, S.c.y), hold: me.ph === PH.CHARGE, urgent: true };
      }
    } else teeterRoll = null;

    if (!P.attacks) return sparring(me, foe, fl, S, { ux, uy, d, threat, foeCh });

    // They're going under: the round is won. Stop attacking and drift back to the middle
    // (a charge is kept rather than thrown after them over the water).
    if (foe.ph === PH.FALL) {
      if (mode !== 'free') set('free', 0);
      return { ...toward(me, S.c.x, S.c.y), hold: me.ph === PH.CHARGE && held };
    }

    if (mode === 'tap') {
      if (--modeLeft > 0) return { ...aimAt(me, foe, aimOff), hold: true };
      set('free', 0);
      return { ...aimAt(me, foe, aimOff), hold: false };
    }

    // ---- charging ----
    if (me.ph === PH.CHARGE) {
      const pw = me.charge;
      // Where it lets go: inside its reach by as much as it knows it misjudges.
      const reach = sureReach(pw);
      fullFor = pw >= 1 ? fullFor + 1 : 0;
      if (counter) {
        // Answering a masher: walk into them holding the charge, and let it go once
        // they're in reach. A charge 0.34+ wins the clash with their jab, and any other
        // moment they're mid-jab or recovering from one.
        if (dj < Math.max(reachFor(0) - 10, Math.min(reach, 120 + 40 * pw)) && (pw >= 0.36 || dj < reachFor(0) - 30) && safeGo(pw)) return go(me, foe);
        if (fullFor > 20 && dj < reach && safeGo(pw)) return go(me, foe);
        // Not ready to beat a jab yet: give ground while it builds.
        if (pw < 0.36 && !S.danger) return { ...backOff(), hold: true };
        return { ...(S.danger ? toward(me, S.c.x, S.c.y) : toward(me, foe.x, foe.y)), hold: true };
      }
      if (fumble === 'over') {
        // Holds to full whatever happens, then lets go when they look close enough.
        if (pw >= 1 && (dj < reach * 1.35 || fullFor > patience) && safeGo(pw)) {
          fumble = null;
          return go(me, foe);
        }
        return { ...aimAt(me, foe, 0), hold: true };
      }
      if (fumble === 'early' && pw >= 0.2 && dj < reach * 1.7 && safeGo(pw)) {
        fumble = null;
        return go(me, foe);
      }
      const holds = dashSpeed(pw) * (1 + TUNING.clashMargin) > dashSpeed(foeCh);
      const theyGo = foeCh >= 0.95 && dj < reachFor(foeCh) + 20;
      if (threat && holds && (theyGo || dj < reach) && runOut(pw)) return go(me, foe);
      // Their dash went by (it wasn't coming at me) or it's over: let mine go into it.
      if ((open || (foe.ph === PH.DASH && !pointed)) && pw >= 0.36 && dj < reach && safeGo(pw)) return go(me, foe);
      // Outgunned: keep just out of their reach, still holding, so their release falls
      // short and mine goes into the recovery. A slower player keeps a bigger gap,
      // because they'll be closer than they look (wary).
      const keep = reachFor(foeCh) + 30 + P.wary * Math.max(0, closing(me.x, me.y)) * delay;
      if (threat && !holds && dj < keep) {
        if (dj < reachFor(foeCh) + 10 || !fl.alive(me.x - ux * 40, me.y - uy * 40, see(K.warn / 2))) {
          // Nearly in their reach, or no room behind: step out of the line.
          return { ...unit(-uy * side - ux * 0.5, ux * side - uy * 0.5), hold: true };
        }
        return { ...unit(-ux - uy * side * 0.4, -uy + ux * side * 0.4), hold: true };
      }
      if (open && dj < reach && runOut(pw)) return go(me, foe);
      if (pw >= wantPower && dj < reach && (runOut(pw) || greedy)) return go(me, foe);
      // 0.34+ beats a jab in a clash: near the water, or with them close enough to jab
      // me, let it go rather than wait to be poked.
      if ((S.danger && !greedy) || dj < reachFor(0) + 10) if (pw >= 0.36 && dj < reach && safeGo(pw)) return go(me, foe);
      if (fullFor > patience && dj < reach * 1.25 && safeGo(pw)) return go(me, foe);
      // They're walking into my reach: let go now, whatever I was saving up for.
      if (pw >= 0.25 && closing(me.x, me.y) > 0.8 && dj - closing(me.x, me.y) * delay * P.lead < reach && runOut(pw)) return go(me, foe);
      // Line up from the centre side and keep holding: stay outside a jab until the
      // charge is ready, then step in. Greedy chases them instead.
      const want = pw >= wantPower ? Math.max(70, reach - 25) : Math.max(reachFor(0) + 20, reach - 25);
      const spot = standOff(me, foe, S.c, want);
      // Cornered: head back to the middle, but not into their jab before this charge
      // can win a clash against it. (Over the water, the reflex above takes over.)
      const wait = S.danger && pw < 0.36 && dj < reachFor(0) + 25 * P.spacing;
      const move = greedy ? toward(me, foe.x, foe.y) : wait ? ZERO : S.danger ? toward(me, S.c.x, S.c.y) : around(me, foe, spot, fl);
      return { ...(len(move.x, move.y) ? move : aimAt(me, foe, 0)), hold: true };
    }
    greedy = false;

    const actionable = me.ph === PH.IDLE;
    // A charge that's still building. A glow that's only just lit is usually a jab
    // on its way, and jabbing a jab just bounces both.
    const interrupt = foe.ph === PH.CHARGE && foeCh >= 0.1 && foeCh < 0.6;

    // Up against a masher, just back on its feet after being jabbed: they're still
    // recovering from that jab (a jab recovers slower than a stun lasts), so jab back now.
    if (counter && actionable && sinceStun <= 2 && dj < sureReach(0) && runOut(0) && R() < P.punish) {
      aimOff = (R() * 2 - 1) * P.aim;
      set('tap', P.tapHold);
      return { ...aimAt(me, foe, aimOff), hold: true, urgent: true };
    }
    // Otherwise charge from outside their jab, and meet the next one with it.
    if (counter && actionable && !S.danger && dj < 420) {
      set('free', 0);
      startCharge(0.5 + R() * 0.3);
      return { ...aimAt(me, foe, aimOff), hold: true };
    }

    // Punish a recovery, or a charge that isn't ready yet: a jab interrupts it.
    // (Jabbing a charge is a reflex; punishing a recovery waits for the CPU's rest.)
    if (actionable && dj < sureReach(0) && runOut(0) && (interrupt || (open && cooldown === 0))) {
      if (R() < (interrupt ? P.jab : P.punish)) {
        aimOff = (R() * 2 - 1) * P.aim;
        set('tap', P.tapHold);
        return { ...aimAt(me, foe, aimOff), hold: true, urgent: true };
      }
      cooldown = 6 + Math.floor(R() * 12); // missed the moment
    }
    // Someone at the tip of my jab: poke them before they poke me, if they've been
    // standing there (not just getting up: two jabs just bounce) or if they're walking
    // in on me while I hold the middle.
    const mine = len(S.c.x - me.x, S.c.y - me.y) + 20 < len(S.c.x - foe.x, S.c.y - foe.y);
    if (actionable && cooldown === 0 && foe.ph === PH.IDLE && (foe.still >= 15 || mine) && dj < sureReach(0) && dj > sureReach(0) - 36 && runOut(0)) {
      if (R() < P.poke) {
        aimOff = (R() * 2 - 1) * P.aim;
        set('tap', P.tapHold);
        return { ...aimAt(me, foe, aimOff), hold: true, urgent: true };
      }
      cooldown = 6 + Math.floor(R() * 12);
    }

    // A charge pointed at me: rush it while it's small, charge back to meet a big
    // one, step out of the line, or (Hard) hover just outside its reach to draw it.
    if (threat) {
      if (threatAns === null) threatAns = answer(interrupt);
      if (threatAns === 'rush' && interrupt && actionable && dj < reachFor(0) + 120) {
        if (mode !== 'free') set('free', 0);
        return { ...unit(ux, uy), hold: false };
      }
      if (threatAns === 'clash' && actionable) {
        set('free', 0);
        startCharge(1);
        pickSide(me, fl, ux, uy);
        return { ...aimAt(me, foe, aimOff), hold: true };
      }
      if ((threatAns === 'step' || (threatAns === 'clash' && !actionable)) && mode !== 'dodge') {
        pickSide(me, fl, ux, uy);
        set('dodge', 14);
      }
      if (threatAns === 'hover' && mode !== 'hover' && mode !== 'dodge') {
        pickSide(me, fl, ux, uy);
        set('hover', 90);
      }
    }

    if (mode === 'dodge') {
      if (--modeLeft <= 0) set('free', 0);
      return { ...unit(-uy * side - ux * 0.35, ux * side - uy * 0.35), hold: false };
    }
    if (mode === 'hover') {
      // Just outside their reach, sliding sideways: a release now falls short.
      if (--modeLeft <= 0 || S.danger || foe.ph !== PH.CHARGE) {
        if (foe.ph === PH.DASH) {
          set('dodge', 8);
          return { ...unit(-uy * side, ux * side), hold: false, urgent: true };
        }
        set('free', 0);
      } else {
        const want = reachFor(foeCh) + 30;
        const spot = { x: foe.x - ux * want - uy * side * 40, y: foe.y - uy * want + ux * side * 40 };
        if (!fl.alive(spot.x, spot.y, see(K.warn))) side = -side;
        return { ...toward(me, spot.x, spot.y), hold: false };
      }
    }
    if (mode === 'pause') {
      if (--modeLeft > 0 && !S.danger && !threat) return { ...ZERO, hold: false };
      set('free', 0);
      cooldown = 0;
    }
    if (mode === 'feint') {
      // In for a few ticks, then back out: draw a dash, then make it pay.
      if (--modeLeft <= 0 || S.danger) set('free', 0);
      else if (modeLeft > 12) return { ...unit(ux, uy), hold: false };
      else return { ...toward(me, foe.x - ux * 230, foe.y - uy * 230), hold: false };
    }
    if (mode === 'wander') {
      if (--modeLeft <= 0 || S.danger || d < 170) set('free', 0);
      else return { ...modeDir, hold: false };
    }

    // They're near the water: some go all in.
    const foeEdge = !fl.alive(foe.x, foe.y, see(K.warn)) || freeRun(fl, foe.x, foe.y, ux, uy, 96, see(K.warn / 2)) < 60;
    if (!foeEdge) greedRoll = null;
    else if (greedRoll === null) greedRoll = R() < P.greed;
    if (actionable && greedRoll && dj < 300) {
      greedRoll = false; // once per chance
      greedy = true;
      startCharge(1);
      return { ...aimAt(me, foe, aimOff), hold: true };
    }

    if (!S.danger) cornered = null;
    if (S.danger) {
      // Near the water with them in the middle: walking in means eating a jab, so
      // charge back in instead (a charged dash wins a clash against a jab).
      // Already inside their jab: jab first (a trade at worst) if careful.
      if (actionable && dj < sureReach(0) && runOut(0) && R() < P.spacing) {
        aimOff = (R() * 2 - 1) * P.aim;
        set('tap', P.tapHold);
        return { ...aimAt(me, foe, aimOff), hold: true, urgent: true };
      }
      if (actionable && dj < 230 && (cornered ??= R() < P.comeBack)) {
        startCharge(0.4 + R() * 0.4);
        return { ...aimAt(me, foe, aimOff), hold: true };
      }
      return home();
    }

    // Inside their jab with nothing charged: careful players back out first.
    const jabZone = reachFor(0) + 40;
    if (mode === 'space') {
      if (--modeLeft <= 0 || dj > jabZone + 10 || foe.ph !== PH.IDLE) set('free', 0);
      else return { ...toward(me, foe.x - ux * (jabZone + 20), foe.y - uy * (jabZone + 20)), hold: false };
    }
    if (actionable && cooldown === 0 && dj < jabZone && foe.ph === PH.IDLE && !mine && R() < P.spacing) {
      set('space', 20);
      return { ...toward(me, foe.x - ux * (jabZone + 20), foe.y - uy * (jabZone + 20)), hold: false };
    }

    // Start a charge from a good spot (after a moment's thought, sometimes).
    if (actionable && cooldown === 0 && dj < 280) {
      if (R() < P.hesitate) {
        set('pause', 8 + Math.floor(R() * 16));
        return { ...ZERO, hold: false };
      }
      cooldown = between(P.rest);
      if (R() < P.eager && !(jabbedLately && P.spacing > 0 && dj < nearJab)) {
        startCharge(0.35 + R() * 0.65);
        return { ...aimAt(me, foe, aimOff), hold: true };
      }
      if (!baited && foe.ph !== PH.DASH && R() < P.bait) {
        baited = true;
        set('feint', 22);
        return { ...unit(ux, uy), hold: false };
      }
    }
    if (dj > 300) baited = false;

    // Drifting off (Slush): a few seconds of not quite paying attention.
    if (P.wander && d > 220 && R() < P.wander / TUNING.tickHz) {
      const a = R() * Math.PI * 2;
      modeDir = { x: Math.cos(a), y: Math.sin(a) };
      set('wander', 20 + Math.floor(R() * 30));
      return { ...modeDir, hold: false };
    }

    // Close in from the centre side, to just outside their jab if careful.
    const spot = standOff(me, foe, S.c, 160 + (jabZone + 5 - 160) * P.spacing);
    return { ...around(me, foe, spot, fl), hold: false };
  }

  // Practice: keeps its distance, side-steps a big charge now and then, never shoves.
  function sparring(me, foe, fl, S, { ux, uy, d, threat, foeCh }) {
    if (S.danger) return { ...toward(me, S.c.x, S.c.y), hold: false };
    if (threat && threatAns === null) {
      threatAns = foeCh > 0.3 && R() < P.read ? 'step' : 'ignore';
      if (threatAns === 'step') {
        pickSide(me, fl, ux, uy);
        set('dodge', 16);
      }
    }
    if (mode === 'dodge') {
      if (--modeLeft <= 0) set('free', 0);
      return { ...unit(-uy * side - ux * 0.35, ux * side - uy * 0.35), hold: false };
    }
    if (mode === 'pause' || mode === 'wander') {
      if (--modeLeft <= 0) set('free', 0);
      return { ...(mode === 'wander' ? modeDir : ZERO), hold: false };
    }
    if (R() < 0.4 / TUNING.tickHz) {
      const a = R() * Math.PI * 2;
      modeDir = { x: Math.cos(a) * 0.6, y: Math.sin(a) * 0.6 };
      set(R() < 0.5 ? 'pause' : 'wander', 20 + Math.floor(R() * 30));
    }
    const spot = d < 140 ? { x: me.x - ux * 60, y: me.y - uy * 60 } : standOff(me, foe, S.c, 170);
    return { ...toward(me, spot.x, spot.y), hold: false };
  }

  // ---- the test bots' exploit styles (tests/balance.test.mjs) ----
  // These play on the same senses as everyone (the profile's aim and judgement).
  function judged(me, foe) {
    if (--judgeLeft <= 0) {
      judge = 1 + (R() * 2 - 1) * P.judge;
      judgeLeft = 40 + Math.floor(R() * 50);
    }
    return len(foe.x - me.x, foe.y - me.y) * judge;
  }
  // Stands in the middle and jabs whatever comes close.
  function camper(me, foe, fl) {
    const { c } = safety(me, fl);
    const d = judged(me, foe);
    if (held) return { ...aimAt(me, foe, aimOff), hold: false }; // let go: a jab
    if (d < 125 && me.ph === PH.IDLE) {
      aimOff = (R() * 2 - 1) * P.aim;
      return { ...aimAt(me, foe, aimOff), hold: true };
    }
    if (len(c.x - me.x, c.y - me.y) > 16) return { ...toward(me, c.x, c.y), hold: false };
    return { ...ZERO, hold: false };
  }
  // Charges to full every time and lets go as soon as they're in reach.
  function spammer(me, foe, fl) {
    const d = judged(me, foe);
    const { c, danger } = safety(me, fl);
    if (me.ph === PH.CHARGE) {
      if (me.charge >= 1 && d < reachFor(1) + 10) return { ...aimAt(me, foe, aimOff), hold: false };
      return { ...(danger ? toward(me, c.x, c.y) : aimAt(me, foe, 0)), hold: true };
    }
    if (me.ph === PH.IDLE) {
      aimOff = (R() * 2 - 1) * P.aim;
      return { ...(danger ? toward(me, c.x, c.y) : aimAt(me, foe, 0)), hold: true };
    }
    return { ...toward(me, c.x, c.y), hold: false };
  }

  const brain = { fighter, camper, spammer }[style] ?? fighter;
  return function cpu(meState, foeState, world) {
    if (!meState || !foeState || !world) return hand({ ...ZERO, hold: false, urgent: true }, { ph: PH.IDLE });
    const v = perceive(meState, foeState, world);
    note(v.foe);
    watchJabs();
    const want = brain(v.me, recall(), v.floe);
    onThink?.(want, v, { mode, greedy, fumble, threat: threatAns, delay, masher: jabsSeen.length >= P.mashRead && P.mashRead > 0 }); // ?debug and tests
    return hand(want, v.me);
  };
}

// The first build's API, kept for the test harness, the online bots and the room's
// CPU seat: createBrain(kind, random, { reaction, aimError }) -> (me, foe, world) => input.
//   balanced (or cpu)   the steady balance-test bot
//   camper, spammer     the exploit strategies the balance tests check it beats
//   easy, normal, hard, practice   the opponents on the title screen
export function createBrain(kind = 'balanced', random = Math.random, { reaction, aimError } = {}) {
  const tweak = {};
  if (Number.isFinite(reaction)) tweak.reaction = [reaction, reaction];
  if (Number.isFinite(aimError)) tweak.aim = aimError;
  if (kind === 'camper' || kind === 'spammer') return createCpu({ level: 'bot', random, style: kind, tweak });
  if (kind in PROFILES && kind !== 'bot') return createCpu({ level: kind, random, tweak });
  return createCpu({ level: 'bot', random, tweak });
}
