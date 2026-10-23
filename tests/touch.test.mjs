// Touch controls (js/touch.js) with simulated pointer events, through the real input
// path: router -> controls.js -> deviceInput -> the shared sim step. Covers the stick's
// vectors and dead zone, two fingers at once, tap versus hold, cancels, and the two
// shared-screen layouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOUCH, stickVector, layoutPads, hitPad, toPad, createTouchRouter } from '../js/touch.js';
import { createControls } from '../js/controls.js';
import { TUNING, K, PH, stepPlayer, spawnState } from '../js/game/sim.js';

const R = TOUCH.radius;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// A phone held upright: 390 x 844 CSS px.
function rig(kind = 'solo', w = 390, h = 844, opts = {}) {
  const controls = createControls();
  controls.setEnabled(true);
  const visuals = [];
  const router = createTouchRouter({ controls, onVisual: (...a) => visuals.push(a) });
  router.setPads(layoutPads(kind, w, h, opts));
  let id = 0;
  const finger = (x, y) => {
    const pointerId = ++id;
    const taken = router.down({ pointerId, x, y });
    return {
      taken,
      move: (nx, ny) => router.move({ pointerId, x: nx, y: ny }),
      up: () => router.up({ pointerId }),
      cancel: () => router.cancel({ pointerId }),
    };
  };
  // One fixed tick of input, exactly as local.js samples it.
  const tick = (slot = 0) => {
    controls.step();
    return controls.sample(slot);
  };
  return { controls, router, finger, tick, visuals };
}

test('stick vector: radial dead zone, scaled up to a full push at the rim, direction kept', () => {
  const dz = TOUCH.deadzone;
  // Inside or on the dead zone: nothing, in every direction.
  for (const a of [0, 0.7, 2, 3.9, 5.5]) {
    const v = stickVector(Math.cos(a) * dz * R * 0.99, Math.sin(a) * dz * R * 0.99);
    assert.deepEqual([v.x, v.y], [0, 0]);
  }
  assert.deepEqual(stickVector(dz * R, 0), { x: 0, y: 0 });
  // Just past it: a slow walk, not a jump to 18%.
  const small = stickVector((dz + 0.02) * R, 0);
  assert.ok(small.x > 0 && small.x < 0.05, `just past the dead zone gives ${small.x}`);
  // Halfway between the dead zone and the rim: half a push.
  const mid = stickVector(((dz + 1) / 2) * R, 0);
  assert.ok(near(mid.x, 0.5, 1e-9), `mid push ${mid.x}`);
  // At the rim and beyond: length exactly 1.
  for (const d of [R, R * 1.3, R * 5]) {
    const v = stickVector(d * Math.cos(1), d * Math.sin(1));
    assert.ok(near(Math.hypot(v.x, v.y), 1, 1e-12));
    assert.ok(near(Math.atan2(v.y, v.x), 1, 1e-12), 'direction is exact');
  }
  // Monotonic along a ray.
  let last = -1;
  for (let d = 0; d <= R * 1.2; d += 2) {
    const m = Math.hypot(...Object.values(stickVector(d * 0.6, d * 0.8)));
    assert.ok(m >= last - 1e-12);
    last = m;
  }
});

test('a drag on the left half moves you; the amount follows the thumb; letting go stops you', () => {
  const { finger, tick, controls } = rig();
  const f = finger(80, 600);
  assert.ok(f.taken, 'left half is the stick');
  assert.deepEqual(tick(), { mx: 0, my: 0, b: 0 }, 'the stick appears where the thumb lands: no movement yet');
  f.move(80 + R, 600); // a full push right
  assert.deepEqual(tick(), { mx: 100, my: 0, b: 0 });
  f.move(80, 600 - R * 2); // up, past the rim
  assert.deepEqual(tick(), { mx: 0, my: -100, b: 0 });
  f.move(80, 600 - R * 2 - ((TOUCH.deadzone + 1) / 2) * R); // the centre followed: now a half push up from the trailing centre
  const half = tick();
  assert.equal(half.mx, 0);
  assert.ok(half.my <= -99, `still pushing up (${half.my})`);
  f.up();
  assert.deepEqual(tick(), { mx: 0, my: 0, b: 0 });
  assert.equal(controls.device, 'touch');
  assert.ok(controls.used(0), 'counts as using your controls (the tutorial hint fades)');
});

test('dead zone: a thumb resting and wobbling a few px does nothing', () => {
  const { finger, tick } = rig();
  const f = finger(100, 700);
  for (const [dx, dy] of [
    [3, 0],
    [-5, 4],
    [0, -8],
    [6, 6],
  ]) {
    f.move(100 + dx, 700 + dy);
    assert.deepEqual(tick(), { mx: 0, my: 0, b: 0 }, `wobble ${dx},${dy}`);
  }
  f.move(100 + R * 0.6, 700);
  assert.ok(tick().mx > 30, 'a real push gets through');
});

test('the stick centre trails the thumb, so swinging back reverses at once', () => {
  const { finger, tick } = rig();
  const f = finger(60, 600);
  f.move(60 + 200, 600); // far past the rim: the centre is dragged along behind
  assert.equal(tick().mx, 100);
  f.move(60 + 200 - TOUCH.follow * R - R * 0.6, 600); // back past where the centre now sits
  const back = tick();
  assert.ok(back.mx < -30, `turned left at once (${back.mx}); a fixed centre would still say right`);
});

test('two fingers at once: steer with one, hold DASH with the other, each lets go on its own', () => {
  const { finger, tick } = rig();
  const stick = finger(70, 620);
  const dash = finger(320, 700);
  assert.ok(stick.taken && dash.taken);
  stick.move(70 - R, 620);
  let i = tick();
  assert.equal(i.mx, -100);
  assert.equal(i.b, 3, 'held, and pressed this tick');
  i = tick();
  assert.equal(i.b, 1, 'still held; the press edge counts once');
  assert.equal(i.mx, -100, 'still steering');
  // A third finger on the left half doesn't steal or recentre the stick.
  const extra = finger(150, 500);
  assert.equal(extra.taken, false);
  assert.equal(tick().mx, -100);
  // The stick thumb slides over into the DASH half: it keeps steering.
  stick.move(260, 620);
  assert.equal(tick().mx, 100);
  dash.up();
  i = tick();
  assert.equal(i.b, 0);
  assert.equal(i.mx, 100, 'lifting DASH leaves the stick alone');
  stick.up();
  assert.deepEqual(tick(), { mx: 0, my: 0, b: 0 });
});

test('a cancelled pointer (system gesture, rotation, palm) never leaves a control stuck', () => {
  const { finger, tick, router } = rig();
  const s = finger(50, 600);
  const d = finger(300, 600);
  s.move(50 + R, 600);
  assert.equal(tick().b, 3);
  s.cancel();
  d.cancel();
  assert.deepEqual(tick(), { mx: 0, my: 0, b: 0 });
  assert.equal(router.fingers, 0);
  // A layout change mid-press lets go too.
  const d2 = finger(300, 600);
  assert.ok(d2.taken);
  assert.equal(tick().b, 3);
  router.setPads(layoutPads('solo', 844, 390));
  assert.equal(tick().b, 0);
});

// Tap versus hold, all the way into the shared sim step.
function play(rigged, script) {
  let s = { ...spawnState(0) };
  const seen = [];
  for (const step of script) {
    step.before?.();
    const input = rigged.tick(0);
    s = stepPlayer(s, input);
    seen.push({ input, ph: s.ph, pw: s.pw, vx: s.vx });
  }
  return { s, seen };
}
const ticks = (n, before) => Array.from({ length: n }, (_, i) => ({ before: i === 0 ? before : undefined }));

test('DASH: a tap is a jab, even one shorter than a tick', () => {
  for (const holdTicks of [0, 1, 3]) {
    const r = rig();
    let dash;
    const script = [...ticks(1, () => (dash = r.finger(300, 650))), ...ticks(Math.max(0, holdTicks - 1)), ...ticks(3, () => dash.up())];
    if (holdTicks === 0) {
      // Down and up between two ticks: the press still lands exactly once.
      script.splice(0, script.length, ...ticks(1, () => (r.finger(300, 650).up())), ...ticks(2));
    }
    const { seen } = play(r, script);
    const dashTick = seen.find((x) => x.ph === PH.DASH);
    assert.ok(dashTick, `a ${holdTicks}-tick tap dashed`);
    assert.equal(dashTick.pw, 0, 'at zero power: a jab');
    assert.equal(dashTick.vx, TUNING.dashSpeedMin, 'jab speed (Coral faces right at spawn)');
    assert.equal(seen.filter((x) => x.input.b & 2).length, 1, 'one press edge');
  }
});

test('DASH: holding charges (you see the charge build), letting go launches at full power', () => {
  const r = rig();
  let dash;
  const holdFor = K.chargeMax + 10;
  const { seen } = play(r, [...ticks(holdFor, () => (dash = r.finger(330, 700))), ...ticks(2, () => dash.up())]);
  const charging = seen.slice(K.tap + 1, holdFor);
  assert.ok(charging.every((x) => x.ph === PH.CHARGE && (x.input.b & 1) === 1), 'charging the whole time it is held');
  assert.equal(seen[holdFor].ph, PH.DASH, 'launches on release');
  assert.equal(seen[holdFor].pw, 1, 'full power');
  assert.equal(seen[holdFor].vx, TUNING.dashSpeedMax);
});

test('DASH: a half hold gives a half-power dash', () => {
  const r = rig();
  let dash;
  const n = Math.round((K.tap + K.chargeMax) / 2);
  const { seen } = play(r, [...ticks(n, () => (dash = r.finger(330, 700))), ...ticks(2, () => dash.up())]);
  const launched = seen.find((x) => x.ph === PH.DASH);
  assert.ok(launched.pw > 0.3 && launched.pw < 0.7, `power ${launched.pw}`);
});

test('menus open: touches do nothing to the game, and no press is banked for later', () => {
  const r = rig();
  r.controls.setEnabled(false);
  const d = r.finger(300, 600);
  d.up();
  r.controls.setEnabled(true);
  assert.deepEqual(r.tick(), { mx: 0, my: 0, b: 0 });
});

test('left-handed swap: DASH on the left half, the stick on the right', () => {
  const pads = layoutPads('solo', 844, 390, { swap: true });
  assert.equal(hitPad(pads, 100, 300).part, 'dash');
  assert.equal(hitPad(pads, 700, 300).part, 'stick');
});

test('shared screen, upright (split-v): each player gets their own stick and DASH, turned toward them', () => {
  const W = 820;
  const H = 1180; // a tablet flat on a table, one player at each end
  const pads = layoutPads('split-v', W, H);
  // Bottom player (Coral): their left is the screen's left.
  assert.deepEqual([hitPad(pads, 100, 1000).pad.slot, hitPad(pads, 100, 1000).part], [0, 'stick']);
  assert.deepEqual([hitPad(pads, 700, 1000).pad.slot, hitPad(pads, 700, 1000).part], [0, 'dash']);
  // Top player (Teal), facing the other way: their left is the screen's right.
  assert.deepEqual([hitPad(pads, 700, 150).pad.slot, hitPad(pads, 700, 150).part], [1, 'stick']);
  assert.deepEqual([hitPad(pads, 100, 150).pad.slot, hitPad(pads, 100, 150).part], [1, 'dash']);
  // The pad's own frame: "toward the player" is +y for both.
  assert.ok(toPad(pads[0], W / 2, H - 5)[1] > 0);
  assert.ok(toPad(pads[1], W / 2, 5)[1] > 0);

  const { finger, controls } = rig('split-v', W, H);
  const coralStick = finger(100, 1000);
  const coralDash = finger(700, 1050);
  const tealStick = finger(700, 150);
  const tealDash = finger(100, 120);
  assert.ok([coralStick, coralDash, tealStick, tealDash].every((f) => f.taken), 'four thumbs at once');
  coralStick.move(100 + R, 1000);
  // Teal drags toward the bottom of the screen, away from themselves: their fighter
  // goes down the screen, where they pushed. The stick works in screen space.
  tealStick.move(700, 150 + R);
  controls.step();
  assert.deepEqual(controls.sample(0), { mx: 100, my: 0, b: 3 });
  assert.deepEqual(controls.sample(1), { mx: 0, my: 100, b: 3 });
  tealDash.up();
  coralStick.up();
  controls.step();
  assert.deepEqual(controls.sample(0), { mx: 0, my: 0, b: 1 });
  assert.deepEqual(controls.sample(1), { mx: 0, my: 100, b: 0 });
});

test('shared screen, sideways (split-h): players at the left and right ends', () => {
  const W = 844;
  const H = 390; // a phone flat between two players
  const pads = layoutPads('split-h', W, H);
  // Left-end player (Coral) faces right: their left hand is toward the screen's top.
  assert.deepEqual([hitPad(pads, 150, 60).pad.slot, hitPad(pads, 150, 60).part], [0, 'stick']);
  assert.deepEqual([hitPad(pads, 150, 330).pad.slot, hitPad(pads, 150, 330).part], [0, 'dash']);
  // Right-end player (Teal) faces left: their left hand is toward the screen's bottom.
  assert.deepEqual([hitPad(pads, 700, 330).pad.slot, hitPad(pads, 700, 330).part], [1, 'stick']);
  assert.deepEqual([hitPad(pads, 700, 60).pad.slot, hitPad(pads, 700, 60).part], [1, 'dash']);
  // Every point on the screen belongs to exactly one player's half.
  for (let x = 1; x < W; x += 37) for (let y = 1; y < H; y += 29) assert.ok(hitPad(pads, x, y), `${x},${y} is in a pad`);
  const { finger, controls } = rig('split-h', W, H);
  const a = finger(150, 60);
  const b = finger(700, 330);
  a.move(150 + R, 60);
  b.move(700 - R, 330);
  controls.step();
  assert.equal(controls.sample(0).mx, 100);
  assert.equal(controls.sample(1).mx, -100);
});

test('the router reports what to draw: where the stick sits and whether DASH is down', () => {
  const { finger, visuals } = rig();
  const s = finger(90, 610);
  s.move(90 + 20, 610);
  const d = finger(300, 600);
  d.up();
  s.up();
  const kinds = visuals.map(([k, slot, st]) => `${k}:${slot}:${st === null ? 'off' : typeof st === 'object' ? 'on' : st}`);
  assert.deepEqual(kinds, ['stick:0:on', 'stick:0:on', 'dash:0:true', 'dash:0:false', 'stick:0:off']);
  assert.equal(visuals[1][2].ox, 90, 'the stick sits where the thumb landed');
});

test("a browser bar sliding (same layout, new size) keeps a held charge; turning the phone doesn't leave one stuck", () => {
  const { finger, tick, router } = rig('solo', 390, 844);
  const d = finger(330, 700);
  const s = finger(60, 700);
  s.move(60 + R, 700);
  assert.equal(tick().b, 3);
  router.setPads(layoutPads('solo', 390, 790), { keep: true }); // Safari's toolbar came back
  const held = tick();
  assert.equal(held.b, 1, 'still charging');
  assert.equal(held.mx, 100, 'still steering');
  d.up();
  assert.equal(tick().b, 0);
  const d2 = finger(330, 700);
  assert.ok(d2.taken);
  router.setPads(layoutPads('solo', 844, 390)); // rotated: a different layout
  assert.equal(tick().b & 1, 0, 'nothing held after the turn (the press itself still counts once, like any tap)');
  assert.deepEqual(tick(), { mx: 0, my: 0, b: 0 });
});

test('a key or a pad hides the touch controls, a touch brings them back (device tracking)', () => {
  const controls = createControls();
  const seen = [];
  controls.setDevice('touch');
  controls.onDevice((d) => seen.push(d));
  controls.useDevice('keys');
  controls.useDevice('keys');
  controls.touchStick(0, 0, 0, true);
  controls.useDevice('pad');
  assert.deepEqual(seen, ['keys', 'touch', 'pad'], 'each change reported once');
});

test('touch settings: bigger controls need more travel, a fixed stick stays put, and easy charge is tap to charge, tap to launch', () => {
  // Size: the stick's travel scales with the control size.
  const { router, finger, tick } = rig();
  router.setOptions({ size: 'l' });
  assert.ok(near(router.radius, R * 1.25));
  const a = finger(60, 600);
  a.move(60 + R, 600); // a full push at the normal size is no longer full
  const half = tick();
  assert.ok(half.mx > 30 && half.mx < 100, `push ${half.mx}`);
  a.move(60 + R * 1.25, 600);
  assert.equal(tick().mx, 100);
  a.up();

  // Fixed: the centre is the thumb ring's spot, wherever the thumb lands.
  router.setOptions({ stick: 'fixed' });
  const b = finger(40, 790); // lands left of and below the fixed centre
  const st = router.stickOf(0);
  assert.ok(st.ox > 40 && st.oy < 790, 'the stick did not move to the thumb');
  assert.ok(tick().mx < 0, 'a thumb left of the fixed centre walks left at once');
  b.move(st.ox + R * 3, st.oy); // far past the rim: the centre doesn't follow
  assert.equal(router.stickOf(0).ox, st.ox);
  b.up();

  // Easy charge: the first tap holds DASH (a charge builds with no finger down), the
  // second lets go: a charged dash.
  router.setOptions({ easy: true });
  let s = { ...spawnState(0), lock: 0 };
  const tap = () => {
    const f = finger(330, 600);
    f.up();
  };
  tap();
  for (let i = 0; i < K.chargeMax + 2; i++) s = stepPlayer(s, tick());
  assert.equal(s.ph, PH.CHARGE, 'tapping once starts a charge that keeps building');
  assert.ok(router.dashDown(0) === false, 'no finger is down');
  tap();
  s = stepPlayer(s, tick());
  assert.equal(s.ph, PH.DASH);
  assert.equal(s.pw, 1, 'the second tap launches the full charge');
  // Pausing (releaseAll) lets go of a latched charge, so nothing stays held.
  tap();
  router.releaseAll();
  const i = tick();
  assert.equal(i.b & 1, 0, 'released on pause');
});
