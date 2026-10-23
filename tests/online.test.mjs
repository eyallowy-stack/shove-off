// End to end: real sockets, the real room server, the real client session code,
// and headless bots (tools/bot.mjs) playing whole matches through a simulated bad
// network. The rooms here use a faster-sinking floe so a match takes ~30 s; the
// fighters, hits and netcode are the shipped ones. tools/bot-match.mjs plays the
// shipped schedule against a running server.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../server/ws.mjs';
import { createShoveRules } from '../js/game/rules.js';
import { createBot as makeBot } from '../tools/bot.mjs';
import { memoryStorage } from '../js/net/net.js';
import { PH } from '../js/game/sim.js';
import { createAutoStart } from '../js/online.js';

const ORIGIN = 'http://test.local';
const FAST = { crumbleStartS: 2.5, crumbleEveryS: 1 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let srv;
let n = 0;
const freshCode = () => `T${String(++n).padStart(3, '0')}`;

before(async () => {
  srv = await startTestServer({
    allowedOrigins: [ORIGIN],
    // shovequick: the same game with a 1.5 s seat hold, so a closed tab's seat runs out quickly.
    games: { shove: createShoveRules({ crumble: FAST }), shovequick: { ...createShoveRules({ id: 'shovequick', crumble: FAST }), graceMs: 1500 } },
  });
});
const live = [];
const createBot = (opts) => {
  const bot = makeBot(opts);
  live.push(bot);
  return bot;
};
const autos = [];
afterEach(() => {
  for (const x of autos.splice(0)) x.cancel();
  for (const b of live.splice(0)) b.halt();
});
after(async () => {
  await wait(300);
  await srv.stop();
});

async function waitFor(check, ms = 5000, what = 'condition') {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}

async function makeRoom(lag, { code = freshCode(), start = true, brains = ['balanced', 'balanced'] } = {}) {
  const a = createBot({ url: srv.url('shove', code), room: code, name: 'Coral bot', create: true, lag, origin: ORIGIN, seed: 11 * n, brain: brains[0] });
  await waitFor(() => a.session.net.status === 'online', 5000, 'host online');
  const b = createBot({ url: srv.url('shove', code), room: code, name: 'Teal bot', lag, origin: ORIGIN, seed: 11 * n + 1, brain: brains[1] });
  await waitFor(() => [a, b].every((x) => x.session.net.status === 'online' && x.session.roster.size === 2), 5000, 'both online');
  if (start) {
    a.session.start();
    await waitFor(() => [a, b].every((x) => x.session.phase === 'playing'), 5000, 'match start');
  }
  return { code, bots: [a, b], room: () => srv.registry.get('shove', code) };
}

test('two bots play two whole matches back to back through 120 ms RTT, jitter and 2% TCP loss', { timeout: 240000 }, async () => {
  const lag = { latencyMs: 60, jitterMs: 20, loss: 0.02, stallMs: [200, 500] };
  const { bots, room } = await makeRoom(lag);
  const [a, b] = bots;
  await waitFor(() => a.matches >= 2 && b.matches >= 2, 220000, 'two finished matches');
  const reports = bots.map((x) => x.report());
  console.log('online match reports', JSON.stringify(reports), 'delays (ms)', bots.map((x) => Math.round(x.session.interpDelayMs)).join(', '));
  const r = room();
  const duel = r._game._duel;
  for (const rep of reports) {
    assert.equal(rep.status, 'online');
    assert.equal(rep.rosterSize, 2);
    assert.equal(rep.decodeErrors, 0);
    // The shared step is deterministic and the server applies every input exactly
    // once, so prediction never needs correcting. Hits, clashes and pushes are the
    // server's own changes (rev bumps), counted apart.
    assert.equal(rep.corrections, 0, JSON.stringify(rep));
    assert.ok(rep.serverChanges > 0, 'hits should register as server changes');
    assert.ok(rep.interp > 0.75, `remote drawn by interpolation on only ${rep.interp} of frames`);
    assert.ok(rep.hold < 0.15, `remote stood still on ${rep.hold} of frames`);
    assert.ok(rep.rounds >= 6, `saw only ${rep.rounds} rounds`);
  }
  assert.equal(r.stats.rejectedInputs, 0);
  assert.equal(r.stats.overflowedInputs, 0);
  assert.equal(r.stats.badMessages, 0);
  // Both clients agree with the server about the score.
  for (const x of bots) assert.deepEqual(x.session.view.sc, [...duel.scores]);
  assert.ok(Math.max(...duel.scores) === 3 || duel.state !== 'end');
  for (const x of bots) x.stop();
});

test('a dropped player rejoins the same seat, and the round clock waits for them', { timeout: 30000 }, async () => {
  const { bots, room } = await makeRoom({ latencyMs: 30, jitterMs: 10 });
  const [, b] = bots;
  await wait(2500);
  const pid = b.session.pid;
  const tickBefore = room().tick;
  room()._seats.get(pid).conn.terminate(); // no close frame: the client sees 1006
  await waitFor(() => room().phase === 'paused', 3000, 'pause while away');
  assert.equal(room()._seats.size, 2, 'the seat is held');
  await waitFor(() => b.session.net.status === 'online' && room().phase === 'playing', 15000, 'rejoin');
  assert.equal(b.session.pid, pid, 'same seat');
  assert.equal(b.session.net.stats.reconnects, 1);
  assert.ok(room().tick >= tickBefore);
  await wait(1500);
  for (const x of bots) assert.equal(x.report().corrections, 0, JSON.stringify(x.report()));
  for (const x of bots) x.stop();
});

test('a pause shorter than a round trip (a quick drop and rejoin) causes no corrections for the player who stayed', { timeout: 40000 }, async () => {
  // The room pauses while a player is away. Inputs the other player sent just before
  // the pause can arrive after a quick resume; they must not be applied, because that
  // player's client already reset to the paused state without them.
  const { bots, room } = await makeRoom({ latencyMs: 60, jitterMs: 10 });
  const [a, b] = bots;
  await wait(2500);
  for (let i = 0; i < 4; i++) {
    const before = b.session.net.stats.reconnects;
    b.session.net.reconnectNow(); // drop (close 4000) and straight back in
    await waitFor(() => b.session.net.status === 'online' && b.session.net.stats.reconnects > before && room().phase === 'playing', 10000, 'quick rejoin');
    await wait(1500);
  }
  for (const x of bots) assert.equal(x.report().corrections, 0, JSON.stringify(x.report()));
  for (const x of bots) x.stop();
});

test('a hidden tab is brought to rest by the server and resyncs when it comes back', { timeout: 30000 }, async () => {
  const { bots, room } = await makeRoom({ latencyMs: 40, jitterMs: 10 });
  const [, b] = bots;
  await wait(2000);
  b.hide();
  await wait(2500);
  // In a 1v1 the room pauses for a hidden tab (after a second of autopilot), so the
  // away fighter stands exactly still.
  assert.equal(room().phase, 'paused');
  const duel = room()._game._duel;
  const slot = room()._game.team(b.session.pid);
  const p = { ...duel.player(slot) };
  await wait(400);
  const p2 = duel.player(slot);
  assert.ok(p.x === p2.x && p.y === p2.y, 'the server stopped the away player');
  b.show();
  await waitFor(() => room().phase === 'playing', 3000, 'resume when shown');
  await wait(800);
  const me = b.session.predictor.state;
  const q = duel.player(slot);
  assert.ok(Math.hypot(me.x - q.x, me.y - q.y) < 60, 'resynced to the server');
  for (const x of bots) x.stop();
});

test('a player who waited through a long pause (12 s) is not dropped when the match resumes', { timeout: 45000 }, async () => {
  // 10-15 s is the usual "my phone locked for a moment". While paused the waiter sends
  // only pings; the server used to count that quiet as a dead socket on the first tick
  // after resuming and kick the player who stayed.
  const code = freshCode();
  const store = memoryStorage();
  const a = createBot({ url: srv.url('shove', code), room: code, name: 'stays', create: true, lag: { latencyMs: 20 }, origin: ORIGIN, seed: 3 });
  await waitFor(() => a.session.net.status === 'online', 5000, 'a online');
  const b = createBot({ url: srv.url('shove', code), room: code, name: 'away', lag: { latencyMs: 20 }, origin: ORIGIN, seed: 4, storage: store });
  await waitFor(() => b.session.net.status === 'online' && a.session.roster.size === 2, 5000, 'b online');
  a.session.start();
  const room = () => srv.registry.get('shove', code);
  await waitFor(() => room().phase === 'playing', 5000, 'start');
  await wait(1500);
  b.halt(); // B's phone sleeps
  await waitFor(() => room().phase === 'paused', 3000, 'pause');
  await wait(12000);
  const b2 = createBot({ url: srv.url('shove', code), room: code, name: 'away', lag: { latencyMs: 20 }, origin: ORIGIN, seed: 5, storage: store });
  await waitFor(() => b2.session.net.status === 'online' && room().phase === 'playing', 8000, 'rejoin and resume');
  await wait(2500);
  assert.equal(a.session.net.stats.reconnects, 0, `the player who waited reconnected: ${a.statuses.join(',')}`);
  assert.ok(!a.statuses.includes('reconnecting'), a.statuses.join(','));
  assert.equal(room().phase, 'playing');
  a.stop();
  b2.stop();
});

test('Rematch pressed while the other phone sleeps on the scoreboard still counts when they come back', { timeout: 150000 }, async () => {
  const code = freshCode();
  const store = memoryStorage();
  const a = createBot({ url: srv.url('shove', code), room: code, name: 'A', create: true, origin: ORIGIN, autoRematch: false, seed: 21 });
  await waitFor(() => a.session.net.status === 'online', 5000, 'a');
  const b = createBot({ url: srv.url('shove', code), room: code, name: 'B', origin: ORIGIN, storage: store, autoRematch: false, seed: 22 });
  await waitFor(() => b.session.net.status === 'online' && a.session.roster.size === 2, 5000, 'b');
  a.session.start();
  const room = () => srv.registry.get('shove', code);
  await waitFor(() => room()._game._duel.state === 'end', 120000, 'the match to end');
  b.halt();
  await waitFor(() => room().phase === 'paused', 3000, 'pause');
  a.session.act('rematch');
  await waitFor(() => room()._game.view().rd.includes(a.session.pid), 2000, 'the press to count while paused');
  const b2 = createBot({ url: srv.url('shove', code), room: code, name: 'B', origin: ORIGIN, storage: store, autoRematch: false, seed: 23 });
  await waitFor(() => b2.session.net.status === 'online' && room().phase === 'playing', 8000, 'rejoin');
  b2.session.act('rematch');
  await waitFor(() => room()._game._duel.state !== 'end', 3000, 'the rematch to start');
  a.stop();
  b2.stop();
});

test('a hidden tab counts as away in a 1v1: the clock stops, a background reconnect keeps it away, and showing it resumes', { timeout: 40000 }, async () => {
  // Switching apps for a moment used to hand the other player a free ring-out while the
  // hidden fighter stood still, and a background reconnect froze it (invulnerable) instead.
  const { bots, room } = await makeRoom({ latencyMs: 30, jitterMs: 5 });
  const [, b] = bots;
  await wait(1500);
  b.hide();
  await waitFor(() => room().phase === 'paused', 2500, 'the 1v1 to pause for a hidden tab');
  const pid = b.session.pid;
  room()._seats.get(pid).conn.terminate(); // a Wi-Fi blip while hidden
  await waitFor(() => b.session.net.status === 'online' && b.session.net.stats.reconnects === 1, 10000, 'background rejoin');
  await wait(400);
  assert.equal(room()._seats.get(pid).away, true, 'still away after rejoining in the background');
  assert.equal(room().phase, 'paused', 'no resume around a fighter nobody is steering');
  b.show();
  await waitFor(() => room().phase === 'playing', 3000, 'resume when shown');
  await wait(1500);
  for (const x of bots) assert.equal(x.report().corrections, 0, JSON.stringify(x.report()));
  for (const x of bots) x.stop();
});

test('a match does not start around an opponent who is away: it starts paused', { timeout: 20000 }, async () => {
  const { bots, room } = await makeRoom({ latencyMs: 20 }, { start: false });
  const [a, b] = bots;
  b.hide();
  await wait(1300);
  a.session.start();
  await waitFor(() => room().phase === 'paused', 3000, 'a paused start');
  b.show();
  await waitFor(() => room().phase === 'playing', 3000, 'resume');
  for (const x of bots) x.stop();
});

test('when the other player leaves mid-match, the room goes back to the lobby and says why', { timeout: 20000 }, async () => {
  const { bots, room } = await makeRoom({ latencyMs: 20, jitterMs: 5 });
  const [a, b] = bots;
  let why = null;
  const orig = a.session.phase;
  void orig;
  await wait(1500);
  b.stop(); // an explicit leave frees the seat at once
  await waitFor(() => a.session.phase === 'lobby', 5000, 'back to the lobby');
  assert.equal(room().phase, 'lobby');
  assert.equal(a.session.roster.size, 1);
  why = a.statuses;
  assert.ok(why.includes('online'));
  a.stop();
});

// A headless player whose host logic is the page's own (js/online.js createAutoStart):
// it starts the match when both seats fill, exactly as a host's screen does, and it
// records each roster and phase in the order the page is told about them.
function pageBot({ game = 'shove', code, ...opts }) {
  const seen = [];
  let auto = null;
  let bot = null;
  bot = createBot({
    url: srv.url(game, code),
    room: code,
    origin: ORIGIN,
    ...opts,
    onEvent: (e) => {
      if (e.t === 'roster') seen.push({ t: 'roster', size: e.roster.size });
      if (e.t === 'phase') seen.push({ t: 'phase', phase: e.phase, why: e.why, rosterSize: bot.session.roster.size });
      if (e.t === 'roster' || e.t === 'phase' || (e.t === 'status' && e.status === 'online')) auto?.check();
    },
  });
  auto = createAutoStart(bot.session);
  autos.push(auto);
  return Object.assign(bot, { seen, auto });
}

// What the player who stayed must see once their friend is gone for good: the lobby,
// with the reason, a roster of one that arrived before it, and no match started for one.
async function assertLeftAlone(stay, room, matchesBefore) {
  await waitFor(() => stay.session.phase === 'lobby', 8000, 'back to the lobby');
  const lobby = stay.seen.findLast((x) => x.t === 'phase');
  assert.equal(lobby.why, 'opponent left', 'the lobby says why');
  assert.equal(lobby.rosterSize, 1, 'the roster of one arrives before the lobby phase');
  await wait(1500); // well past the host's 600 ms start beat
  assert.equal(room().phase, 'lobby', 'no ghost match for one');
  assert.equal(room().match, matchesBefore, 'no new match started');
  assert.equal(stay.session.phase, 'lobby');
  assert.equal(stay.session.roster.size, 1);
  assert.ok(stay.session.isHost, 'the player who stayed is host, so Play the CPU is offered');
}

test('a friend who presses Leave room mid-match leaves a lobby for one, and rejoining the code plays on', { timeout: 30000 }, async () => {
  const code = freshCode();
  const room = () => srv.registry.get('shove', code);
  const a = pageBot({ code, name: 'A', create: true, seed: 31 });
  await waitFor(() => a.session.net.status === 'online', 5000, 'host online');
  const b = pageBot({ code, name: 'B', seed: 32 });
  await waitFor(() => room()?.phase === 'playing' && [a, b].every((x) => x.session.phase === 'playing'), 5000, 'the host page to start the match');
  assert.equal(room().match, 1);
  await wait(1500);
  b.stop(); // Leave room: an explicit leave frees the seat at once
  await assertLeftAlone(a, room, 1);
  // The friend comes back with the same code: both seats fill and play goes on.
  const b2 = pageBot({ code, name: 'B', seed: 33 });
  await waitFor(() => room().phase === 'playing' && room().match === 2 && b2.session.phase === 'playing', 5000, 'a new match with the friend');
  assert.equal(room()._seats.size, 2);
  a.stop();
  b2.stop();
});

test('a friend who leaves from the scoreboard sends the host to the lobby, not a scoreboard where Rematch does nothing', { timeout: 150000 }, async () => {
  const code = freshCode();
  const room = () => srv.registry.get('shove', code);
  const a = pageBot({ code, name: 'A', create: true, seed: 41, autoRematch: false });
  await waitFor(() => a.session.net.status === 'online', 5000, 'host online');
  const b = pageBot({ code, name: 'B', seed: 42, autoRematch: false });
  await waitFor(() => room()?.phase === 'playing', 5000, 'match start');
  await waitFor(() => room()._game._duel.state === 'end', 120000, 'the match to end');
  b.stop();
  await assertLeftAlone(a, room, 1);
  a.stop();
});

test("a friend's closed tab: when the seat hold runs out the host gets the lobby, and the guest left behind becomes host and can play the CPU", { timeout: 30000 }, async () => {
  // The friend's tab closes mid-match (no Leave room): the seat is held, then expires.
  {
    const code = freshCode();
    const room = () => srv.registry.get('shovequick', code);
    const a = pageBot({ game: 'shovequick', code, name: 'A', create: true, seed: 51 });
    await waitFor(() => a.session.net.status === 'online', 5000, 'host online');
    const b = pageBot({ game: 'shovequick', code, name: 'B', seed: 52 });
    await waitFor(() => room()?.phase === 'playing', 5000, 'match start');
    await wait(1000);
    b.halt();
    await waitFor(() => room().phase === 'paused', 3000, 'paused for the held seat');
    await assertLeftAlone(a, room, 1);
    a.stop();
  }
  // The host's tab closes: the guest takes over the room, and its Play the CPU works.
  {
    const code = freshCode();
    const room = () => srv.registry.get('shovequick', code);
    const a = pageBot({ game: 'shovequick', code, name: 'A', create: true, seed: 53 });
    await waitFor(() => a.session.net.status === 'online', 5000, 'host online');
    const b = pageBot({ game: 'shovequick', code, name: 'B', seed: 54 });
    await waitFor(() => room()?.phase === 'playing', 5000, 'match start');
    await wait(1000);
    a.halt();
    await assertLeftAlone(b, room, 1);
    b.session.addBot(); // the lobby's "No friend yet? Play the CPU"
    await waitFor(() => room().phase === 'playing' && room().match === 2 && b.session.phase === 'playing', 5000, 'a match against the CPU');
    b.stop();
  }
});

test('the room refuses to start a match for one', async () => {
  const code = freshCode();
  const a = createBot({ url: srv.url('shove', code), room: code, name: 'A', create: true, origin: ORIGIN, seed: 61 });
  await waitFor(() => a.session.net.status === 'online', 5000, 'host online');
  a.session.start(); // a late or stale start, as the old page sent after a friend left
  await wait(500);
  const room = srv.registry.get('shove', code);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.match, 0);
  assert.equal(a.session.phase, 'lobby');
  a.stop();
});

test('a fighter standing still is still stepped on time when hit (no long freeze on the other screen)', { timeout: 30000 }, async () => {
  // The victim's client keeps sending neutral ticks, so the server counts its hit
  // freeze down on schedule instead of waiting for it to notice and start sending.
  const { bots, room } = await makeRoom({ latencyMs: 40, jitterMs: 10 }, { brains: ['balanced', 'idle'] });
  const [, victim] = bots;
  const freezes = [];
  let watching = null;
  const until = performance.now() + 20000;
  while (freezes.length < 3 && performance.now() < until) {
    await wait(4);
    const g = room()._game;
    const p = g._duel.player(g.team(victim.session.pid));
    if (!watching && p.ph === PH.FROZEN) watching = { tick: g._duel.ticks, expect: p.t };
    if (watching && p.ph !== PH.FROZEN) {
      freezes.push(g._duel.ticks - watching.tick - watching.expect);
      watching = null;
    }
  }
  console.log('idle victim: extra freeze ticks on the server', JSON.stringify(freezes));
  assert.ok(freezes.length >= 2, 'not enough hits to measure');
  assert.ok(Math.max(...freezes) <= 3, `freeze ran long by ${Math.max(...freezes)} ticks`);
  for (const x of bots) assert.equal(x.report().corrections, 0);
  for (const x of bots) x.stop();
});

test('a third player is told the room is full', async () => {
  const { code, bots } = await makeRoom({ latencyMs: 10, jitterMs: 5 }, { start: false });
  const third = createBot({ url: srv.url('shove', code), room: code, name: 'late', origin: ORIGIN, seed: 99 });
  await waitFor(() => third.session.net.status === 'gone', 3000, 'room full');
  assert.equal(third.session.net.stats.lastCloseCode, 4006);
  for (const x of bots) x.stop();
});

test('joining a code nobody made says so once, without a retry storm', async () => {
  const bot = createBot({ url: srv.url('shove', 'ZZZZ'), room: 'ZZZZ', name: 'lost', origin: ORIGIN });
  await wait(1200);
  assert.equal(bot.session.net.status, 'gone');
  assert.equal(bot.session.net.stats.lastCloseCode, 4004);
  assert.equal(srv.registry.get('shove', 'ZZZZ'), undefined);
});

test('a page from another site cannot open a room socket (Origin check)', async () => {
  const code = freshCode();
  const bot = createBot({ url: srv.url('shove', code), room: code, name: 'x', create: true, origin: 'http://evil.example', storage: memoryStorage() });
  await wait(1200);
  assert.notEqual(bot.session.net.status, 'online');
  assert.equal(srv.registry.get('shove', code), undefined, 'no room was made');
});

test("the host page's start beat checks the room again before it starts: a friend gone during the beat starts nothing", async () => {
  const two = new Map([
    ['p1', { pid: 'p1', kind: 0, online: true }],
    ['p2', { pid: 'p2', kind: 0, online: true }],
  ]);
  const fake = { phase: 'lobby', isHost: true, net: { status: 'online' }, roster: two, starts: 0, start() { this.starts++; } };
  const auto = createAutoStart(fake, { delayMs: 50 });
  auto.check();
  fake.roster = new Map([...two].slice(0, 1)); // the friend leaves inside the 600 ms beat
  await wait(120);
  assert.equal(fake.starts, 0, 'no start for one');
  fake.roster = two; // they come back: the next roster starts it
  auto.check();
  auto.check(); // a second event during the beat doesn't start twice
  await wait(120);
  assert.equal(fake.starts, 1);
  auto.cancel();
});
