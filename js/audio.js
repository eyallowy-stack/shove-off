// Every sound in Shove Off, generated with Web Audio: no files. Two layers per
// event, pitch varied ±5% and volume ±10%, so the hundredth bonk doesn't grate.
// Adapted from the browser-games starter's audio.js (unlock on a real activation
// event, iOS interruption recovery, buses, a voice cap).
//
// Buses: sfx and ui, under a master volume. M mutes (main.js).

import { read, write } from './lib/storage.js';

const UNLOCK_EVENTS = ['pointerup', 'touchend', 'keydown', 'mousedown', 'click'];
const MAX_VOICES = 32;

let ac = null;
let master = null;
let buses = null;
let noiseBuf = null;
let armed = false;
let muted = read('audio:muted', false) === true;
// iPhone: "play over my music" mixes with whatever is playing (and so respects the
// silent switch); off, the game's sound takes over and plays through the switch.
let overMusic = read('audio:overMusic', false) === true;
let volume = (() => {
  const v = read('audio:volume', 0.8);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
})();
const active = new Set();
const hums = new Map(); // slot -> { osc, osc2, gain, lfo }
const listeners = new Set();

export function initAudio() {
  if (typeof window === 'undefined') return;
  arm();
  // iPhone: the lock button, a call, Siri or another app suspend or interrupt the
  // context. Coming back, try to resume, and keep the unlock armed: iOS often refuses a
  // resume outside a gesture, and then the next tap anywhere brings the sound back.
  const back = () => {
    if (!ac || muted) return;
    ac.resume().catch(() => {});
    arm();
  };
  document.addEventListener('visibilitychange', () => {
    if (!ac) return;
    if (document.visibilityState === 'hidden') ac.suspend().catch(() => {});
    else back();
  });
  window.addEventListener('pageshow', back); // restored from the back/forward cache
  window.addEventListener('focus', back);
}

function arm() {
  if (armed) return;
  armed = true;
  for (const t of UNLOCK_EVENTS) window.addEventListener(t, onGesture, { capture: true, passive: true });
}
function disarm() {
  armed = false;
  for (const t of UNLOCK_EVENTS) window.removeEventListener(t, onGesture, { capture: true });
}

function onGesture() {
  if (muted) return;
  if (!ac) create();
  if (!ac) return disarm();
  session();
  if (ac.state === 'running') return disarm();
  ac.resume().then(() => ac.state === 'running' && disarm(), () => {});
}

function create() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;
  try {
    ac = new AC({ latencyHint: 'interactive' });
  } catch {
    ac = null;
    return;
  }
  master = ac.createGain();
  master.gain.value = volume;
  // A gentle limiter so a clash on top of a splash never clips.
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.ratio.value = 6;
  master.connect(comp).connect(ac.destination);
  buses = { sfx: ac.createGain(), ui: ac.createGain() };
  buses.sfx.connect(master);
  buses.ui.gain.value = 0.7;
  buses.ui.connect(master);
  const len = Math.floor(ac.sampleRate * 2);
  noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  ac.addEventListener('statechange', () => {
    if (!muted && ac.state !== 'running' && document.visibilityState === 'visible') arm();
  });
}

// iPhone: "playback" plays through the silent switch and pauses the player's music;
// "ambient" mixes with their music and follows the switch. Muted is always ambient.
function session() {
  if (typeof navigator === 'undefined' || !('audioSession' in navigator)) return;
  try {
    navigator.audioSession.type = muted || overMusic ? 'ambient' : 'playback';
  } catch {
    /* unsupported */
  }
}

let quiet = false; // the title screen's demo match plays silently
export const setQuiet = (v) => {
  quiet = !!v;
  if (quiet) stopAllHums();
};
const ready = () => ac && !muted && !quiet && ac.state === 'running' && active.size < MAX_VOICES;
const vary = (v, pct = 0.05) => v * (1 + (Math.random() * 2 - 1) * pct);
const vol = (v) => vary(v, 0.1);

function track(src, ...nodes) {
  active.add(src);
  src.onended = () => {
    active.delete(src);
    src.disconnect();
    for (const n of nodes) n.disconnect();
  };
}

function tone({ freq = 440, to = 0, dur = 0.12, type = 'sine', v = 0.2, delay = 0, bus = 'sfx', attack = 0.005 } = {}) {
  if (!ready()) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(buses[bus]);
  track(osc, g);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function noise({ dur = 0.15, freq = 1200, q = 0.8, type = 'bandpass', v = 0.25, delay = 0, sweepTo = 0, bus = 'sfx', attack = 0.004 } = {}) {
  if (!ready()) return;
  const t = ac.currentTime + delay;
  const d = Math.min(dur, noiseBuf.duration - 0.05);
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + d);
  f.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(f).connect(g).connect(buses[bus]);
  track(src, f, g);
  src.start(t, Math.random() * (noiseBuf.duration - d), d);
}

// --- the sound list (DESIGN.md) -------------------------------------------

export const sfx = {
  // Charge: a hum that rises with the charge (held per fighter), and a ping at full.
  humStart(slot) {
    if (!ready() || hums.has(slot)) return;
    const t = ac.currentTime;
    const base = slot === 0 ? 98 : 110;
    const osc = ac.createOscillator();
    const osc2 = ac.createOscillator();
    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    const g = ac.createGain();
    osc.type = 'triangle';
    osc2.type = 'sawtooth';
    osc.frequency.value = base;
    osc2.frequency.value = base * 2.01;
    lfo.frequency.value = 7;
    lfoGain.gain.value = 3;
    lfo.connect(lfoGain).connect(osc.frequency);
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g2 = ac.createGain();
    g2.gain.value = 0.25;
    osc.connect(g);
    osc2.connect(g2).connect(f).connect(g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.06);
    g.connect(buses.sfx);
    for (const o of [osc, osc2, lfo]) o.start(t);
    hums.set(slot, { osc, osc2, lfo, g, f, base });
  },
  humLevel(slot, level) {
    const h = hums.get(slot);
    if (!h || !ac) return;
    const t = ac.currentTime;
    h.osc.frequency.setTargetAtTime(h.base * (1 + level * 1.6), t, 0.03);
    h.osc2.frequency.setTargetAtTime(h.base * 2.01 * (1 + level * 1.6), t, 0.03);
    h.f.frequency.setTargetAtTime(700 + level * 2200, t, 0.05);
    h.g.gain.setTargetAtTime(0.04 + level * 0.09, t, 0.05);
    h.lfo.frequency.setTargetAtTime(6 + level * 10, t, 0.05);
  },
  humStop(slot) {
    const h = hums.get(slot);
    if (!h) return;
    hums.delete(slot);
    if (!ac) return;
    const t = ac.currentTime;
    h.g.gain.cancelScheduledValues(t);
    h.g.gain.setTargetAtTime(0.0001, t, 0.02);
    for (const o of [h.osc, h.osc2, h.lfo]) {
      try {
        o.stop(t + 0.12);
      } catch {
        /* already stopped */
      }
    }
    setTimeout(() => h.g.disconnect(), 300);
  },
  full() {
    tone({ freq: vary(1320), dur: 0.12, type: 'sine', v: vol(0.16) });
    tone({ freq: vary(1980), dur: 0.2, type: 'triangle', v: vol(0.08), delay: 0.03 });
  },
  // Dash: a noise sweep (whoosh) plus a short rising blip.
  dash(pw = 0) {
    noise({ dur: 0.16 + pw * 0.12, freq: vary(500), sweepTo: vary(2600 + pw * 2000), q: 1.2, v: vol(0.16 + pw * 0.12) });
    tone({ freq: vary(260 + pw * 120), to: vary(560 + pw * 300), dur: 0.07, type: 'square', v: vol(0.05) });
  },
  // Bonk: a sine thump falling 160 -> 50 Hz plus a high-passed crack, by power.
  bonk(pw = 0) {
    tone({ freq: vary(160), to: 50, dur: 0.16 + pw * 0.12, type: 'sine', v: vol(0.32 + pw * 0.3), attack: 0.002 });
    noise({ dur: 0.05 + pw * 0.06, freq: vary(2600), type: 'highpass', q: 0.7, v: vol(0.18 + pw * 0.18), attack: 0.001 });
  },
  // Two jabs bumping: a light tink, not the big ring.
  tink() {
    tone({ freq: vary(1760, 0.04), dur: 0.09, type: 'triangle', v: vol(0.07), attack: 0.001 });
    noise({ dur: 0.03, freq: vary(4200), type: 'highpass', q: 0.7, v: vol(0.06), attack: 0.001 });
  },
  // Clash: two detuned triangles ringing plus a thump.
  clash() {
    tone({ freq: vary(880, 0.03), dur: 0.6, type: 'triangle', v: vol(0.12), attack: 0.002 });
    tone({ freq: vary(932, 0.03), dur: 0.55, type: 'triangle', v: vol(0.1), attack: 0.002 });
    tone({ freq: vary(130), to: 45, dur: 0.2, type: 'sine', v: vol(0.4), attack: 0.002 });
  },
  // Tile crack: soft rattles. Tile sink: a low-passed crumble.
  crack() {
    for (let i = 0; i < 3; i++) noise({ dur: 0.03, freq: vary(3200, 0.2), q: 4, v: vol(0.05), delay: i * 0.045 + Math.random() * 0.02 });
    tone({ freq: vary(1800, 0.1), dur: 0.03, type: 'square', v: vol(0.015), delay: 0.02 });
  },
  sink() {
    noise({ dur: 0.55, freq: vary(900), sweepTo: 140, type: 'lowpass', q: 0.9, v: vol(0.16) });
    tone({ freq: vary(90), to: 40, dur: 0.45, type: 'sine', v: vol(0.12), delay: 0.05 });
  },
  // Teeter: a wobbly two-note creak.
  teeter() {
    tone({ freq: vary(330), to: vary(300), dur: 0.12, type: 'sawtooth', v: vol(0.035) });
    tone({ freq: vary(262), to: vary(240), dur: 0.16, type: 'sawtooth', v: vol(0.03), delay: 0.11 });
  },
  save() {
    tone({ freq: vary(523), dur: 0.08, type: 'triangle', v: vol(0.08) });
    tone({ freq: vary(784), dur: 0.12, type: 'triangle', v: vol(0.08), delay: 0.07 });
  },
  // Ring-out: a falling slide whistle, then a splash.
  slide() {
    tone({ freq: vary(1400), to: 300, dur: 0.75, type: 'sine', v: vol(0.12), attack: 0.02 });
    tone({ freq: vary(2800), to: 600, dur: 0.6, type: 'sine', v: vol(0.025), attack: 0.02 });
  },
  splash() {
    noise({ dur: 0.45, freq: vary(1400), sweepTo: 300, type: 'lowpass', q: 0.6, v: vol(0.3) });
    tone({ freq: vary(320), to: 70, dur: 0.22, type: 'sine', v: vol(0.25) });
  },
  // Countdown: three beeps, then a higher GO.
  beep() {
    tone({ freq: vary(660, 0.01), dur: 0.1, type: 'square', v: vol(0.06), bus: 'ui' });
    tone({ freq: vary(1320, 0.01), dur: 0.08, type: 'sine', v: vol(0.04), bus: 'ui' });
  },
  go() {
    tone({ freq: 990, dur: 0.28, type: 'square', v: vol(0.07), bus: 'ui' });
    tone({ freq: 1485, dur: 0.32, type: 'triangle', v: vol(0.06), bus: 'ui' });
  },
  // Stings: 2 notes for a round, 4 for the match.
  roundWin() {
    [523, 784].forEach((f, i) => {
      tone({ freq: f, dur: 0.22, type: 'triangle', v: 0.13, delay: i * 0.11, bus: 'ui' });
      tone({ freq: f * 2, dur: 0.14, type: 'sine', v: 0.04, delay: i * 0.11, bus: 'ui' });
    });
  },
  matchWin() {
    [523, 659, 784, 1047].forEach((f, i) => {
      tone({ freq: f, dur: i === 3 ? 0.6 : 0.2, type: 'triangle', v: 0.14, delay: i * 0.12, bus: 'ui' });
      tone({ freq: f / 2, dur: i === 3 ? 0.6 : 0.2, type: 'square', v: 0.03, delay: i * 0.12, bus: 'ui' });
    });
  },
  // A new opponent unlocked: a rising run that lands on a bright, held chord.
  unlock() {
    [659, 784, 988, 1319].forEach((f, i) => {
      tone({ freq: f, dur: i === 3 ? 0.7 : 0.14, type: 'triangle', v: 0.12, delay: i * 0.08, bus: 'ui' });
      tone({ freq: f * 1.5, dur: i === 3 ? 0.6 : 0.1, type: 'sine', v: 0.035, delay: i * 0.08 + 0.02, bus: 'ui' });
    });
  },
  // UI: a tick on move, a blip on confirm, a soft back.
  uiMove() {
    tone({ freq: vary(1250), dur: 0.025, type: 'triangle', v: vol(0.05), bus: 'ui' });
    noise({ dur: 0.015, freq: 5000, q: 2, v: 0.015, bus: 'ui' });
  },
  uiConfirm() {
    tone({ freq: vary(660), to: 990, dur: 0.08, type: 'triangle', v: vol(0.1), bus: 'ui' });
    tone({ freq: vary(1320), dur: 0.06, type: 'sine', v: vol(0.04), delay: 0.04, bus: 'ui' });
  },
  uiBack() {
    tone({ freq: vary(440), to: 330, dur: 0.09, type: 'triangle', v: vol(0.07), bus: 'ui' });
    tone({ freq: vary(220), dur: 0.08, type: 'sine', v: vol(0.04), bus: 'ui' });
  },
  // Online: a chime when the opponent joins, a low tone when they drop.
  joined() {
    tone({ freq: 784, dur: 0.5, type: 'sine', v: 0.1, bus: 'ui' });
    tone({ freq: 1175, dur: 0.6, type: 'sine', v: 0.07, delay: 0.09, bus: 'ui' });
  },
  dropped() {
    tone({ freq: 196, to: 150, dur: 0.45, type: 'triangle', v: 0.1, bus: 'ui' });
    tone({ freq: 98, dur: 0.4, type: 'sine', v: 0.06, bus: 'ui' });
  },
};

export function stopAllHums() {
  for (const slot of [...hums.keys()]) sfx.humStop(slot);
}

export const isMuted = () => muted;
export const playsOverMusic = () => overMusic;
// Call from a change event (a gesture), like setMuted.
export function setOverMusic(value) {
  overMusic = !!value;
  write('audio:overMusic', overMusic);
  session();
}
export const getVolume = () => volume;

// Call from a click or key handler (itself a gesture), so unmuting can start audio.
export function setMuted(value) {
  muted = !!value;
  write('audio:muted', muted);
  session();
  if (muted) {
    stopAllHums();
    ac?.suspend().catch(() => {});
  } else if (ac) ac.resume().catch(() => arm());
  else onGesture();
  for (const fn of listeners) fn(muted);
}

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v) || 0));
  write('audio:volume', volume);
  if (master) master.gain.value = volume;
}

export function onMuteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const audioState = () => ({ state: ac?.state ?? 'none', voices: active.size, hums: hums.size, muted, volume });
