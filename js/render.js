// Drawing and game feel for Shove Off. The look: flat print-style colour with ink
// outlines, two wrestlers (coral with stripes, teal with dots) on a hex ice floe
// in dark water.
//
// The controllers (local.js, online.js) hand this a plain scene every frame:
//   { fighters: [{ x, y, ph, charge, pw, fx, fy, teeter, name, online, me }],
//     floe, sinkAt, elapsed, state, goIn, hints, foeOf }
// and call the event handlers (hit, clash, out, ...) at the moment the event is
// visibly happening on this screen. Everything here is presentation: nothing
// feeds back into the simulation.

import { PH, TUNING, K } from './game/sim.js';
import { sfx } from './audio.js';

// The canvas fills the stage at any shape (a 16:9 laptop stage, a phone held either
// way). The floe, plus room for a fighter flying off its edge, is this box in world
// units; it's scaled to fit whatever the HUD and the thumbs leave free (setView), so
// it's as big as it can be in portrait and landscape alike. On a 16:9 laptop stage
// that comes out at the original 1.1 px per unit.
const FLOE_W = 660;
const FLOE_H = 600;
const DESIGN_SCALE = 1.1; // px per world unit on the original 1280x720 stage: text and shake are sized against it
// Where the 3-2-1-GO goes: [x, y] offsets toward each player, and the turn toward them.
const COUNT_ONE = [[0, 0, 0]];
const COUNT_V = [
  [0, 1, 0], // the player at the bottom edge
  [0, -1, Math.PI], // the player at the top edge
];
const COUNT_H = [
  [-1, 0, Math.PI / 2], // the player at the left edge
  [1, 0, -Math.PI / 2], // the player at the right edge
];

export const C = {
  ink: '#16202e',
  water: '#1d5874',
  waterDeep: '#174a62',
  wave: 'rgba(214, 240, 248, 0.16)',
  ice: '#eef8fa',
  iceSide: '#86bccb',
  iceWarn: '#bcd5dc',
  iceCrack: '#3b5566',
  glow: '#ffd23f',
  white: '#ffffff',
  coral: '#ff6b57',
  coralDark: '#c4402c',
  teal: '#17a597',
  tealDark: '#0b6b61',
  star: '#ffe27a',
};
export const TEAM = [
  { name: 'Coral', body: C.coral, dark: C.coralDark },
  { name: 'Teal', body: C.teal, dark: C.tealDark },
];
const FONT = '"Rockwell", "Roboto Slab", "Museo Slab", "Georgia", serif';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - (1 - t) * (1 - t) * (1 - t);

// ---------------------------------------------------------------------------
// onFeel(kind, info): 'hit' { pw }, 'clash', 'full' { slot }, 'fall' { slot }, for
// haptics. Presentation only, like everything here.
export function createRenderer(canvas, { settings, onFeel = () => {} }) {
  let g = canvas.getContext('2d', { alpha: false });
  // The view: CSS size, pixel ratio (capped at 2: a 3x phone draws 2.25x fewer pixels
  // and still looks sharp), and the free area the floe is fitted into. Measured only in
  // the ResizeObserver callback and setView(), never in the frame loop.
  const view = { w: 0, h: 0, dpr: 1, insets: { top: 0, right: 0, bottom: 0, left: 0 }, split: null, s: DESIGN_SCALE, cx: 0, cy: 0, ts: DESIGN_SCALE, tcx: 0, tcy: 0, snap: true };
  function fit() {
    const { top, right, bottom, left } = view.insets;
    const aw = Math.max(80, view.w - left - right);
    const ah = Math.max(80, view.h - top - bottom);
    view.ts = Math.min(aw / FLOE_W, ah / FLOE_H);
    view.tcx = left + aw / 2;
    view.tcy = top + ah / 2;
  }
  function resize(cssW = canvas.clientWidth, cssH = canvas.clientHeight) {
    if (!cssW || !cssH) return;
    view.w = cssW;
    view.h = cssH;
    view.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const bw = Math.round(cssW * view.dpr);
    const bh = Math.round(cssH * view.dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    fit();
    view.snap = true;
  }
  const ro = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1].contentRect;
    resize(box.width, box.height);
  });
  ro.observe(canvas);
  resize();
  // A ResizeObserver doesn't fire when only the pixel ratio changes (a window dragged
  // to another monitor), so watch for that too.
  (function watchDpr() {
    if (typeof matchMedia !== 'function') return;
    matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`).addEventListener?.(
      'change',
      () => {
        resize();
        watchDpr();
      },
      { once: true },
    );
  })();

  const reduced = () => settings.reducedMotion();

  // ---- pooled particles and rings ----
  const parts = Array.from({ length: 260 }, () => ({ life: 0, max: 1, x: 0, y: 0, vx: 0, vy: 0, size: 4, kind: 0, color: C.white, rot: 0, vr: 0 }));
  const rings = Array.from({ length: 24 }, () => ({ life: 0, max: 1, x: 0, y: 0, r0: 0, r1: 0, color: C.white, width: 3 }));
  function spawn(kind, x, y, n, speed, color, size = 4, life = 0.5) {
    for (const p of parts) {
      if (n <= 0) break;
      if (p.life > 0) continue;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.75);
      Object.assign(p, { kind, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: size * (0.6 + Math.random() * 0.7), color, life, max: life, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12 });
      n--;
    }
  }
  function ring(x, y, r0, r1, color, life = 0.4, width = 3) {
    const r = rings.find((q) => q.life <= 0);
    if (r) Object.assign(r, { x, y, r0, r1, color, life, max: life, width });
  }

  // ---- shake, flashes, camera ----
  const shake = { t: 0, dur: 0, amp: 0 };
  const flashTimes = [];
  function addShake(amp, dur) {
    const k = settings.shake();
    if (reduced() || k <= 0) return;
    if (amp * k > shake.amp * (shake.t / (shake.dur || 1))) Object.assign(shake, { t: dur, dur, amp: amp * k });
  }
  // Never more than 3 big flashes a second, and only ever the fighter, not the screen.
  function canFlash(now) {
    while (flashTimes.length && flashTimes[0] < now - 1000) flashTimes.shift();
    if (flashTimes.length >= 3) return false;
    flashTimes.push(now);
    return true;
  }
  const cam = { x: 0, y: 0, zoom: 1, punch: 0, px: 0, py: 0 }; // zoom is on top of the view's fit
  let slowUntil = 0; // presentation slow-mo after a ring-out (fx time only)
  let pxPerUnitInv = 1; // world units per CSS pixel this frame (for minimum line widths)

  // ---- per-fighter looks ----
  const look = [0, 1].map(() => ({
    prevPh: -1,
    sx: 1,
    sy: 1,
    stretchDir: 0,
    stretchT: 0,
    flashUntil: 0,
    spin: 0,
    spinV: 0,
    trail: [],
    blinkAt: 0,
    blinkUntil: 0,
    fullDone: false,
    fallAt: 0,
    splashed: true,
    teeter: false,
    teeterSound: 0,
    bob: Math.random() * 6,
    frozenAt: 0,
  }));

  // ---- tiles ----
  let crackCache = null;
  function cracks(floe) {
    if (crackCache?.floe === floe) return crackCache.lines;
    const lines = floe.tiles.map((t, i) => {
      let a = Math.sin(i * 12.9898) * 43758.5453;
      const rnd = () => {
        a = Math.sin(a) * 10000;
        return a - Math.floor(a);
      };
      const pts = [[(rnd() - 0.5) * 10, (rnd() - 0.5) * 10]];
      const ang = rnd() * Math.PI * 2;
      for (let k = 1; k <= 3; k++) pts.push([Math.cos(ang + (rnd() - 0.5) * 0.9) * k * 10, Math.sin(ang + (rnd() - 0.5) * 0.9) * k * 10]);
      const branch = [pts[1], [pts[1][0] + Math.cos(ang + 1.6) * 12, pts[1][1] + Math.sin(ang + 1.6) * 12]];
      return { pts, branch };
    });
    crackCache = { floe, lines };
    return lines;
  }
  let hatch = null;
  function hatchPattern() {
    if (hatch) return hatch;
    const c = document.createElement('canvas');
    c.width = c.height = 10;
    const x = c.getContext('2d');
    x.strokeStyle = 'rgba(22,32,46,0.45)';
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(0, 10);
    x.lineTo(10, 0);
    x.stroke();
    hatch = g.createPattern(c, 'repeat');
    return hatch;
  }
  // Which tiles started warning or sinking since last frame (for their sounds).
  let lastElapsed = -1e9;
  let lastFloeKey = null;

  function hexPath(x, y, s) {
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const px = x + s * Math.cos(a);
      const py = y + s * Math.sin(a);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
  }

  // Waves over exactly the world area the canvas shows (any shape, any zoom).
  const seen = { x0: 0, y0: 0, x1: 0, y1: 0 };
  function drawWater(now) {
    g.strokeStyle = C.wave;
    g.lineWidth = 3;
    g.lineCap = 'round';
    const t = reduced() ? 0 : now / 1000;
    for (let row = Math.floor(seen.y0 / 36); row <= Math.ceil(seen.y1 / 36) + 1; row++) {
      const y = row * 36;
      const off = ((((row & 1) * 40 + t * (row & 1 ? 14 : -10)) % 80) + 80) % 80;
      g.beginPath();
      for (let x = Math.floor((seen.x0 - 80) / 80) * 80 + off; x < seen.x1 + 40; x += 80) {
        g.moveTo(x, y);
        g.quadraticCurveTo(x + 12, y - 6, x + 24, y);
      }
      g.stroke();
    }
  }

  function drawFloe(scene, now) {
    const { floe, sinkAt, elapsed } = scene;
    if (!floe) return;
    const s = floe.size - 1.2;
    const lines = cracks(floe);
    const warn = K.warn;
    const sinkTicks = 0.6 * TUNING.tickHz;
    const rm = reduced();
    // Sounds when a group starts to crack or goes under (once per group).
    if (scene.floeKey !== lastFloeKey) {
      lastFloeKey = scene.floeKey;
      lastElapsed = elapsed;
    }
    let cracked = 0;
    let sank = 0;
    for (let i = 0; i < floe.tiles.length; i++) {
      const at = sinkAt[i];
      if (lastElapsed < at - warn && elapsed >= at - warn && elapsed < at) cracked++;
      if (lastElapsed < at && elapsed >= at) {
        sank++;
        const t = floe.tiles[i];
        if (sank <= 6) ring(t.x, t.y, 8, 46, 'rgba(214,240,248,0.7)', 0.7, 2.5);
        if (Math.random() < 0.5) spawn(2, t.x, t.y, 2, 60, C.ice, 4, 0.5);
      }
    }
    if (cracked && elapsed > 0) sfx.crack();
    if (sank && elapsed > 0) sfx.sink();
    lastElapsed = elapsed;

    // Sides first (the ice has thickness), then faces, so neighbours overlap cleanly.
    for (const pass of [0, 1]) {
      for (let i = 0; i < floe.tiles.length; i++) {
        const t = floe.tiles[i];
        const at = sinkAt[i];
        if (elapsed >= at + sinkTicks) continue;
        let x = t.x;
        let y = t.y;
        let sc = 1;
        let alpha = 1;
        let rot = 0;
        let warnK = 0;
        if (elapsed >= at) {
          const p = clamp((elapsed - at) / sinkTicks, 0, 1);
          sc = 1 - 0.45 * p;
          y += 16 * p;
          alpha = 1 - p;
          rot = rm ? 0 : 0.35 * p * (i % 2 ? 1 : -1);
        } else if (elapsed >= at - warn) {
          warnK = clamp((elapsed - (at - warn)) / warn, 0, 1);
          if (!rm) rot = Math.sin(now / 38 + i) * 0.05 * warnK;
        }
        g.save();
        g.globalAlpha = alpha;
        g.translate(x, y);
        g.rotate(rot);
        g.scale(sc, sc);
        if (pass === 0) {
          hexPath(0, 7, s);
          g.fillStyle = elapsed >= at ? C.waterDeep : C.iceSide;
          g.fill();
          g.lineWidth = 2.5;
          g.strokeStyle = C.ink;
          g.stroke();
        } else {
          hexPath(0, 0, s);
          g.fillStyle = warnK > 0 ? mix(C.ice, C.iceWarn, warnK) : elapsed >= at ? mix(C.iceWarn, C.water, (elapsed - at) / sinkTicks) : C.ice;
          g.fill();
          if (warnK > 0 && rm) {
            g.fillStyle = hatchPattern();
            g.fill();
          }
          g.lineWidth = 2.5;
          g.strokeStyle = C.ink;
          g.stroke();
          // A highlight on the top-left facets.
          if (warnK === 0 && elapsed < at) {
            g.strokeStyle = 'rgba(255,255,255,0.9)';
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(-s * 0.62, -s * 0.2);
            g.lineTo(-s * 0.2, -s * 0.55);
            g.stroke();
          }
          if (warnK > 0 || elapsed >= at) {
            const L = lines[i];
            const k = elapsed >= at ? 1 : warnK;
            g.strokeStyle = C.iceCrack;
            g.lineWidth = 1.6;
            g.beginPath();
            const n = Math.max(1, Math.ceil(k * 3));
            g.moveTo(L.pts[0][0], L.pts[0][1]);
            for (let j = 1; j <= n; j++) g.lineTo(L.pts[j][0], L.pts[j][1]);
            if (k > 0.5) {
              g.moveTo(L.branch[0][0], L.branch[0][1]);
              g.lineTo(L.branch[1][0], L.branch[1][1]);
            }
            g.stroke();
          }
        }
        g.restore();
      }
    }
  }

  function mix(a, b, t) {
    t = clamp(t, 0, 1);
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    const gg = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return `rgb(${r},${gg},${bl})`;
  }

  // Glow the edge of the ice nearest a teetering fighter.
  function drawEdgeGlow(scene, f) {
    const { floe, sinkAt, elapsed } = scene;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < floe.tiles.length; i++) {
      if (elapsed >= sinkAt[i]) continue;
      const t = floe.tiles[i];
      const d = (t.x - f.x) ** 2 + (t.y - f.y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return;
    const t = floe.tiles[best];
    g.save();
    hexPath(t.x, t.y, floe.size - 1);
    g.strokeStyle = C.glow;
    g.lineWidth = 6;
    g.globalAlpha = 0.85;
    g.stroke();
    g.restore();
  }

  // ---- fighters ----
  function drawFighter(f, slot, L, now, foe, small = false) {
    const team = TEAM[slot];
    const R = TUNING.radius;
    const rm = reduced();
    let { x, y } = f;
    let scale = 1;
    let alpha = f.online === false ? 0.45 : 1;
    let sink = 0;
    // Falling: tumble, shrink and go under.
    if (f.ph === PH.FALL && L.fallAt) {
      const slow = !rm ? 0.4 : 1;
      const p = clamp(((now - L.fallAt) / 700) * (now < slowUntil ? slow : 1), 0, 1);
      scale = 1 - ease(p) * 0.85;
      sink = p * 18;
      alpha *= 1 - p * 0.6;
      if (p >= 1) return;
    }
    const frozen = f.ph === PH.FROZEN;
    if (frozen && !rm) {
      x += (Math.random() - 0.5) * 3;
      y += (Math.random() - 0.5) * 3;
    }
    if (f.ph === PH.CHARGE && !rm) {
      x += (Math.random() - 0.5) * 2.4 * f.charge;
      y += (Math.random() - 0.5) * 2.4 * f.charge;
    }
    // Shadow
    g.save();
    g.globalAlpha = 0.22 * alpha;
    g.fillStyle = C.ink;
    g.beginPath();
    g.ellipse(x, y + R * 0.75 + sink, R * 1.05 * scale, R * 0.45 * scale, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // Charge ring: the tell. On a small phone screen a world unit is barely half a
    // pixel, so the ring keeps a minimum thickness in screen pixels, and starts brighter.
    if (f.ph === PH.CHARGE) {
      const c = f.charge;
      const full = c >= 0.999;
      const pulse = full && !rm ? 0.5 + 0.5 * Math.sin(now / 45) : 1;
      g.save();
      g.globalAlpha = (0.45 + 0.5 * c) * (full ? 0.6 + 0.4 * pulse : 1);
      g.strokeStyle = C.glow;
      g.lineWidth = Math.max(3 + 5 * c, (2.5 + 4 * c) * pxPerUnitInv);
      g.beginPath();
      g.arc(x, y, R + 8 + 22 * c, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.9;
      g.strokeStyle = C.ink;
      g.lineWidth = 2;
      // A wedge showing where the dash will go.
      const a = Math.atan2(f.fy, f.fx);
      g.beginPath();
      g.arc(x, y, R + 8 + 22 * c, a - 0.28, a + 0.28);
      g.stroke();
      g.restore();
    }

    // Recovering from a dash (endlag): off balance, with skid marks behind. It's the
    // opening a careful player punishes, so it has to be readable: static marks, so
    // they show under reduced motion too.
    if (f.ph === PH.ENDLAG && !small) {
      const a = Math.atan2(f.fy, f.fx);
      g.save();
      g.globalAlpha = 0.55 * alpha;
      g.strokeStyle = C.iceSide;
      g.lineWidth = 3;
      g.lineCap = 'round';
      for (const k of [-1, 0, 1]) {
        const ox = x - Math.cos(a) * (R + 6) + Math.cos(a + Math.PI / 2) * k * 11;
        const oy = y - Math.sin(a) * (R + 6) + Math.sin(a + Math.PI / 2) * k * 11 + R * 0.5;
        g.beginPath();
        g.moveTo(ox, oy);
        g.lineTo(ox - Math.cos(a) * (12 - Math.abs(k) * 4), oy - Math.sin(a) * (12 - Math.abs(k) * 4));
        g.stroke();
      }
      g.restore();
    }

    // Afterimages while dashing.
    if (!rm) {
      for (let i = 0; i < L.trail.length; i++) {
        const t = L.trail[i];
        g.save();
        g.globalAlpha = 0.18 * (i + 1) * alpha;
        g.fillStyle = team.body;
        g.beginPath();
        g.arc(t.x, t.y, R * 0.92, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    }

    // Body, squashed and stretched along the dash.
    g.save();
    g.globalAlpha = alpha;
    g.translate(x, y + sink);
    const dir = Math.atan2(f.fy, f.fx);
    let sx = L.sx;
    let sy = L.sy;
    if (!rm && f.ph === PH.IDLE) sy *= 1 + 0.03 * Math.sin(now / 260 + L.bob);
    if (f.ph === PH.CHARGE) {
      sx *= 1 + 0.12 * f.charge;
      sy *= 1 - 0.14 * f.charge;
    } else if (f.ph === PH.ENDLAG) {
      sx *= 1.06; // a slump, held for the whole recovery
      sy *= 0.92;
    }
    g.rotate(L.stretchDir);
    g.scale(sx * scale, sy * scale);
    g.rotate(-L.stretchDir);
    const spin = L.spin;
    const flashing = now < L.flashUntil;

    // Hands (behind the body edge): pulled back while charging, forward on a dash,
    // flailing on the edge.
    let spread = 1.15;
    if (f.ph === PH.CHARGE) spread = 1.9;
    else if (f.ph === PH.DASH) spread = 0.55;
    else if (f.ph === PH.ENDLAG) spread = 2.5; // arms flung back: off balance
    else if (f.teeter) spread = 1.15 + (rm ? 0.4 : Math.sin(now / 40) * 0.6);
    for (const side of [-1, 1]) {
      const a = dir + side * spread + (f.teeter && !rm ? side * Math.sin(now / 33 + side) * 0.5 : 0);
      g.beginPath();
      g.arc(Math.cos(a) * (R + 3), Math.sin(a) * (R + 3), 6.5, 0, Math.PI * 2);
      g.fillStyle = flashing ? C.white : team.body;
      g.fill();
      g.lineWidth = 2.5;
      g.strokeStyle = C.ink;
      g.stroke();
    }

    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fillStyle = flashing ? C.white : team.body;
    g.fill();
    if (!flashing) {
      g.save();
      g.clip();
      g.rotate(spin);
      g.fillStyle = team.dark;
      if (slot === 0) {
        for (let k = -2; k <= 2; k++) {
          g.save();
          g.rotate(-0.6);
          g.fillRect(k * 12 - 3, -R - 2, 6, R * 2 + 4);
          g.restore();
        }
      } else {
        for (const [dx, dy] of [
          [-9, -9],
          [9, -8],
          [0, 2],
          [-10, 10],
          [10, 11],
          [0, -17],
          [-17, 1],
          [17, 2],
        ]) {
          g.beginPath();
          g.arc(dx, dy, 3.6, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.restore();
    }
    g.lineWidth = 3;
    g.strokeStyle = C.ink;
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.stroke();

    // Eyes look at the other fighter; they blink now and then.
    const look = foe ? Math.atan2(foe.y - f.y, foe.x - f.x) : dir;
    const blink = now < L.blinkUntil || f.ph === PH.STUN;
    for (const side of [-1, 1]) {
      const ex = Math.cos(dir + side * 0.55) * R * 0.5;
      const ey = Math.sin(dir + side * 0.55) * R * 0.5;
      g.beginPath();
      g.ellipse(ex, ey, 5.6, blink ? 1.2 : 6.6, dir, 0, Math.PI * 2);
      g.fillStyle = C.white;
      g.fill();
      g.lineWidth = 1.8;
      g.strokeStyle = C.ink;
      g.stroke();
      if (!blink) {
        g.beginPath();
        g.arc(ex + Math.cos(look) * 2.4, ey + Math.sin(look) * 2.4, f.ph === PH.FROZEN ? 1.6 : 2.7, 0, Math.PI * 2);
        g.fillStyle = C.ink;
        g.fill();
      }
    }
    g.restore();

    // Badge: the player number, so colour isn't the only difference.
    if (!small && scale > 0.6) {
      const bx = x - Math.cos(dir) * (R - 2);
      const by = y - Math.sin(dir) * (R - 2) + sink;
      g.save();
      g.globalAlpha = alpha;
      g.beginPath();
      g.arc(bx, by, 9, 0, Math.PI * 2);
      g.fillStyle = C.white;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = C.ink;
      g.stroke();
      g.fillStyle = C.ink;
      g.font = `800 12px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(slot + 1), bx, by + 0.5);
      g.restore();
    }
  }

  function drawParticles(dt) {
    for (const p of parts) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = Math.exp(-5 * dt);
      p.vx *= drag;
      p.vy *= drag;
      if (p.kind === 3) p.vy += 300 * dt; // droplets fall
      p.rot += p.vr * dt;
      const k = clamp(p.life / p.max, 0, 1);
      g.save();
      g.globalAlpha = Math.min(1, k * 1.6);
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      if (p.kind === 1) {
        // A four-point star with an ink edge.
        const s = p.size * (0.6 + 0.4 * k);
        g.beginPath();
        for (let i = 0; i < 8; i++) {
          const r = i % 2 ? s * 0.38 : s;
          const a = (i * Math.PI) / 4;
          g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        g.closePath();
        g.fillStyle = p.color;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = C.ink;
        g.stroke();
      } else if (p.kind === 2) {
        g.fillStyle = p.color;
        g.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        g.lineWidth = 1.2;
        g.strokeStyle = C.ink;
        g.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size);
      } else {
        g.beginPath();
        g.arc(0, 0, p.size * (0.5 + 0.5 * k), 0, Math.PI * 2);
        g.fillStyle = p.color;
        g.fill();
      }
      g.restore();
    }
    for (const r of rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const k = 1 - clamp(r.life / r.max, 0, 1);
      g.save();
      g.globalAlpha = 1 - k;
      g.strokeStyle = r.color;
      g.lineWidth = r.width * (1 - k * 0.6);
      g.beginPath();
      g.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * ease(k), 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
  }

  // ---- transitions -> feel (runs once per drawn frame) ----
  function react(scene, now, dt) {
    for (let slot = 0; slot < 2; slot++) {
      const f = scene.fighters[slot];
      const L = look[slot];
      if (!f) {
        if (L.prevPh === PH.CHARGE) sfx.humStop(slot);
        L.prevPh = -1;
        continue;
      }
      const was = L.prevPh;
      if (f.ph !== was) {
        if (was === PH.CHARGE) sfx.humStop(slot);
        if (f.ph === PH.CHARGE) {
          sfx.humStart(slot);
          L.fullDone = false;
        }
        if (f.ph === PH.DASH) {
          // Launch: stretch along the dash, a dust puff, the whoosh.
          L.stretchDir = Math.atan2(f.fy, f.fx);
          L.stretchT = 0.12;
          spawn(0, f.x - f.fx * 18, f.y - f.fy * 18, 6 + Math.round(f.pw * 6), 90, 'rgba(238,248,250,0.85)', 7, 0.45);
          sfx.dash(f.pw);
        }
        if (f.ph === PH.STUN && was === PH.FROZEN) {
          // Launched by a hit: squash and spin.
          L.sx = 1.25;
          L.sy = 0.78;
          L.spinV = 14 * (Math.random() < 0.5 ? -1 : 1);
        }
        if (f.ph === PH.FALL) {
          L.fallAt = now;
          L.splashed = false;
          L.spinV = 10;
          sfx.slide();
          onFeel('fall', { slot });
          if (!reduced()) {
            slowUntil = now + 900;
            cam.punch = 1;
            cam.px = f.x;
            cam.py = f.y;
          }
        }
        if (was === PH.FALL || f.ph !== PH.FALL) L.fallAt = f.ph === PH.FALL ? L.fallAt : 0;
        L.prevPh = f.ph;
      }
      if (f.ph === PH.CHARGE) {
        sfx.humLevel(slot, f.charge);
        if (f.charge >= 0.999 && !L.fullDone) {
          L.fullDone = true;
          sfx.full();
          onFeel('full', { slot });
          ring(f.x, f.y, TUNING.radius + 10, TUNING.radius + 44, C.glow, 0.35, 5);
        }
      }
      if (f.ph === PH.FALL && L.fallAt && !L.splashed && now - L.fallAt > (now < slowUntil ? 900 : 550)) {
        L.splashed = true;
        sfx.splash();
        ring(f.x, f.y + 10, 10, 90, 'rgba(230,246,250,0.95)', 0.8, 5);
        ring(f.x, f.y + 10, 6, 55, 'rgba(230,246,250,0.7)', 0.6, 3);
        spawn(3, f.x, f.y, 22, 260, 'rgba(225,243,248,0.95)', 6, 0.8);
      }
      // Teeter: a creak when it starts.
      if (f.teeter && !L.teeter && now - L.teeterSound > 400 && f.ph !== PH.FALL) {
        L.teeterSound = now;
        sfx.teeter();
      }
      L.teeter = !!f.teeter;
      // Trail of three afterimages while dashing.
      if (f.ph === PH.DASH) {
        L.trail.push({ x: f.x, y: f.y });
        if (L.trail.length > 3) L.trail.shift();
      } else if (L.trail.length) L.trail.shift();
      // Ease squash and stretch back to round.
      if (L.stretchT > 0) {
        L.stretchT -= dt;
        const k = clamp(L.stretchT / 0.12, 0, 1);
        L.sx = 1 + 0.3 * k;
        L.sy = 1 - 0.25 * k;
      } else {
        const k = Math.exp(-14 * dt);
        L.sx = 1 + (L.sx - 1) * k;
        L.sy = 1 + (L.sy - 1) * k;
      }
      L.spin += L.spinV * dt;
      L.spinV *= Math.exp(-3 * dt);
      if (Math.abs(L.spinV) < 0.2) L.spin *= Math.exp(-6 * dt);
      if (now > L.blinkAt) {
        L.blinkUntil = now + 110;
        L.blinkAt = now + 1800 + Math.random() * 3200;
      }
    }
  }

  // ---- countdown ----
  let lastCount = null;
  function drawCountdown(scene, now) {
    const goIn = scene.goIn;
    let label = null;
    let k = 0;
    if (scene.state === 'cd' && goIn > 0) {
      const n = Math.ceil(goIn / (TUNING.countdownMs / 3));
      label = String(Math.min(3, n));
      k = 1 - ((goIn % (TUNING.countdownMs / 3)) / (TUNING.countdownMs / 3) || 1);
    } else if (goIn > -550 && goIn <= 0 && (scene.state === 'fight' || scene.state === 'cd')) {
      label = 'GO!';
      k = -goIn / 550;
    }
    if (label !== lastCount) {
      if (label === 'GO!') sfx.go();
      else if (label) sfx.beep();
      lastCount = label;
    }
    if (!label) return;
    const rm = reduced();
    const pop = rm ? 1 : 1 + 0.6 * Math.max(0, 1 - k * 5);
    const u = view.s / DESIGN_SCALE; // design px -> CSS px, so the count scales with the floe
    // Two players sharing one screen from opposite ends each get a copy turned toward them.
    const dy = FLOE_H * view.s * 0.24;
    const dx = FLOE_W * view.s * 0.24;
    const spots = view.split === 'v' ? COUNT_V : view.split === 'h' ? COUNT_H : COUNT_ONE;
    for (const [ox, oy, rot] of spots) {
      g.save();
      g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      // One player: above the fighters (they spawn on the centre line), so GO never
      // covers them at the moment play starts. Shared screens: toward each player.
      g.translate(view.cx + ox * dx, view.cy + oy * dy - (view.split ? 0 : 135 * view.s));
      g.rotate(rot);
      g.scale(pop * u * (view.split ? 0.62 : 1), pop * u * (view.split ? 0.62 : 1));
      g.globalAlpha = label === 'GO!' ? 1 - k * k : 1;
      g.font = `900 ${label === 'GO!' ? 150 : 170}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = 16;
      g.strokeStyle = C.ink;
      g.strokeText(label, 0, 0);
      g.fillStyle = label === 'GO!' ? C.glow : C.white;
      g.fillText(label, 0, 0);
      g.restore();
    }
  }

  // Text drawn in the world stays readable on a small phone: never under ~12 CSS px.
  const textSize = (n, minPx) => Math.max(n, minPx / view.s);
  function drawHints(scene) {
    if (!scene.hints) return;
    for (let slot = 0; slot < 2; slot++) {
      const f = scene.fighters[slot];
      const text = scene.hints[slot];
      if (!f || !text || f.ph === PH.FALL) continue;
      const fs = textSize(15, 12.5);
      const k = fs / 15;
      g.save();
      g.font = `700 ${fs}px ${FONT}`;
      g.textAlign = 'center';
      const w = g.measureText(text).width + 18 * k;
      const y = f.y + TUNING.radius + 14 + 12 * k;
      // Keep the pill on screen on a narrow window (the fighter may be near the edge).
      const lo = seen.x0 + w / 2 + 4;
      const hi = seen.x1 - w / 2 - 4;
      const x = lo < hi ? clamp(f.x, lo, hi) : (seen.x0 + seen.x1) / 2;
      g.fillStyle = 'rgba(22,32,46,0.85)';
      roundRect(x - w / 2, y - 13 * k, w, 26 * k, 13 * k);
      g.fill();
      g.fillStyle = C.white;
      g.textBaseline = 'middle';
      g.fillText(text, x, y + k);
      g.restore();
    }
  }
  function drawTags(scene) {
    for (let slot = 0; slot < 2; slot++) {
      const f = scene.fighters[slot];
      if (!f || f.ph === PH.FALL || (!f.me && f.online !== false)) continue;
      const text = f.online === false ? 'reconnecting…' : 'you';
      const fs = textSize(13, 11);
      g.save();
      g.font = `800 ${fs}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 4 * (fs / 13);
      g.strokeStyle = C.ink;
      const y = f.y - TUNING.radius - 8 - 12 * (fs / 13);
      g.strokeText(text.toUpperCase(), f.x, y);
      g.fillStyle = C.white;
      g.fillText(text.toUpperCase(), f.x, y);
      g.restore();
    }
  }
  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ---- the camera: eases toward what's left of the floe ----
  function updateCamera(scene, dt) {
    let tx = 0;
    let ty = 0;
    let tz = 1;
    if (scene.floe && scene.state !== 'end') {
      let n = 0;
      let sx = 0;
      let sy = 0;
      let far = 0;
      for (let i = 0; i < scene.floe.tiles.length; i++) {
        if (scene.elapsed >= scene.sinkAt[i]) continue;
        const t = scene.floe.tiles[i];
        sx += t.x;
        sy += t.y;
        n++;
      }
      if (n) {
        tx = (sx / n) * 0.5;
        ty = (sy / n) * 0.5;
        for (let i = 0; i < scene.floe.tiles.length; i++) {
          if (scene.elapsed >= scene.sinkAt[i]) continue;
          const t = scene.floe.tiles[i];
          far = Math.max(far, Math.hypot(t.x - tx, t.y - ty));
        }
        tz = clamp(330 / (far + 40), 1, 1.4);
      }
    }
    if (reduced()) tz = 1;
    const k = 1 - Math.exp(-1.5 * dt);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    cam.zoom += (tz - cam.zoom) * k;
    cam.punch *= Math.exp(-2.2 * dt);
  }

  let lastNow = 0;
  const api = {
    draw(scene, now) {
      const dtReal = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 0;
      lastNow = now;
      const fxScale = now < slowUntil && !reduced() ? 0.4 : 1;
      const dt = dtReal * fxScale;
      react(scene, now, dtReal);
      updateCamera(scene, dtReal);
      // The floe glides to its new spot when the free area changes (touch controls
      // shown or hidden); under reduced motion, or after a resize, it just moves.
      if (view.snap || reduced()) {
        view.s = view.ts;
        view.cx = view.tcx;
        view.cy = view.tcy;
        view.snap = false;
      } else {
        const k = 1 - Math.exp(-8 * dtReal);
        view.s += (view.ts - view.s) * k;
        view.cx += (view.tcx - view.cx) * k;
        view.cy += (view.tcy - view.cy) * k;
      }
      const u = view.s / DESIGN_SCALE;
      let shx = 0;
      let shy = 0;
      if (shake.t > 0) {
        shake.t -= dtReal;
        const k = clamp(shake.t / shake.dur, 0, 1);
        shx = (Math.random() * 2 - 1) * shake.amp * k * u;
        shy = (Math.random() * 2 - 1) * shake.amp * k * u;
      }
      const z = cam.zoom * (1 + 0.08 * cam.punch);
      const cx = cam.x + (cam.px - cam.x) * cam.punch * 0.3;
      const cy = cam.y + (cam.py - cam.y) * cam.punch * 0.3;
      const S = view.s * z;
      pxPerUnitInv = 1 / Math.max(0.1, S);
      const ox = view.cx + shx;
      const oy = view.cy + shy;
      g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      g.fillStyle = C.water;
      g.fillRect(0, 0, view.w, view.h);
      g.translate(ox, oy);
      g.scale(S, S);
      g.translate(-cx, -cy);
      seen.x0 = cx - ox / S;
      seen.x1 = cx + (view.w - ox) / S;
      seen.y0 = cy - oy / S;
      seen.y1 = cy + (view.h - oy) / S;
      drawWater(now);
      drawFloe(scene, now);
      for (let slot = 0; slot < 2; slot++) {
        const f = scene.fighters[slot];
        if (f?.teeter && f.ph !== PH.FALL) drawEdgeGlow(scene, f);
      }
      // Draw the lower fighter last, so overlaps read as depth.
      const order = [0, 1].filter((s) => scene.fighters[s]).sort((a, b) => scene.fighters[a].y - scene.fighters[b].y);
      for (const s of order) drawFighter(scene.fighters[s], s, look[s], now, scene.fighters[1 - s]);
      drawParticles(dt);
      drawHints(scene);
      drawTags(scene);
      drawCountdown(scene, now);
    },
    // ---- events, called when they visibly happen on this screen ----
    hit(ev, now) {
      const big = ev.big || ev.pw >= TUNING.bigPower;
      if (canFlash(now)) look[ev.who].flashUntil = now + 80;
      spawn(1, ev.x, ev.y, 8 + Math.round(ev.pw * 14), 240 + ev.pw * 260, C.star, 9 + ev.pw * 6, 0.45 + ev.pw * 0.2);
      spawn(0, ev.x, ev.y, 6, 140, 'rgba(255,255,255,0.9)', 6, 0.3);
      ring(ev.x, ev.y, 10, 40 + 50 * ev.pw, C.white, 0.25, 4);
      addShake(2 + 10 * ev.pw + (big ? 3 : 0), 0.15 + 0.15 * ev.pw);
      sfx.bonk(ev.pw);
      onFeel('hit', { pw: ev.pw, who: ev.who });
    },
    // Sized by the dashes: two jabs bumping is a tink and a few sparks; the full spark,
    // ring and sound are kept for two dashes at least half charged. Shake is a budget:
    // none for jab on jab, up to 14 at full power.
    clash(ev, now) {
      const pw = Number.isFinite(ev.pw) ? ev.pw : 1;
      const both = Number.isFinite(ev.both) ? ev.both : pw;
      if (both >= 0.5) {
        spawn(1, ev.x, ev.y, 18, 420, C.glow, 12, 0.55);
        spawn(2, ev.x, ev.y, 10, 300, C.white, 5, 0.5);
        ring(ev.x, ev.y, 12, 110, C.glow, 0.4, 6);
        ring(ev.x, ev.y, 6, 70, C.white, 0.3, 3);
        sfx.clash();
        onFeel('clash', {});
      } else if (pw >= 0.15) {
        spawn(1, ev.x, ev.y, 8 + Math.round(pw * 10), 260 + pw * 160, C.glow, 8 + pw * 4, 0.4);
        ring(ev.x, ev.y, 10, 40 + 60 * pw, C.glow, 0.3, 4);
        sfx.clash();
        onFeel('hit', { pw });
      } else {
        spawn(2, ev.x, ev.y, 5, 160, C.white, 4, 0.25);
        sfx.tink();
      }
      if (pw > 0) addShake(14 * pw, 0.12 + 0.18 * pw);
      void now;
    },
    // The free area for the floe, in CSS px from each edge (HUD, thumbs, notch), and
    // whether two players share the screen from opposite ends ('v' top and bottom,
    // 'h' left and right). Called on resize and when the controls change, not per frame.
    setView({ insets, split = null } = {}) {
      if (insets) view.insets = { top: insets.top || 0, right: insets.right || 0, bottom: insets.bottom || 0, left: insets.left || 0 };
      view.split = split;
      fit();
    },
    // Where the floe's centre is on screen and how big a world unit is (tests, debug).
    get view() {
      return { w: view.w, h: view.h, dpr: view.dpr, scale: view.ts, cx: view.tcx, cy: view.tcy, backing: [canvas.width, canvas.height] };
    },
    save(slot) {
      const f = look[slot];
      void f;
      sfx.save();
    },
    reset() {
      for (const L of look) {
        L.trail.length = 0;
        L.fallAt = 0;
        L.sx = L.sy = 1;
        L.spin = L.spinV = 0;
        L.prevPh = -1;
      }
      for (const p of parts) p.life = 0;
      for (const r of rings) r.life = 0;
      shake.t = 0;
      slowUntil = 0;
      lastCount = null;
    },
    resize,
    // The title's three-frame picture: charge, launch, flying.
    drawStrip(strip, now) {
      const x = strip.getContext('2d');
      const sw = strip.width;
      const sh = strip.height;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.fillStyle = C.water;
      x.fillRect(0, 0, sw, sh);
      const panel = sw / 3;
      const active = reduced() ? -1 : Math.floor(now / 700) % 3;
      const saved = g;
      for (let i = 0; i < 3; i++) {
        x.save();
        x.translate(panel * i, 0);
        x.beginPath();
        x.rect(4, 4, panel - 8, sh - 8);
        x.clip();
        x.fillStyle = C.ice;
        x.fillRect(4, sh * 0.55, panel - 8, sh);
        x.strokeStyle = C.ink;
        x.lineWidth = 3;
        x.strokeRect(4, 4, panel - 8, sh - 8);
        x.restore();
      }
      void saved;
      // Reuse drawFighter by pointing it at the strip's context.
      const real = g;
      const realPx = pxPerUnitInv;
      pxPerUnitInv = 1;
      ctxSwap(x);
      const scale = sh / 150;
      const frames = [
        [
          { x: 50, y: 82, ph: PH.CHARGE, charge: 0.8, fx: 1, fy: 0 },
          { x: 128, y: 82, ph: PH.IDLE, charge: 0, fx: -1, fy: 0 },
        ],
        [
          { x: 88, y: 82, ph: PH.DASH, charge: 0, pw: 1, fx: 1, fy: 0 },
          { x: 132, y: 82, ph: PH.IDLE, charge: 0, fx: -1, fy: 0 },
        ],
        [
          { x: 70, y: 82, ph: PH.ENDLAG, charge: 0, fx: 1, fy: 0 },
          { x: 150, y: 60, ph: PH.STUN, charge: 0, fx: -1, fy: 0 },
        ],
      ];
      for (let i = 0; i < 3; i++) {
        g.save();
        g.translate(panel * i, 0);
        g.scale(scale, scale);
        g.globalAlpha = active === -1 || active === i ? 1 : 0.45;
        const [a, b] = frames[i];
        const La = { ...look[0], sx: i === 1 ? 1.3 : 1, sy: i === 1 ? 0.75 : 1, stretchDir: 0, trail: i === 1 ? [{ x: 40, y: 82 }, { x: 56, y: 82 }, { x: 72, y: 82 }] : [], spin: 0, flashUntil: 0, blinkUntil: 0 };
        const Lb = { ...look[1], sx: i === 2 ? 1.2 : 1, sy: i === 2 ? 0.8 : 1, stretchDir: 0, trail: [], spin: i === 2 ? 0.6 : 0, flashUntil: i === 1 ? Infinity : 0, blinkUntil: i === 2 ? Infinity : 0 };
        drawFighter(a, 0, La, now, b, true);
        drawFighter(b, 1, Lb, now, a, true);
        if (i === 1) {
          g.fillStyle = C.star;
          g.strokeStyle = C.ink;
          g.lineWidth = 1.5;
          for (const [sx, sy, s] of [
            [112, 62, 9],
            [118, 100, 7],
            [104, 82, 6],
          ]) {
            g.beginPath();
            for (let k = 0; k < 8; k++) {
              const r = k % 2 ? s * 0.38 : s;
              const a2 = (k * Math.PI) / 4;
              g.lineTo(sx + Math.cos(a2) * r, sy + Math.sin(a2) * r);
            }
            g.closePath();
            g.fill();
            g.stroke();
          }
        }
        g.restore();
      }
      ctxSwap(real);
      pxPerUnitInv = realPx;
    },
  };
  // drawFighter reads `g`; the strip borrows it for a moment.
  function ctxSwap(next) {
    g = next;
  }
  return api;
}
