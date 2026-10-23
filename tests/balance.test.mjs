// The fairness proof (avoid-vibecoded-games' scripted-player harness): thousands of
// whole matches with CPU brains on both sides, on the real rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { playMatch, summarize } from './harness.mjs';

test('2,000 balanced-vs-balanced matches: every round ends by 60 s, and spawn sides win 45-55%', () => {
  const results = [];
  for (let seed = 1; seed <= 2000; seed++) results.push(playMatch({ seed }));
  const s = summarize(results);
  console.log('balanced vs balanced', JSON.stringify(s));
  assert.equal(s.ended, 2000, 'every match reached the scoreboard');
  assert.ok(s.roundSeconds.max <= 60, `longest round ${s.roundSeconds.max.toFixed(1)} s`);
  assert.ok(s.leftWins >= 0.45 && s.leftWins <= 0.55, `left spawn won ${(s.leftWins * 100).toFixed(1)}% of rounds`);
  assert.ok(s.slot0Wins >= 0.45 && s.slot0Wins <= 0.55, `Coral won ${(s.slot0Wins * 100).toFixed(1)}% of matches`);
});

for (const exploit of ['camper', 'spammer']) {
  test(`a ${exploit === 'camper' ? 'centre-camper' : 'max-charge-spam'} bot loses to the balanced bot`, () => {
    const results = [];
    // Play both seat orders, so neither side's spawn helps.
    for (let seed = 1; seed <= 200; seed++) {
      results.push({ ...playMatch({ seed, a: 'balanced', b: exploit }), balancedSlot: 0 });
      results.push({ ...playMatch({ seed: seed + 5000, a: exploit, b: 'balanced' }), balancedSlot: 1 });
    }
    const wins = results.filter((m) => m.winner === m.balancedSlot).length / results.length;
    console.log(`balanced vs ${exploit}: balanced won ${(wins * 100).toFixed(1)}% of ${results.length} matches`);
    assert.ok(wins > 0.6, `balanced won only ${(wins * 100).toFixed(1)}%`);
  });
}

// The balanced bot clashes far more than people do, so check fairness between
// human-like scripts too: first-timers, and players who rush with a held charge.
for (const kind of ['novice', 'rusher20']) {
  test(`${kind === 'novice' ? 'first-timer' : 'rusher'} against ${kind === 'novice' ? 'first-timer' : 'rusher'}: matches end and neither spawn side is favoured`, () => {
    const results = [];
    for (let seed = 1; seed <= 200; seed++) results.push(playMatch({ seed: seed + 9000, a: kind, b: kind }));
    const s = summarize(results);
    console.log(`${kind} vs ${kind}`, JSON.stringify({ matches: s.matches, ended: s.ended, rounds: s.rounds, leftWins: +s.leftWins.toFixed(3), slot0Wins: s.slot0Wins, roundSeconds: s.roundSeconds }));
    assert.equal(s.ended, 200);
    assert.ok(s.roundSeconds.max <= 60, `longest round ${s.roundSeconds.max.toFixed(1)} s`);
    assert.ok(s.leftWins >= 0.42 && s.leftWins <= 0.58, `left spawn won ${(s.leftWins * 100).toFixed(1)}% of rounds`);
  });
}
