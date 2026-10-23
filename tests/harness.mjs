// The scripted-player harness (avoid-vibecoded-games): run the real rules for whole
// matches with CPU players on both sides and measure what happened.
//
// A side is one of: a test bot ('balanced', 'camper', 'spammer'), an opponent from the
// title screen ('practice', 'easy', 'normal', 'hard'), 'novice' (a scripted first-time
// player), 'rusher14' (the plan most beginners find: hold DASH and walk at them; the
// number is its reaction time in ticks), or a masher (the first thing anyone tries: tap
// DASH over and over): 'masher' (5 a second on keys), 'masher4', 'mashpad' (an analog
// stick), 'sloppy' (uneven keyboard mashing) and 'jabber' (jab whenever in reach). All below.

import { createDuel, rng } from '../js/game/rules.js';
import { createBrain, createCpu, perceive, PROFILES } from '../js/game/cpu.js';
import { TUNING, PH, deviceInput } from '../js/game/sim.js';

export function makePlayer(kind, seed) {
  if (kind === 'novice') return createNovice(seed);
  if (kind.startsWith('rusher')) return createRusher(seed, Number(kind.slice(6)) || 14);
  if (kind === 'masher') return createMasher(seed); // steady 5 taps a second on a keyboard
  if (kind === 'masher4') return createMasher(seed, { every: 15 }); // 4 a second
  if (kind === 'mashpad') return createMasher(seed, { keys: false, every: 8, jitter: 4, delay: 20 }); // a pad or touch stick
  if (kind === 'sloppy') return createMasher(seed, { every: 9, jitter: 7, hold: [3, 5], delay: [18, 26], cadence: [6, 10], aimNoise: 0.25, range: 1e9, flee: true });
  if (kind === 'jabber') return createJabber(seed);
  if (kind in PROFILES && kind !== 'bot') return createCpu({ level: kind, seed });
  return createBrain(kind, rng(seed));
}

// Plays one match to the end. Returns per-round results and the winner.
export function playMatch({ seed = 1, a = 'balanced', b = 'balanced', maxSeconds = 600, onTick = null } = {}) {
  const duel = createDuel({ seed });
  duel.join(0);
  duel.join(1);
  const players = [makePlayer(a, seed * 7919 + 13), makePlayer(b, seed * 7919 + 14)];
  duel.startMatch();
  const rounds = [];
  let spawnSide = null; // slot 0's side at the start of each round
  let roundStart = 0;
  const maxTicks = maxSeconds * TUNING.tickHz;
  while (duel.ticks < maxTicks) {
    const w = duel.world();
    const inputs = [0, 1].map((s) => players[s](duel.player(s), duel.player(1 - s), w));
    onTick?.(duel, inputs);
    for (const ev of duel.step(inputs)) {
      if (ev.kind === 'round-start') {
        // Slot 0 spawns on the left when its x is negative.
        spawnSide = duel.player(0).x < 0 ? 0 : 1;
        roundStart = duel.ticks;
      }
      if (ev.kind === 'round') {
        rounds.push({ winner: ev.winner, replay: ev.replay, leftWinner: ev.replay ? -1 : spawnSide === 0 ? (ev.winner === 0 ? 'left' : 'right') : ev.winner === 0 ? 'right' : 'left', seconds: (duel.ticks - duel.goTick) / TUNING.tickHz, totalSeconds: (duel.ticks - roundStart) / TUNING.tickHz });
      }
    }
    if (duel.state === 'end') break;
  }
  return { winner: duel.matchWinner, rounds, stats: duel.stats, ticks: duel.ticks, ended: duel.state === 'end', scores: [...duel.scores] };
}

// `kind` against `other`, alternating seats. Returns kind's share of the wins.
export function headToHead(kind, other, n = 50, seed0 = 1) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const mine = i % 2;
    const seed = seed0 + i;
    const m = mine === 0 ? playMatch({ seed, a: kind, b: other }) : playMatch({ seed, a: other, b: kind });
    results.push({ ...m, mine });
  }
  const wins = results.filter((m) => m.winner === m.mine).length;
  return {
    wins,
    n,
    share: wins / n,
    roundsWon: results.reduce((s, m) => s + m.scores[m.mine], 0),
    roundsLost: results.reduce((s, m) => s + m.scores[1 - m.mine], 0),
    results,
  };
}

export function summarize(results) {
  const rounds = results.flatMap((m) => m.rounds);
  const scored = rounds.filter((r) => !r.replay);
  const secs = scored.map((r) => r.seconds).sort((x, y) => x - y);
  const pct = (q) => secs[Math.min(secs.length - 1, Math.floor(q * secs.length))];
  return {
    matches: results.length,
    ended: results.filter((m) => m.ended).length,
    rounds: rounds.length,
    replays: rounds.length - scored.length,
    leftWins: scored.filter((r) => r.leftWinner === 'left').length / scored.length,
    slot0Wins: results.filter((m) => m.winner === 0).length / results.length,
    roundSeconds: { min: secs[0], p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), max: secs[secs.length - 1] },
    hitsPerRound: results.reduce((s, m) => s + m.stats.hits[0] + m.stats.hits[1], 0) / rounds.length,
    clashesPerMatch: results.reduce((s, m) => s + m.stats.clashes, 0) / results.length,
    savesPerMatch: results.reduce((s, m) => s + m.stats.saves[0] + m.stats.saves[1], 0) / results.length,
  };
}

// A first-time player on a phone, as a script: no reads and no tricks. They walk at
// the other fighter, hold DASH once they're fairly close, let go when it looks close
// enough (or the charge is full and they get bored), sometimes just tap, and head back
// to the middle once the ice under them is visibly cracking. They see things 300-450 ms
// late and drag the touch stick roughly. It's a simpler player than any CPU level and
// written separately, so how often it beats Slush says something about Slush.
export function createNovice(seed) {
  const R = rng(seed);
  const seen = [];
  let stick = { x: 0, y: 0 };
  let stickLeft = 0;
  let held = false;
  let holdFor = 0;
  let gap = 0;
  let releaseAt = 120;
  let tap = false;
  let rest = 0;
  return (me, foe, world) => {
    const v = perceive(me, foe, world);
    seen.push(v.foe);
    if (seen.length > 40) seen.shift();
    const f = seen[Math.max(0, seen.length - 1 - (18 + Math.floor(R() * 9)))];
    const m = v.me;
    const fl = v.floe;
    const dx = f.x - m.x;
    const dy = f.y - m.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    let want = { x: dx / d, y: dy / d };
    let hold = held;
    // The middle of the ice that isn't visibly cracking.
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const t of fl.tiles) {
      if (fl.alive(t.x, t.y, 30)) {
        cx += t.x;
        cy += t.y;
        n++;
      }
    }
    if (n) {
      cx /= n;
      cy /= n;
    }
    const scared = !fl.alive(m.x, m.y, 30);
    if (m.locked) hold = false;
    else if (m.ph === PH.CHARGE) {
      if (tap ? holdFor >= 3 : d < releaseAt || (m.charge >= 1 && R() < 0.03)) hold = false;
    } else if (m.ph === PH.IDLE) {
      if (rest > 0) rest--;
      if (d < 230 && gap <= 0 && rest === 0 && !scared && R() < 0.15) {
        hold = true;
        tap = R() < 0.25;
        releaseAt = 90 + R() * 70;
        rest = 20 + Math.floor(R() * 40);
      }
    } else want = { x: cx - m.x, y: cy - m.y }; // after a dash or a hit: back to the middle
    if (scared && m.ph !== PH.CHARGE) want = { x: cx - m.x, y: cy - m.y };
    if (--stickLeft <= 0) {
      const a = Math.atan2(want.y, want.x) + (R() * 2 - 1) * 0.15;
      stick = { x: Math.cos(a), y: Math.sin(a) };
      stickLeft = 6 + Math.floor(R() * 5);
    }
    let pressed = false;
    if (hold && !held) {
      held = true;
      pressed = true;
      holdFor = 0;
    } else if (!hold && held) {
      held = false;
      gap = 10;
    }
    if (held) holdFor++;
    gap--;
    return deviceInput(stick.x, stick.y, held, pressed);
  };
}

// The first thing a new player tries: mash. Walks straight at the other fighter and
// taps DASH every `every` ticks (12 = 5 a second) whenever they're within `range`,
// never charging. `keys` is an 8-way keyboard stick; false is an analog pad or touch
// stick. It sees things `delay` ticks late ([lo, hi] redraws it each tick). `flee`
// heads for the middle when the ice under it is visibly cracking.
export function createMasher(seed, { every = 12, jitter = 0, hold = [3, 3], delay = 18, keys = true, cadence = [1, 1], aimNoise = 0, range = 160, flee = false } = {}) {
  const R = rng(seed);
  const seen = [];
  const pick = (v) => (Array.isArray(v) ? v[0] + Math.floor(R() * (v[1] - v[0] + 1)) : v);
  let stick = { x: 0, y: 0 };
  let stickLeft = 0;
  let held = 0;
  let next = 0;
  return (me, foe, world) => {
    const v = perceive(me, foe, world);
    seen.push(v.foe);
    if (seen.length > 60) seen.shift();
    const f = seen[Math.max(0, seen.length - 1 - pick(delay))];
    const m = v.me;
    let tx = f.x - m.x;
    let ty = f.y - m.y;
    const d = Math.sqrt(tx * tx + ty * ty);
    if (flee && !v.floe.alive(m.x, m.y, 30)) {
      tx = -m.x;
      ty = -m.y;
    }
    if (--stickLeft <= 0) {
      let a = Math.atan2(ty, tx) + (R() * 2 - 1) * aimNoise;
      if (keys) a = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
      stick = Math.sqrt(tx * tx + ty * ty) < 4 ? { x: 0, y: 0 } : { x: Math.cos(a), y: Math.sin(a) };
      stickLeft = pick(cadence);
    }
    let pressed = false;
    if (held > 0) held--;
    if (--next <= 0 && held === 0 && d < range && !m.locked) {
      pressed = true;
      held = pick(hold);
      next = every + Math.floor(R() * (jitter + 1));
    }
    return deviceInput(stick.x, stick.y, held > 0, pressed);
  };
}

// Walk at them and jab the moment they're in jab reach, and again as soon as you can.
export function createJabber(seed, delay = 18) {
  const R = rng(seed);
  const seen = [];
  let held = 0;
  let gap = 0;
  return (me, foe, world) => {
    const v = perceive(me, foe, world);
    seen.push(v.foe);
    if (seen.length > 40) seen.shift();
    const f = seen[Math.max(0, seen.length - 1 - delay)];
    const m = v.me;
    const dx = f.x - m.x;
    const dy = f.y - m.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    let pressed = false;
    if (held > 0) held--;
    if (gap > 0) gap--;
    if (held === 0 && gap === 0 && m.ph === PH.IDLE && d < 125 + R() * 20) {
      pressed = true;
      held = 3;
      gap = 6;
    }
    return deviceInput((dx > 20) - (dx < -20), (dy > 20) - (dy < -20), held > 0, pressed);
  };
}

// The plan most beginners land on within a match, on a keyboard: walk at them (back
// toward the middle when far out), hold DASH once they're within 210, let go under
// 100-150. It sees the other fighter `delay` ticks late (14 = 233 ms, a quick person).
export function createRusher(seed, delay = 14) {
  const R = rng(seed);
  const seen = [];
  let charging = 0;
  let releaseAt = 120;
  let held = false;
  return (me, foe, world) => {
    const v = perceive(me, foe, world);
    seen.push(v.foe);
    if (seen.length > 40) seen.shift();
    const f = seen[Math.max(0, seen.length - 1 - delay)];
    const m = v.me;
    const dx = f.x - m.x;
    const dy = f.y - m.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    let tx = dx;
    let ty = dy;
    if (Math.sqrt(m.x * m.x + m.y * m.y) > 170) {
      tx = -m.x;
      ty = -m.y;
    }
    let pressed = false;
    if (m.ph === PH.IDLE && d < 210 && !charging) {
      charging = 1;
      releaseAt = 100 + R() * 50;
      held = pressed = true;
    } else if (charging && (d < releaseAt || charging > 50)) {
      charging = 0;
      held = false;
    } else if (charging) charging++;
    return deviceInput((tx > 20) - (tx < -20), (ty > 20) - (ty < -20), held, pressed);
  };
}
