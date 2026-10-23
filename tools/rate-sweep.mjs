// DESIGN.md asks: measure 15 against 30 snapshots a second with the bots.
// Runs pairs of bots on an in-process room server under several simulated
// networks, once at each rate, and prints one row per (rate, network).
//
//   node tools/rate-sweep.mjs              # 2 seeds x 25 s per row, about a minute
//   node tools/rate-sweep.mjs --seconds 40 --seeds 3
//
// Rates are shared by client and server (sim.js TUNING), so both sides change
// together here. The floe sinks faster than shipped so rounds keep turning over.

import { setTuning, TUNING } from '../js/game/sim.js';
import { startTestServer } from '../server/ws.mjs';
import { createShoveRules } from '../js/game/rules.js';
import { createBot } from './bot.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : Number(process.argv[i + 1]);
};
const seconds = arg('seconds', 25);
const seeds = arg('seeds', 2);
const ORIGIN = 'http://sweep.local';
const NETS = [
  { name: '40 ms, 10 ms jitter', lag: { latencyMs: 40, jitterMs: 10 } },
  { name: '60 ms, 20 ms jitter', lag: { latencyMs: 60, jitterMs: 20 } },
  { name: '60 ms, 20 ms jitter, 2% loss (TCP stalls 200-500 ms)', lag: { latencyMs: 60, jitterMs: 20, loss: 0.02, stallMs: [200, 500] } },
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let room = 0;

for (const hz of [15, 30]) {
  setTuning({ snapshotHz: hz, inputSendHz: hz });
  const srv = await startTestServer({ allowedOrigins: [ORIGIN], games: { shove: createShoveRules({ crumble: { crumbleStartS: 4, crumbleEveryS: 1.5 } }) } });
  const runs = [];
  for (const net of NETS) {
    for (let s = 0; s < seeds; s++) {
      const code = `S${String(++room).padStart(3, '0')}`;
      runs.push(
        (async () => {
          const url = srv.url('shove', code);
          const a = createBot({ url, room: code, name: 'A', create: true, lag: net.lag, origin: ORIGIN, seed: room * 10 + 1 });
          await wait(400);
          const b = createBot({ url, room: code, name: 'B', lag: net.lag, origin: ORIGIN, seed: room * 10 + 2 });
          await wait(900);
          a.session.start();
          await wait(seconds * 1000);
          const reps = [a.report(), b.report()];
          a.stop();
          b.stop();
          return { net: net.name, reps };
        })(),
      );
    }
  }
  const done = await Promise.all(runs);
  for (const net of NETS) {
    const reps = done.filter((d) => d.net === net.name).flatMap((d) => d.reps);
    const avg = (k) => reps.reduce((s, r) => s + r[k], 0) / reps.length;
    rows.push({
      'snapshots/s': hz,
      network: net.name,
      'delay ms': Math.round((1000 / hz) * 2.5),
      interp: `${(avg('interp') * 100).toFixed(1)}%`,
      'lowest bot': `${(Math.min(...reps.map((r) => r.interp)) * 100).toFixed(1)}%`,
      extrap: `${(avg('extrap') * 100).toFixed(1)}%`,
      hold: `${(avg('hold') * 100).toFixed(1)}%`,
      depth: +avg('depthAvg').toFixed(2),
      corrections: reps.reduce((s, r) => s + r.corrections, 0),
      'server changes': reps.reduce((s, r) => s + r.serverChanges, 0),
    });
  }
  await wait(300);
  await srv.stop();
}
console.log(`${seeds} room(s) of 2 bots per row, ${seconds} s each. Shipped: ${TUNING.snapshotHz === 30 ? '30' : TUNING.snapshotHz} Hz.`);
console.table(rows);
process.exit(0);
