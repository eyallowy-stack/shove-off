// A phone that sleeps, or walks from Wi-Fi onto cellular: its socket can die without a
// close event and still say OPEN (Safari does this). When the page comes back or the
// network changes, js/net/net.js probes: no reply within probeMs and it drops the
// socket and rejoins the same seat at once. Without the probe, the lobby's 45 s
// staleness check would be the first to notice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../server/ws.mjs';
import { createShoveRules } from '../js/game/rules.js';
import { createSession } from '../js/net/session.js';
import { memoryStorage } from '../js/net/net.js';
import { createBot } from '../tools/bot.mjs';
import * as sim from '../js/game/sim.js';

const ORIGIN = 'http://test.local';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms, what) {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

// A socket whose network can be cut: once dead it delivers nothing either way, never
// reports a close, and keeps saying OPEN.
function flakySockets() {
  const made = [];
  class Flaky {
    constructor(url, options) {
      this.inner = new WebSocket(url, options);
      this.dead = false;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.inner.onopen = (e) => !this.dead && this.onopen?.(e);
      this.inner.onmessage = (e) => !this.dead && this.onmessage?.(e);
      this.inner.onclose = (e) => !this.dead && this.onclose?.(e);
      this.inner.onerror = (e) => !this.dead && this.onerror?.(e);
      made.push(this);
    }
    get readyState() {
      return this.dead ? 1 : this.inner.readyState;
    }
    get bufferedAmount() {
      return this.inner.bufferedAmount;
    }
    send(data) {
      if (!this.dead && this.inner.readyState === 1) this.inner.send(data);
    }
    close(code, reason) {
      if (!this.dead) this.inner.close(code, reason);
    }
  }
  return { Flaky, made, cut: () => (made.at(-1).dead = true) };
}

let srv;
before(async () => {
  srv = await startTestServer({ allowedOrigins: [ORIGIN], games: { shove: createShoveRules({ crumble: { crumbleStartS: 2.5, crumbleEveryS: 1 } }) } });
});
after(async () => {
  await wait(200);
  await srv.stop();
});

function phone(code, create, extra = {}) {
  const net = flakySockets();
  const session = createSession({
    url: srv.url('shove', code),
    room: code,
    name: 'Phone',
    sim,
    create,
    sendAtRest: true,
    netOptions: { WebSocketImpl: net.Flaky, socketOptions: { headers: { origin: ORIGIN } }, storage: memoryStorage(), probeMs: 1500, ...extra },
  });
  // The page's loop: ticks at 60 Hz, frames for the snapshot clock.
  const loop = setInterval(() => {
    session.tick(sim.NEUTRAL);
    session.frame(16);
  }, 1000 / 60);
  return { session, net, stop: () => (clearInterval(loop), session.leave()) };
}

test('in the lobby: the phone wakes on a dead socket, notices within the probe, and gets its seat back', { timeout: 20000 }, async () => {
  const code = 'W001';
  const p = phone(code, true);
  await waitFor(() => p.session.net.status === 'online', 5000, 'phone online');
  const friend = createBot({ url: srv.url('shove', code), room: code, name: 'Friend', origin: ORIGIN, lag: { latencyMs: 10, jitterMs: 2 } });
  await waitFor(() => p.session.roster.size === 2, 5000, 'friend in the lobby');
  const pid = p.session.pid;
  p.net.cut(); // asleep, or the Wi-Fi went away under it
  await wait(300);
  const t0 = performance.now();
  p.session.net.probe('visible'); // what visibilitychange / 'online' / a network change call
  await waitFor(() => p.net.made.length === 2 && p.session.net.status === 'online', 6000, 'back online');
  const took = performance.now() - t0;
  console.log(`lobby: back in ${Math.round(took)} ms after waking`);
  assert.ok(took < 4000, `took ${Math.round(took)} ms (the lobby's own staleness check is 45 s)`);
  assert.equal(p.session.pid, pid, 'same seat');
  assert.equal(p.session.roster.size, 2, 'the friend is still there');
  assert.equal(srv.registry.get('shove', code)._seats.size, 2, 'no ghost third seat');
  // A live socket answers the probe and is left alone.
  p.session.net.probe('visible');
  await wait(2000);
  assert.equal(p.net.made.length, 2, 'a healthy socket is not replaced');
  friend.halt();
  friend.stop();
  p.stop();
});

test('mid-match: a network switch is noticed by the probe and the match carries on with the same seat', { timeout: 25000 }, async () => {
  const code = 'W002';
  const p = phone(code, true);
  await waitFor(() => p.session.net.status === 'online', 5000, 'phone online');
  const friend = createBot({ url: srv.url('shove', code), room: code, name: 'Friend', origin: ORIGIN, lag: { latencyMs: 10, jitterMs: 2 } });
  await waitFor(() => p.session.roster.size === 2, 5000, 'both in');
  p.session.start();
  await waitFor(() => p.session.phase === 'playing', 5000, 'playing');
  await wait(1500);
  const pid = p.session.pid;
  p.net.cut();
  const t0 = performance.now();
  p.session.net.probe('network');
  await waitFor(() => p.net.made.length === 2 && p.session.net.status === 'online', 6000, 'rejoined');
  const took = performance.now() - t0;
  console.log(`match: rejoined in ${Math.round(took)} ms after the network change`);
  assert.ok(took < 3500, `took ${Math.round(took)} ms`);
  assert.equal(p.session.pid, pid);
  await waitFor(() => srv.registry.get('shove', code).phase === 'playing', 5000, 'room playing again');
  friend.halt();
  friend.stop();
  p.stop();
});

test('waiting out a long backoff when the network comes back: it tries again at once', { timeout: 20000 }, async () => {
  const code = 'W003';
  // The next retry is 20 s away, as it would be after a few failed tries.
  const p = phone(code, true, { backoff: { baseMs: 20000, capMs: 20000, random: () => 0.99 } });
  await waitFor(() => p.session.net.status === 'online', 5000, 'phone online');
  p.net.made.at(-1).inner.close(4000, 'network gone');
  await waitFor(() => p.session.net.status === 'reconnecting', 3000, 'reconnecting');
  await wait(300);
  assert.equal(p.net.made.length, 1, 'still waiting out the backoff');
  const t0 = performance.now();
  p.session.net.probe('online'); // the browser says the network is back
  await waitFor(() => p.session.net.status === 'online', 4000, 'back');
  const took = performance.now() - t0;
  console.log(`backoff: back in ${Math.round(took)} ms instead of about 20 s`);
  assert.ok(took < 2000);
  p.stop();
});
