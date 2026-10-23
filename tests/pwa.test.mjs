// The phone side of the page: the viewport and Home Screen tags, the manifest and its
// generated icons, and the service worker (run here in a sandbox with a fake cache):
// it caches every file the game loads, serves the game with no connection, never
// touches the room server's endpoints, versions itself from the files, and the real
// server stamps that version and keeps its own files private.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { swFiles, swVersion, stampSw, createSwServer } from '../server/sw-version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('index.html');
const swSource = read('sw.js');
const FILES = swFiles(swSource);

function pngSize(p) {
  const b = readFileSync(join(ROOT, p));
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${p} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('viewport and Home Screen tags: full screen under the notch, zoom left to the browser outside play', () => {
  const vp = html.match(/<meta name="viewport" content="([^"]+)">/)?.[1];
  assert.equal(vp, 'width=device-width, initial-scale=1, viewport-fit=cover');
  assert.ok(!/user-scalable|maximum-scale/.test(html), 'zoom is blocked only on the play surface (touch-action), never for the page');
  for (const tag of ['apple-mobile-web-app-capable" content="yes', 'apple-mobile-web-app-status-bar-style" content="black-translucent', 'apple-mobile-web-app-title" content="Shove Off', 'theme-color']) assert.ok(html.includes(tag), tag);
  const touchIcon = html.match(/<link rel="apple-touch-icon" href="([^"]+)">/)?.[1];
  assert.deepEqual(pngSize(touchIcon), [180, 180]);
  assert.ok(html.includes('<link rel="manifest" href="manifest.webmanifest">'));
});

test('the manifest: relative paths, standalone, and real icons at the sizes it claims', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.ok(m.name && m.short_name.length <= 12, 'a short name that fits under the icon');
  const purposes = new Set();
  for (const icon of m.icons) {
    const [w, h] = pngSize(icon.src);
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    assert.equal(icon.type, 'image/png');
    purposes.add(`${icon.purpose}:${icon.sizes}`);
  }
  assert.ok(purposes.has('any:192x192') && purposes.has('any:512x512') && purposes.has('maskable:512x512'));
});

test('the service worker caches everything the game loads (so it opens offline) and nothing that does not exist', () => {
  // The whole import graph from the page's entry module, plus what index.html links.
  const graph = new Set();
  const queue = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map((m) => m[1]);
  const spec = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  while (queue.length) {
    const f = queue.pop();
    if (graph.has(f)) continue;
    graph.add(f);
    for (const m of read(f).matchAll(spec)) queue.push(new URL(m[1] ?? m[2], `http://x/${f}`).pathname.slice(1));
  }
  for (const m of html.matchAll(/<link rel="(?:stylesheet|manifest|apple-touch-icon)" href="([^"]+)"/g)) graph.add(m[1]);
  for (const icon of JSON.parse(read('manifest.webmanifest')).icons) graph.add(icon.src);
  graph.add('index.html');
  graph.add('./');
  const missing = [...graph].filter((f) => !FILES.includes(f));
  assert.deepEqual(missing, [], 'add these to FILES in sw.js, or the game breaks offline');
  for (const f of FILES) assert.ok(existsSync(join(ROOT, f === './' ? 'index.html' : f)), `sw.js caches ${f}, which doesn't exist`);
  assert.ok(!FILES.some((f) => /^(room|health|server|tests|tools)\b/.test(f)), 'nothing from the server side');
});

// sw.js in a sandbox: a fake self, cache storage and network.
function loadWorker({ online = true } = {}) {
  const origin = 'https://laptop.tail1234.ts.net';
  const swUrl = `${origin}/sw.js`;
  const listeners = {};
  const store = new Map();
  const network = { online, requests: [] };
  const fakeFetch = async (req) => {
    const url = typeof req === 'string' ? new URL(req, swUrl).href : req.url;
    network.requests.push(url);
    if (!network.online) throw new TypeError('Failed to fetch');
    return { url, body: `network:${new URL(url).pathname}` };
  };
  class FakeRequest {
    constructor(u, init = {}) {
      this.url = new URL(u, swUrl).href;
      this.cache = init.cache;
      this.method = 'GET';
    }
  }
  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name);
      return {
        async addAll(reqs) {
          for (const r of reqs) m.set(r.url, { ...(await fakeFetch(r)), cache: r.cache });
        },
        async match(key) {
          return m.get(new URL(typeof key === 'string' ? key : key.url, swUrl).href);
        },
      };
    },
    keys: async () => [...store.keys()],
    delete: async (k) => store.delete(k),
  };
  const self = {
    location: new URL(swUrl),
    registration: { scope: `${origin}/` },
    clients: { claim: async () => (self.claimed = true) },
    skipWaiting: () => (self.skipped = true),
    addEventListener: (t, fn) => (listeners[t] = fn),
  };
  vm.runInNewContext(swSource, { self, caches, fetch: fakeFetch, Request: FakeRequest, URL, console });
  const run = async (type, extra = {}) => {
    let wait = null;
    let response = null;
    listeners[type]({ ...extra, waitUntil: (p) => (wait = p), respondWith: (p) => (response = p) });
    await wait;
    return response ? await response : null;
  };
  const fetchEvent = (path, { mode = 'cors', method = 'GET', at = origin } = {}) => run('fetch', { request: { url: new URL(path, at).href, mode, method } });
  return { run, fetchEvent, store, network, self, origin };
}

test('installing caches every file in one go, bypassing the HTTP cache', async () => {
  const w = loadWorker();
  await w.run('install');
  const [name] = [...w.store.keys()];
  assert.match(name, /^shove-off-/);
  const cached = w.store.get(name);
  assert.equal(cached.size, FILES.length);
  assert.ok([...cached.values()].every((r) => r.cache === 'reload'));
});

test('offline after one visit: the page and every module come from the cache', async () => {
  const w = loadWorker();
  await w.run('install');
  await w.run('activate');
  w.network.online = false; // Tailscale off, or no signal at all
  w.network.requests.length = 0;
  for (const path of ['/', '/?debug', '/index.html']) assert.equal((await w.fetchEvent(path, { mode: 'navigate' }))?.body, 'network:/', `${path} opens offline`);
  for (const f of FILES.filter((x) => x !== './')) assert.equal((await w.fetchEvent(`/${f}`))?.body, `network:/${f}`, `${f} offline`);
  assert.equal(w.network.requests.length, 0, 'nothing touched the network');
});

test("the room server's endpoints, other sites and anything that isn't the game are never cached or answered", async () => {
  const w = loadWorker();
  await w.run('install');
  for (const path of ['/room/shove/K7Q0', '/room/shove/K7Q0?x=1', '/health', '/README.md', '/server/room.js', '/js/unknown.js'])
    assert.equal(await w.fetchEvent(path), null, `${path} goes straight to the network`);
  assert.equal(await w.fetchEvent('/room/shove/K7Q0', { mode: 'navigate' }), null);
  assert.equal(await w.fetchEvent('/js/main.js', { method: 'POST' }), null);
  assert.equal(await w.fetchEvent('/js/main.js', { at: 'https://elsewhere.example' }), null);
  for (const cache of w.store.values()) for (const url of cache.keys()) assert.ok(!/\/(room|health)\b/.test(url), url);
});

test('a new version replaces the old cache on activation, and only takes over when the page asks', async () => {
  const w = loadWorker();
  w.store.set('shove-off-oldversion', new Map());
  w.store.set('someone-else', new Map());
  await w.run('install');
  assert.ok(!w.self.skipped, 'waits: never swaps files under a running match');
  await w.run('message', { data: { t: 'skip-waiting' } });
  assert.ok(w.self.skipped);
  await w.run('activate');
  assert.deepEqual([...w.store.keys()].sort(), ['shove-off-dev', 'someone-else']);
  assert.ok(w.self.claimed);
});

test('the version is a hash of the cached files: any change to the game makes a new one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shove-sw-'));
  try {
    const src = `const VERSION = 'dev';\nconst FILES = ["./", "a.js"];\n`;
    writeFileSync(join(dir, 'index.html'), '<p>hi</p>');
    writeFileSync(join(dir, 'a.js'), 'export const a = 1;');
    const v1 = swVersion(dir, src);
    assert.match(v1, /^[0-9a-f]{12}$/);
    assert.equal(swVersion(dir, src), v1, 'stable');
    writeFileSync(join(dir, 'a.js'), 'export const a = 2;');
    const v2 = swVersion(dir, src);
    assert.notEqual(v2, v1, 'a module changed');
    writeFileSync(join(dir, 'index.html'), '<p>hello</p>');
    assert.notEqual(swVersion(dir, src), v2, 'the page changed');
    assert.notEqual(swVersion(dir, src.replace('"a.js"]', '"a.js", "index.html"]')), swVersion(dir, src), 'the list changed');
    assert.match(stampSw(dir, src), new RegExp(`const VERSION = '${swVersion(dir, src)}';`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const live = createSwServer(ROOT)();
  assert.match(live, /const VERSION = '[0-9a-f]{12}';/);
  assert.equal(live, stampSw(ROOT, swSource));
});

test('the room server serves the stamped worker, the manifest and icons, and still hides its own files', { timeout: 15000 }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(ROOT, 'server/server.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 8000);
      child.stdout.on('data', (d) => String(d).includes('"listening"') && (clearTimeout(t), resolve()));
      child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
    });
    const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
    const sw = await get('/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.equal(sw.headers.get('cache-control'), 'no-store', 'update checks always see the newest worker');
    assert.match(await sw.text(), /const VERSION = '[0-9a-f]{12}';/);
    const man = await get('/manifest.webmanifest');
    assert.equal(man.headers.get('content-type'), 'application/manifest+json');
    assert.equal((await get('/icons/icon-192.png')).headers.get('content-type'), 'image/png');
    for (const hidden of ['/tools/make-icons.mjs', '/server/sw-version.mjs', '/tests/pwa.test.mjs']) assert.equal((await get(hidden)).status, 404, hidden);
  } finally {
    child.kill('SIGTERM');
  }
});
