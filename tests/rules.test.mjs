// The rules (js/game/rules.js): hits, clashes, the edge grace, ring-outs, rounds,
// the match, and the room adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, createShoveRules, createBrain, rng, clashStop } from '../js/game/rules.js';
import { TUNING, K, PH, NEUTRAL, spawnState, knockFor, stepPlayer } from '../js/game/sim.js';

// A duel in the middle of a fight, past the countdown.
function fighting(seed = 1) {
  const duel = createDuel({ seed });
  duel.join(0);
  duel.join(1);
  duel.startMatch();
  for (let i = 0; i < K.countdown + 2; i++) duel.step([NEUTRAL, NEUTRAL]);
  assert.equal(duel.state, 'fight');
  return duel;
}
const at = (duel, slot, patch) => duel.setPlayer(slot, { ...duel.player(slot), ...patch });
const steps = (duel, n, inputs = [NEUTRAL, NEUTRAL]) => {
  const evs = [];
  for (let i = 0; i < n; i++) evs.push(...duel.step(inputs));
  return evs;
};

test('a dash hit freezes both (hitstop), then launches the victim and recoils the attacker', () => {
  const duel = fighting();
  at(duel, 0, { x: -40, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 1, vx: 900, vy: 0 });
  at(duel, 1, { x: 8, y: 0 }); // 48 apart: inside the 52-unit reach
  const rev = [duel.player(0).rev, duel.player(1).rev];
  const [ev] = duel.tick().filter((e) => e.kind === 'hit');
  assert.ok(ev, 'no hit');
  assert.equal(ev.by, 0);
  assert.equal(ev.who, 1);
  assert.equal(ev.big, true);
  const [a, v] = [duel.player(0), duel.player(1)];
  assert.equal(v.ph, PH.FROZEN);
  assert.equal(a.ph, PH.FROZEN);
  assert.equal(v.t, K.bigHitstop);
  assert.ok(v.kx > knockFor(1) * 0.9, `launch ${v.kx}`);
  assert.ok(a.kx < 0, 'attacker recoils backward');
  assert.ok(Math.abs(a.kx) < Math.abs(v.kx) * 0.3);
  assert.deepEqual([a.rev, v.rev], [rev[0] + 1, rev[1] + 1], 'server changes bump rev');
  steps(duel, K.bigHitstop);
  assert.equal(duel.player(1).ph, PH.STUN);
  assert.ok(duel.player(1).vx > 500);
});

test('online, the victim stays frozen for the interpolation delay too, so the attacker visibly arrives first', () => {
  const duel = createDuel({ seed: 3, freezeExtra: 5 });
  duel.join(0);
  duel.join(1);
  duel.startMatch();
  for (let i = 0; i < K.countdown + 2; i++) duel.step([NEUTRAL, NEUTRAL]);
  at(duel, 0, { x: -40, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 0, vx: 520 });
  at(duel, 1, { x: 10, y: 0 });
  duel.tick();
  assert.equal(duel.player(1).t, K.hitstop + 5);
  assert.equal(duel.player(0).t, K.hitstop);
});

test('a clash: a dash 25% stronger wins it, closer dashes both bounce', () => {
  const duel = fighting();
  at(duel, 0, { x: -25, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 1 });
  at(duel, 1, { x: 25, y: 0, fx: -1, fy: 0, ph: PH.DASH, t: 5, pw: 0 });
  const evs = duel.tick();
  assert.equal(evs.find((e) => e.kind === 'clash').win, 0);
  assert.equal(evs.find((e) => e.kind === 'hit').who, 1);

  const even = fighting(2);
  at(even, 0, { x: -25, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 0.5 });
  at(even, 1, { x: 25, y: 0, fx: -1, fy: 0, ph: PH.DASH, t: 5, pw: 0.6 });
  const e2 = even.tick();
  assert.equal(e2.find((e) => e.kind === 'clash').win, -1);
  assert.ok(even.player(0).kx < 0 && even.player(1).kx > 0, 'both pushed apart');
});

test('a clash weighs what the dashes do: two jabs bump lightly, two big dashes stop the world', () => {
  // Clashes are common (about 2-8 a round between people), so a jab-on-jab bump gets a
  // short stop and no shake; the full 140 ms is for dashes at least half charged.
  const jabs = fighting();
  at(jabs, 0, { x: -25, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 0 });
  at(jabs, 1, { x: 25, y: 0, fx: -1, fy: 0, ph: PH.DASH, t: 5, pw: 0 });
  const small = jabs.tick().find((e) => e.kind === 'clash');
  assert.equal(small.pw, 0);
  assert.equal(jabs.player(0).t, clashStop(0));
  assert.ok(clashStop(0) <= Math.round(0.045 * TUNING.tickHz), `jab clash stop ${clashStop(0)} ticks`);
  assert.ok(jabs.player(0).kx <= -knockFor(0) * 0.9, 'two jabs end up out of each other\'s reach, so it does not loop');
  const big = fighting(2);
  at(big, 0, { x: -25, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 0.6 });
  at(big, 1, { x: 25, y: 0, fx: -1, fy: 0, ph: PH.DASH, t: 5, pw: 0.7 });
  const e = big.tick().find((x) => x.kind === 'clash');
  assert.ok(e.pw >= 0.5 && e.both >= 0.5);
  assert.equal(big.player(0).t, K.bigHitstop);
});

test('a dash only lands on someone in front of it: walking into its side or back is a push', () => {
  const duel = fighting();
  // Dashing right (+x) past someone just behind and to the side.
  at(duel, 0, { x: 0, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 1, vx: 900, vy: 0 });
  at(duel, 1, { x: -30, y: 40 });
  assert.equal(duel.tick().filter((e) => e.kind === 'hit').length, 0, 'launched by the back of a dash');
  const front = fighting(2);
  at(front, 0, { x: 0, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 1, vx: 900, vy: 0 });
  at(front, 1, { x: 40, y: 20 });
  assert.equal(front.tick().filter((e) => e.kind === 'hit').length, 1, 'a dash at someone in front lands');
  // Two dashes going away from each other don't clash.
  const apart = fighting(3);
  at(apart, 0, { x: -20, y: 0, fx: -1, fy: 0, ph: PH.DASH, t: 5, pw: 0.5 });
  at(apart, 1, { x: 20, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 0.5 });
  assert.equal(apart.tick().filter((e) => e.kind === 'clash' || e.kind === 'hit').length, 0);
});

test('a jab costs more recovery than a charged dash, and breaks a charge without launching the charger', () => {
  assert.ok(K.endlagJab > K.endlag, 'a jab recovers slower than a charged dash');
  assert.ok(K.endlagJab > K.stunMin, 'someone jabbed is back on their feet before the jabber recovers');
  let s = spawnState(0);
  s = { ...s, lock: 0 };
  s = stepPlayer(s, { mx: 0, my: 0, b: 3 }); // press
  s = stepPlayer(s, { mx: 0, my: 0, b: 0 }); // release at once: a jab
  while (s.ph === PH.DASH) s = stepPlayer(s, NEUTRAL);
  assert.equal(s.ph, PH.ENDLAG);
  assert.ok(s.t >= K.endlagJab - 1, `jab endlag ${s.t}`);
  const duel = fighting();
  at(duel, 0, { x: -40, y: 0, fx: 1, fy: 0, ph: PH.DASH, t: 5, pw: 0, vx: 520 });
  at(duel, 1, { x: 8, y: 0, ph: PH.CHARGE, ch: 20 });
  duel.tick();
  assert.ok(Math.abs(duel.player(1).kx - knockFor(0) * TUNING.jabOnCharge) < 1, 'a jab on a charge only nudges');
  assert.equal(duel.player(0).nt, K.endlagJab, 'the jabber recovers like a jab');
});

test('bodies push apart instead of overlapping', () => {
  const duel = fighting();
  at(duel, 0, { x: -5, y: 0 });
  at(duel, 1, { x: 5, y: 0 });
  duel.tick();
  assert.ok(duel.player(1).x - duel.player(0).x >= 2 * TUNING.radius - 0.25);
});

test('the edge grace: a fighter just off the ice can walk back on', () => {
  const duel = fighting();
  // x = 0 is the seam between two bottom tiles, where the ice ends at y = 272.
  at(duel, 0, { x: -200, y: 0 });
  at(duel, 1, { x: 0, y: 282, vx: 0, vy: -120 });
  const toward = { mx: 0, my: -100, b: 0 };
  const evs = steps(duel, 12, [NEUTRAL, toward]);
  assert.notEqual(duel.player(1).ph, PH.FALL, 'fell inside the grace');
  assert.ok(evs.some((e) => e.kind === 'teeter' && e.who === 1));
  assert.ok(evs.some((e) => e.kind === 'save' && e.who === 1), 'a clutch save');
  assert.ok(!evs.some((e) => e.kind === 'round'));

  // Standing off the edge past the grace: a ring-out.
  const d2 = fighting(5);
  at(d2, 1, { x: 0, y: 400 });
  const out = steps(d2, K.grace + 2);
  assert.equal(d2.player(1).ph, PH.FALL);
  const round = out.find((e) => e.kind === 'round');
  assert.equal(round.winner, 0);
  assert.deepEqual(round.scores, [1, 0]);
});

test('a clutch save is counted when you get back inside the grace', () => {
  const duel = fighting();
  at(duel, 1, { x: 0, y: 400 });
  steps(duel, 4); // off for 4 ticks, inside the 7-tick grace
  at(duel, 1, { x: 0, y: 0 });
  const evs = steps(duel, 1);
  assert.ok(evs.some((e) => e.kind === 'save' && e.who === 1));
  assert.equal(duel.stats.saves[1], 1);
});

test('a double ring-out replays the round and nobody scores', () => {
  const duel = fighting();
  const round = duel.round;
  at(duel, 0, { x: -500, y: 0 });
  at(duel, 1, { x: 500, y: 0 });
  const evs = steps(duel, K.grace + 2);
  const r = evs.find((e) => e.kind === 'round');
  assert.equal(r.replay, true);
  assert.deepEqual([...duel.scores], [0, 0]);
  const next = steps(duel, K.outro + 2).find((e) => e.kind === 'round-start');
  assert.ok(next, 'no new round');
  assert.equal(next.replay, true);
  assert.equal(duel.round, round, 'a replay keeps the round number');
});

test('spawn sides swap every round, and the match ends at roundsToWin with a rematch', () => {
  const duel = fighting();
  const sides = [Math.sign(duel.player(0).x)];
  for (let r = 0; r < TUNING.roundsToWin; r++) {
    if (r > 0) {
      steps(duel, K.outro + 1);
      sides.push(Math.sign(duel.player(0).x));
      steps(duel, K.countdown + 1);
    }
    at(duel, 1, { x: 0, y: 500 });
    steps(duel, K.grace + 2);
  }
  assert.deepEqual(sides, [sides[0], -sides[0], sides[0]]);
  const evs = steps(duel, K.outro + 1);
  assert.equal(duel.state, 'end');
  assert.equal(evs.find((e) => e.kind === 'match').winner, 0);
  assert.equal(duel.stats.rounds, 3);
  duel.rematch();
  steps(duel, 1);
  assert.equal(duel.state, 'cd');
  assert.deepEqual([...duel.scores], [0, 0]);
  assert.equal(duel.round, 1);
});

test('the floe sinks on schedule, and standing on a sunk tile is a ring-out', () => {
  const duel = fighting();
  // Park slot 1 on an outer tile that sinks at the first crumble.
  const outer = duel.floe.tiles.findIndex((t, i) => t.ring === TUNING.rings && duel.sinkAt[i] === Math.round(TUNING.crumbleStartS * TUNING.tickHz));
  const tile = duel.floe.tiles[outer];
  at(duel, 0, { x: 0, y: 0 });
  at(duel, 1, { x: tile.x, y: tile.y });
  let fell = null;
  for (let i = 0; i < (TUNING.crumbleStartS + 1) * TUNING.tickHz && !fell; i++) {
    at(duel, 1, { x: tile.x, y: tile.y, vx: 0, vy: 0 });
    for (const e of duel.step([NEUTRAL, NEUTRAL])) if (e.kind === 'out') fell = duel.elapsed;
  }
  assert.ok(fell, 'never fell');
  assert.ok(Math.abs(fell - duel.sinkAt[outer] - K.grace) <= 2, `fell at ${fell}, tile sank at ${duel.sinkAt[outer]}`);
});

test('a player who stops sending is brought to rest, and a charge in progress is let go, not fired', () => {
  const duel = fighting();
  at(duel, 0, { x: 0, y: 0, ph: PH.CHARGE, ch: 30, vx: 100, vy: 0 });
  duel.autopilot(0);
  assert.equal(duel.player(0).ph, PH.IDLE);
  for (let i = 0; i < 200; i++) duel.autopilot(0);
  const p = duel.player(0);
  assert.equal(p.vx, 0);
  assert.notEqual(p.ph, PH.DASH);
});

test('the CPU brains only ever produce valid inputs', () => {
  const duel = fighting(9);
  const r = rng(4);
  const brains = [createBrain('balanced', r), createBrain('spammer', r)];
  for (let i = 0; i < 3000; i++) {
    const w = duel.world();
    const inputs = [0, 1].map((s) => brains[s](duel.player(s), duel.player(1 - s), w));
    for (const i of inputs) {
      assert.ok(Number.isInteger(i.mx) && Math.abs(i.mx) <= 100 && Number.isInteger(i.my) && Math.abs(i.my) <= 100 && i.b >= 0 && i.b <= 3, JSON.stringify(i));
    }
    duel.step(inputs);
  }
});

test('room adapter: seats map to Coral and Teal, a third is refused, rematch needs both humans', () => {
  const events = [];
  let seed = 1;
  const ctx = { random: () => ((seed = (seed * 16807) % 2147483647) / 2147483647), emit: (kind, data) => events.push({ kind, ...data }), isOnline: () => true, log: () => {} };
  const game = createShoveRules().create(ctx);
  game.join('p1', { kind: 0 });
  game.join('p2', { kind: 0 });
  game.join('p3', { kind: 0 }); // no free slot: ignored (the room also caps seats at 2)
  assert.equal(game.team('p1'), 0);
  assert.equal(game.team('p2'), 1);
  assert.deepEqual(game.view().sl, { p1: 0, p2: 1 });
  game.start();
  game.tick();
  assert.equal(game.view().st, 'cd');
  assert.equal(game.rows('p1').length, 1);
  assert.equal(game.rows('p1')[0][0], 'p2');
  const duel = game._duel;
  // Win three quick rounds for p1.
  for (let r = 0; r < 3; r++) {
    while (duel.state !== 'fight') {
      game.step('p1', { ...NEUTRAL, seq: 1 });
      game.step('p2', { ...NEUTRAL, seq: 1 });
      game.tick();
    }
    duel.setPlayer(1, { ...duel.player(1), x: 0, y: 600 });
    for (let i = 0; i < K.grace + 2; i++) game.tick();
  }
  for (let i = 0; i < K.outro + 1; i++) game.tick();
  assert.equal(game.view().st, 'end');
  assert.ok(game.view().stats, 'the scoreboard carries the match stats');
  assert.equal(events.find((e) => e.kind === 'match').winner, 'p1');
  game.action('p1', 'rematch');
  assert.equal(game.view().st, 'end', 'one player alone cannot restart');
  assert.deepEqual(game.view().rd, ['p1']);
  game.action('p2', 'rematch');
  game.tick();
  assert.equal(game.view().st, 'cd');
  assert.deepEqual(game.view().sc, [0, 0]);
});

test('spawnState faces the other side', () => {
  assert.equal(spawnState(0).fx, 1);
  assert.equal(spawnState(1).fx, -1);
});
