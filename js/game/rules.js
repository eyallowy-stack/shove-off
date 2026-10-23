// Shove Off: the rules. Hits, clashes, ring-outs with the edge grace, the sinking
// floe, rounds and the match. There are no secrets in here, so local play imports
// this same file and runs exactly what the room server runs.
//
//   createDuel()        the match itself: two fighters, the floe, rounds, stats
//   createShoveRules()  the duel wired into the room server's rules contract
// The CPU is in cpu.js; createBrain is re-exported here for the first build's callers.
//
// Per tick, the order is always: each fighter's own stepPlayer (sim.js), then
// duel.tick() for everything that involves both fighters or the floe. Any change
// tick() makes to a fighter bumps its `rev`, so an online client counts it as the
// server's doing, not as a prediction error.

import {
  TUNING,
  K,
  PH,
  NEUTRAL,
  stepPlayer,
  spawnState,
  buildFloe,
  tileAt,
  sinkSchedule,
  dashSpeed,
  knockFor,
  stunFor,
  endlagFor,
  isFiniteSelf,
  encodeSelf,
  encodeRemote,
  sanitizeInput,
  quantize as q8,
  rng,
} from './sim.js';
import { createCpu, createBrain } from './cpu.js';

export { rng, createBrain };
export const STATES = ['wait', 'cd', 'fight', 'over', 'end'];
// A clash's hitstop, in ticks, from the bigger dash's power: 40 ms for two jabs up to
// the full 140 ms once a dash is half charged.
export const clashStop = (pw) => Math.round(ticksOfMs(40) + (K.bigHitstop - ticksOfMs(40)) * Math.min(1, pw / 0.5));
const ticksOfMs = (ms) => (ms * TUNING.tickHz) / 1000;
const NEVER = 0x7fffffff;

export const freshStats = () => ({ hits: [0, 0], big: [0, 0], saves: [0, 0], clashes: 0, rounds: 0, replays: 0, longest: 0, shortest: 0, bestHit: 0 });

// A read-only view of the floe at one moment, for the CPU and for drawing.
export function makeWorld(floe, sinkAt, elapsed) {
  let centre = null;
  return {
    floe,
    elapsed,
    alive(x, y, ahead = 0) {
      const i = tileAt(floe, x, y);
      return i >= 0 && elapsed + ahead < sinkAt[i];
    },
    // The middle of what will still be there after the next warning.
    centre() {
      if (centre) return centre;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < floe.tiles.length; i++) {
        if (elapsed + K.warn < sinkAt[i]) {
          sx += floe.tiles[i].x;
          sy += floe.tiles[i].y;
          n++;
        }
      }
      centre = n ? { x: sx / n, y: sy / n, n } : { x: 0, y: 0, n: 0 };
      return centre;
    },
  };
}

// The online client's copy of the floe: rebuilt from the room's view (the round
// seed and crumble settings) and timed from snapshots, so it sinks on exactly the
// schedule the server judges ring-outs by. No per-tile messages are ever sent.
export function createArenaTracker() {
  const floe = buildFloe();
  const never = new Int32Array(floe.tiles.length).fill(NEVER);
  let key = '';
  let sinkAt = never;
  const live = (view) => !!view && (view.st === 'cd' || view.st === 'fight' || view.st === 'over');
  return {
    floe,
    update(view) {
      if (!view) return;
      const k = `${view.sd}:${view.cr?.[0]}:${view.cr?.[1]}`;
      if (k === key) return;
      key = k;
      sinkAt = sinkSchedule(floe, view.sd >>> 0, { crumbleStartS: view.cr?.[0], crumbleEveryS: view.cr?.[1] });
    },
    sinkAt: (view) => (live(view) ? sinkAt : never),
    // Round-elapsed ticks (fractional) at a server time, from the newest snapshot.
    elapsedAt(serverTime, lastSnap, view) {
      if (!lastSnap || !view || !Number.isFinite(serverTime)) return -1;
      const goTm = lastSnap.time - ((view.k - view.gk) * 1000) / TUNING.tickHz;
      return ((serverTime - goTm) * TUNING.tickHz) / 1000;
    },
    world(elapsed, view) {
      return makeWorld(floe, live(view) ? sinkAt : never, elapsed);
    },
  };
}

export function createDuel({
  seed = 1,
  freezeExtra = 0, // online: the interpolation delay in ticks, so the attacker visibly arrives first
  crumble = {}, // { crumbleStartS, crumbleEveryS } overrides (tests)
  headStart = TUNING.loserHeadStart,
} = {}) {
  const floe = buildFloe();
  const rand = rng(seed);
  const P = [null, null];
  const off = [0, 0];
  const scores = [0, 0];
  let stats = freshStats();
  let tick = 0;
  let state = 'wait';
  let started = false;
  let round = 0;
  let roundSeed = 0;
  let goTick = 0;
  let overTick = 0;
  let sinkAt = new Int32Array(floe.tiles.length).fill(NEVER);
  let side0 = 1; // the side slot 0 spawns on; flips every round
  let winner = -1; // last round: 0 or 1, 2 for a replay, -1 none yet
  let matchWinner = -1;
  let loser = -1;
  let events = [];
  const emit = (kind, data = {}) => events.push({ kind, ...data });
  const sideOf = (slot) => (slot === 0 ? side0 : 1 - side0);
  const elapsed = () => tick - goTick;
  const both = () => !!(P[0] && P[1]);

  function place(slot, lock) {
    const s = spawnState(sideOf(slot), P[slot]);
    s.lock = lock;
    if (slot === loser && headStart > 0) s.head = Math.round(headStart * K.chargeMax);
    P[slot] = s;
    off[slot] = 0;
  }

  function startRound(replay) {
    if (!replay) round++;
    side0 = 1 - side0;
    roundSeed = Math.floor(rand() * 4294967296) >>> 0;
    sinkAt = sinkSchedule(floe, roundSeed, crumble);
    goTick = tick + K.countdown;
    state = 'cd';
    for (const slot of [0, 1]) place(slot, K.countdown);
    emit('round-start', { round, replay: !!replay });
  }

  function enterEnd() {
    state = 'end';
    sinkAt = new Int32Array(floe.tiles.length).fill(NEVER);
    for (const slot of [0, 1]) if (P[slot]) place(slot, 0);
    emit('match', { winner: matchWinner, scores: [...scores] });
  }

  function startMatch() {
    started = true;
    scores[0] = scores[1] = 0;
    stats = freshStats();
    round = 0;
    winner = matchWinner = loser = -1;
    side0 = 1;
    state = 'wait';
    if (both()) startRound(false);
  }

  function hit(a, b, power, big, mult = 1) {
    const A = P[a];
    const B = P[b];
    let sx = B.x - A.x;
    let sy = B.y - A.y;
    const d = Math.sqrt(sx * sx + sy * sy) || 1;
    sx /= d;
    sy /= d;
    let dx = 0.6 * A.fx + 0.4 * sx;
    let dy = 0.6 * A.fy + 0.4 * sy;
    const n = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= n;
    dy /= n;
    const knock = knockFor(power) * mult;
    const stop = big ? K.bigHitstop : K.hitstop;
    P[b] = { ...B, ph: PH.FROZEN, t: stop + freezeExtra, nx: PH.STUN, nt: stunFor(power), kx: q8(dx * knock), ky: q8(dy * knock), vx: 0, vy: 0, ch: 0, buf: 0, rev: B.rev + 1 };
    P[a] = { ...A, ph: PH.FROZEN, t: stop, nx: PH.ENDLAG, nt: endlagFor(power), kx: q8(-dx * knock * TUNING.recoil), ky: q8(-dy * knock * TUNING.recoil), vx: 0, vy: 0, ch: 0, buf: 0, rev: A.rev + 1 };
    if (state === 'fight') {
      stats.hits[a]++;
      if (big) stats.big[a]++;
      if (power > stats.bestHit) stats.bestHit = power;
    }
    emit('hit', { by: a, who: b, pw: power, big, x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, dx, dy });
  }

  // Dash meets dash. Its weight scales with the bigger dash (pw): two jabs bumping is
  // a light tap with a short stop; two half-charged dashes or more is the big one.
  function clash() {
    const A = P[0];
    const B = P[1];
    const sa = dashSpeed(A.pw);
    const sb = dashSpeed(B.pw);
    const m = 1 + TUNING.clashMargin;
    if (state === 'fight') stats.clashes++;
    const x = (A.x + B.x) / 2;
    const y = (A.y + B.y) / 2;
    const pw = Math.max(A.pw, B.pw);
    const both = Math.min(A.pw, B.pw);
    if (sa >= sb * m) {
      hit(0, 1, A.pw, A.pw >= 0.5);
      return emit('clash', { win: 0, x, y, pw, both });
    }
    if (sb >= sa * m) {
      hit(1, 0, B.pw, B.pw >= 0.5);
      return emit('clash', { win: 1, x, y, pw, both });
    }
    // Close enough: both bounce back. Two jabs only nudge each other apart.
    let sx = B.x - A.x;
    let sy = B.y - A.y;
    const d = Math.sqrt(sx * sx + sy * sy) || 1;
    sx /= d;
    sy /= d;
    const bounce = pw < 0.15 ? 1 : 0.7; // two jabs: apart and out of each other's reach, so it doesn't loop
    const ka = knockFor(B.pw) * bounce;
    const kb = knockFor(A.pw) * bounce;
    const stop = clashStop(pw) + freezeExtra;
    P[0] = { ...A, ph: PH.FROZEN, t: stop, nx: PH.STUN, nt: K.stunMin, kx: q8(-sx * ka), ky: q8(-sy * ka), vx: 0, vy: 0, ch: 0, buf: 0, rev: A.rev + 1 };
    P[1] = { ...B, ph: PH.FROZEN, t: stop, nx: PH.STUN, nt: K.stunMin, kx: q8(sx * kb), ky: q8(sy * kb), vx: 0, vy: 0, ch: 0, buf: 0, rev: B.rev + 1 };
    emit('clash', { win: -1, x, y, pw, both });
  }

  // A jab breaks a charge, but only nudges the charger: it interrupts, it doesn't launch.
  const jabbed = (A, B) => (A.pw === 0 && B.ph === PH.CHARGE ? TUNING.jabOnCharge : 1);

  // Is A's dash pointed at B? A dash only lands on someone in front of it, so a fighter
  // dashing past doesn't launch someone who walks into its side or back.
  function pointed(A, B) {
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    return d < 1 || (A.fx * dx + A.fy * dy) / d > TUNING.hitFacing;
  }

  function contacts() {
    const A = P[0];
    const B = P[1];
    if (A.ph === PH.FALL || B.ph === PH.FALL || A.lock > 0 || B.lock > 0) return;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d2 = dx * dx + dy * dy;
    const reach = 2 * TUNING.radius + TUNING.hitTolerance;
    const aDash = A.ph === PH.DASH && pointed(A, B);
    const bDash = B.ph === PH.DASH && pointed(B, A);
    if ((aDash || bDash) && d2 <= reach * reach) {
      // Both coming at each other: a clash. One dashing into the other (even into the
      // back of a dash going away): a hit.
      if (aDash && bDash) return clash();
      if (aDash && B.ph !== PH.FROZEN) return hit(0, 1, A.pw, A.pw >= TUNING.bigPower, jabbed(A, B));
      if (bDash && A.ph !== PH.FROZEN) return hit(1, 0, B.pw, B.pw >= TUNING.bigPower, jabbed(B, A));
      return;
    }
    // Bodies don't pass through each other: a soft push apart.
    const min = 2 * TUNING.radius;
    if (d2 < min * min && A.ph !== PH.FROZEN && B.ph !== PH.FROZEN) {
      let d = Math.sqrt(d2);
      let nx = 1;
      let ny = 0;
      if (d > 0) {
        nx = dx / d;
        ny = dy / d;
      } else d = 0;
      const push = (min - d) / 2;
      P[0] = { ...A, x: q8(A.x - nx * push), y: q8(A.y - ny * push), rev: A.rev + 1 };
      P[1] = { ...B, x: q8(B.x + nx * push), y: q8(B.y + ny * push), rev: B.rev + 1 };
    }
  }

  function edges() {
    const fell = [];
    for (const slot of [0, 1]) {
      const p = P[slot];
      if (!p || p.ph === PH.FALL) continue;
      const i = tileAt(floe, p.x, p.y);
      const onIce = i >= 0 && elapsed() < sinkAt[i];
      if (onIce) {
        if (off[slot] >= 3 && state === 'fight') {
          stats.saves[slot]++;
          emit('save', { who: slot });
        }
        off[slot] = 0;
        continue;
      }
      if (off[slot] === 0) emit('teeter', { who: slot });
      off[slot]++;
      if (off[slot] > K.grace) {
        if (state === 'end') {
          place(slot, 0); // after the match, just put them back
          continue;
        }
        P[slot] = { ...p, ph: PH.FALL, t: 0, ch: 0, buf: 0, kx: 0, ky: 0, nx: 0, nt: 0, rev: p.rev + 1 };
        off[slot] = 0;
        fell.push(slot);
        emit('out', { who: slot, x: p.x, y: p.y });
      }
    }
    if (state !== 'fight' || fell.length === 0) return;
    state = 'over';
    overTick = tick;
    const len = tick - goTick;
    if (fell.length === 2) {
      winner = 2;
      stats.replays++;
      emit('round', { winner: -1, replay: true, scores: [...scores], round });
      return;
    }
    winner = 1 - fell[0];
    loser = fell[0];
    scores[winner]++;
    stats.rounds++;
    if (len > stats.longest) stats.longest = len;
    if (!stats.shortest || len < stats.shortest) stats.shortest = len;
    if (scores[winner] >= TUNING.roundsToWin) matchWinner = winner;
    emit('round', { winner, replay: false, scores: [...scores], round, match: matchWinner >= 0, len });
  }

  const duel = {
    floe,
    join(slot) {
      P[slot] = spawnState(sideOf(slot), P[slot]);
      off[slot] = 0;
    },
    leave(slot) {
      P[slot] = null;
      if (state !== 'wait') state = 'wait';
    },
    startMatch,
    stop() {
      started = false;
      state = 'wait';
      sinkAt = new Int32Array(floe.tiles.length).fill(NEVER);
    },
    rematch: () => startMatch(),
    has: (slot) => !!P[slot],
    player: (slot) => P[slot],
    setPlayer(slot, s) {
      P[slot] = s;
    },
    // One tick of one fighter's own input.
    stepPlayer(slot, input) {
      const p = P[slot];
      if (!p) return;
      const next = stepPlayer(p, input);
      if (isFiniteSelf(next)) P[slot] = next;
      else place(slot, 0);
    },
    // A fighter who isn't sending (hidden tab, dropped socket): neutral input until
    // they come to rest. A charge in progress is let go rather than fired.
    autopilot(slot) {
      const p = P[slot];
      if (!p) return;
      if (p.ph === PH.CHARGE) P[slot] = { ...p, ph: PH.IDLE, ch: 0, buf: 0, rev: p.rev + 1 };
      P[slot] = stepPlayer(P[slot], NEUTRAL);
    },
    // Everything after both fighters have stepped. Returns this tick's events.
    tick() {
      tick++;
      events = [];
      if (!both()) return events;
      if (state === 'wait') {
        if (started) startRound(false);
        return events;
      }
      if (state === 'cd' && tick >= goTick) {
        state = 'fight';
        emit('go', { round });
      }
      contacts();
      edges();
      if (state === 'over' && tick - overTick >= K.outro) {
        if (matchWinner >= 0) enterEnd();
        else startRound(winner === 2);
      }
      return events;
    },
    // Local play: both fighters' inputs for one tick, then the rules.
    step(inputs) {
      for (const slot of [0, 1]) if (P[slot]) duel.stepPlayer(slot, inputs[slot] ?? NEUTRAL);
      return duel.tick();
    },
    world: (ahead = 0) => makeWorld(floe, sinkAt, elapsed() + ahead),
    offTicks: (slot) => off[slot],
    get ticks() {
      return tick;
    },
    get state() {
      return state;
    },
    get round() {
      return round;
    },
    get roundSeed() {
      return roundSeed;
    },
    get goTick() {
      return goTick;
    },
    get elapsed() {
      return elapsed();
    },
    get sinkAt() {
      return sinkAt;
    },
    get scores() {
      return scores;
    },
    get stats() {
      return stats;
    },
    get winner() {
      return winner;
    },
    get matchWinner() {
      return matchWinner;
    },
    get started() {
      return started;
    },
    get crumble() {
      return { crumbleStartS: crumble.crumbleStartS ?? TUNING.crumbleStartS, crumbleEveryS: crumble.crumbleEveryS ?? TUNING.crumbleEveryS };
    },
  };
  return duel;
}

// --- the room server's rules contract ------------------------------------
// See server/room.js for the contract. Seats are pids; the duel works in slots
// (0 Coral, 1 Teal). Events go out with pids, and the view maps pid -> slot.

export function createShoveRules({ id = 'shove', crumble = {}, interpDelayMs = (1000 / TUNING.snapshotHz) * 2.5 } = {}) {
  return {
    id,
    realtime: true,
    tuning: TUNING,
    sanitizeInput,
    maxPlayers: 2,
    minPlayers: 2, // a duel: the room refuses to start a match for one
    graceMs: TUNING.graceMs,
    pauseBelow: 2,
    create(ctx) {
      const duel = createDuel({
        seed: Math.floor(ctx.random() * 4294967296),
        freezeExtra: Math.round(interpDelayMs / (1000 / TUNING.tickHz)),
        crumble,
      });
      const slotOf = new Map(); // pid -> slot
      const pidOf = [null, null];
      const brains = new Map();
      const ready = new Set();
      const freeSlot = () => (pidOf[0] === null ? 0 : pidOf[1] === null ? 1 : -1);
      // Events name players by pid, and carry the slot as well (whoSlot, winnerSlot...),
      // so a client can still place an event after that player has left the room.
      const map = (ev) => {
        const o = { ...ev };
        for (const k of ['by', 'who', 'winner', 'win']) {
          if (Number.isInteger(o[k]) && o[k] >= 0 && o[k] <= 1) {
            o[`${k}Slot`] = o[k];
            o[k] = pidOf[o[k]];
          }
        }
        return o;
      };
      const other = (slot) => duel.player(1 - slot);

      return {
        join(pid, { kind } = {}) {
          const slot = freeSlot();
          if (slot < 0) return;
          slotOf.set(pid, slot);
          pidOf[slot] = pid;
          duel.join(slot);
          // The lobby's "Play the CPU" seat is Skipper (Normal), on the same body and senses.
          if (kind === 2) brains.set(pid, createCpu({ level: 'normal', seed: Math.floor(ctx.random() * 4294967296) }));
        },
        leave(pid) {
          const slot = slotOf.get(pid);
          if (slot === undefined) return;
          const running = duel.started;
          slotOf.delete(pid);
          pidOf[slot] = null;
          brains.delete(pid);
          ready.delete(pid);
          duel.leave(slot);
          // A 1v1 can't go on without the other player: back to the lobby, with a reason.
          if (running) ctx.endMatch('opponent left');
        },
        start() {
          ready.clear();
          duel.startMatch();
        },
        end() {
          ready.clear();
          duel.stop();
        },
        // { t: 'act', a: 'rematch' }: both players press it (a CPU is always ready).
        action(pid, a) {
          if (a !== 'rematch' || duel.state !== 'end' || !slotOf.has(pid)) return;
          ready.add(pid);
          const everyone = [...slotOf.keys()].every((p) => ready.has(p) || brains.has(p));
          if (everyone) {
            ready.clear();
            duel.rematch();
          }
        },
        step(pid, input) {
          const slot = slotOf.get(pid);
          if (slot !== undefined) duel.stepPlayer(slot, input);
        },
        autopilot(pid) {
          const slot = slotOf.get(pid);
          if (slot !== undefined) duel.autopilot(slot);
        },
        botInput(pid) {
          const slot = slotOf.get(pid);
          if (slot === undefined) return null;
          return brains.get(pid)?.(duel.player(slot), other(slot), duel.world()) ?? NEUTRAL;
        },
        tick() {
          for (const ev of duel.tick()) {
            const { kind, ...data } = map(ev);
            ctx.emit(kind, data);
          }
        },
        self: (pid) => encodeSelf(duel.player(slotOf.get(pid))),
        rows: (forPid) =>
          [...slotOf.entries()]
            .filter(([pid]) => pid !== forPid)
            .map(([pid, slot]) => encodeRemote(pid, duel.player(slot), duel.offTicks(slot) > 0 ? 1 : 0)),
        view: () => ({
          st: duel.state,
          r: duel.round,
          k: duel.ticks,
          gk: duel.goTick,
          sd: duel.roundSeed,
          cr: [duel.crumble.crumbleStartS, duel.crumble.crumbleEveryS],
          sc: [...duel.scores],
          w: duel.winner,
          mw: duel.matchWinner,
          sl: Object.fromEntries(slotOf),
          rd: [...ready],
          ...(duel.state === 'end' ? { stats: duel.stats } : {}),
        }),
        team: (pid) => slotOf.get(pid) ?? 0,
        _duel: duel,
      };
    },
  };
}

export const shoveRules = createShoveRules();
