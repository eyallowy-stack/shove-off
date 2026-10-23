// The service worker's version is a hash of every file it caches (and of sw.js itself),
// so any change to the game reaches a phone that has it on the Home Screen: the browser
// sees a different sw.js, installs the new files in the background, and the page offers
// a reload. The room server stamps it live (server.mjs); tools/stamp-sw.mjs writes it
// into sw.js for a static host.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const VERSION_LINE = /const VERSION = '[^']*';/;

export function swFiles(source) {
  const m = source.match(/const FILES = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('sw.js has no FILES list');
  return JSON.parse(m[1]);
}

const diskPath = (root, f) => path.join(root, f === './' ? 'index.html' : f);

export function swVersion(root, source) {
  const h = createHash('sha256');
  h.update(source.replace(VERSION_LINE, ''));
  for (const f of swFiles(source)) {
    h.update(`\n${f}\n`);
    h.update(readFileSync(diskPath(root, f)));
  }
  return h.digest('hex').slice(0, 12);
}

export const stampSw = (root, source) => source.replace(VERSION_LINE, `const VERSION = '${swVersion(root, source)}';`);

// For the server: re-hash only when a file's size or modified time changed, so the
// request a phone makes on every launch costs a few stat calls, not reading the game.
export function createSwServer(root) {
  let key = '';
  let body = '';
  return function serveSw() {
    const source = readFileSync(path.join(root, 'sw.js'), 'utf8');
    const k =
      source.length +
      swFiles(source)
        .map((f) => {
          const s = statSync(diskPath(root, f));
          return `${s.size}:${s.mtimeMs}`;
        })
        .join('|');
    if (k !== key || !body) {
      body = stampSw(root, source);
      key = k;
    }
    return body;
  };
}
