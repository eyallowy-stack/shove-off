// An online match through the room server. The server owns the truth; this file
// predicts your own fighter (so your controls answer at once), draws the other one
// and the sinking floe from the snapshot buffer, and plays every confirming effect
// (bonk, flash, shake, splash, round results) when the render clock reaches the
// event's server time, so it lands on the contact you actually see.

import * as sim from './game/sim.js';
import { createArenaTracker } from './game/rules.js';
import { createSession } from './net/session.js';
import { roomPath } from './net/protocol.js';
import { createNetOverlay } from './net/overlay.js';
import { createLagProfile, laggyWebSocketClass } from './net/lag.js';
import { tabStorage } from './net/net.js';
import { read, write, remove } from './lib/storage.js';

// The room you're in, kept on this device (not just this tab) so that a phone that
// throws the app out of memory in the background can offer "Rejoin room K7Q0" on the
// next launch, with the same seat, while the server still holds it.
const ACTIVE = 'activeRoom';
export function savedRoom() {
  const r = read(ACTIVE, null);
  if (!r || typeof r.code !== 'string' || typeof r.pid !== 'string' || typeof r.token !== 'string' || !Number.isFinite(r.savedAt)) return null;
  // The seat is held for graceMs after the last contact; leave a little margin.
  if (Date.now() - r.savedAt > TUNING.graceMs - 2000 || Date.now() < r.savedAt) return null;
  return { code: r.code.slice(0, 8), pid: r.pid.slice(0, 16), token: r.token.slice(0, 64), savedAt: r.savedAt };
}
export const forgetRoom = () => remove(ACTIVE);

const { K, PH, TUNING } = sim;

export const STATUS_TEXT = {
  connecting: () => 'Connecting…',
  waking: () => 'Still connecting. Is the room server running?',
  online: () => '',
  reconnecting: (d) => `Connection lost. Reconnecting${d?.attempt > 1 ? ` (try ${d.attempt})` : ''}…`,
  replaced: () => 'You opened this room in another tab, so this one stepped out.',
  'new-code': () => 'That code is already in use. Make a new room.',
  gone: (d) =>
    d?.code === 4006
      ? d?.hadSeat
        ? 'The room is still holding your old seat. Try again in a few seconds.'
        : 'That room is full: it already has two players.'
      : d?.code === 4010
        ? 'The game was updated. Press Reload to get the new version.'
        : d?.code === 4004
          ? 'No room with that code. Check it, or make a new one.'
          : d?.code === 4011
            ? d?.reason || 'The room server is busy. Try again later.'
            : d?.code === 4012
              ? 'Your connection could not keep up. Try joining again.'
              : 'That room has ended.',
  unavailable: () => "The room server isn't answering. Check it's still running, then try again.",
  closed: () => 'Left the room.',
  blocked: () => "This page's Content-Security-Policy blocks the room server.",
};

// The host's page starts the match as soon as both seats are filled, after a short beat
// so "Both here. Starting…" can be read. Everything is checked again when the beat ends:
// a friend who left during it, or a roster that arrived after the phase, must never
// start a match for one. Exported so the tests can drive it with headless sessions.
export function createAutoStart(session, { delayMs = 600, isDestroyed = () => false } = {}) {
  let timer = 0;
  const ready = () =>
    !isDestroyed() &&
    session.phase === 'lobby' &&
    session.isHost &&
    session.net.status === 'online' &&
    [...session.roster.values()].filter((p) => p.kind !== 1 && p.online).length >= 2;
  return {
    check() {
      if (timer || !ready()) return;
      timer = setTimeout(() => {
        timer = 0;
        if (ready()) session.start();
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = 0;
    },
  };
}

import { ROOM_SERVER } from './config.js';

export function createOnlineMatch({ code, create, name, controls, renderer, events, stage, debug = false, lag = null, rejoin = null }) {
  const wsOrigin = ROOM_SERVER
    ? ROOM_SERVER.replace(/^http/, 'ws').replace(/\/+$/, '')
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  const arena = createArenaTracker();
  const queue = []; // server events waiting for the render clock
  const lagged = lag ? laggyWebSocketClass(createLagProfile(lag)) : null;
  let lastOnline = new Map();
  let scores = [0, 0];
  let lockZeroAt = 0;
  let prevLock = 0;
  let destroyed = false;
  // One person per device online: WASD, the arrows, every dash key and any pad drive you.
  controls.setMerged(true);
  controls.resetUsed();

  // Seat storage: this tab's (a reload rejoins), mirrored to the device-wide record, and
  // seeded from that record when the player chose "Rejoin room".
  const url = wsOrigin + roomPath('shove', code);
  const tab = tabStorage();
  let seat = null;
  const storage = {
    get: (k) => tab.get(k) ?? (rejoin && rejoin.code === code ? { pid: rejoin.pid, token: rejoin.token } : null),
    set(k, v) {
      tab.set(k, v);
      seat = v?.pid && v?.token ? { pid: v.pid, token: v.token } : null;
      if (seat) keepSeat();
      else forgetRoom();
    },
  };
  const keepSeat = () => seat && write(ACTIVE, { code, ...seat, savedAt: Date.now() });
  const seatTimer = setInterval(() => session?.net.status === 'online' && keepSeat(), 5000);

  // Keep the screen on while waiting in the lobby or playing: a phone that locks drops
  // the socket. Needs HTTPS (the ts.net address); released when hidden or on leave.
  let wake = null;
  const wantWake = () => !destroyed && document.visibilityState === 'visible';
  async function lockScreenOn() {
    if (wake || !wantWake() || !navigator.wakeLock?.request) return;
    try {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener?.('release', () => (wake = null));
      if (!wantWake()) releaseScreen();
    } catch {
      wake = null; // not allowed (battery saver, http://), never mind
    }
  }
  function releaseScreen() {
    const w = wake;
    wake = null;
    w?.release?.().catch?.(() => {});
  }

  const session = createSession({
    url,
    room: code,
    name,
    sim,
    create,
    sendAtRest: true,
    netOptions: {
      ...(lagged ? { WebSocketImpl: lagged } : {}),
      // The room server is your own laptop, not a sleeping free host: fail fast.
      wakeAfterMs: 2500,
      firstConnectTimeoutMs: 10000,
      giveUpAfterMs: 120000, // DESIGN.md: stop retrying after about 2 minutes, and say so
      storage,
      log: (o) => debug && console.debug('[net]', JSON.stringify({ room: code, tick: session?.stats.serverTick, ...o })),
    },
    onEvent,
  });
  const overlay = createNetOverlay(stage, session, { visible: debug });

  const mySlot = () => session.view?.sl?.[session.pid] ?? 0;
  const otherPid = () => [...session.roster.keys()].find((p) => p !== session.pid) ?? null;

  function onEvent(e) {
    if (destroyed) return;
    if (e.t === 'status') {
      if (['gone', 'replaced', 'new-code', 'closed'].includes(e.status)) forgetRoom();
      if (e.status === 'online') lockScreenOn();
      events.status?.(e.status, STATUS_TEXT[e.status]?.(e.detail) ?? '', e.detail);
      if (e.status === 'online') maybeStart();
      return;
    }
    if (e.t === 'roster') {
      // Opponent joined or dropped: a chime or a low tone, and words for both.
      const other = otherPid();
      const r = other ? session.roster.get(other) : null;
      const was = other ? lastOnline.get(other) : undefined;
      if (r && was === undefined) events.opponent?.('joined', r);
      else if (r && was === true && !r.online) events.opponent?.('dropped', r);
      else if (r && was === false && r.online) events.opponent?.('back', r);
      for (const [pid, p] of lastOnline) if (!session.roster.has(pid) && p !== undefined) events.opponent?.('left', { pid });
      lastOnline = new Map([...session.roster.values()].map((p) => [p.pid, p.online]));
      events.roster?.(session.roster);
      maybeStart();
      return;
    }
    if (e.t === 'phase') {
      queue.length = 0;
      scores = [...(e.view?.sc ?? scores)];
      events.phase?.(e.phase, e.why, e.view);
      maybeStart();
      return;
    }
    if (e.t === 'ev') {
      // Remember who we are as of now: by the time it is shown, the view may have moved on.
      if (e.kind === 'match') e.stats = session.view?.stats ?? null;
      queue.push(e);
    }
  }

  const autoStart = createAutoStart(session, { isDestroyed: () => destroyed });
  const maybeStart = () => autoStart.check();

  // Effects whose moment has come on this screen.
  function present(now) {
    const rt = session.renderTime(now);
    if (rt === null) return;
    while (queue.length && queue[0].tm <= rt) {
      const e = queue.shift();
      switch (e.kind) {
        case 'hit':
          renderer.hit({ ...e, who: e.whoSlot, by: e.bySlot }, now);
          break;
        case 'clash':
          renderer.clash(e, now);
          break;
        case 'save':
          renderer.save(e.whoSlot);
          break;
        case 'round':
          scores = [...e.scores];
          events.round?.({ ...e, winner: e.winnerSlot ?? -1 });
          break;
        case 'round-start':
          events.roundStart?.(e);
          break;
        case 'match':
          scores = [...e.scores];
          events.match?.({ winner: e.winnerSlot, scores: [...e.scores], stats: e.stats ?? session.view?.stats ?? null, mySlot: mySlot() });
          break;
      }
    }
  }

  document.addEventListener('visibilitychange', onVis);
  function onVis() {
    const visible = document.visibilityState === 'visible';
    session.setVisible(visible);
    if (visible) lockScreenOn();
    else releaseScreen();
  }

  return {
    session,
    mode: 'online',
    update() {
      controls.step();
      session.tick(controls.sample(0));
    },
    scene(alpha, now, frameMs = 16) {
      // The real frame time: correction easing runs at the same speed at 30, 60 or 120 fps.
      session.frame(Math.max(0, Math.min(100, frameMs)), now);
      present(now);
      const v = session.view;
      arena.update(v);
      const rt = session.renderTime(now);
      const elapsed = arena.elapsedAt(rt ?? 0, session.lastSnap, v);
      const world = arena.world(elapsed, v);
      const fighters = [null, null];
      const me = session.predictor?.state;
      const pos = session.localPos(alpha);
      const playing = session.phase !== 'lobby' && session.net.status === 'online';
      if (me && pos && playing) {
        fighters[mySlot()] = {
          x: pos.x,
          y: pos.y,
          ph: me.ph,
          charge: me.ph === PH.CHARGE ? Math.min(1, me.ch / K.chargeMax) : 0,
          pw: me.pw,
          fx: me.fx,
          fy: me.fy,
          teeter: me.ph !== PH.FALL && !world.alive(me.x, me.y),
          online: true,
          me: true,
        };
        if (prevLock > 0 && me.lock === 0) lockZeroAt = now;
        prevLock = me.lock;
      }
      const remotes = playing ? session.remotes(now) : [];
      for (const r of remotes) {
        const [ph = 0, charge = 0, deg = 0, flags = 0] = r.extra ?? [];
        const a = (deg * Math.PI) / 180;
        fighters[v?.sl?.[r.pid] ?? 1 - mySlot()] = {
          x: r.x,
          y: r.y,
          ph,
          charge: charge / 100,
          pw: ph === PH.DASH ? charge / 100 : 0,
          fx: Math.cos(a),
          fy: Math.sin(a),
          teeter: (flags & 1) === 1,
          online: r.online,
          me: false,
        };
      }
      overlay.update(now, remotes);
      // The countdown follows your own fighter's lock: GO is when you can move.
      const goIn = me && me.lock > 0 ? (me.lock * 1000) / TUNING.tickHz : lockZeroAt ? lockZeroAt - now : -1e9;
      return {
        fighters,
        floe: arena.floe,
        sinkAt: arena.sinkAt(v),
        floeKey: `${v?.sd}:${v?.st === 'end'}`,
        elapsed,
        state: v?.st ?? 'wait',
        goIn,
        hints: null,
        round: v?.r ?? 0,
        scores,
      };
    },
    get state() {
      return session.view?.st ?? 'wait';
    },
    get mySlot() {
      return mySlot();
    },
    get scores() {
      return scores;
    },
    rematch() {
      session.act('rematch');
    },
    addCpu() {
      session.addBot();
    },
    toggleOverlay: () => overlay.toggle(),
    destroy() {
      destroyed = true;
      autoStart.cancel();
      clearInterval(seatTimer);
      releaseScreen();
      document.removeEventListener('visibilitychange', onVis);
      session.leave();
      forgetRoom(); // left on purpose: nothing to rejoin
      overlay.destroy();
    },
  };
}
