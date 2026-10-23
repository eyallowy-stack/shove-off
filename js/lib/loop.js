// Fixed-timestep loop with render interpolation (Glenn Fiedler, "Fix Your
// Timestep!"). The simulation always advances in equal steps, so a slow frame
// never changes how far anything moves. render() receives alpha, how far the
// clock has got between the last step and the next one, and draws
// prev + (curr - prev) * alpha, which keeps motion smooth on 60, 90, 120 and
// 144 Hz displays alike.

import { track } from './live.js';

export function createLoop({
  update, // update(step): advance the simulation by exactly one step
  render, // render(alpha, frameDt): draw only; never change game state here
  hz = 120,
  maxSteps = 8, // catch-up cap per frame; 8 steps at 120 Hz covers a 15 fps frame
  maxFrame = 0.25, // a longer frame (debugger pause, GC, tab switch) is clamped
  maxFps = 0, // 0 draws every display frame; 60 draws every 2nd frame at 120 Hz, every frame at 90
  signal,
} = {}) {
  const step = 1 / hz;
  let acc = 0;
  let last = null; // null: the next frame counts as dt = 0
  // Frame skipping by a whole-number divisor of the measured display rate, never by a
  // time threshold: a threshold against "time since the last draw" halves a 90 Hz phone
  // to 45 fps. The median of recent raw frame times sets the divisor: 60 Hz draws
  // every frame, 90 Hz every frame, 120 Hz every 2nd (60), 144 Hz every 2nd (72).
  const recentDt = new Float32Array(31);
  let dtN = 0;
  let dtI = 0;
  let divisor = 1;
  let frameNo = 0;
  const scratch = new Float32Array(31);
  function measureDivisor() {
    if (dtN < 10) return;
    scratch.set(recentDt);
    const s = scratch.subarray(0, dtN).sort();
    const median = s[dtN >> 1];
    if (median > 0) divisor = Math.max(1, Math.floor((1000 / maxFps) / median + 0.1));
  }
  let raf = 0;
  let running = false;
  let untrack = null;
  let timeScale = 1; // game speed: 0.5 is an assist mode, 0 stops the sim
  let freezeLeft = 0; // hitstop, counted in real seconds while rendering continues
  const times = new Float32Array(240); // recent frame times in ms, for frameStats()
  let ti = 0;
  let tn = 0;

  function tick(t) {
    const raw = last === null ? 0 : (t - last) / 1000;
    last = t;
    let dt = raw > 0 ? Math.min(raw, maxFrame) : 0;
    if (dt > 0) {
      times[ti] = dt * 1000;
      ti = (ti + 1) % times.length;
      if (tn < times.length) tn++;
      if (maxFps > 0) {
        recentDt[dtI] = raw * 1000;
        dtI = (dtI + 1) % recentDt.length;
        if (dtN < recentDt.length) dtN++;
        if (dtN === 10 || dtI === 0) measureDivisor(); // early, then every 31 frames
      }
    }
    if (freezeLeft > 0) {
      const used = Math.min(freezeLeft, dt);
      freezeLeft -= used;
      dt -= used;
    }
    acc += dt * timeScale;
    let n = 0;
    while (acc >= step && n < maxSteps) {
      update(step);
      acc -= step;
      n++;
    }
    // Hit the cap: the machine can't keep up, so drop whole steps rather than
    // spiral, but keep the fraction so interpolation doesn't hitch.
    if (acc >= step) acc %= step;
    if (render && (maxFps <= 0 || frameNo++ % divisor === 0)) render(acc / step, raw);
    return n;
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    tick(t);
  }

  // rAF stops in hidden tabs. Without this the first frame back would be one
  // huge (clamped) step; the game decides separately whether to pause.
  function onVisibility() {
    if (document.visibilityState === 'visible') last = null;
  }

  const loop = {
    step,
    hz,
    get running() {
      return running;
    },
    get timeScale() {
      return timeScale;
    },
    set timeScale(v) {
      timeScale = Math.max(0, Number(v) || 0);
    },
    // Hitstop: hold the simulation for real seconds; render() keeps running.
    freeze(seconds) {
      freezeLeft = Math.max(freezeLeft, seconds);
    },
    start() {
      if (running || signal?.aborted) return;
      running = true;
      last = null;
      acc = 0;
      untrack = track('loop');
      globalThis.document?.addEventListener('visibilitychange', onVisibility);
      raf = requestAnimationFrame(frame);
    },
    stop() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
      globalThis.document?.removeEventListener('visibilitychange', onVisibility);
      untrack?.();
      untrack = null;
    },
    resetClock() {
      last = null;
    },
    // Drive the loop with fake timestamps (ms) in tests.
    tick,
    // Advance n steps synchronously, exactly as frames would (debug hook, tests).
    advance(n = 1) {
      for (let i = 0; i < n; i++) update(step);
      render?.(0, 0);
    },
    // Frame-time percentiles from recent real frames, for ?debug overlays.
    // Allocates, so call it on demand rather than every frame.
    frameStats() {
      if (!tn) return { frames: 0, p50: 0, p95: 0, max: 0 };
      const s = Array.from(times.subarray(0, tn)).sort((a, b) => a - b);
      const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
      return { frames: tn, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
    },
  };
  signal?.addEventListener('abort', () => loop.stop(), { once: true });
  return loop;
}

// Timers on simulation time. They pause with the game, freeze during hitstop,
// scale with game speed and cannot outlive the mount, none of which holds for
// setTimeout. Call timers.update(dt) inside the fixed update.
export function createTimers() {
  const list = [];
  let gen = 0; // bumped by clear(), so a callback that clears ends the update it runs in
  const add = (seconds, fn, every) => {
    const t = { left: seconds, fn, every, dead: false };
    list.push(t);
    return () => {
      t.dead = true;
    };
  };
  return {
    after: (seconds, fn) => add(seconds, fn, 0),
    every: (seconds, fn) => add(seconds, fn, Math.max(seconds, 1e-3)),
    update(dt) {
      const n = list.length; // timers created by callbacks start next step
      const g = gen;
      for (let i = 0; i < n && g === gen; i++) {
        const t = list[i];
        if (t.dead) continue;
        t.left -= dt;
        while (!t.dead && t.left <= 1e-7) {
          t.fn();
          if (t.every > 0) t.left += t.every;
          else t.dead = true;
        }
      }
      let w = 0; // compact in place, keeping order, without allocating
      for (let r = 0; r < list.length; r++) if (!list[r].dead) list[w++] = list[r];
      list.length = w;
    },
    // Cancels every pending timer; safe inside a timer's own callback (game over).
    clear() {
      gen++;
      for (const t of list) t.dead = true;
      list.length = 0;
    },
    get size() {
      return list.length;
    },
  };
}

// Calls onHide when the page is hidden or the window loses focus. Ends with
// signal, or call the returned cleanup (Cougar Arcade's onPageHidden shape).
// Right for single-player pause; an online game listens to visibilitychange
// alone, since blur also fires when a player clicks a second test window.
export function onPageHidden(onHide, signal) {
  const own = new AbortController();
  signal?.addEventListener('abort', () => own.abort(), { once: true });
  const opts = { signal: own.signal };
  const vis = () => {
    if (document.visibilityState !== 'visible') onHide();
  };
  document.addEventListener('visibilitychange', vis, opts);
  window.addEventListener('blur', onHide, opts);
  window.addEventListener('pagehide', onHide, opts);
  return () => own.abort();
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// The setting can change while the game is open; fn(reduced) runs on each change.
export function watchReducedMotion(fn, signal) {
  if (typeof matchMedia !== 'function') return;
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => fn(e.matches), { signal });
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Frame-rate-independent smoothing toward a target: approach(x, target, rate, dt).
export const approach = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);

// Seeded PRNG (mulberry32). save()/load() snapshot the state for replays and
// save games. Use one stream per system so a new particle effect can't change
// the level generator's sequence.
export function rng(seed = Date.now()) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => Math.floor(lo + next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.save = () => a;
  next.load = (s) => {
    a = s >>> 0;
  };
  return next;
}
