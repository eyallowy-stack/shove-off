// A real-time room, from the client's side, without any drawing: roster,
// snapshots, prediction for the local player, interpolation for everyone and
// everything else, and input batching. The browser game and the headless bots
// both use this file, so a bot run tests exactly what players run.
// Turn-based games use client/turns.js instead.
//
//   const session = createSession({ url, room, name, sim, onEvent });
//   // in createLoop's update, at sim.TUNING.tickHz:  session.tick({ mx, my })
//   // in render:  session.localPos(alpha), session.remotes(), session.entities()

import { decodeSnapshot } from './protocol.js';
import { createNet } from './net.js';
import { createRoster } from './roster.js';
import { createPredictor } from './predict.js';
import { createSnapshotBuffer, createPlaybackClock, interpolationDelayMs } from './snapshots.js';

const ENTITY = '#'; // entity tracks share the buffer with players, under a prefix

export function createSession({
  url,
  room,
  name,
  sim, // the game's shared sim.js: TUNING, stepPlayer, isNeutral, atRest, encodeInput, decodeSelf
  create = false,
  role = 'player',
  // Shove Off sets this: the server only steps a fighter when its inputs arrive, so a
  // fighter standing still (sending nothing) who gets hit would stay frozen on the
  // server until its client noticed and started sending: measured 117 ms too long at
  // 40 ms one way. A neutral tick at rest is still a no-op (sim.test.mjs), just sent.
  sendAtRest = false,
  netOptions = {}, // passed through to createNet (signal, storage, ticket, WebSocketImpl, timeouts...)
  interpDelayMs = interpolationDelayMs(sim.TUNING.snapshotHz), // the starting delay; it adapts (below)
  maxInterpDelayMs = 250,
  onEvent = () => {}, // { t: 'ev', kind, ... } from the server, and 'phase', 'roster', 'status'
  now = () => performance.now(),
}) {
  const T = sim.TUNING;
  const roster = createRoster();
  const buffer = createSnapshotBuffer();
  const playback = createPlaybackClock();
  let predictor = null;
  let myPid = null;
  let phase = 'lobby';
  let match = 0;
  let epoch = 0; // the room's start/pause/resume counter; inputs carry it (server/room.js)
  let view = null;
  let visible = true;
  let resync = false; // wait for the next snapshot and stand where it says
  let holdUntil = 0;
  let outbox = [];
  let ticksSinceFlush = 0;
  let lastRosterAsk = -Infinity;
  let entityIds = new Set();
  const flushEvery = Math.max(1, Math.round(T.tickHz / T.inputSendHz));
  const stats = { rosterAsks: 0, snapshots: 0, lastSnapshotAt: 0, snapshotGapMs: 0, serverTick: 0, serverTickHz: 0, unknownPids: 0 };
  let lastSnap = null; // { tick, time } of the newest snapshot: maps server ticks to server time
  let prevSnap = null;

  // The interpolation delay adapts to the link. On a clean link it stays at 2.5 send
  // intervals (83 ms at 30 Hz). When the other fighter has to stand still or be guessed
  // ('hold' or 'extrap') on more than 5% of frames in a 2 s window, which is what TCP
  // stalls on lossy Wi-Fi or a relayed Tailscale link do, it grows by one send interval,
  // up to maxInterpDelayMs; after a few clean seconds it shrinks back slowly. The drawn
  // delay slews toward the target at 5%, so the other fighter never visibly jumps.
  const sendMs = 1000 / T.snapshotHz;
  const baseDelay = interpDelayMs;
  const maxDelay = Math.max(baseDelay, maxInterpDelayMs);
  let delayTarget = baseDelay;
  let delay = baseDelay;
  const win = { start: 0, frames: 0, bad: 0, cleanSince: 0 };
  function adapt(clientNow, dtMs) {
    const step = 0.05 * Math.max(0, Math.min(100, dtMs));
    delay += Math.max(-step, Math.min(step, delayTarget - delay));
    if (phase !== 'playing') return;
    const rt = renderTime(clientNow);
    if (rt === null) return;
    let any = false;
    let bad = false;
    for (const r of roster.byPid.values()) {
      if (r.pid === myPid) continue;
      const smp = buffer.sample(r.pid, rt);
      if (!smp || smp.state === 'waiting') continue;
      any = true;
      if (smp.state !== 'interp') bad = true;
    }
    if (!any) return;
    if (!win.start) win.start = win.cleanSince = clientNow;
    win.frames++;
    if (bad) {
      win.bad++;
      win.cleanSince = clientNow;
    }
    if (clientNow - win.start < 2000) return;
    if (win.bad / win.frames > 0.05) delayTarget = Math.min(maxDelay, delayTarget + sendMs);
    else if (clientNow - win.cleanSince > 4000) delayTarget = Math.max(baseDelay, delayTarget - sendMs / 2);
    win.start = clientNow;
    win.frames = win.bad = 0;
  }

  function setRoster(rows, version, hostPid) {
    roster.set(rows, version, hostPid);
    // No ghosts at a departed player's last spot; entity tracks come and go with snapshots.
    buffer.removeMissing(new Set(roster.byPid.keys()), (id) => id.startsWith(ENTITY));
    onEvent({ t: 'roster', roster: roster.byPid, rv: roster.rv, host: roster.host });
  }

  // A snapshot naming someone we don't know means our roster is stale. Ask for the
  // full roster (once per half second) instead of treating it as a network failure.
  function askRoster() {
    const t = now();
    if (t - lastRosterAsk < 500) return;
    lastRosterAsk = t;
    stats.rosterAsks++;
    net.send({ t: 'need' });
  }

  function standAt(encoded) {
    const s = sim.decodeSelf(encoded);
    predictor ??= createPredictor({ step: sim.stepPlayer, isNeutral: sim.isNeutral, atRest: sim.atRest, start: s, maxPending: 4 * T.tickHz, skipAtRest: !sendAtRest });
    predictor.resetTo(s);
  }

  // The timeline changed under us (a new match, a resume, a tab coming back):
  // old samples and the old clock offset describe a different moment.
  function freshTimeline() {
    buffer.clear();
    playback.reset();
    outbox = [];
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        if (!visible) net.send({ t: 'away', on: true }); // belt and braces with the hello
        myPid = msg.pid;
        phase = msg.phase;
        match = msg.match;
        epoch = msg.ep ?? 0;
        view = msg.view;
        setRoster(msg.players, msg.rv, msg.host);
        freshTimeline();
        if (msg.you) standAt(msg.you); // join or rejoin: stand where the server says
        resync = false;
        onEvent({ t: 'phase', phase, view });
        break;
      case 'roster':
        setRoster(msg.players, msg.rv, msg.host);
        break;
      case 'phase':
        phase = msg.phase;
        match = msg.match;
        epoch = msg.ep ?? epoch;
        outbox = []; // anything unsent belongs to the old epoch
        view = msg.view ?? view;
        if (phase !== 'paused') freshTimeline(); // paused: keep drawing the frozen scene
        // Every new match (and a resume) carries our state, so prediction restarts
        // from it at once. Inputs still in flight from the last match are ignored by
        // the server (they carry the old match number), so nothing is replayed twice.
        if (msg.you) {
          standAt(msg.you);
          resync = false;
        } else resync = true;
        onEvent({ t: 'phase', phase, view, why: msg.why });
        break;
      case 's': {
        const snap = decodeSnapshot(msg, roster.byPid); // throws ProtocolError on garbage; net counts it
        if (snap.missing > 0 || snap.rv !== roster.rv) {
          stats.unknownPids += snap.missing;
          askRoster();
        }
        const t = now();
        playback.onSnapshot(snap.time, t);
        stats.snapshots++;
        if (stats.lastSnapshotAt) stats.snapshotGapMs = t - stats.lastSnapshotAt;
        stats.lastSnapshotAt = t;
        if (prevSnap && snap.time > prevSnap.time) {
          stats.serverTickHz = ((snap.tick - prevSnap.tick) * 1000) / (snap.time - prevSnap.time);
        }
        prevSnap = snap;
        lastSnap = { tick: snap.tick, time: snap.time };
        stats.serverTick = snap.tick;
        view = snap.view ?? view;
        if (snap.me) {
          // Hidden, we predict nothing (the server's autopilot moves us), so just follow it.
          if (resync || !predictor || !visible) {
            standAt(snap.me);
            resync = false;
          } else predictor.reconcile(sim.decodeSelf(snap.me), snap.ack);
        }
        for (const p of snap.players) buffer.push(p.id, snap.time, p.x, p.y, p.warp, p.extra);
        const ids = new Set();
        for (const e of snap.entities) {
          ids.add(ENTITY + e.id);
          buffer.push(ENTITY + e.id, snap.time, e.x, e.y, e.warp, e.extra);
        }
        for (const id of entityIds) if (!ids.has(id)) buffer.remove(id); // gone from the world
        entityIds = ids;
        break;
      }
      case 'ev':
        onEvent(msg);
        break;
    }
  }

  const net = createNet({
    url,
    room,
    name,
    create,
    role,
    now,
    // A tab that reconnects while hidden (a Wi-Fi blip in the background) says so, so the
    // server keeps treating it as away instead of freezing a fighter nobody steers.
    hello: () => (visible ? {} : { away: true }),
    onMessage,
    onStatus: (status, detail) => onEvent({ t: 'status', status, detail }),
    ...netOptions,
  });

  function flush() {
    ticksSinceFlush = 0;
    if (!outbox.length) return;
    net.send({ t: 'in', m: match, e: epoch, i: outbox }, { droppable: true });
    outbox = [];
  }

  const renderTime = (clientNow = now()) => {
    const head = playback.now(clientNow);
    return head === null ? null : head - delay;
  };

  return {
    net,
    buffer,
    roster: roster.byPid,
    stats,
    get interpDelayMs() {
      return delay;
    },

    // Call from the fixed-step update, at exactly sim.TUNING.tickHz, with this
    // tick's input (for example { mx, my }). Returns the input sent, or null.
    tick(input) {
      if (!predictor || phase !== 'playing' || !visible || resync || net.status !== 'online' || now() < holdUntil) return null;
      const sent = predictor.apply(input);
      if (sent) outbox.push(sim.encodeInput(sent));
      if (++ticksSinceFlush >= flushEvery) flush();
      return sent;
    },

    // Withhold our input for a while, for a respawn freeze. Nothing pauses: the
    // predicted step just gets no input, exactly like the server's.
    holdInput(ms) {
      holdUntil = Math.max(holdUntil, now() + ms);
    },

    // Call once per rendered frame, with the real time since the last one.
    frame(dtMs, clientNow = now()) {
      predictor?.decay(dtMs);
      adapt(clientNow, dtMs);
    },

    // alpha: createLoop's render(alpha), the fraction of a tick since the last update.
    localPos(alpha) {
      return predictor ? predictor.renderPos(alpha) : null;
    },

    // The server time remote players are drawn at. An event stamped `tm` (a tag, a
    // pickup) has visibly happened on this screen once renderTime() >= tm.
    renderTime,

    // Remote players, drawn interpDelayMs behind the newest snapshots.
    remotes(clientNow = now()) {
      const renderT = renderTime(clientNow);
      if (renderT === null) return [];
      const out = [];
      for (const r of roster.byPid.values()) {
        if (r.pid === myPid) continue;
        const s = buffer.sample(r.pid, renderT);
        if (s) out.push({ ...r, x: s.x, y: s.y, extra: s.extra, state: s.state, depth: buffer.depth(r.pid, renderT) });
      }
      return out;
    },

    // World objects (a dropped flag, a puck), interpolated the same way.
    entities(clientNow = now()) {
      const renderT = renderTime(clientNow);
      if (renderT === null) return [];
      const out = [];
      for (const id of entityIds) {
        const s = buffer.sample(id, renderT);
        if (s) out.push({ id: id.slice(ENTITY.length), x: s.x, y: s.y, extra: s.extra, state: s.state });
      }
      return out;
    },

    // Hidden tab: stop sending and tell the server we're away (it stands us still, or
    // a game with momentum lands us). Visible again: the old samples and clock are
    // stale; send nothing until the next snapshot, then stand where it says.
    setVisible(v) {
      if (v === visible) return;
      visible = v;
      outbox = [];
      net.send({ t: 'away', on: !v });
      if (v) {
        freshTimeline();
        net.clock.reset();
        resync = true;
        askRoster();
      }
    },

    start: () => net.send({ t: 'start' }),
    stop: () => net.send({ t: 'stop' }),
    pause: () => net.send({ t: 'pause' }), // host only: pauses everyone
    resume: () => net.send({ t: 'resume' }),
    addBot: () => net.send({ t: 'bot', add: true }), // host only, in the lobby
    removeBot: () => net.send({ t: 'bot', add: false }),
    leave: () => net.close(),

    get pid() {
      return myPid;
    },
    get phase() {
      return phase;
    },
    get view() {
      return view;
    },
    get host() {
      return roster.host;
    },
    get isHost() {
      return myPid !== null && myPid === roster.host;
    },
    get predictor() {
      return predictor;
    },
    get lastSnap() {
      return lastSnap;
    },
    get match() {
      return match;
    },
    // A discrete action for the rules (Shove Off: { a: 'rematch' }).
    act: (a) => net.send({ t: 'act', a }),
  };
}
