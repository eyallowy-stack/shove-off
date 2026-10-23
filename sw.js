// Shove Off's service worker. After one visit the game opens with no connection, from
// the Home Screen too, and Play vs Computer and 2 players here work offline. Online
// rooms still need the room server, and nothing about them is ever cached.
//
// Versioned: VERSION changes whenever any file below (or this file) changes. The room
// server stamps the live hash in each time it serves this file (server/sw-version.mjs);
// for a static host, run `node tools/stamp-sw.mjs` before publishing. A new version
// installs in the background with every file at once, so old and new modules never
// mix, and the page offers a reload in its menus (js/pwa.js).
//
// FILES is plain JSON on purpose: the server and the tests read it. tests/pwa.test.mjs
// fails if a module the page imports is missing here.

const VERSION = 'dev';
const CACHE = `shove-off-${VERSION}`;
const FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/game.css",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "js/audio.js",
  "js/config.js",
  "js/controls.js",
  "js/game/cpu.js",
  "js/game/rules.js",
  "js/game/sim.js",
  "js/haptics.js",
  "js/lib/live.js",
  "js/lib/loop.js",
  "js/lib/storage.js",
  "js/local.js",
  "js/main.js",
  "js/net/backoff.js",
  "js/net/clock.js",
  "js/net/lag.js",
  "js/net/net.js",
  "js/net/overlay.js",
  "js/net/predict.js",
  "js/net/protocol.js",
  "js/net/roster.js",
  "js/net/session.js",
  "js/net/snapshots.js",
  "js/online.js",
  "js/pwa.js",
  "js/render.js",
  "js/solo.js",
  "js/touch.js"
];
// The room server's own endpoints: always straight to the network, never cached.
// (Room sockets don't pass through a service worker at all; this covers plain requests.)
const NEVER = /^(room|health)(\/|$)/;

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the HTTP cache, so a new version is really the new files.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('shove-off-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The page asks for this when the player presses Reload on the "new version" toast.
self.addEventListener('message', (event) => {
  if (event.data?.t === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const base = new URL(self.registration.scope).pathname; // "/" here, "/repo/" on a project site
  if (!url.pathname.startsWith(base)) return;
  const path = url.pathname.slice(base.length);
  if (NEVER.test(path)) return;
  // Opening the game (with or without ?debug) is the cached page; the game's own files
  // come from this version's cache. Anything else isn't the game: the network decides.
  const key = req.mode === 'navigate' && (path === '' || path === 'index.html') ? './' : FILES.includes(path) ? path : null;
  if (!key) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then((c) => c.match(key))
      .then((hit) => hit || fetch(req)),
  );
});
