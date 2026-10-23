// Rooms for a single Node process: every player of a room reaches this one process,
// so the room lives in memory and nobody fights over a database row.
// Used by server/node.js, dev.mjs and the tests. (A Durable Object is one room on
// its own and doesn't need this.)

import { createRoom } from './room.js';
import { GAMES as DEFAULT_GAMES } from './games.js';

export function createRegistry({ now = () => performance.now(), log = () => {}, games = DEFAULT_GAMES, roomOptions = {} } = {}) {
  const rooms = new Map(); // "<game>/<code>" -> room

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
  // adapter must call, or null for a game this server doesn't run.
  function connect(game, code, conn) {
    if (!Object.hasOwn(games, game)) return null;
    const room = get(game, code);
    room.open(conn);
    return {
      message: (text) => room.message(conn, text),
      close: (wsCode) => room.close(conn, wsCode),
    };
  }

  return { connect, has: (game) => Object.hasOwn(games, game), get: (game, code) => rooms.get(`${game}/${code}`), rooms };
}
