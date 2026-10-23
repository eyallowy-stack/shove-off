// The client's connection to one room: join, heartbeat, reconnect, close reasons.
//
// Runs unchanged in the browser and in Node 22+ (which has a global WebSocket),
// so headless bots exercise exactly the code players run.
//
// Status values passed to onStatus(status, detail):
//   'connecting'   first attempt in progress
//   'waking'       first attempt is slow: a free host is probably cold-starting
//   'online'       joined; detail = { pid, rejoined }
//   'reconnecting' connection lost; detail = { attempt, inMs }
//   'replaced'     this player opened the room in another tab (final)
//   'new-code'     the join code is taken; make another (final)
//   'gone'         the room no longer exists, is full, the game updated, or the
//                  join ticket was refused (final); detail = { code, reason }
//   'unavailable'  no connection for giveUpAfterMs: the server is down, or a free
//                  plan's daily limit ran out (final; reconnectNow() tries again)
//   'blocked'      the page's Content-Security-Policy forbids the room host (final, a deploy bug)
//   'closed'       we closed it ourselves (final)

import { PROTOCOL, CLOSE, classifyClose, encode, decode, ProtocolError } from './protocol.js';
import { createClock } from './clock.js';
import { backoffDelay } from './backoff.js';

export { backoffDelay };

// sessionStorage is per tab, so two tabs are two players (what you want when testing
// with two windows), and a reload of one tab rejoins as the same player.
export function tabStorage(prefix = 'net:') {
  return {
    get(key) {
      try {
        return JSON.parse(sessionStorage.getItem(prefix + key));
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        sessionStorage.setItem(prefix + key, JSON.stringify(value));
      } catch {
        /* private mode or blocked storage: we just won't survive a reload */
      }
    },
  };
}

export function memoryStorage() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
}

export function createNet({
  url, // full room URL, e.g. 'wss://rooms.example.org/room/tag/K7QX'
  room, // the join code
  name,
  create = false, // true when this player made the code up and expects a fresh room
  role = 'player', // or 'display': a shared screen that watches without playing
  ticket = null, // async () => string, for rooms behind an app's accounts (server/ticket.js); called per attempt
  storage = typeof sessionStorage !== 'undefined' ? tabStorage() : memoryStorage(),
  signal, // Cougar Arcade's ctx.signal: aborting closes the room connection for good
  now = () => performance.now(),
  WebSocketImpl = globalThis.WebSocket,
  socketOptions, // Node only, e.g. { headers: { origin } } for bots
  staleMs = 4000, // real-time match: snapshots arrive 15 times a second, so 4 s of silence is a dead socket
  pingMs = 2000, // real-time match: frequent pings double as clock samples
  turnStaleMs = 25000, // turn-based match: no snapshots, so pings and pongs are the proof of life
  turnPingMs = 10000,
  lobbyStaleMs = 45000,
  lobbyPingMs = 15000,
  wakeAfterMs = 3000,
  firstConnectTimeoutMs = 75000, // a cold free-tier server can take about a minute
  connectTimeoutMs = 10000,
  giveUpAfterMs = 120000, // this long without getting back in: stop and say so
  probeMs = 2500, // after the phone wakes or changes network: no reply in this long means the socket is dead
  backoff = {},
  maxBufferedBytes = 16 * 1024,
  hello = () => ({}), // extra fields for every hello, e.g. { away: true } from a hidden tab
  onMessage = () => {},
  onStatus = () => {},
  log = () => {},
}) {
  const clock = createClock();
  const key = `room:${url}`;
  let saved = storage.get(key); // { pid, token } from an earlier join in this tab (or a rejoin)
  const hadSeat = !!saved?.pid;
  let sock = null;
  let status = 'idle';
  let phase = 'lobby';
  let realtime = true;
  let attempt = 0;
  let everOnline = false;
  let finished = false;
  let failingSince = 0;
  let lastMsgAt = 0;
  let onlineSince = 0;
  let retryTimer = 0;
  let wakeTimer = 0;
  let openTimer = 0;
  let pingTimer = 0;
  let watchTimer = 0;
  let probeTimer = 0;
  const own = new AbortController(); // our page listeners, removed when we leave for good
  signal?.addEventListener('abort', () => own.abort(), { once: true });
  const stats = {
    msgsIn: 0,
    msgsOut: 0,
    bytesIn: 0,
    decodeErrors: 0, // our bug or a stale roster, never counted as a network failure
    reconnects: 0,
    skippedSends: 0,
    lastCloseCode: null,
  };

  function setStatus(s, detail) {
    status = s;
    onStatus(s, detail);
  }

  function clearTimers() {
    clearTimeout(retryTimer);
    clearTimeout(wakeTimer);
    clearTimeout(openTimer);
    clearInterval(pingTimer);
    clearInterval(watchTimer);
    clearTimeout(probeTimer);
  }

  async function connect() {
    if (finished) return;
    clearTimers();
    const first = !everOnline;
    setStatus(first ? 'connecting' : 'reconnecting', { attempt });
    let t = null;
    if (ticket) {
      try {
        t = await ticket(); // a fresh one each attempt: tickets expire in about a minute
      } catch (err) {
        log({ ev: 'ticket-failed', msg: err?.message });
        return closed(1006, 'ticket');
      }
      if (finished) return;
    }
    const s = socketOptions ? new WebSocketImpl(url, socketOptions) : new WebSocketImpl(url);
    sock = s;
    if (first) wakeTimer = setTimeout(() => s === sock && status === 'connecting' && setStatus('waking'), wakeAfterMs);
    openTimer = setTimeout(() => {
      if (s !== sock || s.readyState === 1) return;
      log({ ev: 'connect-timeout' });
      drop(s, 'connect timeout');
    }, first ? firstConnectTimeoutMs : connectTimeoutMs);

    // Every handler checks that it belongs to the current socket. An old socket's
    // late close event would otherwise start a second reconnect, and the player
    // would end up in the room twice.
    s.onopen = () => {
      if (s !== sock) return;
      clearTimeout(openTimer);
      clearTimeout(wakeTimer);
      lastMsgAt = now();
      rawSend({ ...hello(), t: 'hello', v: PROTOCOL, room, name, role, create: create && !everOnline, pid: saved?.pid, token: saved?.token, ticket: t ?? undefined });
    };
    s.onmessage = (ev) => {
      if (s !== sock) return;
      lastMsgAt = now(); // any message is proof of life, so snapshots double as the server's heartbeat
      stats.msgsIn++;
      stats.bytesIn += typeof ev.data === 'string' ? ev.data.length : 0;
      let msg;
      try {
        msg = decode(ev.data);
      } catch (err) {
        stats.decodeErrors++;
        log({ ev: 'decode-error', msg: err.message });
        return;
      }
      handle(msg);
    };
    s.onclose = (ev) => {
      if (s !== sock) return;
      closed(ev.code, ev.reason);
    };
    s.onerror = () => {}; // a close event always follows; that is where we decide
  }

  function handle(msg) {
    switch (msg.t) {
      case 'welcome':
        if (msg.token) saved = { pid: msg.pid, token: msg.token };
        storage.set(key, saved);
        phase = msg.phase;
        realtime = msg.realtime !== false;
        if (everOnline) stats.reconnects++;
        everOnline = true;
        failingSince = 0;
        onlineSince = now();
        clock.reset();
        if (Number.isFinite(msg.tm)) clock.seed(msg.tm, now());
        startHeartbeat();
        deliver(msg);
        setStatus('online', { pid: msg.pid, rejoined: msg.rejoined }); // after the game has seen the welcome
        return;
      case 'pong':
        if (Number.isFinite(msg.c) && Number.isFinite(msg.s)) clock.addSample(msg.c, msg.s, msg.s, now());
        return; // the game doesn't need to see pongs
      case 'phase':
        phase = msg.phase;
        startHeartbeat(); // cadence and staleness limits differ between lobby and match
        break;
      case 's':
        if (Number.isFinite(msg.tm)) clock.seed(msg.tm, now());
        break;
    }
    // A backoff counter only resets once a connection has stayed up a while, or a
    // server that accepts and immediately drops us would be retried in a tight loop.
    if (attempt && now() - onlineSince > 5000) attempt = 0;
    deliver(msg);
  }

  function deliver(msg) {
    try {
      onMessage(msg);
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      stats.decodeErrors++;
      log({ ev: 'decode-error', type: msg.t, msg: err.message });
    }
  }

  function cadence() {
    if (phase === 'lobby') return { ping: lobbyPingMs, stale: lobbyStaleMs }; // the lobby is quiet
    // Paused counts as the match: no snapshots arrive, so pings keep proving we're alive,
    // and the server's stale check must see them when the clock starts again.
    if (phase === 'paused') return realtime ? { ping: pingMs, stale: Math.max(staleMs, pingMs * 3) } : { ping: turnPingMs, stale: turnStaleMs };
    return realtime ? { ping: pingMs, stale: staleMs } : { ping: turnPingMs, stale: turnStaleMs };
  }

  function startHeartbeat() {
    clearInterval(pingTimer);
    clearInterval(watchTimer);
    const ping = () => rawSend({ t: 'ping', c: now() });
    ping();
    pingTimer = setInterval(ping, cadence().ping);
    // Liveness is "time since the last message", never "number of failed requests":
    // a count means something different at every poll rate, and Safari has left
    // dead sockets OPEN without a close event.
    watchTimer = setInterval(() => {
      if (sock && now() - lastMsgAt > cadence().stale) {
        log({ ev: 'stale', silentMs: Math.round(now() - lastMsgAt) });
        drop(sock, 'stale');
      }
    }, 500);
  }

  // Abandon a socket we no longer trust. Detach it first so its eventual close
  // event (which may arrive much later, or never) cannot touch the new one.
  function drop(s, why) {
    if (s !== sock) return;
    sock = null;
    try {
      s.close(CLOSE.STALE, why);
    } catch {
      /* already closing */
    }
    closed(1006, why);
  }

  function closed(code, reason) {
    clearTimers();
    sock = null;
    stats.lastCloseCode = code;
    if (finished) return setStatus('closed');
    const kind = classifyClose(code);
    if (kind === 'final') {
      finished = true;
      storage.set(key, null);
      return setStatus('gone', { code, reason, hadSeat });
    }
    if (kind === 'replaced' || kind === 'new-code') {
      finished = true;
      return setStatus(kind, { code, reason });
    }
    failingSince ||= now();
    if (now() - failingSince > giveUpAfterMs) {
      // Retrying forever helps nobody: on a free plan whose daily limit ran out,
      // every attempt fails until the reset. Stop, say so, and let the player retry.
      finished = true;
      return setStatus('unavailable', { code, sinceMs: Math.round(now() - failingSince) });
    }
    const inMs = backoffDelay(attempt, backoff);
    attempt++;
    setStatus('reconnecting', { attempt, inMs, code });
    retryTimer = setTimeout(connect, inMs);
  }

  function rawSend(msg) {
    if (!sock || sock.readyState !== 1) return false;
    sock.send(encode(msg));
    stats.msgsOut++;
    return true;
  }

  // The phone just woke up, came back to this app, or switched networks (Wi-Fi to
  // cellular, or Tailscale reconnecting). The socket may be dead while still saying
  // OPEN, and in the lobby the staleness check alone would take 45 s to notice. So ask
  // right away: any message within probeMs proves it's alive; silence means drop it and
  // rejoin the same seat now. While waiting out a backoff, the network may be back, so
  // try at once instead.
  function probe(why = 'check') {
    if (finished) return;
    if (!sock) {
      if (status !== 'reconnecting') return;
      clearTimeout(retryTimer);
      attempt = 0;
      log({ ev: 'probe-retry', why });
      connect();
      return;
    }
    if (sock.readyState !== 1 || status !== 'online') return; // still connecting: its own timeout decides
    const s = sock;
    const sentAt = now();
    rawSend({ t: 'ping', c: sentAt });
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      if (s !== sock || lastMsgAt >= sentAt) return;
      log({ ev: 'probe-dead', why, silentMs: Math.round(now() - lastMsgAt) });
      attempt = 0; // the first retry goes out within half a second
      drop(s, `probe ${why}`);
    }, probeMs);
  }

  function onPageHide() {
    // Leaving open sockets can keep a page out of the back/forward cache, and a
    // frozen page cannot answer anyway. Close as a drop so the server holds our seat.
    if (sock) drop(sock, 'pagehide');
    clearTimeout(retryTimer);
  }
  function onPageShow(e) {
    if (e.persisted && !finished && !sock) reconnectNow();
  }
  // Also what a "Try again" button calls after 'unavailable'.
  function reconnectNow() {
    if (finished && status !== 'unavailable') return;
    finished = false;
    failingSince = 0;
    clearTimeout(retryTimer);
    if (sock) drop(sock, 'manual');
    clearTimeout(retryTimer);
    attempt = 0;
    connect();
  }

  // A CSP that doesn't list the room host blocks the socket without a useful close
  // event; it can sit in "connecting" and look exactly like a cold start. Catch the
  // violation and say what it is.
  function onCsp(e) {
    if (finished || !/^connect-src/.test(e.effectiveDirective || e.violatedDirective || '')) return;
    let blocked;
    try {
      blocked = new URL(e.blockedURI);
    } catch {
      return;
    }
    // Only our socket: a blocked fetch to the same host (say /health) is a different directive source.
    if (!/^wss?:$/.test(blocked.protocol) || blocked.host !== new URL(url).host) return;
    finished = true;
    clearTimers();
    sock = null;
    log({ ev: 'csp-blocked', blocked: e.blockedURI });
    setStatus('blocked', { reason: 'csp', blocked: e.blockedURI });
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const opts = { signal: own.signal };
    window.addEventListener('pagehide', onPageHide, opts);
    window.addEventListener('pageshow', onPageShow, opts);
    document.addEventListener('securitypolicyviolation', onCsp, opts);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && probe('visible'), opts);
    window.addEventListener('online', () => probe('online'), opts);
    navigator.connection?.addEventListener?.('change', () => probe('network'), opts);
  }
  signal?.addEventListener('abort', () => close(), { once: true });

  // Leave for good: the server frees the seat now instead of after the grace window.
  function close() {
    if (finished && status !== 'unavailable') return;
    rawSend({ t: 'leave' });
    finished = true;
    own.abort();
    const s = sock;
    sock = null;
    clearTimers();
    try {
      s?.close(CLOSE.NORMAL, 'leave');
    } catch {
      /* ignore */
    }
    setStatus('closed');
  }

  // Stop everything without saying goodbye: what a crashed tab looks like to the
  // server (a drop, so the seat is held). Tests use it; games call close().
  function abandon() {
    finished = true;
    own.abort();
    clearTimers();
    const s = sock;
    sock = null;
    try {
      s?.close(CLOSE.STALE, 'abandoned');
    } catch {
      /* ignore */
    }
  }

  // Start on the next microtask, so the caller has its handle before the first
  // onStatus callback runs (a callback that reads it would otherwise hit a TDZ error).
  queueMicrotask(connect);

  return {
    // Sends a message if the socket is open. `droppable` messages (inputs) are
    // skipped while the send buffer is backed up: sending stale movement late is
    // worse than not sending it.
    send(msg, { droppable = false } = {}) {
      if (droppable && sock && sock.bufferedAmount > maxBufferedBytes) {
        stats.skippedSends++;
        return false;
      }
      return rawSend(msg);
    },
    close,
    abandon,
    reconnectNow,
    probe,
    clock,
    stats,
    get status() {
      return status;
    },
    get phase() {
      return phase;
    },
    get pid() {
      return saved?.pid ?? null;
    },
    get silentMs() {
      return now() - lastMsgAt;
    },
  };
}
