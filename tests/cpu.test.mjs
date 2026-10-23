// The computer opponent (js/game/cpu.js) and the solo record (js/solo.js): it plays
// whole matches that end, the ladder is in order, it only presses what a player can,
// it never reads what a player can't see, it plays the same at any frame rate, and it
// does the human things it's meant to (hesitate, feint, get greedy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, makeWorld } from '../js/game/rules.js';
import { createCpu, LEVELS, PROFILES } from '../js/game/cpu.js';
import { TUNING, K, PH, NEUTRAL, sanitizeInput } from '../js/game/sim.js';
import { createLoop } from '../js/lib/loop.js';
import { createLocalMatch } from '../js/local.js';
import { createSoloRecord } from '../js/solo.js';
import { playMatch, headToHead, summarize, makePlayer } from './harness.mjs';

const ATTACKERS = ['easy', 'normal', 'hard'];
const pct = (x) => `${Math.round(x * 100)}%`;

test('CPU vs CPU: every match finishes and no round outlasts the sinking floe', () => {
  // The centre tile sinks at crumbleStart + 9 x crumbleEvery = 60 s, so no round can
  // outlast that by more than the edge grace.
  const limit = TUNING.crumbleStartS + 9 * TUNING.crumbleEveryS + 1;
  const pairs = [...ATTACKERS.flatMap((a) => ATTACKERS.map((b) => [a, b])), ...ATTACKERS.map((a) => ['practice', a])];
  const all = [];
  for (const [a, b] of pairs) {
    const results = [];
    for (let seed = 1; seed <= 20; seed++) results.push(playMatch({ seed: seed * 101, a, b }));
    const s = summarize(results);
    all.push(...results);
    assert.equal(s.ended, 20, `${a} vs ${b}: ${20 - s.ended} matches never ended`);
    assert.ok(s.roundSeconds.max <= limit, `${a} vs ${b}: a round lasted ${s.roundSeconds.max.toFixed(1)} s`);
    for (const m of results) assert.ok(m.rounds.length <= 12, `${a} vs ${b}: ${m.rounds.length} rounds in one match`);
  }
  const s = summarize(all);
  console.log(`${all.length} CPU-vs-CPU matches, ${s.rounds} rounds (${s.replays} replays): rounds ${s.roundSeconds.p50.toFixed(1)} s median, ${s.roundSeconds.max.toFixed(1)} s longest`);
});

test('the ladder: Hard beats Easy in most of 50 seeded matches, and each level beats the one below', () => {
  const hardEasy = headToHead('hard', 'easy', 50);
  const hardNormal = headToHead('hard', 'normal', 50);
  const normalEasy = headToHead('normal', 'easy', 50);
  for (const [name, r] of [['Hard vs Easy', hardEasy], ['Hard vs Normal', hardNormal], ['Normal vs Easy', normalEasy]]) {
    console.log(`${name}: won ${r.wins}/50 matches, rounds ${r.roundsWon}-${r.roundsLost}`);
  }
  assert.ok(hardEasy.wins > 25, `Hard won only ${hardEasy.wins} of 50 against Easy`);
  assert.ok(hardNormal.wins > 25, `Hard won only ${hardNormal.wins} of 50 against Normal`);
  assert.ok(normalEasy.wins > 25, `Normal won only ${normalEasy.wins} of 50 against Easy`);
});

test('a scripted first-time player: beats Easy most of the time, Skipper a fair share, Hard almost never', () => {
  // tests/harness.mjs createNovice: walks at you, holds DASH when close, lets go when
  // it looks close enough, sees 300-450 ms late. A real first-timer learns; this doesn't.
  // Skipper is the middle rung: a first-timer should take roughly a third of matches
  // (measured 45/100 and 29/80 on other seeds), not be shut out.
  const easy = headToHead('novice', 'easy', 60);
  const normal = headToHead('novice', 'normal', 80);
  const hard = headToHead('novice', 'hard', 50);
  console.log(`first-timer script: beat Easy ${easy.wins}/60 (${pct(easy.share)}), Normal ${normal.wins}/80 (${pct(normal.share)}), Hard ${hard.wins}/50`);
  assert.ok(easy.share >= 0.5, `the first-timer beat Easy only ${easy.wins} of 60`);
  assert.ok(normal.share >= 0.22 && normal.share <= 0.52, `the first-timer beat Normal ${normal.wins} of 80: outside the middle-rung band`);
  assert.ok(normal.share < easy.share && hard.share <= normal.share, 'Normal and Hard should be harder for a first-timer than Easy');
  assert.ok(hard.share <= 0.1, `the first-timer beat Hard ${hard.wins} of 50`);
});

test('the rush (hold DASH and walk at them) is a coin flip at best against Skipper, and The Berg punishes it', () => {
  // Rushing is the plan most beginners find. It must not walk over Skipper (it used to
  // win 40/40), and The Berg has to answer it. headToHead alternates seats.
  const quick = headToHead('hard', 'rusher14', 60);
  const slow = headToHead('hard', 'rusher20', 60);
  const nQuick = headToHead('rusher14', 'normal', 80);
  const nSlow = headToHead('rusher20', 'normal', 80);
  console.log(`The Berg vs a rusher reacting in 233 ms: won ${quick.wins}/60; in 333 ms: won ${slow.wins}/60. Rushers vs Skipper: 233 ms won ${nQuick.wins}/80 (${pct(nQuick.share)}), 333 ms won ${nSlow.wins}/80 (${pct(nSlow.share)})`);
  assert.ok(quick.share >= 0.75, `The Berg won only ${quick.wins} of 60 against a quick rusher`);
  assert.ok(slow.share >= 0.8, `The Berg won only ${slow.wins} of 60 against a slow rusher`);
  for (const [name, r] of [['quick', nQuick], ['slow', nSlow]]) assert.ok(r.share <= 0.62, `a ${name} rusher beat Skipper ${r.wins} of 80`);
});

test('mashing the jab does not beat the computer: Skipper and The Berg read a masher and answer it', () => {
  // The first thing a new player tries. tests/harness.mjs: 'masher' walks at you on 8-way
  // keys and taps DASH 5 times a second within reach, seeing 300 ms late; 'masher4' taps
  // 4 a second; 'mashpad' does it on an analog stick 6 a second; 'sloppy' is an uneven
  // keyboard masher; 'jabber' jabs whenever you're in reach. Before this fix the masher
  // beat Slush and Skipper 40/40.
  const vsNormal = Object.fromEntries(['masher', 'masher4', 'sloppy', 'jabber'].map((k) => [k, headToHead(k, 'normal', 60)]));
  const vsHard = Object.fromEntries(['masher', 'mashpad', 'sloppy', 'jabber'].map((k) => [k, headToHead(k, 'hard', 50)]));
  console.log('vs Skipper:', Object.entries(vsNormal).map(([k, r]) => `${k} ${r.wins}/60`).join(', '), '| vs The Berg:', Object.entries(vsHard).map(([k, r]) => `${k} ${r.wins}/50`).join(', '));
  assert.ok(vsNormal.masher.share <= 0.5 && vsNormal.masher4.share <= 0.5, `a steady masher beat Skipper ${vsNormal.masher.wins}/60, a slower one ${vsNormal.masher4.wins}/60`);
  for (const k of ['sloppy', 'jabber']) assert.ok(vsNormal[k].share <= 0.7, `${k} beat Skipper ${vsNormal[k].wins} of 60`);
  assert.ok(vsHard.masher.share <= 0.1, `a steady masher beat The Berg ${vsHard.masher.wins} of 50`);
  assert.ok(vsHard.mashpad.share <= 0.2, `an analog masher beat The Berg ${vsHard.mashpad.wins} of 50`);
  for (const k of ['sloppy', 'jabber']) assert.ok(vsHard[k].share <= 0.1, `${k} beat The Berg ${vsHard[k].wins} of 50`);
});

test("the CPU doesn't throw itself in after winning a round, and Skipper and The Berg don't dash themselves off", () => {
  // Watching a won round, the CPU used to charge at your sinking body and let go over the
  // water (73-104 of 120 outros). A fall within the edge grace plus a reaction of the
  // round's end is two near-simultaneous falls, not a choice. "Own dash" means it fell
  // within 50 ticks of its own dash without being hit for 2 s. Slush forgets the edge on purpose.
  const late = K.grace + 30;
  for (const level of ATTACKERS) {
    let rounds = 0;
    let outro = 0;
    let ownDash = 0;
    for (let i = 0; i < 30; i++) {
      const duel = createDuel({ seed: 300 + i });
      duel.join(0);
      duel.join(1);
      duel.startMatch();
      const cpu = createCpu({ level, seed: i * 7 + 3 });
      const me = makePlayer(i % 2 ? 'novice' : 'rusher20', i * 11 + 5);
      let overAt = 0;
      let lastHit = -1e9;
      let lastDash = -1e9;
      while (duel.state !== 'end' && duel.ticks < 36000) {
        const w = duel.world();
        const st = duel.state;
        if (duel.player(1).ph === PH.DASH) lastDash = duel.ticks;
        for (const e of duel.step([me(duel.player(0), duel.player(1), w), cpu(duel.player(1), duel.player(0), w)])) {
          if ((e.kind === 'hit' && e.who === 1) || e.kind === 'clash') lastHit = duel.ticks;
          if (e.kind === 'round') {
            overAt = duel.ticks;
            if (!e.replay) rounds++;
          }
          if (e.kind === 'out' && e.who === 1) {
            if (st === 'over' && duel.ticks - overAt > late) outro++;
            if (st === 'fight' && duel.ticks - lastHit > 120 && duel.ticks - lastDash < 50) ownDash++;
          }
        }
      }
    }
    console.log(`${level}: ${rounds} rounds, threw itself in after a won round ${outro} times, dashed itself off ${ownDash} times`);
    assert.equal(outro, 0, `${level} fell in after the round was decided`);
    if (level !== 'easy') assert.ok(ownDash <= rounds * 0.03, `${level} dashed itself off ${ownDash} times in ${rounds} rounds`);
  }
});

test('the CPU only presses what a player can: a stick, one dash button, human timing', () => {
  for (const level of ['practice', ...ATTACKERS]) {
    const P = PROFILES[level];
    let presses = 0;
    let ticks = 0;
    let minHold = Infinity;
    let minGap = Infinity;
    let heldFor = 0;
    let since = Infinity;
    let prevHeld = false;
    let off8 = 0;
    playMatch({
      seed: 7,
      a: level,
      b: 'normal',
      onTick: (duel, inputs) => {
        const i = inputs[0];
        ticks++;
        // the shape the server accepts from any client
        assert.ok(sanitizeInput([1, i.mx, i.my, i.b]), `${level}: rejected input ${JSON.stringify(i)}`);
        assert.deepEqual(Object.keys(i).sort(), ['b', 'mx', 'my']);
        assert.ok(i.mx * i.mx + i.my * i.my <= 101 * 101, `${level}: stick pushed past full ${JSON.stringify(i)}`);
        const held = (i.b & 1) === 1;
        const pressed = (i.b & 2) === 2;
        assert.ok(!pressed || (held && !prevHeld), `${level}: a press that isn't a fresh push of the button`);
        if (pressed) {
          presses++;
          minGap = Math.min(minGap, since);
          since = 0;
        } else since++;
        if (held) heldFor++;
        else if (prevHeld) {
          minHold = Math.min(minHold, heldFor);
          heldFor = 0;
        }
        prevHeld = held;
        // Slush plays on a keyboard: eight directions, full push.
        if (P.keys && (i.mx || i.my)) {
          const a = Math.atan2(i.my, i.mx) / (Math.PI / 4);
          if (Math.abs(a - Math.round(a)) > 0.02) off8++;
        }
      },
    });
    const perSecond = presses / (ticks / TUNING.tickHz);
    console.log(`${level}: ${presses} presses in ${(ticks / 60).toFixed(0)} s (${perSecond.toFixed(1)}/s), shortest press ${minHold === Infinity ? '-' : minHold} ticks, closest presses ${minGap === Infinity ? '-' : minGap} ticks apart`);
    if (!P.attacks) assert.equal(presses, 0, 'Practice never presses dash');
    else {
      assert.ok(presses > 0, `${level} never pressed dash`);
      assert.ok(minHold >= 2, `${level}: a press only ${minHold} tick long`);
      assert.ok(minGap >= P.minGap, `${level}: presses ${minGap} ticks apart`);
      assert.ok(perSecond < 8, `${level}: ${perSecond.toFixed(1)} presses a second`);
    }
    assert.equal(off8, 0, `${level}: ${off8} stick directions off the 8-way grid`);
  }
});

test("the CPU never reads what a player can't see: hidden state and the floe's future change nothing", () => {
  // Two copies of the same CPU, same seed. One gets the real fighters and floe; the
  // other gets fighters with every hidden field scrambled (phase timers, buffers,
  // stored launches, the other fighter's exact speed, revision counters) and a floe
  // whose tiles that aren't yet visibly cracking sink at different times.
  const scramble = (s, salt, foe) => {
    const o = { ...s, t: s.t + 37 * salt, buf: (s.buf + salt) % 9, kx: s.kx + 111, ky: s.ky - 77, nx: (s.nx + 3) % 7, nt: s.nt + 5, head: s.head + 4, warp: s.warp + 1000, rev: s.rev + 1000 };
    if (foe) Object.assign(o, { vx: -s.vx + 50, vy: s.vy * 3 - 20, lock: s.lock ? s.lock + 9 : 0 });
    return o;
  };
  for (const level of ATTACKERS) {
    const duel = createDuel({ seed: 21 });
    duel.join(0);
    duel.join(1);
    duel.startMatch();
    const real = createCpu({ level, seed: 5 });
    const blind = createCpu({ level, seed: 5 });
    const other = createCpu({ level: 'normal', seed: 6 });
    let n = 0;
    while (duel.state !== 'end' && duel.ticks < 30000) {
      const w = duel.world();
      const far = Array.from(duel.sinkAt, (t) => (t > duel.elapsed + K.warn ? t + 300 + ((t * 7) % 500) : t));
      const fake = makeWorld(duel.floe, far, duel.elapsed);
      const me = duel.player(0);
      const foe = duel.player(1);
      const a = real(me, foe, w);
      const b = blind(scramble(me, n % 5, false), scramble(foe, n % 7, true), fake);
      assert.deepEqual(b, a, `${level}: tick ${duel.ticks}, it acted on something a player can't see`);
      duel.step([a, other(foe, me, w)]);
      n++;
    }
    assert.ok(n > 1000, `${level}: only ${n} ticks checked`);
  }
});

test('the same match at 30, 60 and 144 fps (and on a jittery laptop): tick for tick identical', () => {
  const stub = { step() {}, sample: () => NEUTRAL, setMerged() {}, resetUsed() {}, used: () => true };
  const quiet = { hit() {}, clash() {}, save() {} };
  function run(frameMs, ticks = 15000) {
    const match = createLocalMatch({ mode: 'demo', demoLevels: ['hard', 'easy'], seed: 99, controls: stub, renderer: quiet, events: {} });
    const trace = [];
    const loop = createLoop({
      hz: TUNING.tickHz,
      update() {
        match.update();
        const d = match.duel;
        const p = [d.player(0), d.player(1)];
        trace.push(`${d.ticks}:${p.map((f) => `${f.x},${f.y},${f.ph},${f.ch}`).join('|')}:${d.scores.join('-')}`);
      },
      render() {},
    });
    let t = 1000;
    let i = 0;
    loop.tick(t);
    while (trace.length < ticks) {
      t += typeof frameMs === 'function' ? frameMs(i++) : frameMs;
      loop.tick(t);
    }
    return trace.slice(0, ticks);
  }
  const at60 = run(1000 / 60);
  const at30 = run(1000 / 30);
  const at144 = run(1000 / 144);
  let s = 3;
  const jitter = run(() => {
    s = (s * 16807) % 2147483647;
    return 4 + (s / 2147483647) * 40; // 4-44 ms frames
  });
  assert.deepEqual(at30, at60, '30 fps played differently from 60');
  assert.deepEqual(at144, at60, '144 fps played differently from 60');
  assert.deepEqual(jitter, at60, 'uneven frames played differently from 60');
  assert.ok(at60.some((line, i) => i > 0 && line.endsWith(':0-0') && !at60[i - 1].endsWith(':0-0')), 'the run covers a whole match and the rematch');
  console.log(`${at60.length} ticks (a whole match and into the rematch) identical at 30, 60, 144 fps and with 4-44 ms frames`);
});

test('seeded: the same seed replays a CPU match exactly, another seed plays differently', () => {
  const a = playMatch({ seed: 5, a: 'hard', b: 'normal' });
  const b = playMatch({ seed: 5, a: 'hard', b: 'normal' });
  const c = playMatch({ seed: 6, a: 'hard', b: 'normal' });
  assert.deepEqual(b.rounds, a.rounds);
  assert.equal(b.ticks, a.ticks);
  assert.notEqual(c.ticks, a.ticks);
});

test('it plays like a person: it hesitates, feints, gets greedy, fumbles charges, and Hard baits', () => {
  const count = (level, n = 12) => {
    const seen = { pause: 0, feint: 0, wander: 0, hover: 0, dodge: 0, greedy: 0, fumble: 0 };
    let last = {};
    for (let seed = 1; seed <= n; seed++) {
      const duel = createDuel({ seed });
      duel.join(0);
      duel.join(1);
      duel.startMatch();
      const me = createCpu({
        level,
        seed: seed * 3,
        onThink: (want, view, st) => {
          // count each new episode once
          if (st.mode !== last.mode && st.mode in seen) seen[st.mode]++;
          if (st.greedy && !last.greedy) seen.greedy++;
          if (st.fumble && st.fumble !== last.fumble) seen.fumble++;
          last = { ...st };
        },
      });
      const foe = createCpu({ level: 'normal', seed: seed * 3 + 1 });
      while (duel.state !== 'end' && duel.ticks < 30000) {
        const w = duel.world();
        duel.step([me(duel.player(0), duel.player(1), w), foe(duel.player(1), duel.player(0), w)]);
      }
    }
    return seen;
  };
  const easy = count('easy');
  const normal = count('normal');
  const hard = count('hard');
  console.log('in 12 matches each:', JSON.stringify({ easy, normal, hard }));
  assert.ok(easy.pause > 0 && easy.wander > 0 && easy.fumble > 0, 'Slush hesitates, drifts off and fumbles charges');
  assert.ok(normal.pause > 0 && normal.feint > 0 && normal.greedy > 0, 'Skipper hesitates, feints and gets greedy');
  assert.ok(hard.hover > 0 && hard.feint > 0 && hard.dodge > 0, 'The Berg hovers at the edge of your reach, feints and side-steps');
  assert.ok(easy.fumble > hard.fumble, 'Slush fumbles more charges than The Berg');
});

test('solo record: wins and losses per CPU, Hard unlocks after beating Normal, storage failures are harmless', () => {
  const store = new Map();
  const read = (k, f) => (store.has(k) ? JSON.parse(store.get(k)) : f);
  const write = (k, v) => (store.set(k, JSON.stringify(v)), true);
  const solo = createSoloRecord({ read, write });
  assert.equal(solo.summary(), null, 'nothing to show before the first match');
  assert.equal(solo.pickDefault(), 'easy', 'a new player starts on Easy');
  assert.equal(solo.unlocked('hard'), false);
  assert.ok(solo.unlocked('practice') && solo.unlocked('easy') && solo.unlocked('normal'), 'only Hard is ever locked');
  assert.deepEqual(solo.result('practice', true), { record: null, fresh: [] }, "practice doesn't count");
  // The softer way in: three close losses to Skipper (2 rounds each) open The Berg too.
  const learner = createSoloRecord({ read: (k, f) => f, write: () => true });
  learner.result('normal', false, 2);
  learner.result('normal', false, 1); // not close
  learner.result('normal', false, 2);
  assert.equal(learner.unlocked('hard'), false);
  assert.deepEqual(learner.progress('hard'), { close: 2, need: 3 });
  assert.deepEqual(learner.result('normal', false, 2).fresh.map((l) => l.id), ['hard'], 'the third close loss opens The Berg');
  assert.equal(learner.unlocked('hard'), true);
  solo.result('easy', true);
  assert.equal(solo.nextUp('easy', true)?.id, 'normal', 'after beating Slush, the next button offers Skipper');
  assert.equal(solo.nextUp('easy', false), null);
  assert.deepEqual(solo.result('normal', false).fresh, []);
  const win = solo.result('normal', true);
  assert.deepEqual(win.record, { w: 1, l: 1, close: 0 });
  assert.deepEqual(win.fresh.map((l) => l.id), ['hard'], 'beating Skipper unlocks The Berg, once');
  assert.deepEqual(solo.result('normal', true).fresh, [], 'the unlock is only announced once');
  assert.equal(solo.unlocked('hard'), true);
  solo.play('hard');
  // A reload reads it all back.
  const again = createSoloRecord({ read, write });
  assert.deepEqual(again.rec.normal, { w: 2, l: 1, close: 0 });
  assert.equal(again.unlocked('hard'), true);
  assert.equal(again.pickDefault(), 'hard');
  assert.match(again.summary(), /Slush 1–0 · Skipper 2–1 · The Berg 0–0/);
  // Junk in storage, or storage that's gone, gives a clean slate rather than a crash.
  store.set('solo', JSON.stringify({ rec: { normal: { w: -4, l: 'x' }, hard: { w: 1e99 } }, last: '<img>', told: 'no' }));
  const junk = createSoloRecord({ read, write });
  assert.deepEqual(junk.rec.normal, { w: 0, l: 0, close: 0 });
  assert.equal(junk.unlocked('hard'), false);
  assert.equal(junk.last, null);
  const gone = createSoloRecord({ read: (k, f) => f, write: () => false });
  gone.result('easy', true);
  assert.deepEqual(gone.rec.easy, { w: 1, l: 0, close: 0 }, 'a private window still counts this session');
  // The first build's single CPU tally carries over to Skipper.
  const old = createSoloRecord({ read: (k, f) => f, write: () => true, legacy: { w: 3, l: 2 } });
  assert.deepEqual(old.rec.normal, { w: 3, l: 2, close: 0 });
  assert.equal(old.unlocked('hard'), true);
});

test('every opponent on the title screen has a name, a label and a personality', () => {
  assert.deepEqual(LEVELS.map((l) => l.id), ['practice', 'easy', 'normal', 'hard']);
  for (const l of LEVELS) {
    assert.ok(l.name && l.label && l.line.length > 20, l.id);
    assert.ok(PROFILES[l.id], `${l.id} has a profile`);
  }
});
