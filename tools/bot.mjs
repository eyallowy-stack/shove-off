// A headless Shove Off player: the real client session (js/net/session.js and
// js/net/net.js) through a simulated bad network, driven by the shared CPU (cpu.js)
// from what this player would actually see: its own predicted fighter, and the
// other fighter drawn from the snapshot buffer, interpolationDelay in the past.
// A "renderer" samples that 60 times a second and counts how remote players were
// drawn. Adapted from the multiplayer-web-games starter's test/bot.mjs.

import { createSession } from '../js/net/session.js';
import { memoryStorage } from '../js/net/net.js';
import { createLagProfile, laggyWebSocketClass } from '../js/net/lag.js';
import * as sim from '../js/game/sim.js';
import { createBrain, rng, createArenaTracker } from '../js/game/rules.js';

const { TUNING, K } = sim;

// A remote row's extras -> what the CPU's senses take (js/game/cpu.js perceive): the
// same position, phase, glow-ring charge and facing a local CPU sees.
export function remoteToFighter(r) {
  const [ph = 0, charge = 0, deg = 0] = r.extra ?? [];
  const a = (deg * Math.PI) / 180;
  return { x: r.x, y: r.y, ph, charge: charge / 100, ch: Math.round((charge / 100) * K.chargeMax), fx: Math.cos(a), fy: Math.sin(a) };
}

export function createBot({
  url,
  room,
  name,
  create = false,
  lag = {},
  origin,
  seed = 1,
  brain = 'balanced',
  autoRematch = true,
  renderHz = 60,
  storage = memoryStorage(),
  log,
  onEvent = () => {},
}) {
  const random = rng(seed);
  const profile = createLagProfile({ random, ...lag });
  const WebSocketImpl = laggyWebSocketClass(profile);
  const events = {};
  const statuses = [];
  const arena = createArenaTracker();
  let think = brain === 'idle' ? () => ({ mx: 0, my: 0, b: 0 }) : createBrain(brain, random, { reaction: 6 });
  let rematchAsked = false;
  let matchesSeen = 0;
  const session = createSession({
    url,
    room,
    name,
    sim,
    create,
    sendAtRest: true,
    netOptions: { WebSocketImpl, socketOptions: origin ? { headers: { origin } } : undefined, storage, random, log },
    onEvent: (e) => {
      if (e.t === 'ev') {
        events[e.kind] = (events[e.kind] ?? 0) + 1;
        if (e.kind === 'match') matchesSeen++;
      }
      if (e.t === 'status') statuses.push(e.status);
      onEvent(e);
    },
  });
  const tickMs = 1000 / TUNING.tickHz;
  const seen = { interp: 0, extrap: 0, hold: 0, waiting: 0 };
  let depthSum = 0;
  let depthN = 0;
  let maxLocalJump = 0;
  let lastLocal = null;
  let lastSnaps = 0;
  let paused = false;

  function drawnFoe(t) {
    const r = session.remotes(t)[0];
    return r ? remoteToFighter(r) : null;
  }

  function nextInput() {
    const v = session.view;
    const me = session.predictor?.state;
    if (!v || !me) return sim.NEUTRAL;
    if (v.st === 'end' && autoRematch && !rematchAsked) {
      rematchAsked = true;
      setTimeout(() => session.act('rematch'), 600 + random() * 600);
    }
    if (v.st !== 'end') rematchAsked = false;
    const t = performance.now();
    const foe = drawnFoe(t);
    if (!foe) return sim.NEUTRAL;
    arena.update(v);
    const world = arena.world(arena.elapsedAt(session.renderTime(t) ?? 0, session.lastSnap, v), v);
    const i = think(me, foe, world);
    return { mx: i.mx, my: i.my, b: i.b };
  }

  let acc = 0;
  let last = performance.now();
  const update = setInterval(() => {
    const t = performance.now();
    acc += Math.min(250, t - last);
    last = t;
    while (acc >= tickMs) {
      acc -= tickMs;
      if (!paused) session.tick(nextInput());
    }
  }, tickMs / 2);

  let lastFrame = performance.now();
  const render = setInterval(() => {
    const t = performance.now();
    session.frame(t - lastFrame);
    lastFrame = t;
    if (session.phase !== 'playing' || session.net.status !== 'online') return;
    for (const r of session.remotes(t)) {
      seen[r.state]++;
      depthSum += r.depth;
      depthN++;
    }
    const me = session.localPos(acc / tickMs);
    const snaps = session.predictor?.snaps ?? 0;
    if (me && lastLocal && snaps === lastSnaps) maxLocalJump = Math.max(maxLocalJump, Math.hypot(me.x - lastLocal.x, me.y - lastLocal.y));
    lastLocal = me;
    lastSnaps = snaps;
  }, 1000 / renderHz);

  return {
    session,
    profile,
    events,
    statuses,
    get matches() {
      return matchesSeen;
    },
    setBrain(kind) {
      think = kind === 'idle' ? () => ({ mx: 0, my: 0, b: 0 }) : createBrain(kind, random, { reaction: 6 });
    },
    hide() {
      paused = true;
      session.setVisible(false);
    },
    show() {
      paused = false;
      session.setVisible(true);
    },
    stop() {
      clearInterval(update);
      clearInterval(render);
      session.leave();
    },
    halt() {
      // stop without leaving, as if the tab crashed: the server holds the seat
      clearInterval(update);
      clearInterval(render);
      session.net.abandon();
    },
    report() {
      const total = seen.interp + seen.extrap + seen.hold + seen.waiting || 1;
      const p = session.predictor;
      return {
        pid: session.pid,
        status: session.net.status,
        interp: +(seen.interp / total).toFixed(3),
        extrap: +(seen.extrap / total).toFixed(3),
        hold: +(seen.hold / total).toFixed(3),
        depthAvg: depthN ? +(depthSum / depthN).toFixed(2) : null,
        corrections: p?.corrections ?? 0,
        serverChanges: p?.serverChanges ?? 0,
        snaps: p?.snaps ?? 0,
        maxLocalJump: +maxLocalJump.toFixed(1),
        rttMs: Math.round(session.net.clock.rttMin),
        decodeErrors: session.net.stats.decodeErrors,
        reconnects: session.net.stats.reconnects,
        rosterSize: session.roster.size,
        hits: events.hit ?? 0,
        clashes: events.clash ?? 0,
        rounds: events.round ?? 0,
        matches: matchesSeen,
      };
    },
  };
}
