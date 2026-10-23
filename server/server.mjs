// Shove Off's room server: one Node process, built-ins only, that serves the game's
// page and runs the online rooms on the same origin.
//
//   node server/server.mjs                 # http://localhost:8793
//
// It binds to 127.0.0.1, so nobody else on the school network can reach it. A
// friend reaches it through `tailscale serve`, which proxies HTTPS on your tailnet
// to this port (README: "Playing with a friend over Tailscale").
//
// Environment:
//   PORT             default 8793
//   HOST             default 127.0.0.1. Leave it: binding 0.0.0.0 exposes the game to
//                    the whole network you're on.
//   ALLOWED_ORIGINS  extra page origins allowed to open room sockets, comma-separated,
//                    e.g. "https://my-laptop.tail1234.ts.net"
//
// Server-only files (this folder, tests, tools) answer 404, as they would on a
// published site. Logs carry room, tick and player id: never names or addresses.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.js';
import { attachRooms } from './ws.mjs';
import { createSwServer } from './sw-version.mjs';
import { CLOSE } from '../js/net/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.PORT ?? 8793);
const HOST = process.env.HOST ?? '127.0.0.1';
const extra = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const ALLOWED = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, ...extra];

// Case-insensitive, because macOS ignores case on disk.
const SERVER_ONLY = /^\/(server|tests|tools|node_modules)(\/|$)|^\/(package\.json|\.claude)(\/|$)/i;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
// Same rules a static host would give the page. The CSP meta tag in index.html
// covers scripts; these cover framing and sniffing, which meta tags can't.
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

// sw.js goes out with its version stamped from the files it caches, so an edit to the
// game reaches a phone that has it on the Home Screen (server/sw-version.mjs).
const serveSw = createSwServer(root);

const log = (o) => console.log(JSON.stringify({ at: Math.round(performance.now()), ...o }));
const registry = createRegistry({ now: () => performance.now(), log });

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, HEADERS).end();
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return res.writeHead(400, HEADERS).end('bad path');
  }
  if (pathname === '/health') return res.writeHead(200, { ...HEADERS, 'content-type': 'text/plain' }).end('ok');
  const file = path.join(root, pathname);
  const inside = file === root || file.startsWith(root + path.sep);
  // Match the path as resolved on disk, not as typed, so /x/../server can't slip past.
  const rel = '/' + path.relative(root, file).split(path.sep).join('/');
  if (!inside || SERVER_ONLY.test(rel) || /\/\./.test(rel)) return res.writeHead(404, HEADERS).end('not found');
  if (rel === '/sw.js') {
    try {
      const body = serveSw();
      res.writeHead(200, { ...HEADERS, 'content-type': TYPES['.js'] });
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      log({ ev: 'sw-error', msg: err.message });
      return res.writeHead(500, HEADERS).end('sw.js could not be built');
    }
  }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? path.join(file, 'index.html') : file;
    const body = await readFile(target);
    res.writeHead(200, { ...HEADERS, 'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, HEADERS).end('not found');
  }
});

attachRooms(server, { registry, allowedOrigins: ALLOWED, log });

server.listen(PORT, HOST, () => {
  log({ ev: 'listening', url: `http://localhost:${PORT}`, host: HOST, origins: ALLOWED });
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn(`Warning: listening on ${HOST}. Anyone who can reach this machine on port ${PORT} can open the game.`);
  }
});

// Ctrl+C or a restart: tell clients it's a restart (1012). Rooms live in memory, so
// a client that comes back gets "room gone" (4004) and can make a new one.
function shutdown() {
  for (const room of registry.rooms.values()) {
    for (const seat of room._seats.values()) seat.conn?.close(CLOSE.RESTART, 'server restarting');
    room.dispose();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
