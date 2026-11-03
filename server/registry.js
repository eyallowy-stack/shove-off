// Rooms for a single Node process: every player of a room reaches this one process,
// so the room lives in memory and nobody fights over a database row.
// Used by server/node.js, dev.mjs and the tests. (A Durable Object is one room on
// its own and doesn't need this.)

import { createRoom } from './room.js';
import { GAMES as DEFAULT_GAMES } from './games.js';
import { CLOSE } from '../js/net/protocol.js';
import { envLimit } from './limits.js';

export function createRegistry({
  now = () => performance.now(), log = () => {}, games = DEFAULT_GAMES, roomOptions = {},
  maxRooms = envLimit('MAX_ROOMS', 200),
  roomCreationsPerMinute = envLimit('ROOM_CREATIONS_PER_MINUTE', 10),
} = {}) {
  const rooms = new Map(); // "<game>/<code>" -> room
  const creations = new Map(); // IP -> creation times in the last minute; never logged

  function get(game, code) {
    const key = `${game}/${code}`;
    let room = rooms.get(key);
    if (!room) {
      room = createRoom({
        code,
        rules: games[game],
        now,
        log,
        ...roomOptions,
        onEmpty: () => {
          if (rooms.get(key) === room) rooms.delete(key);
          room.dispose();
        },
      });
      rooms.set(key, room);
    }
    return room;
  }

  // Wire one transport connection to its room. Returns the two event handlers the
  // adapter must call, or null for an unsupported game or a refused connection.
  function connect(game, code, conn, ip = 'unknown') {
    if (!Object.hasOwn(games, game)) return null;
    if (!rooms.has(`${game}/${code}`)) {
      if (rooms.size >= maxRooms) {
        conn.close(CLOSE.SERVER_BUSY, 'The room server is full. Try again later.');
        return null;
      }
      const t = now();
      // Prune every bucket, including IPs that never connect again.
      for (const [address, times] of creations) {
        const recent = times.filter((at) => t - at < 60000);
        if (recent.length) creations.set(address, recent);
        else creations.delete(address);
      }
      const times = creations.get(ip) ?? [];
      if (times.length >= roomCreationsPerMinute) {
        conn.close(CLOSE.SERVER_BUSY, 'Too many new rooms. Wait a minute and try again.');
        return null;
      }
      times.push(t);
      creations.set(ip, times);
    }
    const room = get(game, code);
    room.open(conn);
    return {
      message: (text) => room.message(conn, text),
      close: (wsCode) => room.close(conn, wsCode),
    };
  }

  return { connect, has: (game) => Object.hasOwn(games, game), get: (game, code) => rooms.get(`${game}/${code}`), rooms };
}
