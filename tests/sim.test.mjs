// The shared step (js/game/sim.js): determinism, rest, charge and dash, the buffer,
// input validation and the floe's schedule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TUNING,
  K,
  PH,
  NEUTRAL,
  stepPlayer,
  spawnState,
  atRest,
  isNeutral,
  sanitizeInput,
  encodeSelf,
  decodeSelf,
  encodeInput,
  powerOf,
  buildFloe,
  tileAt,
  sinkSchedule,
} from '../js/game/sim.js';
import { rng } from '../js/game/rules.js';

const run = (s, inputs) => inputs.reduce((st, i) => stepPlayer(st, i), s);
const hold = (mx, my, n, b = 0) => Array.from({ length: n }, () => ({ mx, my, b }));
const tap = () => [{ mx: 0, my: 0, b: 3 }, { mx: 0, my: 0, b: 0 }];

function randomInputs(seed, n) {
  const r = rng(seed);
  const out = [];
  let held = false;
  for (let i = 0; i < n; i++) {
    const h = r() < 0.4;
    out.push({ mx: Math.round(r() * 200 - 100), my: Math.round(r() * 200 - 100), b: (h ? 1 : 0) | (h && !held ? 2 : 0) });
    held = h;
  }
  return out;
}

test('the same inputs give the same state, every value on the 1/8 grid', () => {
  const inputs = randomInputs(7, 3000);
  const a = run(spawnState(0), inputs);
  const b = run(spawnState(0), inputs);
  assert.deepEqual(encodeSelf(a), encodeSelf(b));
  // A replay from a mid-run state (what reconciliation does) lands in the same place.
  const mid = run(spawnState(0), inputs.slice(0, 1700));
  const replay = run(decodeSelf(JSON.parse(JSON.stringify(encodeSelf(mid)))), inputs.slice(1700));
  assert.deepEqual(encodeSelf(replay), encodeSelf(a));
  for (const k of ['x', 'y', 'vx', 'vy', 'kx', 'ky']) assert.equal(a[k] * 8, Math.round(a[k] * 8), `${k} is off the grid`);
});

test('a neutral step at rest is a no-op, so sending or skipping it cannot desync anyone', () => {
  const s = spawnState(1);
  assert.ok(atRest(s));
  assert.ok(isNeutral(NEUTRAL));
  assert.deepEqual(stepPlayer(s, NEUTRAL), s);
  // ...and rest is reachable after moving: speed snaps to zero below restSpeed.
  let m = run(s, hold(100, 0, 40));
  assert.ok(!atRest(m));
  let n = 0;
  while (!atRest(m) && n < 600) {
    m = stepPlayer(m, NEUTRAL);
    n++;
  }
  assert.ok(atRest(m), 'never came to rest');
  assert.ok(n < 200, `took ${n} ticks to stop`);
  assert.deepEqual(stepPlayer(m, NEUTRAL), m);
});

test('ice: you keep sliding after letting go, and top speed is capped', () => {
  let s = run(spawnState(0), hold(100, 0, 90));
  assert.ok(Math.abs(s.vx - TUNING.maxSpeed) < 1, `top speed ${s.vx}`);
  const x0 = s.x;
  s = run(s, hold(0, 0, 60));
  assert.ok(s.x - x0 > 60, `slid only ${s.x - x0}`);
});

test('a tap is a quick jab, holding charges, and the charge caps at chargeMaxMs', () => {
  const s = spawnState(0); // faces +x
  const jab = run(s, tap());
  assert.equal(jab.ph, PH.DASH);
  assert.equal(jab.pw, 0);
  assert.equal(jab.vx, TUNING.dashSpeedMin);
  const half = run(s, [{ mx: 0, my: 0, b: 3 }, ...hold(0, 0, 24, 1), { mx: 0, my: 0, b: 0 }]);
  assert.equal(half.ph, PH.DASH);
  assert.ok(half.pw > 0.3 && half.pw < 0.7, `power ${half.pw}`);
  const full = run(s, [{ mx: 0, my: 0, b: 3 }, ...hold(0, 0, 200, 1), { mx: 0, my: 0, b: 0 }]);
  assert.equal(full.pw, 1);
  assert.equal(full.vx, TUNING.dashSpeedMax);
  assert.equal(powerOf(K.chargeMax * 3), 1);
});

test('charging slows you to chargeSlow of top speed, and the dash goes where you aim', () => {
  const s = run(spawnState(0), [{ mx: 0, my: 100, b: 3 }, ...hold(0, 100, 90, 1)]);
  assert.equal(s.ph, PH.CHARGE);
  assert.ok(Math.abs(s.vy - TUNING.maxSpeed * TUNING.chargeSlow) < 1.5, `charging speed ${s.vy}`);
  const go = stepPlayer(s, { mx: 0, my: -100, b: 0 }); // aim up and let go
  assert.equal(go.ph, PH.DASH);
  assert.ok(go.vy < -TUNING.dashSpeedMin && Math.abs(go.vx) < 1);
});

test('a dash is committed: no steering until it ends, then a slow recovery', () => {
  let s = run(spawnState(0), tap());
  const dir = s.vx;
  for (let i = 0; i < K.dash - 1; i++) s = stepPlayer(s, { mx: 0, my: 100, b: 0 });
  assert.equal(s.vy, 0, 'steered during the dash');
  assert.equal(s.vx, dir);
  s = stepPlayer(s, NEUTRAL);
  assert.equal(s.ph, PH.ENDLAG);
});

test('a dash pressed during endlag fires within the buffer, but not from too early', () => {
  // Jab, run the dash out, then tap again inside the last dashBufferMs of endlag.
  let s = run(spawnState(0), tap());
  while (s.ph === PH.DASH) s = stepPlayer(s, NEUTRAL);
  assert.equal(s.ph, PH.ENDLAG);
  while (s.t > K.buffer - 2) s = stepPlayer(s, NEUTRAL);
  s = run(s, tap()); // pressed and released while still recovering
  let fired = -1;
  for (let i = 0; i < K.buffer + 4; i++) {
    s = stepPlayer(s, NEUTRAL);
    if (s.ph === PH.DASH) {
      fired = i;
      break;
    }
  }
  assert.ok(fired >= 0, 'the buffered dash never fired');

  // Pressed with more than the buffer still to go: dropped, no surprise dash later.
  let e = run(spawnState(0), tap());
  while (e.ph === PH.DASH) e = stepPlayer(e, NEUTRAL);
  assert.ok(e.t > K.buffer + 2);
  e = run(e, tap());
  for (let i = 0; i < K.endlag + 10; i++) {
    e = stepPlayer(e, NEUTRAL);
    assert.notEqual(e.ph, PH.DASH);
  }
});

test('during the countdown you can turn but not move; holding dash through GO starts a charge', () => {
  let s = { ...spawnState(0), lock: 5 };
  s = run(s, hold(0, -100, 5, 1));
  assert.equal(s.x, spawnState(0).x);
  assert.equal(s.fy, -1);
  s = stepPlayer(s, { mx: 0, my: 0, b: 1 });
  assert.equal(s.ph, PH.CHARGE);
});

test('the server rejects malformed inputs', () => {
  assert.deepEqual(sanitizeInput(encodeInput({ seq: 4, mx: 71, my: -71, b: 3 })), { seq: 4, mx: 71, my: -71, b: 3 });
  for (const bad of [null, [], [1, 0, 0], [0, 0, 0, 0], [1, 101, 0, 0], [1, 0.5, 0, 0], [1, 0, 0, 4], [1, 'x', 0, 0], [1, 0, 0, 0, 0], [1.5, 0, 0, 0]]) {
    assert.equal(sanitizeInput(bad), null, JSON.stringify(bad));
  }
});

test('the floe: 91 tiles, point lookup, and a schedule where every tile sinks', () => {
  const floe = buildFloe();
  assert.equal(floe.tiles.length, 1 + 3 * TUNING.rings * (TUNING.rings + 1));
  assert.equal(tileAt(floe, 0, 0), 0);
  assert.equal(tileAt(floe, 1000, 0), -1);
  for (const [i, t] of floe.tiles.entries()) assert.equal(tileAt(floe, t.x + 3, t.y - 3), i);

  const at = sinkSchedule(floe, 1234);
  const s = (sec) => Math.round(sec * TUNING.tickHz);
  assert.equal(Math.min(...at), s(TUNING.crumbleStartS), 'the first tiles sink at crumbleStartS');
  assert.equal(at[0], Math.max(...at), 'the centre goes last');
  assert.ok(at[0] <= s(60), 'everything is gone by 60 s');
  const ring1 = floe.tiles.map((t, i) => [t, at[i]]).filter(([t]) => t.ring === 1);
  const T = TUNING;
  const ring1At = T.crumbleStartS + T.crumbleEveryS * (2 * (T.rings - 1));
  assert.ok(ring1.every(([, a]) => a === s(ring1At)), `ring 1 goes at ${ring1At} s, leaving only the centre`);
  // Each outer ring goes in two halves, 5 s apart, and the seed picks the halves.
  const outer = floe.tiles.map((t, i) => [t, at[i]]).filter(([t]) => t.ring === TUNING.rings);
  const times = [...new Set(outer.map(([, a]) => a))].sort((x, y) => x - y);
  assert.deepEqual(times, [s(T.crumbleStartS), s(T.crumbleStartS + T.crumbleEveryS)]);
  assert.equal(outer.filter(([, a]) => a === s(T.crumbleStartS)).length, outer.length / 2);
  assert.deepEqual([...sinkSchedule(floe, 1234)], [...at], 'same seed, same schedule');
  assert.notDeepEqual([...sinkSchedule(floe, 99)], [...at], 'another seed, other halves');
});
