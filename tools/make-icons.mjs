// Draws Shove Off's app icons from shapes, so nothing is downloaded: Coral (glowing,
// about to dash) and Teal on a hex of ice in dark water, in the game's ink style.
// Writes PNGs with Node built-ins only (zlib for the compression, a small CRC-32).
//
//   ~/.local/bin/node tools/make-icons.mjs        # writes icons/*.png
//
// Each pixel is 4x4 supersampled, so edges are smooth at every size.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];
const C = {
  ink: hex('#16202e'),
  water: hex('#1d5874'),
  ice: hex('#eef8fa'),
  iceSide: hex('#86bccb'),
  glow: hex('#ffd23f'),
  coral: hex('#ff6b57'),
  coralDark: hex('#c4402c'),
  teal: hex('#17a597'),
  tealDark: hex('#0b6b61'),
  white: hex('#ffffff'),
  none: [0, 0, 0, 0],
};

const SQ3 = Math.sqrt(3);
// Pointy-top hexagon with circumradius r, like the floe's tiles.
const inHex = (dx, dy, r) => {
  const a = (r * SQ3) / 2;
  const x = Math.abs(dx);
  const y = Math.abs(dy);
  return x <= a && x / 2 + (y * SQ3) / 2 <= a;
};
const inCircle = (dx, dy, r) => dx * dx + dy * dy <= r * r;
const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// The picture, in a unit square. Back to front: the first opaque layer from the top wins.
function paint(x, y) {
  const INK = 0.03;
  const fx = { coral: [0.385, 0.53, 0.15], teal: [0.655, 0.46, 0.128] };
  // Eyes (on top of everything).
  for (const [cx, cy, r, look] of [
    [fx.coral[0], fx.coral[1], fx.coral[2], 1],
    [fx.teal[0], fx.teal[1], fx.teal[2], -1],
  ]) {
    for (const side of [-1, 1]) {
      const ex = cx + look * r * 0.42;
      const ey = cy + side * r * 0.3;
      const dx = (x - ex) / (r * 0.27);
      const dy = (y - ey) / (r * 0.32);
      const d = dx * dx + dy * dy;
      if (d <= 1) {
        const px = x - (ex + look * r * 0.09);
        const py = y - ey;
        if (inCircle(px, py, r * 0.13)) return C.ink;
        return d >= 0.72 ? C.ink : C.white;
      }
    }
  }
  // Teal, with dots.
  {
    const [cx, cy, r] = fx.teal;
    const dx = x - cx;
    const dy = y - cy;
    if (inCircle(dx, dy, r)) {
      for (const [ox, oy] of [
        [-0.35, -0.55],
        [0.25, -0.62],
        [-0.62, 0.05],
        [0.0, 0.62],
        [-0.38, 0.5],
        [0.55, 0.42],
      ])
        if (inCircle(dx - ox * r, dy - oy * r, r * 0.13)) return C.tealDark;
      return C.teal;
    }
    if (inCircle(dx, dy, r + INK)) return C.ink;
  }
  // Coral, with stripes.
  {
    const [cx, cy, r] = fx.coral;
    const dx = x - cx;
    const dy = y - cy;
    if (inCircle(dx, dy, r)) {
      const u = dx * Math.cos(0.6) + dy * Math.sin(0.6);
      const band = (((u / r) * 2.4) % 1 + 1) % 1;
      return band < 0.3 ? C.coralDark : C.coral;
    }
    if (inCircle(dx, dy, r + INK)) return C.ink;
    // The glow ring: the charge everyone can see coming.
    const d = Math.hypot(dx, dy);
    if (d >= r + 0.05 && d <= r + 0.085) return C.glow;
  }
  // The ice: a top face and a thick side, both outlined.
  const ix = x - 0.5;
  const iy = y - 0.52;
  const R = 0.36;
  if (inHex(ix, iy, R)) return C.ice;
  if (inHex(ix, iy, R + INK)) return C.ink;
  if (inHex(ix, iy - 0.05, R)) return C.iceSide;
  if (inHex(ix, iy - 0.05, R + INK)) return C.ink;
  return C.water;
}

function render(size, { inset = 1, rounded = 0 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (i + (sx + 0.5) / S) / size;
          const v = (j + (sy + 0.5) / S) / size;
          let c;
          if (rounded && !inRoundRect(u, v, rounded)) c = C.none;
          else c = paint(0.5 + (u - 0.5) / inset, 0.5 + (v - 0.5) / inset);
          const w = c[3] / 255;
          r += c[0] * w;
          g += c[1] * w;
          b += c[2] * w;
          a += w;
        }
      }
      const o = (j * size + i) * 4;
      px[o] = a ? Math.round(r / a) : 0;
      px[o + 1] = a ? Math.round(g / a) : 0;
      px[o + 2] = a ? Math.round(b / a) : 0;
      px[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return png(size, size, px);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); // filter 0 per row
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  const icons = {
    // iOS rounds the corners itself, so the Home Screen icon is full bleed.
    'apple-touch-icon.png': render(180),
    'icon-192.png': render(192, { rounded: 0.2 }),
    'icon-512.png': render(512, { rounded: 0.2 }),
    // Android crops maskable icons to its own shape: keep the picture in the middle 80%.
    'icon-maskable-512.png': render(512, { inset: 0.78 }),
  };
  for (const [name, data] of Object.entries(icons)) {
    writeFileSync(join(OUT, name), data);
    console.log(`icons/${name}  ${data.length} bytes`);
  }
}
