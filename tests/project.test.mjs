// Project-wide checks (from the browser-games starter): modules stay importable in
// Node (so rules are testable and nothing touches the DOM at load), imports match
// real files with exact case, no root-absolute URLs, and the server keeps its own
// files private and listens on 127.0.0.1 by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_MODULES = new Set(['js/main.js']); // allowed to touch the DOM when loaded

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const modules = files.filter((p) => /\.(m?js)$/.test(p) && /^(js|server|tools)\//.test(rel(p)));

function existsExactCase(absPath) {
  const parts = relative(ROOT, absPath).split(sep);
  let dir = ROOT;
  for (const part of parts) {
    if (part === '..' || !readdirSync(dir).includes(part)) return false;
    dir = join(dir, part);
  }
  return true;
}

test('every browser module except the host imports cleanly in Node', async () => {
  const browser = modules.filter((p) => rel(p).startsWith('js/') && !HOST_MODULES.has(rel(p)));
  assert.ok(browser.length > 10);
  for (const p of browser) await assert.doesNotReject(import(pathToFileURL(p).href), `${rel(p)} failed to import`);
});

test('relative imports and page links match real files, case included', () => {
  const specifier = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const p of modules) {
    for (const m of readFileSync(p, 'utf8').matchAll(specifier)) {
      const spec = m[1] ?? m[2];
      assert.ok(existsExactCase(join(dirname(p), spec)), `${rel(p)} imports ${spec}, which doesn't exist with that exact case`);
    }
  }
  const attr = /(?:src|href)="(?!https?:|data:|#|mailto:)([^"]+)"/g;
  for (const m of readFileSync(join(ROOT, 'index.html'), 'utf8').matchAll(attr)) {
    assert.ok(existsExactCase(join(ROOT, m[1].split(/[?#]/)[0])), `index.html links ${m[1]}, which doesn't exist with that exact case`);
  }
});

test('no root-absolute URLs in the page (they break when hosted under a path)', () => {
  const bad = /(?:src|href)="\/(?!\/)|from\s*['"]\/(?!\/)|import\(\s*['"]\/(?!\/)|url\(\s*['"]?\/(?!\/)/;
  for (const p of files.filter((f) => /\.(html|css)$/.test(f) || (f.endsWith('.js') && rel(f).startsWith('js/')))) {
    const hit = readFileSync(p, 'utf8').split('\n').findIndex((line) => bad.test(line));
    assert.equal(hit, -1, `${rel(p)}:${hit + 1} uses a root-absolute URL`);
  }
});

test('the browser never imports server-only code, and the server binds to 127.0.0.1 by default', () => {
  for (const p of modules.filter((f) => rel(f).startsWith('js/'))) {
    assert.ok(!/from\s*['"][^'"]*\/(server|tests|tools)\//.test(readFileSync(p, 'utf8')), `${rel(p)} imports server-only code`);
  }
  const server = readFileSync(join(ROOT, 'server/server.mjs'), 'utf8');
  assert.match(server, /const HOST = process\.env\.HOST \?\? '127\.0\.0\.1';/);
  assert.match(server, /SERVER_ONLY = .*server\|tests\|tools/);
  assert.ok(!/require\(|from ['"](?!node:|\.)/.test(server + readFileSync(join(ROOT, 'server/ws.mjs'), 'utf8')), 'the server uses Node built-ins only');
});

test('no npm dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), []);
});
