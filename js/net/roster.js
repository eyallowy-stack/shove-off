// The client's copy of the room roster. Always rebuilt from the full list the
// server sends (on join, on every change, and when asked), never accumulated from
// join and leave events: a client that missed one event would be wrong forever.
import { decodeRoster, KIND } from './protocol.js';

export function createRoster() {
  const byPid = new Map(); // pid -> { pid, name, team, online, kind }
  let rv = 0;
  let host = null;
  return {
    byPid,
    set(rows, version, hostPid) {
      byPid.clear();
      for (const r of decodeRoster(rows)) byPid.set(r.pid, r);
      rv = version;
      host = hostPid ?? host;
    },
    // Players only: displays watch, bots are players.
    players: () => [...byPid.values()].filter((r) => r.kind !== KIND.DISPLAY),
    get rv() {
      return rv;
    },
    get host() {
      return host;
    },
  };
}
