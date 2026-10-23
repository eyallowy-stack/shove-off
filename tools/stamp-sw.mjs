// Writes the current version hash into sw.js. Only needed before copying the game to a
// static host (GitHub Pages and the like): the room server stamps it live by itself.
//
//   ~/.local/bin/node tools/stamp-sw.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampSw, swVersion } from '../server/sw-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'sw.js');
const source = readFileSync(file, 'utf8');
writeFileSync(file, stampSw(root, source));
console.log(`sw.js version ${swVersion(root, source)}`);
