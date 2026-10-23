// Headless bots play full online matches against a running room server, on the
// shipped rules and schedule, through a simulated network. Start the server first
// (node server/server.mjs), then:
//
//   node tools/bot-match.mjs                          # two bots, one full match
//   node tools/bot-match.mjs --matches 2 --drop       # + a rejoin mid-match, then a rematch
//   node tools/bot-match.mjs --latency 60 --jitter 20 --loss 0.02
//   node tools/bot-match.mjs --join K7Q0              # one bot joins your browser's room
//
// It prints what each bot measured and a PASS/FAIL line per check: zero prediction
// corrections (the server's own changes are counted apart), the share of frames
// where the other fighter was drawn by interpolation, rosters that agree, a rejoin
// to the same seat, back-to-back matches still at zero corrections, and a friend who
// leaves sending the host to a lobby for one (no match started for one).

import { createBot } from './bot.mjs';
import { makeJoinCode } from '../js/net/protocol.js';
import { createAutoStart } from '../js/online.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const base = String(opt('url', 'http://127.0.0.1:8793')).replace(/\/$/, '');
const origin = String(opt('origin', base.replace('127.0.0.1', 'localhost')));
const wsBase = base.replace(/^http/, 'ws');
const matches = Number(opt('matches', 1));
const lag = {
  latencyMs: Number(opt('latency', 40)),
  jitterMs: Number(opt('jitter', 15)),
  loss: Number(opt('loss', 0)),
  stallMs: String(opt('stall', '200,500')).split(',').map(Number),
};
const join = opt('join', null);
const drop = !!opt('drop', false);
const maxSeconds = Number(opt('seconds', 60 * 6 * matches));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
const say = (...a) => console.log(`[${secs().padStart(6)} s]`, ...a);

async function until(check, ms, what) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}

const results = [];
const check = (name, ok, detail = '') => results.push({ check: name, result: ok ? 'PASS' : 'FAIL', detail });

const narrate = (label) => (e) => {
  if (e.t === 'ev' && e.kind === 'round') say(`${label} sees round ${e.round}: ${e.replay ? 'double ring-out, replayed' : `won by ${e.winner}`}, score ${e.scores.join('-')}`);
  if (e.t === 'ev' && e.kind === 'match') say(`${label} sees the match end: ${e.winner} wins ${e.scores.join('-')}`);
  if (e.t === 'status' && e.status !== 'online') say(`${label} status: ${e.status}`);
};

if (join) {
  const code = String(join).toUpperCase();
  say(`joining room ${code} at ${wsBase} as one bot; play it from the browser`);
  const bot = createBot({ url: `${wsBase}/room/shove/${code}`, room: code, name: 'Bot', lag, origin, seed: 7, onEvent: narrate('bot') });
  await until(() => bot.matches >= matches || ['gone', 'unavailable', 'closed'].includes(bot.session.net.status), maxSeconds * 1000, 'the match');
  console.table([bot.report()]);
  bot.stop();
  await wait(300);
  process.exit(0);
}

const code = makeJoinCode();
const url = `${wsBase}/room/shove/${code}`;
say(`room ${code} on ${wsBase}, ${matches} match(es), one-way latency ${lag.latencyMs} ms ±${lag.jitterMs}, loss ${lag.loss}`);
let onA = () => {}; // set for the leave check at the end
const a = createBot({ url, room: code, name: 'Coral bot', create: true, lag, origin, seed: 1, onEvent: (e) => (narrate('A')(e), onA(e)) });
await until(() => a.session.net.status === 'online', 10000, 'bot A online');
const b = createBot({ url, room: code, name: 'Teal bot', lag, origin, seed: 2, onEvent: narrate('B') });
await until(() => a.session.roster.size === 2 && b.session.net.status === 'online', 10000, 'bot B online');
say('both bots in; the host starts the match');
a.session.start();
await until(() => a.session.phase === 'playing' && b.session.phase === 'playing', 5000, 'the match to start');

let rejoin = null;
if (drop) {
  await wait(9000);
  const pid = b.session.pid;
  say(`dropping bot B's socket (pid ${pid}) the way a dead connection is dropped (close 4000), then reconnecting`);
  // The server treats 4000 as a drop, not a leave: it holds the seat, pauses the round
  // clock, and the reconnect comes back with the saved seat token.
  const before = b.session.net.stats.reconnects;
  b.session.net.reconnectNow();
  await until(() => b.session.net.status === 'online' && b.session.net.stats.reconnects > before, 15000, 'rejoin');
  rejoin = { pidBefore: pid, pidAfter: b.session.pid };
  say(`bot B is back: pid ${b.session.pid}`);
}

const correctionsAfterMatch = [];
for (let m = 1; m <= matches; m++) {
  await until(() => a.matches >= m && b.matches >= m, maxSeconds * 1000, `match ${m}`);
  correctionsAfterMatch.push([a.report().corrections, b.report().corrections]);
  if (m < matches) say(`match ${m} done; both bots press Rematch`);
}
const reports = [a.report(), b.report()];
const lossy = lag.loss > 0;
const interpNeed = lossy ? 0.8 : 0.9;
const holdMax = lossy ? 0.1 : 0.05;
console.log('');
console.table(reports);

for (const [i, r] of reports.entries()) {
  const who = i ? 'B' : 'A';
  check(`bot ${who}: zero prediction corrections`, r.corrections === 0, `${r.corrections} corrections, ${r.serverChanges} server changes (hits, clashes, pushes), ${r.snaps} snaps (new rounds)`);
  // On a lossy link TCP stalls hold the other fighter still now and then; the client's
  // interpolation delay grows to cover them (js/net/session.js), so the bar is lower
  // there than on a clean link.
  check(`bot ${who}: other fighter interpolated (${(interpNeed * 100).toFixed(0)}%+)`, r.interp >= interpNeed, `${(r.interp * 100).toFixed(1)}% interp, ${(r.extrap * 100).toFixed(1)}% extrap, ${(r.hold * 100).toFixed(1)}% hold, delay ${Math.round((i ? b : a).session.interpDelayMs)} ms`);
  check(`bot ${who}: other fighter held still under ${(holdMax * 100).toFixed(0)}% of frames`, r.hold < holdMax, `${(r.hold * 100).toFixed(1)}% hold`);
  check(`bot ${who}: no decode errors`, r.decodeErrors === 0, `${r.decodeErrors}`);
}
check('rosters agree', a.session.roster.size === 2 && b.session.roster.size === 2, `${a.session.roster.size} and ${b.session.roster.size} players`);
check('both clients agree on the final score', JSON.stringify(a.session.view?.sc) === JSON.stringify(b.session.view?.sc), JSON.stringify(a.session.view?.sc));
if (rejoin) check('rejoin to the same seat', rejoin.pidBefore === rejoin.pidAfter, `${rejoin.pidBefore} -> ${rejoin.pidAfter}`);
if (matches > 1) check('back-to-back matches still at zero corrections', correctionsAfterMatch.every(([x, y]) => x === 0 && y === 0), JSON.stringify(correctionsAfterMatch));

// Bot B presses Leave room. Bot A runs the host page's own start logic (js/online.js),
// so a roster that still listed B when the lobby arrived would start a match for one.
let lobby = null;
const autoA = createAutoStart(a.session);
onA = (e) => {
  if (e.t === 'phase') lobby = { phase: e.phase, why: e.why, rosterSize: a.session.roster.size };
  if (e.t === 'phase' || e.t === 'roster') autoA.check();
};
say('bot B presses Leave room on the scoreboard');
b.stop();
await until(() => a.session.phase === 'lobby', 8000, 'the lobby after B left').catch(() => {});
await wait(1500); // past the host's 600 ms start beat
check(
  'a friend who leaves sends the host to a lobby for one',
  lobby?.phase === 'lobby' && lobby.why === 'opponent left' && lobby.rosterSize === 1 && a.session.phase === 'lobby' && a.session.roster.size === 1,
  `phase ${a.session.phase}, told ${JSON.stringify(lobby)}`,
);
autoA.cancel();
console.table(results);
a.stop();
await wait(300);
process.exit(results.every((r) => r.result === 'PASS') ? 0 : 1);
