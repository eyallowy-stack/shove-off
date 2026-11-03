// Messages, close codes, join codes, names and hashing, shared by client and server.
// (From the multiplayer-web-games starter; names are capped at 12 for Shove Off.)
// If the two sides encode anything differently they disagree silently, so every
// generic encoder lives here and both sides import it. Game-specific encoders
// (inputs, the local player's state, remote rows) live in games/<id>/sim.js.

// Bump on any incompatible message change; old clients get 4010. 3: inputs carry
// the room's epoch (server/room.js), so none from before a pause can land after it.
export const PROTOCOL = 4; // 4: jab recovery, dash facing, clash weight, hidden-tab hello (2026-10-23)

// 1000-1015 are defined by the WebSocket spec. 4000-4999 are ours, and are the only
// way a page can learn *why* the server closed it: a page sees 1006 for DNS
// failure, refused connections, TLS errors and dropped networks alike.
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
  RESTART: 1012,
  TRY_LATER: 1013,
  STALE: 4000, // client gave up on a silent socket; server treats it as a drop, not a leave
  NOT_ALLOWED: 4001, // a join ticket was missing, expired or forged
  KICKED: 4003,
  ROOM_GONE: 4004,
  CODE_TAKEN: 4005,
  ROOM_FULL: 4006,
  HELLO_TIMEOUT: 4008,
  REPLACED: 4009,
  BAD_VERSION: 4010,
  SERVER_BUSY: 4011,
  SLOW_READER: 4012,
};

// What the client should do after a close.
export function classifyClose(code) {
  switch (code) {
    case CLOSE.ROOM_GONE:
    case CLOSE.KICKED:
    case CLOSE.ROOM_FULL:
    case CLOSE.BAD_VERSION:
    case CLOSE.NOT_ALLOWED:
    case CLOSE.SERVER_BUSY:
    case CLOSE.SLOW_READER:
      return 'final';
    case CLOSE.CODE_TAKEN:
      return 'new-code';
    case CLOSE.REPLACED:
      return 'replaced';
    default:
      return 'retry'; // 1000/1001/1006/1011/1012/1013 and anything unknown
  }
}

// Game ids route a room to its rules: /room/<game>/<code>. Lower case, so a game
// id can never be confused with a join code.
const GAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
export const isGameId = (s) => typeof s === 'string' && GAME_RE.test(s);

// Join codes use Crockford's base32 alphabet: no I, L, O or U, so nothing a
// player reads aloud can be mistaken for 1 or 0, and no accidental words.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4,8}$/;

export const isJoinCode = (s) => typeof s === 'string' && CODE_RE.test(s);

export function makeJoinCode(length = 4) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes); // browsers, Node 19+ and Workers all have global crypto
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

// Accept what people actually type: lower case, spaces, dashes, O for 0, I or L for 1.
export function normalizeJoinCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

// The path both servers route on and the client connects to.
export const roomPath = (game, code) => `/room/${game}/${code}`;
export function parseRoomPath(pathname) {
  const m = /^\/room\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!m || !isGameId(m[1]) || !isJoinCode(m[2])) return null;
  return { game: m[1], code: m[2] };
}

export function makeToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Display names: NFC so "José" typed on a Mac and on a Chromebook compare equal,
// no control or bidi-override characters, collapsed spaces, at most 12 code points.
export function cleanName(input) {
  const s = String(input ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s).slice(0, 12).join('');
  return chars || 'Player';
}

export class ProtocolError extends Error {}
export class RosterOutOfDate extends Error {}

export const encode = (msg) => JSON.stringify(msg);

export function decode(raw) {
  if (typeof raw !== 'string') throw new ProtocolError('expected a text frame');
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    throw new ProtocolError('not JSON');
  }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new ProtocolError('no message type');
  return msg;
}

// Seat kinds. A display is a shared screen (a classroom TV) that watches the room
// without playing; a bot is a player the server drives.
export const KIND = { PLAYER: 0, DISPLAY: 1, BOT: 2 };

// Roster rows: [pid, name, team, online, kind]. An array with a fixed field order,
// sorted by pid, so the same roster always serializes to the same string.
const byFirst = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
export function rosterRows(players) {
  return players.map((p) => [p.pid, p.name, p.team ?? 0, p.online ? 1 : 0, p.kind ?? KIND.PLAYER]).sort(byFirst);
}

export function decodeRoster(rows) {
  if (!Array.isArray(rows)) throw new ProtocolError('roster is not a list');
  return rows.map((r) => {
    if (!Array.isArray(r) || typeof r[0] !== 'string') throw new ProtocolError('bad roster row');
    const [pid, name, team, online, kind = KIND.PLAYER] = r;
    return { pid, name: String(name), team, online: online === 1, kind };
  });
}

// Remote rows, for other players and for world entities (a dropped flag, a puck):
// [id, x, y, warp, ...extra]. The snapshot buffer interpolates x and y, snaps when
// warp changes (a teleport), and passes `extra` (hasFlag, facing...) through from
// the newest sample. Each game names its extras in its own sim.js.
function decodeRows(rows, what) {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new ProtocolError(`${what} rows are not a list`);
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length < 4) throw new ProtocolError(`bad ${what} row`);
    const [id, x, y, warp, ...extra] = row;
    if (typeof id !== 'string' || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(warp)) {
      throw new ProtocolError(`non-finite ${what} row`);
    }
    return { id, x, y, warp, extra };
  });
}

// Turn a snapshot into positions, using the roster the client already has.
// A pid the client has never seen means *our roster* is stale, which is a
// different problem from a broken network and gets a different error.
export function decodeSnapshot(msg, rosterByPid) {
  if (!Number.isInteger(msg.k) || !Number.isFinite(msg.tm)) throw new ProtocolError('incomplete snapshot');
  const players = [];
  let missing = 0;
  for (const row of decodeRows(msg.p, 'player')) {
    if (!rosterByPid.has(row.id)) {
      missing++;
      continue; // draw everyone we do know about this frame
    }
    players.push(row);
  }
  if (msg.me !== undefined && !Array.isArray(msg.me)) throw new ProtocolError('bad self state');
  return {
    tick: msg.k,
    time: msg.tm,
    ack: Number.isInteger(msg.a) ? msg.a : 0,
    rv: msg.rv,
    me: msg.me ?? null, // the local player's whole state, encoded by the game's sim.js
    players,
    entities: decodeRows(msg.e, 'entity'),
    view: msg.v ?? null,
    missing,
  };
}

// --- Hashing, for designs that send a roster hash instead of a version number ---
//
// The starter uses a version counter (rv), which cannot disagree. If you poll and
// want "send names only when they changed", hash a canonical encoding, and hash
// UTF-8 bytes: hashing JavaScript's UTF-16 code units gives a different answer
// from Node Buffers, Python or Go as soon as a name has an accent or an emoji.
// This is the one canonicalizer. Both sides import it; neither re-implements it.

export function canonicalRoster(players) {
  return JSON.stringify(rosterRows(players.map((p) => ({ ...p, name: String(p.name).normalize('NFC') }))));
}

const utf8 = new TextEncoder();

export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (const byte of utf8.encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193); // Math.imul, not *, or large products lose bits
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Which players count is part of the hash definition, so the filter lives here too.
export const rosterHash = (players) => fnv1a32(canonicalRoster(players.filter((p) => p.online)));
