// One authoritative room, for any game. Transport-agnostic: the Node adapter
// (server/node.js), the Durable Object (server/worker.js) and the tests all drive
// it through the same calls: open(conn), message(conn, text), close(conn, code),
// dispose().
//
// conn is { send(text), close(code, reason), terminate?(), data }. The room
// writes conn.data; adapters may persist it (Durable Object attachments).
//
// This file is the machinery every online game shares: hello and rejoin with a
// secret token, seats held through a grace window, versioned rosters, phases,
// a host, rate limits, the input budget, the fixed tick, snapshots, pausing,
// server-side bots and display seats. What a game *is* lives in its rules
// module (games/<id>/rules.js), so a second online game is one new rules file,
// not a copy of this one.
//
// The rules contract. `rules` is { id, realtime, tuning?, sanitizeInput?, maxPlayers?,
// minPlayers?, maxDisplays?, graceMs?, pauseBelow?, create(ctx) }, and create() returns an
// object with any of:
//   join(pid, { name, kind, team? })   a new seat (team is a hint, after hibernation)
//   leave(pid)                         the seat is gone for good
//   start(), end(why)                  a match begins or ends
//   action(pid, a)                     a discrete action: { t: 'act', a }
//   view(pid)                          small public state for this recipient (scores, a question)
//   team(pid)                          the number shown in the roster
// Real-time games (realtime: true, a tick at tuning.tickHz) also implement:
//   step(pid, input)                   apply one sanitized input: one tick of that player
//   tick()                             once per tick after inputs: contacts, scoring, the world
//   self(pid)                          the player's own whole state, encoded (sim.encodeSelf)
//   rows(forPid), entities?(forPid)    what forPid may see of others and of world objects
//   autopilot?(pid)                    games with momentum: a tick for a player who isn't sending
//   botInput?(pid)                     an input for a server-side bot, or null
// ctx gives the rules: now(), tick, random() (seeded), emit(kind, data, toPid?),
// changed() (turn-based: send views now), after(ms, fn) -> cancel, endMatch(why),
// isOnline(pid), players() (pids of online player seats), log(obj).
//
// The room owns the truth: clients send intent, the rules step it, and nothing a
// client says about where it is, or whom it hit, is believed.

import { PROTOCOL, CLOSE, KIND, encode, decode, cleanName, makeToken, rosterRows } from '../js/net/protocol.js';

const MAX_MESSAGE_CHARS = 4096;
const HELLO_TIMEOUT_MS = 5000;

function seededRandom(text) {
  let a = 0x9e3779b9;
  for (const ch of text) a = Math.imul(a ^ ch.charCodeAt(0), 0x01000193);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRoom({
  code,
  rules,
  now, // ms clock: performance.now in Node, Date.now in Workers
  log = () => {},
  timers = globalThis, // { setTimeout, clearTimeout, setInterval, clearInterval }
  onEmpty = () => {}, // the room has nobody left and can be thrown away
  onAttach = () => {}, // (conn, data) after join, so a Durable Object can persist it
  verifyTicket = null, // async (ticket, { game, room }) -> { uid, name } | null; see server/ticket.js
  graceMs = rules.graceMs ?? 20000, // how long a dropped player's seat is held
  playingStaleMs = 10000, // no message from a player for this long during a match: drop them
  awayPauseMs = 1000, // 1v1 (rules.pauseBelow): a player whose tab has been hidden this long counts as gone, and the clock stops
  maxPlayers = rules.maxPlayers ?? 8,
  minPlayers = rules.minPlayers ?? 1, // seats (bots included) a 'start' needs
  maxDisplays = rules.maxDisplays ?? 0,
  matchMs = rules.tuning?.matchMs ?? 0, // 0: the rules end the match themselves
  random = seededRandom(`${rules.id}:${code}`),
}) {
  const realtime = !!rules.realtime;
  const T = rules.tuning ?? {};
  const DT = realtime ? 1 / T.tickHz : 0;
  const snapEvery = realtime ? Math.max(1, Math.round(T.tickHz / T.snapshotHz)) : 0;
  const seats = new Map(); // pid -> seat
  const pendingConns = new Set(); // opened, no hello yet
  let everHadPlayers = false;
  let nextPid = 1;
  let nextBot = 1;
  let rv = 1; // roster version: bumped on every join, leave, team or online change
  let phase = 'lobby'; // 'lobby' | 'playing' | 'paused' (real-time games only)
  let pausedBy = null; // 'host' | 'waiting'
  let match = 0; // which match this is; inputs from an earlier match are ignored
  // Bumped on every start, pause and resume. Each of those resets every client to the
  // server's state, so inputs sent before it (still in flight, possibly arriving after
  // a quick resume) must not be applied. Shove Off fix: without it, a pause shorter
  // than a round trip gave the player who stayed prediction corrections.
  let epoch = 0;
  let tick = 0;
  let timeBase = 0; // server ms at tick 0 of this match, moved on by pauses
  let pausedAt = 0;
  let lastTimer = 0;
  let acc = 0;
  let tickTimer = 0;
  let graceTimer = 0;
  let disposed = false;
  let dirty = false; // turn-based: views changed, send them when this event is done
  let sv = 0; // turn-based view version
  const afterTimers = new Set();
  const stats = { ticks: 0, droppedBacklogs: 0, rejectedInputs: 0, overflowedInputs: 0, rateLimited: 0, badMessages: 0, staleInputs: 0 };
  const L = (o) => log({ room: code, game: rules.id, tick, ...o }); // logs carry room and tick; never names or IPs

  const isOnline = (s) => s.kind === KIND.BOT || !!s.conn;
  const humans = () => [...seats.values()].filter((s) => s.kind !== KIND.BOT);
  const ordered = () => [...seats.values()].sort((a, b) => (a.pid < b.pid ? -1 : 1));
  const seatedPlayers = () => [...seats.values()].filter((s) => s.kind !== KIND.DISPLAY).length;
  const hostPid = () => humans().sort((a, b) => a.joinedAt - b.joinedAt)[0]?.pid ?? null;
  const sendTo = (s, msg) => s.conn && s.conn.send(encode(msg));
  const broadcast = (msg) => {
    const text = encode(msg);
    for (const s of seats.values()) s.conn?.send(text);
  };
  const timeNow = () => (realtime && phase !== 'lobby' ? timeBase + tick * DT * 1000 : now());

  const ctx = {
    now,
    get tick() {
      return tick;
    },
    random,
    log: L,
    emit(kind, data = {}, toPid = null) {
      const msg = { t: 'ev', k: tick, tm: timeNow(), kind, ...data };
      if (toPid) {
        const s = seats.get(toPid);
        if (s) sendTo(s, msg);
      } else broadcast(msg);
    },
    changed() {
      dirty = true;
    },
    after(ms, fn) {
      const h = timers.setTimeout(() => {
        afterTimers.delete(h);
        if (!disposed) run(fn);
      }, ms);
      afterTimers.add(h);
      return () => {
        timers.clearTimeout(h);
        afterTimers.delete(h);
      };
    },
    endMatch: (why) => phase !== 'lobby' && endMatch(why),
    isOnline: (pid) => {
      const s = seats.get(pid);
      return !!s && isOnline(s);
    },
    players: () => [...seats.values()].filter((s) => s.kind !== KIND.DISPLAY && isOnline(s)).map((s) => s.pid),
  };
  const game = rules.create(ctx);

  // Run a piece of work, then send any turn-based views it changed, once.
  function run(fn) {
    try {
      fn();
    } finally {
      flushViews();
    }
  }

  function flushViews() {
    if (!dirty || !game.view) return;
    dirty = false;
    sv++;
    for (const s of seats.values()) if (s.conn) sendTo(s, { t: 'st', sv, view: game.view(s.pid) });
  }

  const rosterView = () => [...seats.values()].map((s) => ({ ...s, team: game.team?.(s.pid) ?? 0, online: isOnline(s) }));
  const rosterMsg = () => ({ t: 'roster', rv, host: hostPid(), players: rosterRows(rosterView()) });

  function rosterChanged() {
    rv++;
    broadcast(rosterMsg());
  }

  // --- connections ---------------------------------------------------------

  function open(conn) {
    conn.data = { pid: null };
    pendingConns.add(conn);
    conn.helloTimer = timers.setTimeout(() => {
      if (pendingConns.has(conn)) conn.close(CLOSE.HELLO_TIMEOUT, 'no hello');
    }, HELLO_TIMEOUT_MS);
    // Per-connection message budget: enough for inputs at inputSendHz plus pings,
    // with burst. Sized from the game's own send rate, not a generic API limit.
    conn.bucket = { tokens: 40, at: now() };
  }

  function allowMessage(conn) {
    const b = conn.bucket;
    const t = now();
    b.tokens = Math.min(40, b.tokens + ((t - b.at) / 1000) * ((T.inputSendHz ?? 15) * 2));
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function message(conn, text) {
    if (conn.waiting) return void conn.waiting.push(text); // a hello is still being verified
    run(() => {
      try {
        conn.data ??= { pid: null }; // a socket restored after hibernation before it said hello
        conn.bucket ??= { tokens: 40, at: now() };
        if (typeof text !== 'string' || text.length > MAX_MESSAGE_CHARS) return conn.close(CLOSE.TOO_BIG, 'too big');
        if (!allowMessage(conn)) {
          stats.rateLimited++;
          return; // drop it; a well-behaved client never gets here
        }
        const msg = decode(text);
        const pid = conn.data?.pid;
        if (!pid) return msg.t === 'hello' ? hello(conn, msg) : conn.close(CLOSE.POLICY, 'hello first');
        const s = seats.get(pid);
        if (!s || s.conn !== conn) return; // an old connection that was replaced
        s.lastSeen = now();
        handle(s, msg);
      } catch (err) {
        // One bad message must never take the room (or the process) down.
        stats.badMessages++;
        L({ ev: 'bad-message', err: err.message });
      }
    });
  }

  function handle(s, msg) {
    const isHost = s.pid === hostPid();
    switch (msg.t) {
      case 'in':
        return inputs(s, msg);
      case 'act':
        // Paused too: a Rematch pressed while the other phone sleeps on the scoreboard
        // must count when they come back (the rules check the duel is over).
        if (s.kind === KIND.PLAYER && (phase === 'playing' || phase === 'paused')) game.action?.(s.pid, msg.a);
        return;
      case 'away': // the tab was hidden (true) or shown again (false)
        return setAway(s, !!msg.on);
      case 'ping':
        if (Number.isFinite(msg.c)) sendTo(s, { t: 'pong', c: msg.c, s: now() });
        return;
      case 'need':
        return sendTo(s, rosterMsg());
      case 'start':
        // A match needs its players seated (a held seat counts: the match starts paused
        // for them). A late or stale 'start' for a room of one is ignored.
        if (isHost && phase === 'lobby' && seatedPlayers() >= minPlayers) startMatch();
        return;
      case 'stop':
        if (isHost && phase !== 'lobby') endMatch('host');
        return;
      case 'pause': // the host's pause is the one pause that covers everyone
        if (isHost && realtime && phase === 'playing') pause('host');
        return;
      case 'resume':
        if (isHost && phase === 'paused' && pausedBy === 'host') resume();
        return;
      case 'bot':
        if (isHost && phase === 'lobby' && realtime && game.botInput) msg.add ? addBot() : removeBot();
        return;
      case 'leave':
        return removeSeat(s, 'left');
      default:
        stats.badMessages++;
    }
  }

  function hello(conn, msg) {
    pendingConns.delete(conn);
    timers.clearTimeout(conn.helloTimer);
    if (msg.v !== PROTOCOL) return conn.close(CLOSE.BAD_VERSION, 'update the game');
    if (!verifyTicket) return seat(conn, msg, null);
    // A room behind an app with accounts: the app signed a short-lived ticket for
    // this player and this room, and the name comes from the account, not the client.
    conn.waiting = [];
    Promise.resolve(verifyTicket(msg.ticket, { game: rules.id, room: code }))
      .catch(() => null)
      .then((id) => {
        const queued = conn.waiting;
        conn.waiting = null;
        if (disposed) return;
        if (!id) return conn.close(CLOSE.NOT_ALLOWED, 'sign in again');
        run(() => seat(conn, msg, id));
        for (const text of queued) message(conn, text);
      });
  }

  function seat(conn, msg, id) {
    const display = msg.role === 'display';
    if (display && maxDisplays === 0) return conn.close(CLOSE.ROOM_FULL, 'this game has no shared screen');
    const existing = id
      ? [...seats.values()].find((s) => s.uid === id.uid)
      : typeof msg.pid === 'string'
        ? seats.get(msg.pid)
        : null;
    const rejoin = !!existing && (id ? true : typeof msg.token === 'string' && msg.token === existing.token);

    if (!rejoin && !msg.create && !everHadPlayers) {
      conn.close(CLOSE.ROOM_GONE, 'no such room');
      maybeEmpty();
      return;
    }
    if (!rejoin && msg.create && everHadPlayers) return conn.close(CLOSE.CODE_TAKEN, 'code in use');

    let s = rejoin ? existing : null;
    if (s) {
      if (s.conn && s.conn !== conn) s.conn.close(CLOSE.REPLACED, 'opened in another tab'); // one seat per player
      L({ ev: 'rejoin', pid: s.pid, awayMs: s.leftAt ? Math.round(now() - s.leftAt) : 0 });
    } else {
      const kind = display ? KIND.DISPLAY : KIND.PLAYER;
      const count = [...seats.values()].filter((x) => (kind === KIND.DISPLAY ? x.kind === KIND.DISPLAY : x.kind !== KIND.DISPLAY)).length;
      if (count >= (display ? maxDisplays : maxPlayers)) return conn.close(CLOSE.ROOM_FULL, 'room full');
      const pid = display ? `d${nextPid++}` : `p${nextPid++}`; // a letter prefix keeps ids from sorting as array indexes
      s = { pid, token: makeToken(), uid: id?.uid ?? null, name: cleanName(id?.name ?? msg.name), kind, joinedAt: now() };
      seats.set(pid, s);
      if (kind === KIND.PLAYER) game.join?.(pid, { name: s.name, kind });
      everHadPlayers = true;
      L({ ev: 'join', pid });
    }
    s.conn = conn;
    s.leftAt = null;
    // A tab that reconnects while hidden says so in its hello, so it isn't counted as
    // back (and the match doesn't resume around a fighter nobody is steering).
    if (s.awayTimer) timers.clearTimeout(s.awayTimer);
    s.awayTimer = 0;
    s.away = msg.away === true;
    s.awayLong = s.away && !!rules.pauseBelow;
    s.lastSeen = now();
    // Fresh input stream per connection: whatever was in flight on the old socket is gone.
    s.lastQueuedSeq = 0;
    s.ack = 0;
    clearInputs(s);
    conn.data = { pid: s.pid };
    onAttach(conn, { pid: s.pid, token: s.token, uid: s.uid, name: s.name, kind: s.kind, team: game.team?.(s.pid) ?? 0, joinedAt: s.joinedAt });

    // Join and rejoin get the full picture; after that, only what changes.
    rv++;
    sendTo(s, {
      t: 'welcome',
      v: PROTOCOL,
      pid: s.pid,
      token: id ? undefined : s.token, // with tickets, the account is the identity
      rejoined: rejoin,
      room: code,
      game: rules.id,
      kind: s.kind,
      realtime,
      phase,
      match,
      ep: epoch,
      tick,
      tickHz: realtime ? T.tickHz : null,
      snapshotHz: realtime ? T.snapshotHz : null,
      tm: timeNow(),
      you: realtime && s.kind === KIND.PLAYER ? game.self(s.pid) : null,
      view: game.view?.(s.pid) ?? null,
      rv,
      host: hostPid(),
      players: rosterRows(rosterView()),
    });
    const others = encode(rosterMsg());
    for (const q of seats.values()) if (q !== s) q.conn?.send(others);
    if (phase === 'paused' && pausedBy === 'waiting') maybeResume();
  }

  // A hidden tab stops sending, so the server stands that fighter still. In a 1v1 that
  // would hand the other player a free ring-out, so after awayPauseMs the clock stops
  // for them exactly as it does for a dropped socket.
  function setAway(s, on) {
    s.away = on;
    if (s.awayTimer) timers.clearTimeout(s.awayTimer);
    s.awayTimer = 0;
    if (on) {
      clearInputs(s);
      if (!rules.pauseBelow) return;
      s.awayTimer = timers.setTimeout(() => {
        s.awayTimer = 0;
        if (disposed || !s.away) return;
        s.awayLong = true;
        run(maybeAutoPause);
      }, awayPauseMs);
      return;
    }
    s.awayLong = false;
    if (phase === 'paused' && pausedBy === 'waiting') maybeResume();
  }

  function clearInputs(s) {
    s.queue = [];
    s.tokens = 0;
  }

  function close(conn, wsCode) {
    pendingConns.delete(conn);
    timers.clearTimeout(conn.helloTimer);
    const s = conn.data?.pid ? seats.get(conn.data.pid) : null;
    if (s && s.conn === conn) run(() => drop(s, wsCode));
    maybeEmpty();
  }

  // Any close is a drop with a held seat; only an explicit 'leave' frees it now.
  // Phones close sockets when the screen locks, and a reload looks like a close.
  // A dropped player sends nothing, so they stand still (or, in a game with
  // momentum, the rules' autopilot lands them); nothing already queued is applied.
  function drop(s, wsCode) {
    s.conn = null;
    s.leftAt = now();
    if (s.awayTimer) timers.clearTimeout(s.awayTimer);
    s.awayTimer = 0;
    clearInputs(s);
    L({ ev: 'drop', pid: s.pid, code: wsCode });
    rosterChanged();
    scheduleGrace();
    maybeAutoPause();
  }

  function removeSeat(s, why) {
    seats.delete(s.pid);
    L({ ev: 'remove', pid: s.pid, why });
    if (s.conn) {
      const c = s.conn;
      s.conn = null;
      c.close(CLOSE.NORMAL, why);
    }
    // The new roster goes out before the rules react. game.leave() can end the match,
    // and a client told 'lobby' while its roster still listed the player who left
    // would start a new match for one.
    rosterChanged();
    if (s.kind !== KIND.DISPLAY) game.leave?.(s.pid);
    if (phase !== 'lobby' && !humans().some((x) => x.conn)) endMatch('empty');
    else if (phase === 'paused' && pausedBy === 'waiting') maybeResume();
    maybeEmpty();
  }

  function scheduleGrace() {
    if (graceTimer || disposed) return;
    graceTimer = timers.setTimeout(() => {
      graceTimer = 0;
      run(expireGrace);
      if ([...seats.values()].some((s) => s.leftAt)) scheduleGrace();
    }, Math.min(graceMs, 5000));
  }

  function expireGrace() {
    const t = now();
    for (const s of [...seats.values()]) if (s.leftAt && t - s.leftAt >= graceMs) removeSeat(s, 'grace expired');
  }

  function maybeEmpty() {
    if (humans().length > 0) return;
    for (const s of [...seats.values()]) seats.delete(s.pid); // bots don't keep a room alive
    everHadPlayers = false; // an emptied room is gone: a later "join" to this code gets 4004
    if (pendingConns.size === 0) {
      stopTicking();
      onEmpty();
    }
  }

  // --- bots ------------------------------------------------------------------

  function addBot() {
    if ([...seats.values()].filter((s) => s.kind !== KIND.DISPLAY).length >= maxPlayers) return;
    const pid = `b${nextBot++}`;
    seats.set(pid, { pid, token: null, name: `Bot ${pid.slice(1)}`, kind: KIND.BOT, joinedAt: now(), conn: null, leftAt: null, queue: [], tokens: 0, ack: 0 });
    game.join?.(pid, { name: `Bot ${pid.slice(1)}`, kind: KIND.BOT });
    rosterChanged();
  }

  function removeBot() {
    const bot = [...seats.values()].filter((s) => s.kind === KIND.BOT).pop();
    if (bot) removeSeat(bot, 'bot removed');
  }

  // --- the match ------------------------------------------------------------

  function inputs(s, msg) {
    if (!realtime || phase !== 'playing' || s.kind !== KIND.PLAYER || s.away) return;
    if (msg.m !== match || msg.e !== epoch) {
      stats.staleInputs++; // sent before the last start, pause or resume; the client has already reset
      return;
    }
    if (!Array.isArray(msg.i) || msg.i.length > 16) return;
    for (const row of msg.i) {
      const input = rules.sanitizeInput(row);
      if (!input || input.seq <= s.lastQueuedSeq) {
        stats.rejectedInputs++;
        continue;
      }
      s.lastQueuedSeq = input.seq;
      s.queue.push(input);
      if (s.queue.length > T.maxQueuedInputs) {
        s.queue.shift();
        stats.overflowedInputs++;
      }
    }
  }

  // Each player gets their own `you` (a spawn point), so the client can reset its
  // prediction at once rather than replaying inputs from the last match.
  function sendPhase(why) {
    for (const s of seats.values()) {
      if (!s.conn) continue;
      sendTo(s, {
        t: 'phase',
        phase,
        match,
        ep: epoch,
        tick,
        tm: timeNow(),
        why,
        you: realtime && s.kind === KIND.PLAYER && phase !== 'lobby' ? game.self(s.pid) : undefined,
        view: game.view?.(s.pid),
      });
    }
  }

  function startMatch() {
    if (disposed) return;
    phase = 'playing';
    pausedBy = null;
    match++;
    epoch++;
    tick = 0;
    for (const s of seats.values()) {
      clearInputs(s);
      s.lastSeen = now(); // silence in the lobby (pings every 15 s) isn't a dead socket
    }
    game.start?.();
    L({ ev: 'start', match, players: seats.size });
    if (realtime) {
      timeBase = now();
      startTicking();
    }
    sendPhase();
    // The opponent dropped (or hid the tab) in the moment before the start: wait for them.
    if (realtime) maybeAutoPause();
  }

  function endMatch(why) {
    stopTicking();
    phase = 'lobby';
    pausedBy = null;
    game.end?.(why);
    L({ ev: 'end', why, match });
    sendPhase(why);
  }

  // Real-time only. Paused, nothing steps and the match clock stands still.
  // `note` is what the clients are told: 'waiting' (a dropped socket) or 'away' (a hidden tab).
  function pause(why, note = why) {
    stopTicking();
    phase = 'paused';
    pausedBy = why;
    pausedAt = now();
    epoch++;
    for (const s of seats.values()) clearInputs(s);
    L({ ev: 'pause', why: note });
    sendPhase(note);
  }

  function resume() {
    timeBase += now() - pausedAt; // the server timeline skips the pause instead of jumping
    phase = 'playing';
    pausedBy = null;
    epoch++;
    for (const s of seats.values()) {
      clearInputs(s);
      // The player who waited was quiet while paused (nothing to send): that silence
      // must not count toward the stale check the moment the clock starts again.
      s.lastSeen = now();
    }
    startTicking();
    L({ ev: 'resume' });
    sendPhase();
  }

  // rules.pauseBelow, for 1v1 games: when a match drops below that many online
  // players because someone is in their grace window, hold the clock for them.
  // A player in their grace window, or with the tab hidden for awayPauseMs, isn't here.
  const here = (s) => isOnline(s) && !(rules.pauseBelow && s.awayLong);
  const onlinePlayers = () => [...seats.values()].filter((s) => s.kind !== KIND.DISPLAY && here(s)).length;
  const waitingFor = () => [...seats.values()].some((s) => s.leftAt || (s.awayLong && s.conn));
  function maybeAutoPause() {
    if (!rules.pauseBelow || phase !== 'playing') return;
    if (onlinePlayers() < rules.pauseBelow && waitingFor()) pause('waiting', [...seats.values()].some((s) => s.leftAt) ? 'waiting' : 'away');
  }
  function maybeResume() {
    if (onlinePlayers() >= rules.pauseBelow) resume();
    else if (!waitingFor()) endMatch('opponent left');
  }

  function startTicking() {
    lastTimer = now();
    acc = 0;
    // A timer fires late and unevenly. The accumulator turns elapsed time into a
    // whole number of fixed ticks, and drops the backlog after a long stall rather
    // than running a burst of catch-up ticks.
    tickTimer = timers.setInterval(onTimer, 1000 / T.tickHz);
  }

  function stopTicking() {
    if (tickTimer) timers.clearInterval(tickTimer);
    tickTimer = 0;
  }

  function onTimer() {
    const t = now();
    acc += t - lastTimer;
    lastTimer = t;
    const stepMs = DT * 1000;
    let n = 0;
    run(() => {
      while (acc >= stepMs && n < 4) {
        simulate();
        acc -= stepMs;
        n++;
        if (phase !== 'playing') return;
      }
      if (n === 4 && acc >= stepMs) {
        acc = 0;
        stats.droppedBacklogs++;
      }
    });
  }

  function simulate() {
    tick++;
    stats.ticks++;
    const t = now();
    for (const s of ordered()) {
      if (s.kind === KIND.DISPLAY) continue;
      if (s.kind === KIND.BOT) {
        const input = game.botInput?.(s.pid);
        if (input) game.step(s.pid, input);
        continue;
      }
      if (s.conn && t - s.lastSeen > playingStaleMs) {
        L({ ev: 'stale', pid: s.pid, silentMs: Math.round(t - s.lastSeen) });
        const c = s.conn;
        close(c, CLOSE.STALE); // treat as a drop now; the socket may never report it
        if (c.terminate) c.terminate();
        else c.close(CLOSE.STALE, 'stale');
        if (phase !== 'playing') return;
      }
      if (!s.conn || s.away) {
        game.autopilot?.(s.pid); // momentum games settle a silent player; others stand still
        continue;
      }
      // Each input moves one tick, and a player earns one input per tick, banking at
      // most a few. Jitter and short hitches are absorbed by the bank; flooding
      // inputs gains a cheater nothing beyond it. A player with nothing queued isn't
      // stepped: the server never guesses the input of someone who is still sending.
      s.tokens = Math.min(T.inputBurst, s.tokens + 1);
      let k = 0;
      while (s.queue.length && s.tokens >= 1 && k < T.maxInputsPerTick) {
        const input = s.queue.shift();
        game.step(s.pid, input);
        s.ack = input.seq;
        s.tokens -= 1;
        k++;
      }
    }
    game.tick?.();
    if (tick % snapEvery === 0) sendSnapshots();
    if (matchMs && tick * DT * 1000 >= matchMs) endMatch('time');
    expireGrace();
  }

  // Positions go to everyone in full every snapshot: a handful of players fit in a
  // few hundred bytes, and a full snapshot repairs any client that missed one.
  // Names and teams are not repeated; `rv` tells the client whether its roster is current.
  function sendSnapshots() {
    const tm = timeNow();
    for (const s of seats.values()) {
      if (!s.conn) continue;
      const player = s.kind === KIND.PLAYER;
      sendTo(s, {
        t: 's',
        k: tick,
        tm,
        a: player ? s.ack : undefined,
        rv,
        me: player ? game.self(s.pid) : undefined,
        p: game.rows(s.pid),
        e: game.entities?.(s.pid),
        v: game.view?.(s.pid),
      });
    }
  }

  // Durable Objects: after hibernation the room object is rebuilt, and sockets that
  // are still attached are handed back with the data saved by onAttach. Only the
  // lobby survives: a match in progress lived in memory.
  function restore(conn, data) {
    if (!data?.pid || seats.has(data.pid)) return;
    const s = { pid: data.pid, token: data.token, uid: data.uid ?? null, name: data.name, kind: data.kind ?? KIND.PLAYER, joinedAt: data.joinedAt };
    Object.assign(s, { conn, leftAt: null, away: false, lastSeen: now(), lastQueuedSeq: 0, ack: 0, queue: [], tokens: 0 });
    conn.data = { pid: s.pid };
    conn.bucket = { tokens: 40, at: now() };
    seats.set(s.pid, s);
    if (s.kind === KIND.PLAYER) game.join?.(s.pid, { name: s.name, kind: s.kind, team: data.team });
    everHadPlayers = true;
    nextPid = Math.max(nextPid, Number(s.pid.slice(1)) + 1);
  }

  function dispose() {
    disposed = true; // late socket events still arrive; they must not start new timers
    stopTicking();
    for (const s of seats.values()) if (s.awayTimer) timers.clearTimeout(s.awayTimer);
    if (graceTimer) timers.clearTimeout(graceTimer);
    for (const h of afterTimers) timers.clearTimeout(h);
    afterTimers.clear();
    for (const c of pendingConns) timers.clearTimeout(c.helloTimer);
  }

  return {
    open,
    message,
    close,
    restore,
    dispose,
    get phase() {
      return phase;
    },
    get match() {
      return match;
    },
    get tick() {
      return tick;
    },
    get rv() {
      return rv;
    },
    get size() {
      return seats.size;
    },
    roster: () => rosterRows(rosterView()),
    stats,
    // Tests and debugging only.
    _seats: seats,
    _game: game,
  };
}
