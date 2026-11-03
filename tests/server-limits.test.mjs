import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { attachRooms, startTestServer } from '../server/ws.mjs';
import { createRegistry } from '../server/registry.js';
import { envLimit } from '../server/limits.js';
import { createNet, memoryStorage } from '../js/net/net.js';
import { CLOSE, classifyClose } from '../js/net/protocol.js';
import { STATUS_TEXT } from '../js/online.js';

const ORIGIN = 'http://test.local';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check) {
  const until = performance.now() + 3000;
  while (!check()) {
    assert.ok(performance.now() < until, 'timed out waiting for server/client');
    await wait(10);
  }
}

async function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function fixture(t, env = {}, options = {}) {
  const srv = await withEnv(env, () => startTestServer(options));
  const clients = [];
  t.after(async () => {
    for (const { client } of clients) client.close();
    await srv.stop();
  });
  function connect(code, { create = true, forwarded } = {}) {
    const seen = [];
    const client = createNet({
      url: srv.url('shove', code), room: code, name: 'Test', create,
      storage: memoryStorage(),
      socketOptions: { headers: { origin: ORIGIN, ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) } },
      onStatus: (status, detail) => seen.push({ status, ...detail }),
    });
    const result = { client, seen };
    clients.push(result);
    return result;
  }
  return { srv, connect };
}

async function refused({ client, seen }, reason) {
  await waitFor(() => client.status === 'gone');
  const detail = seen.findLast((s) => s.status === 'gone');
  assert.equal(detail.code, CLOSE.SERVER_BUSY);
  assert.match(detail.reason, reason);
  assert.equal(STATUS_TEXT.gone(detail), detail.reason, 'the page shows the rejection reason');
  await wait(50);
  assert.equal(client.stats.reconnects, 0);
  assert.equal(seen.filter((s) => s.status === 'connecting').length, 1, 'no retry storm');
}

test('a malformed upgrade returns HTTP 400, closes the socket, and leaves the server running', async (t) => {
  const { srv, connect } = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(srv.port, '127.0.0.1');
    t.after(() => socket.destroy());
    let received = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('upgrade did not close')));
    socket.on('error', reject);
    socket.on('data', (chunk) => received += chunk);
    socket.on('close', () => resolve(received));
    socket.on('connect', () => socket.write(
      'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    ));
  });
  assert.match(response, /^HTTP\/1.1 400 Bad Request\r\n/);
  const health = await fetch(`http://127.0.0.1:${srv.port}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  const { client } = connect('A001');
  await waitFor(() => client.status === 'online');
});

test('MAX_ROOMS caps new rooms, permits existing rooms, and frees capacity after deletion', async (t) => {
  const { srv, connect } = await fixture(t, { MAX_ROOMS: '1' });
  const host = connect('A001');
  await waitFor(() => host.client.status === 'online');
  await refused(connect('A002'), /server is full/);
  assert.equal(srv.registry.rooms.size, 1);
  const guest = connect('A001', { create: false });
  await waitFor(() => guest.client.status === 'online');
  host.client.close();
  guest.client.close();
  await waitFor(() => srv.registry.rooms.size === 0);
  const next = connect('A002');
  await waitFor(() => next.client.status === 'online');
  assert.equal(srv.registry.rooms.size, 1);
});

test('MAX_SOCKETS rejects extra sockets before connecting to a room and releases closed slots', async (t) => {
  const { srv, connect } = await fixture(t, { MAX_SOCKETS: '1' });
  const host = connect('A001');
  await waitFor(() => host.client.status === 'online');
  await refused(connect('A002'), /too many connections/);
  assert.equal(srv.registry.get('shove', 'A002'), undefined);
  assert.equal(host.client.status, 'online');
  host.client.close();
  await waitFor(() => srv.registry.rooms.size === 0);
  // The room empties on "leave", but the socket keeps its slot until it has closed
  // (up to a second), so wait for the slot itself before connecting again.
  await waitFor(() => srv.sockets.size === 0);
  const next = connect('A002');
  await waitFor(() => next.client.status === 'online');
});

test('ROOM_CREATIONS_PER_MINUTE uses the first forwarded IP, allows joins, and expires after a minute', async (t) => {
  let now = 1;
  const { srv, connect } = await fixture(t, { ROOM_CREATIONS_PER_MINUTE: '1' }, { registryOptions: { now: () => now } });
  const host = connect('A001', { forwarded: '203.0.113.1, 10.0.0.1' });
  await waitFor(() => host.client.status === 'online');
  await refused(connect('A002', { forwarded: ' 203.0.113.1 , 10.0.0.2' }), /Wait a minute/);
  const other = connect('A003', { forwarded: '203.0.113.2, 10.0.0.1' });
  await waitFor(() => other.client.status === 'online');
  const guest = connect('A001', { create: false, forwarded: '203.0.113.1, 10.0.0.3' });
  await waitFor(() => guest.client.status === 'online');
  assert.equal(srv.registry.rooms.size, 2);
  now += 60000;
  const later = connect('A002', { forwarded: '203.0.113.1' });
  await waitFor(() => later.client.status === 'online');
});

test('the creation rate limit falls back to the socket address without X-Forwarded-For', async (t) => {
  const { connect } = await fixture(t, { ROOM_CREATIONS_PER_MINUTE: '1' });
  const host = connect('A001');
  await waitFor(() => host.client.status === 'online');
  await refused(connect('A002'), /Wait a minute/);
});

// A deterministic slow socket: the operating system's TCP buffer size varies by
// platform. Keep writableLength under test control and exercise the real adapter.
class SlowSocket extends EventEmitter {
  writableLength = 0;
  writes = [];
  ended = false;
  destroyed = false;
  write(packet) { this.writes.push(packet); }
  setNoDelay() {}
  end(packet) { if (packet) this.write(packet); this.ended = true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

function upgrade(server, socket, url = '/room/shove/A001') {
  server.emit('upgrade', {
    url,
    headers: { origin: ORIGIN, upgrade: 'websocket', 'sec-websocket-key': 'test', 'sec-websocket-version': '13' },
  }, socket);
}

test('the upgrade handler catches malformed URLs before routing and remains usable', async (t) => {
  const server = new EventEmitter();
  let connected = 0;
  const sockets = attachRooms(server, {
    allowedOrigins: [ORIGIN],
    registry: { has: () => true, connect() { connected++; return { message() {}, close() {} }; } },
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.emit('close');
  });
  const bad = new SlowSocket();
  assert.doesNotThrow(() => upgrade(server, bad, 'http://['));
  assert.match(bad.writes[0], /^HTTP\/1.1 400 Bad Request\r\n/);
  assert.equal(bad.ended, true);
  assert.equal(connected, 0);
  upgrade(server, new SlowSocket());
  assert.equal(connected, 1);
  await waitFor(() => bad.destroyed);
});

test('the registry enforces room and per-IP caps even for connections still waiting for hello', async (t) => {
  let now = 1;
  const registry = await withEnv({ MAX_ROOMS: '2', ROOM_CREATIONS_PER_MINUTE: '1' }, () => createRegistry({ now: () => now }));
  const handlers = [];
  t.after(() => { for (const handler of handlers) handler.close(1006); });
  function connect(code, ip) {
    let refusal;
    const handler = registry.connect('shove', code, { send() {}, close(code, reason) { refusal = { code, reason }; } }, ip);
    if (handler) handlers.push(handler);
    return { handler, refusal };
  }
  assert.ok(connect('A001', 'one').handler);
  assert.match(connect('A002', 'one').refusal.reason, /Wait a minute/);
  assert.ok(connect('A001', 'one').handler, 'existing rooms bypass the creation quota');
  assert.ok(connect('A002', 'two').handler);
  const full = connect('A003', 'three');
  assert.equal(full.refusal.code, CLOSE.SERVER_BUSY);
  assert.match(full.refusal.reason, /server is full/);
  assert.equal(registry.rooms.size, 2);
  handlers[0].close(1006);
  handlers[1].close(1006);
  assert.equal(registry.rooms.size, 1);
  assert.match(connect('A003', 'one').refusal.reason, /Wait a minute/, 'deleting a room does not reset the IP quota');
  now += 60000;
  assert.ok(connect('A003', 'one').handler);
});

test('the adapter caps sockets before invoking the registry and reuses a closed slot', async (t) => {
  const server = new EventEmitter();
  let connected = 0;
  const sockets = await withEnv({ MAX_SOCKETS: '1' }, () => attachRooms(server, {
    allowedOrigins: [ORIGIN],
    registry: { has: () => true, connect() { connected++; return { message() {}, close() {} }; } },
  }));
  const refused = new SlowSocket();
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    refused.destroy();
    server.emit('close');
  });
  const first = new SlowSocket();
  upgrade(server, first);
  upgrade(server, refused);
  assert.equal(connected, 1);
  assert.equal(refused.writes[1].readUInt16BE(2), CLOSE.SERVER_BUSY);
  assert.equal(refused.ended, true);
  assert.equal(sockets.size, 1);
  first.destroy();
  upgrade(server, new SlowSocket());
  assert.equal(connected, 2);
  assert.equal(sockets.size, 1);
});

test('MAX_OUTGOING_BYTES stops data and pong writes to slow sockets and destroys them', async (t) => {
  const server = new EventEmitter();
  const connections = [];
  let closes = 0;
  const registry = {
    has: () => true,
    connect(game, code, conn) {
      connections.push(conn);
      return { message() {}, close() { closes++; } };
    },
  };
  const sockets = await withEnv({ MAX_OUTGOING_BYTES: '128' }, () => attachRooms(server, { registry, allowedOrigins: [ORIGIN] }));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.emit('close');
  });
  function slowReader() {
    const socket = new SlowSocket();
    upgrade(server, socket);
    socket.writes = []; // discard the HTTP handshake
    return socket;
  }
  const data = slowReader();
  data.writableLength = 120;
  connections[0].send('small'); // 7 bytes including the frame header: still fits
  assert.equal(data.writes.length, 1);
  connections[0].send('too large');
  connections[0].send('must not queue');
  assert.equal(data.writes.length, 2, 'only the fitting message and one close frame');
  assert.equal(data.writes[1][0], 0x88);
  assert.equal(data.writes[1].readUInt16BE(2), CLOSE.SLOW_READER);
  assert.equal(data.ended, true);
  const pong = slowReader();
  pong.writableLength = 129;
  // Empty, masked client ping. Even control replies must respect the cap.
  pong.emit('data', Buffer.from([0x89, 0x80, 0, 0, 0, 0]));
  assert.equal(pong.writes.length, 1);
  assert.equal(pong.writes[0][0], 0x88);
  assert.equal(pong.writes[0].readUInt16BE(2), CLOSE.SLOW_READER);
  assert.equal(pong.ended, true);
  await waitFor(() => data.destroyed && pong.destroyed);
  assert.equal(sockets.size, 0);
  assert.equal(closes, 2);
  assert.equal(classifyClose(CLOSE.SLOW_READER), 'final');
  assert.match(STATUS_TEXT.gone({ code: CLOSE.SLOW_READER }), /could not keep up/);
});

test('invalid environment limits keep the safe defaults', async () => {
  for (const value of ['', '0', '-1', '1.5', 'Infinity', 'no', '9007199254740992']) {
    await withEnv({ MAX_ROOMS: value }, () => assert.equal(envLimit('MAX_ROOMS', 200), 200));
  }
  await withEnv({ MAX_ROOMS: '2' }, () => assert.equal(envLimit('MAX_ROOMS', 200), 2));
});

test('Pages runs the full test suite before stamping or publishing, without ignoring failures', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const tests = workflow.indexOf('- run: npm test');
  assert.ok(tests > 0);
  assert.ok(tests < workflow.indexOf('- run: node tools/stamp-sw.mjs'));
  assert.ok(tests < workflow.indexOf('actions/upload-pages-artifact'));
  assert.ok(tests < workflow.indexOf('actions/deploy-pages'));
  assert.doesNotMatch(workflow, /continue-on-error|always\(\)|npm test.*\|\|/);
});
