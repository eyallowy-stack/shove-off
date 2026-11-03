// A small RFC 6455 WebSocket server on Node built-ins (http + crypto), adapted from
// the multiplayer-web-games starter's test server. It handles what browsers and
// Node's built-in WebSocket client send: text frames (whole or fragmented), ping,
// pong and close.
//
// Scope: local play and one trusted friend over Tailscale. It is not hardened for
// the open internet. Public hosting is a separate step: swap in the `ws` package
// (an npm install, with the user's OK) or the starter's Workers variant, and run a
// security review first (see README).
//
// What it does check: the Origin on every upgrade (browsers don't apply CORS to
// sockets), the handshake headers, client masking, a 16 KB frame cap and a 64 KB
// buffer cap, and a protocol-level heartbeat that drops dead sockets.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRegistry } from './registry.js';
import { CLOSE, parseRoomPath } from '../js/net/protocol.js';
import { envLimit } from './limits.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024; // a game message is a few hundred bytes
const MAX_BUFFER = 64 * 1024;
const HEARTBEAT_MS = 30000;

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

const refuse = (socket, status) => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  setTimeout(() => socket.destroy(), 1000).unref();
};

// Route /room/<game>/<code> upgrades on an existing http.Server to rooms.
export function attachRooms(server, {
  registry, allowedOrigins, log = () => {},
  maxSockets = envLimit('MAX_SOCKETS', 500),
  maxOutgoingBytes = envLimit('MAX_OUTGOING_BYTES', 1024 * 1024),
}) {
  const sockets = new Set();
  const allowed = new Set(allowedOrigins);

  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    let route;
    try {
      route = parseRoomPath(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return refuse(socket, '400 Bad Request');
    }
    const key = req.headers['sec-websocket-key'];
    const why =
      !route || !registry.has(route.game)
        ? 'path'
        : !allowed.has(req.headers.origin)
          ? 'origin'
          : String(req.headers.upgrade).toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13'
            ? 'handshake'
            : null;
    if (why) {
      // Log why (never the address), so "stuck connecting" can be traced to a missing origin.
      log({ ev: 'upgrade-refused', why, origin: req.headers.origin ?? null });
      return refuse(socket, why === 'handshake' ? '400 Bad Request' : '403 Forbidden');
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const atCapacity = sockets.size >= maxSockets;
    if (!atCapacity) sockets.add(socket);

    let closed = false;
    let sentClose = false;
    let closeCode = 1006; // what the room hears if the socket just dies
    socket.alive = true;
    const conn = {
      data: null,
      send(text) {
        write(1, Buffer.from(text));
      },
      close(c = 1000, reason = '') {
        if (closed || sentClose) return;
        sentClose = true;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(c, 0);
        body.write(reason, 2);
        socket.write(frame(8, body));
        setTimeout(() => socket.destroy(), 1000).unref();
      },
      terminate() {
        socket.destroy(); // no close frame: the client sees 1006, like a dropped network
      },
    };
    // Every data or control frame shares the same budget. Allow one small close
    // frame through so a reader that catches up can learn why it was disconnected.
    function write(opcode, payload) {
      if (closed || sentClose) return;
      const packet = frame(opcode, payload);
      if (socket.writableLength + packet.length > maxOutgoingBytes) {
        conn.close(CLOSE.SLOW_READER, 'Your connection could not keep up. Try joining again.');
        socket.end();
        return;
      }
      socket.write(packet);
      if (socket.writableLength > maxOutgoingBytes) {
        conn.close(CLOSE.SLOW_READER, 'Your connection could not keep up. Try joining again.');
        socket.end();
      }
    }
    socket.sendFrame = write;
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || socket.remoteAddress;
    const handlers = atCapacity ? null : registry.connect(route.game, route.code, conn, ip);
    if (atCapacity) conn.close(CLOSE.SERVER_BUSY, 'The room server has too many connections. Try again later.');
    if (!handlers) socket.end();

    let buf = Buffer.alloc(0);
    let fragments = [];
    let fragmentBytes = 0;
    const fail = (code, reason) => {
      conn.close(code, reason);
      buf = Buffer.alloc(0);
      fragments = [];
    };
    socket.on('data', (chunk) => {
      if (sentClose) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_BUFFER) return fail(1009, 'too big');
      for (;;) {
        if (buf.length < 2) return;
        const fin = buf[0] & 0x80;
        const opcode = buf[0] & 0x0f;
        const masked = buf[1] & 0x80;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (!masked) return fail(1002, 'unmasked frame'); // clients must mask (RFC 6455 5.1)
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(MAX_FRAME)) return fail(1009, 'too big');
          len = Number(big);
          off = 10;
        }
        if (len > MAX_FRAME) return fail(1009, 'too big');
        const maskOff = off;
        off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i & 3)];
        buf = buf.subarray(off + len);
        socket.alive = true; // any frame is proof of life

        if (opcode === 8) {
          closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          if (!sentClose) {
            write(8, payload.subarray(0, 2));
            sentClose = true;
          }
          socket.end();
          return;
        }
        if (opcode === 9) {
          write(10, payload.subarray(0, 125));
          if (sentClose) return;
          continue;
        }
        if (opcode === 10) continue;
        if (opcode === 2) return fail(1003, 'text only');
        if (opcode !== 0 && opcode !== 1) return fail(1002, 'bad opcode');
        fragments.push(payload);
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_FRAME) return fail(1009, 'too big');
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          fragmentBytes = 0;
          handlers.message(text);
          if (sentClose) return;
        }
      }
    });
    socket.on('close', () => {
      if (closed) return;
      closed = true;
      sockets.delete(socket);
      handlers?.close(closeCode);
    });
  });

  // Browsers answer protocol pings in the network stack, even from a background tab,
  // so a socket that misses a whole interval is dead.
  const heartbeat = setInterval(() => {
    for (const s of sockets) {
      if (!s.alive) {
        s.destroy();
        continue;
      }
      s.alive = false;
      s.sendFrame(9, Buffer.alloc(0));
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  return sockets;
}

// For tests: a server with rooms only, on a free port on 127.0.0.1.
export function startTestServer({ port = 0, allowedOrigins = ['http://test.local'], roomOptions = {}, registryOptions = {}, socketOptions = {}, games, log = () => {} } = {}) {
  const registry = createRegistry({ now: () => performance.now(), log, roomOptions, ...registryOptions, ...(games ? { games } : {}) });
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'cache-control': 'no-store' });
    res.end(req.url === '/health' ? 'ok' : '');
  });
  const sockets = attachRooms(server, { registry, allowedOrigins, log, ...socketOptions });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      server.close();
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({
        url: (game, code) => `ws://127.0.0.1:${p}/room/${game}/${code}`,
        port: p,
        registry,
        sockets,
        cutAll() {
          for (const s of sockets) s.destroy();
        },
        async stop() {
          for (const s of sockets) s.destroy();
          for (const room of registry.rooms.values()) room.dispose();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}
