// The frame loop's draw cap (js/lib/loop.js maxFps, 60 on touch screens): it skips by a
// whole-number divisor of the display rate, so a 90 Hz phone still draws every frame
// instead of being halved to 45 fps, and a 120 Hz one draws 60.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoop } from '../js/lib/loop.js';

function drawnFps(hz, { maxFps = 60, seconds = 3, jitterMs = 0.3 } = {}) {
  let draws = 0;
  let updates = 0;
  const loop = createLoop({ hz: 60, maxFps, update: () => updates++, render: () => draws++ });
  let t = 1000;
  let s = 7;
  const frames = Math.round(hz * seconds);
  // Skip the first second while the divisor settles, then count.
  let counted = 0;
  for (let i = 0; i < frames; i++) {
    s = (s * 16807) % 2147483647;
    t += 1000 / hz + ((s / 2147483647) * 2 - 1) * jitterMs;
    if (i === Math.round(hz)) counted = draws;
    loop.tick(t);
  }
  return { fps: (draws - counted) / (seconds - 1), updates };
}

test('the 60 fps draw cap: 60 Hz and 90 Hz draw every frame, 120 Hz draws 60, 144 Hz draws 72', () => {
  const r = Object.fromEntries([60, 90, 120, 144].map((hz) => [hz, drawnFps(hz).fps]));
  console.log('drawn fps by display rate:', JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)]))));
  for (const [hz, fps] of Object.entries(r)) {
    assert.ok(fps >= Math.min(60, Number(hz)) - 1, `${hz} Hz drew only ${fps.toFixed(1)} fps`);
    assert.ok(fps <= Number(hz) + 1, `${hz} Hz drew ${fps.toFixed(1)} fps`);
  }
  assert.ok(Math.abs(r[90] - 90) < 2, `90 Hz drew ${r[90].toFixed(1)}, not every frame`);
  assert.ok(Math.abs(r[120] - 60) < 2, `120 Hz drew ${r[120].toFixed(1)}`);
  // The simulation itself is unaffected: still 60 steps a second.
  const { updates } = drawnFps(120);
  assert.ok(Math.abs(updates - 180) <= 2, `${updates} steps in 3 s`);
});

test('without a cap every display frame is drawn', () => {
  assert.ok(Math.abs(drawnFps(144, { maxFps: 0 }).fps - 144) < 2);
});
