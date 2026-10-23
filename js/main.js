// Shove Off: the page. Screens and menus, settings, the loop, and which kind of
// match is running (an attract-mode demo behind the title, two players here, the
// CPU, or online). The rules live in js/game/, the netcode in js/net/.

import { createLoop, prefersReducedMotion } from './lib/loop.js';
import { read, write } from './lib/storage.js';
import { initAudio, sfx, setMuted, isMuted, setVolume, getVolume, stopAllHums, setQuiet, audioState, onMuteChange, playsOverMusic, setOverMusic } from './audio.js';
import { createControls, ACTIONS, cleanBindings, keyLabel } from './controls.js';
import { createTouchRouter, createTouchVisuals, attachTouch, layoutPads } from './touch.js';
import { feel, hapticsAvailable, hapticsOn, setHaptics } from './haptics.js';
import { setupOffline } from './pwa.js';
import { createRenderer, TEAM } from './render.js';
import { createLocalMatch } from './local.js';
import { createOnlineMatch, savedRoom, forgetRoom } from './online.js';
import { TUNING, K, PH, setTuning } from './game/sim.js';
import { makeJoinCode, normalizeJoinCode, isJoinCode } from './net/protocol.js';
import { LEVELS, levelInfo } from './game/cpu.js';
import { createSoloRecord } from './solo.js';

import { ROOM_SERVER } from './config.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const COMEBACK = params.get('v') === 'comeback';

// ---------- settings (this device only) ----------
const saved = read('settings', {}) ?? {};
const settings = {
  motion: ['system', 'reduce', 'full'].includes(saved.motion) ? saved.motion : 'system',
  shake: Number.isFinite(saved.shake) ? Math.max(0, Math.min(1, saved.shake)) : 1,
  name: typeof saved.name === 'string' ? saved.name.slice(0, 12) : '',
  bindings: cleanBindings(saved.bindings),
  touch: ['auto', 'on', 'off'].includes(saved.touch) ? saved.touch : 'auto', // on-screen controls
  swap: saved.swap === true, // left-handed: DASH on the left
  tsize: ['s', 'm', 'l'].includes(saved.tsize) ? saved.tsize : 'm', // touch control size
  stick: saved.stick === 'fixed' ? 'fixed' : 'float',
  easy: saved.easy === true, // easy charge: tap DASH to charge, tap again to launch
  reducedMotion() {
    return this.motion === 'reduce' || (this.motion === 'system' && prefersReducedMotion());
  },
  shakeAmount() {
    return this.reducedMotion() ? 0 : this.shake;
  },
};
const saveSettings = () =>
  write('settings', { motion: settings.motion, shake: settings.shake, name: settings.name, bindings: controls.bindings(), touch: settings.touch, swap: settings.swap, tsize: settings.tsize, stick: settings.stick, easy: settings.easy });
const applyMotionAttr = () => (document.documentElement.dataset.motion = settings.motion);

// Rivalry tally on this device: Coral vs Teal here, and you vs each online friend.
const rivalry = (() => {
  const r = read('rivalry', null);
  const ok = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
  const online = {};
  if (r?.online && typeof r.online === 'object') for (const [k, v] of Object.entries(r.online).slice(0, 30)) online[String(k).slice(0, 12)] = { w: ok(v?.w), l: ok(v?.l) };
  return { local: [ok(r?.local?.[0]), ok(r?.local?.[1])], cpu: { w: ok(r?.cpu?.w), l: ok(r?.cpu?.l) }, online };
})();
const saveRivalry = () => write('rivalry', rivalry);

// Solo: this device's record against each CPU, and what it has unlocked.
const solo = createSoloRecord({ read, write, legacy: rivalry.cpu });
const unlocked = (id) => solo.unlocked(id);
let cpuLevel = 'easy';

// ---------- core objects ----------
const ac = new AbortController();
const stage = $('stage');
const canvas = $('game');
const controls = createControls({ bindings: settings.bindings, signal: ac.signal });
const renderer = createRenderer(canvas, {
  settings: { reducedMotion: () => settings.reducedMotion(), shake: () => settings.shakeAmount() },
  // Android buzzes on contact; the title's demo match never does.
  onFeel: (kind, info) => mode !== 'title' && feel[kind]?.(info.pw),
});
initAudio();
applyMotionAttr();

let mode = 'title'; // title | 2p | cpu | online (cpu: against cpuLevel)
let match = null; // the running controller
let paused = false;
let screen = null; // id of the visible screen, or null while playing
const back = []; // where Esc / Back goes from each screen

const live = (text) => {
  const el = $('live');
  el.textContent = '';
  setTimeout(() => (el.textContent = text), 30);
};

function hintFor(slot, kind = mode) {
  // On touch the hints sit on the controls themselves (the dashed thumb ring).
  if (touchShown()) return null;
  if (kind === 'cpu') return 'Move: WASD or arrows · hold Space to charge';
  const b = controls.bindings()[slot];
  const move = slot === 0 ? b.up.concat(b.left, b.down, b.right).map(keyLabel).join('') : 'Arrows';
  return `${move} · hold ${keyLabel(b.dash[0])}`;
}
function controlsLine() {
  if (controls.device === 'touch') {
    $('controls-line').textContent = 'Touch: drag anywhere on the left to move, tap DASH to jab, hold it to charge and let go to launch. Keyboard: WASD / arrows and Space.';
    return;
  }
  const b = controls.bindings();
  const d0 = b[0].dash.map(keyLabel).join(' or ');
  const d1 = b[1].dash.slice(0, 2).map(keyLabel).join(' or ');
  const m0 = [b[0].up, b[0].left, b[0].down, b[0].right].map((k) => keyLabel(k[0])).join('');
  $('controls-line').textContent = `Move: ${m0} / arrows. Hold ${d0} or ${d1} to charge, let go to dash. Knock them off the ice.`;
}

// ---------- screens ----------
// push: remember the current screen so Back returns to it (settings, online).
// Top-level screens (title, pause, lobby, scoreboard, messages) start a fresh stack.
function show(id, { push = true } = {}) {
  if (!push) back.length = 0;
  else if (screen && screen !== id) back.push(screen);
  for (const el of stage.querySelectorAll('.screen')) el.hidden = el.id !== `scr-${id}`;
  screen = id;
  shownAt = performance.now();
  controls.setEnabled(false);
  router.releaseAll();
  controls.releaseAll();
  touchVisuals.reset();
  stopAllHums();
  updateTouch();
  pwa.menusShown();
  if (id === 'title') checkStrip();
  const panel = $(`scr-${id}`);
  const first = panel.querySelector('[data-autofocus]') ?? panel.querySelector('.btn-primary:not([hidden]):not([disabled])') ?? panel.querySelector('button:not([hidden])');
  first?.focus({ preventScroll: true });
}
function hideScreens() {
  for (const el of stage.querySelectorAll('.screen')) el.hidden = true;
  screen = null;
  back.length = 0;
  document.activeElement?.blur?.();
  controls.setEnabled(mode !== 'title');
  updateTouch();
  pwa.hide();
}
function goBack() {
  const prev = back.pop();
  if (prev) {
    sfx.uiBack();
    show(prev, { push: false });
    return;
  }
  if (screen === 'pause') return resume();
  if (screen === 'online' || screen === 'cpu') {
    sfx.uiBack();
    return toTitle();
  }
  // The title, lobby, scoreboard and messages have their own buttons for leaving.
}

function message(title, body, actions) {
  $('msg-h').textContent = title;
  $('msg-body').textContent = body;
  const box = $('msg-actions');
  box.textContent = '';
  for (const [i, a] of actions.entries()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn${i === 0 ? ' btn-primary' : ' btn-quiet'}`;
    b.textContent = a.label;
    b.addEventListener('click', () => {
      sfx.uiConfirm();
      a.onClick();
    });
    box.append(b);
  }
  show('message', { push: false });
}

// ---------- the matches ----------
// The HUD writes text and classes only when something changed (once a second for the
// clock), and never reads layout, so the frame loop stays free of layout work.
const pipEls = [0, 1].map((s) => [...document.querySelectorAll(`[data-pips="${s}"] i`)]);
const hud = {
  el: $('hud'),
  shown: '',
  set(scene) {
    if (!scene) return;
    const sc = scene.scores ?? [0, 0];
    const secs = Math.max(0, Math.floor((scene.elapsed ?? 0) / TUNING.tickHz));
    const crumble = (scene.elapsed ?? 0) >= TUNING.crumbleStartS * TUNING.tickHz - K.warn && scene.state === 'fight';
    const key = `${sc[0]}${sc[1]}|${secs}|${scene.round}|${crumble}|${scene.state}`;
    if (key === this.shown) return;
    this.shown = key;
    for (const s of [0, 1]) pipEls[s].forEach((p, i) => p.classList.toggle('on', i % 3 < sc[s]));
    $('hud-clock').textContent = scene.state === 'end' ? '–' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    $('hud-clock').classList.toggle('crumble', crumble);
    $('hud-round').textContent = scene.round ? `Round ${scene.round}` : 'Ready';
  },
};
function setNames(n0, n1) {
  $('hud-name0').textContent = n0;
  $('hud-name1').textContent = n1;
  for (const el of document.querySelectorAll('[data-name]')) el.textContent = el.dataset.name === '0' ? n0 : n1;
}
let names = ['Coral', 'Teal'];

// Round results punch in: on the stage, and on each player's own end when two share a
// screen. WAAPI, so a new result restarts the punch without a forced layout.
let bannerTimer = 0;
const PUNCH = [
  { transform: 'scale(0.4) rotate(-4deg)', opacity: 0 },
  { transform: 'none', opacity: 1 },
];
function banner(text, slot) {
  const main = $('banner');
  const side = slot === 0 || slot === 1 ? ` p${slot}` : '';
  main.hidden = false;
  main.className = `banner${side}`;
  main.textContent = text;
  const pads = [...document.querySelectorAll('.tpad-banner')];
  for (const el of pads) {
    el.className = `tpad-banner${side}`;
    el.textContent = text;
  }
  if (!settings.reducedMotion()) for (const el of [main, ...pads]) el.animate?.(PUNCH, { duration: 420, easing: 'cubic-bezier(0.2, 1.5, 0.4, 1)' });
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    main.hidden = true;
    for (const el of pads) el.textContent = '';
  }, 1700);
}

const matchEvents = {
  hintFor,
  round(ev) {
    if (ev.winner === -1 || ev.replay) {
      banner('Both in! Replay', null);
      live(`Both fell in. Round ${ev.round} is replayed.`);
      return;
    }
    const w = ev.winner;
    const who = whoName(w);
    sfx.roundWin();
    // Bumper never shoves, so a round it "wins" is the ice taking you, and says so.
    if (sparring() && w === 1) {
      banner(ev.match ? 'The ice got you!' : `The ice got you: round ${ev.round}`, w);
      live(`You fell in. Round ${ev.round}, ${Math.max(...ev.scores)} to ${Math.min(...ev.scores)} to the ice.`);
      return;
    }
    banner(ev.match ? `${who} ${youVerb(w, 'win', 'wins')} it!` : `${who} ${youVerb(w, 'take', 'takes')} round ${ev.round}`, w);
    live(`${who} ${youVerb(w, 'win', 'wins')} round ${ev.round}, ${Math.max(...ev.scores)} to ${Math.min(...ev.scores)}.`);
  },
  roundStart() {},
  match(ev) {
    sfx.matchWin();
    const m = match;
    // Only if it's still that match, and (online) the room didn't go back to the lobby.
    setTimeout(() => m === match && (mode !== 'online' || match.session.phase !== 'lobby') && showScoreboard(ev), 900);
  },
};
const sparring = () => mode === 'cpu' && cpuLevel === 'practice';
function whoName(slot) {
  if (mode === 'online' && match && slot === match.mySlot) return 'You';
  if (mode === 'cpu') return slot === 0 ? 'You' : names[1];
  return names[slot];
}
const youVerb = (slot, you, them) => (whoName(slot) === 'You' ? you : them);

function startLocal(kind, level = cpuLevel) {
  sfx.uiConfirm();
  teardown();
  setQuiet(false);
  mode = kind;
  if (kind === 'cpu') {
    cpuLevel = level;
    solo.play(level);
  }
  const foe = levelInfo(cpuLevel);
  names = kind === 'cpu' ? ['You', foe.name] : ['Coral', 'Teal'];
  setNames(names[0], names[1]);
  // Round 1 is the tutorial: key hints under each fighter until they use their keys.
  match = createLocalMatch({ mode: kind, level: cpuLevel, controls, renderer, events: matchEvents, headStart: COMEBACK ? 0.5 : TUNING.loserHeadStart, tutorial: true });
  guardBack();
  renderer.reset();
  $('hud').hidden = false;
  paused = false;
  hideScreens();
  live(
    kind === 'cpu'
      ? `You against ${foe.name} (${foe.label}). ${foe.line} First to 3 ring-outs.`
      : touchWanted()
        ? 'Two players on one screen, one at each end. Each end has its own stick and DASH button. First to 3 ring-outs.'
        : 'Two players. Coral uses WASD and Space, Teal uses the arrows and slash or Enter. First to 3 ring-outs.',
  );
}

// How to open a locked opponent: beat the one below, or push it close a few times.
function lockedLine(l) {
  const by = levelInfo(l.unlockedBy).name;
  const p = solo.progress(l.id);
  return `Beat ${by} once, or take 2 rounds off ${by} in ${p.need} matches (${p.close} of ${p.need} so far), to unlock.`;
}

// ---------- play vs computer: the opponent picker ----------
// Easiest first. Opens on the last one you played, or the first you haven't beaten.
function openCpuPicker({ push = true } = {}) {
  sfx.uiConfirm();
  const box = $('cpu-list');
  box.textContent = '';
  $('cpu-status').textContent = '';
  const pick = solo.pickDefault();
  const span = (cls, text) => {
    const e = document.createElement('span');
    e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  for (const [i, l] of LEVELS.entries()) {
    const open = unlocked(l.id);
    const rec = solo.rec[l.id];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn foe${open ? '' : ' locked'}${rec?.w ? ' beaten' : ''}`;
    b.dataset.act = 'cpu';
    b.dataset.level = l.id;
    if (l.id === pick) b.dataset.autofocus = '';
    const head = span('foe-head');
    const pips = span('foe-pips');
    pips.setAttribute('aria-hidden', 'true');
    for (let p = 1; p <= 3; p++) pips.append(span(p <= i ? 'on' : ''));
    head.append(span('foe-name', l.name), span('foe-tag', l.label), pips);
    const record = !l.record
      ? "Doesn't count toward your record."
      : !open
        ? lockedLine(l)
        : rec.w + rec.l
          ? `You ${rec.w} – ${rec.l}${rec.w ? ' · beaten' : ''}`
          : 'Not played yet.';
    b.append(head, span('foe-line', l.line), span('foe-rec', record));
    if (!open) b.setAttribute('aria-disabled', 'true');
    b.setAttribute('aria-label', `${l.name}, ${l.label}. ${l.line} ${record}`);
    box.append(b);
  }
  show('cpu', { push });
}

function startDemo() {
  teardown();
  setQuiet(true);
  mode = 'title';
  match = createLocalMatch({ mode: 'demo', controls, renderer, events: { round() {}, match() {} } });
  renderer.reset();
  $('hud').hidden = true;
}

function teardown() {
  stopAllHums();
  if (match?.destroy) match.destroy();
  match = null;
  $('netline').hidden = true;
  $('banner').hidden = true;
}

// The system Back gesture (iOS Safari's edge swipe, Android's gesture navigation) would
// leave the page mid-match, and in the installed app close it. A match pushes one
// history entry; Back pops it, and we open the pause menu and push it again.
let backGuard = false;
let skipPop = false;
// A reload mid-match keeps that entry's state; this page starts on the title, so clear it.
try {
  if (history.state?.shoveOff === 'match') history.replaceState(null, '');
} catch {
  /* no history */
}
function guardBack() {
  if (backGuard) return;
  try {
    history.pushState({ shoveOff: 'match' }, '');
    backGuard = true;
  } catch {
    /* sandboxed: no history */
  }
}
function unguardBack() {
  if (!backGuard) return;
  backGuard = false;
  if (history.state?.shoveOff === 'match') {
    skipPop = true;
    history.back();
  }
}
window.addEventListener(
  'popstate',
  () => {
    if (skipPop) {
      skipPop = false;
      return;
    }
    if (!backGuard) return;
    try {
      history.pushState({ shoveOff: 'match' }, '');
    } catch {
      /* ignore */
    }
    if (!screen) pause();
  },
  { signal: ac.signal },
);

function toTitle() {
  unguardBack();
  startDemo();
  back.length = 0;
  refreshTitle();
  show('title', { push: false });
}

function refreshTitle() {
  // A room this device was in a moment ago (the app was thrown out of memory, or the
  // page reloaded): offer the same seat back while the server still holds it.
  const room = savedRoom();
  $('btn-rejoin').hidden = !room;
  $('rejoin-code').textContent = room?.code ?? '';
  const line = solo.summary();
  $('title-solo').hidden = !line;
  $('title-solo').textContent = line ?? '';
  const r = rivalry.local;
  const el = $('title-rivalry');
  if (r[0] + r[1] > 0) {
    el.hidden = false;
    el.innerHTML = '';
    el.append('On this device: ');
    const a = document.createElement('span');
    a.className = 'c0';
    a.textContent = `Coral ${r[0]}`;
    const b = document.createElement('span');
    b.className = 'c1';
    b.textContent = `Teal ${r[1]}`;
    el.append(a, ' · ', b);
  } else el.hidden = true;
}

function pause() {
  if (!match || mode === 'title' || screen) return;
  sfx.uiConfirm();
  const online = mode === 'online';
  paused = !online;
  $('pause-h').textContent = online ? 'Menu' : 'Paused';
  $('pause-sub').textContent = online ? "The match keeps going: an online match can't pause for one player." : '';
  $('pause-restart').hidden = online;
  $('pause-quit').textContent = online ? 'Leave room' : 'Quit to title';
  $('scr-pause').querySelector('[data-act="resume"]').textContent = online ? 'Back to the match' : 'Resume';
  show('pause', { push: false });
}
function resume() {
  paused = false;
  sfx.uiConfirm();
  hideScreens();
  // A fresh clock: the pause shouldn't come back as one long frame.
  loop.resetClock();
}

// ---------- scoreboard ----------
function showScoreboard(ev) {
  if (!match) return;
  const w = ev.winner;
  const online = mode === 'online';
  const me = online ? match.mySlot : null;
  const title = online
    ? w === me
      ? 'You win!'
      : `${names[w]} wins!`
    : mode === 'cpu'
      ? w === 0
        ? 'You win!'
        : sparring()
          ? 'The ice got you!'
          : `${names[1]} wins!`
      : `${names[w]} wins!`;
  $('score-eyebrow').textContent = 'Match over';
  $('score-h').textContent = title;
  $('score-h').className = `winner c${w}`;
  $('score-final').textContent = `${ev.scores[0]} – ${ev.scores[1]}`;
  const st = ev.stats;
  const dl = $('score-stats');
  dl.textContent = '';
  const row = (label, a, b) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const d0 = document.createElement('dd');
    d0.textContent = String(a);
    const d1 = document.createElement('dd');
    d1.textContent = String(b);
    dl.append(dt, d0, d1);
  };
  const head = document.createElement('dt');
  head.textContent = '';
  const h0 = document.createElement('dd');
  h0.className = 'h c0';
  h0.textContent = names[0];
  const h1 = document.createElement('dd');
  h1.className = 'h c1';
  h1.textContent = names[1];
  dl.append(head, h0, h1);
  if (st) {
    row('Hits landed', st.hits[0], st.hits[1]);
    row('Full-charge hits', st.big[0], st.big[1]);
    row('Clutch saves', st.saves[0], st.saves[1]);
    const dt = document.createElement('dt');
    dt.textContent = `Clashes ${st.clashes} · longest round ${Math.round(st.longest / TUNING.tickHz)} s`;
    dt.style.gridColumn = '1 / -1';
    dl.append(dt);
  }
  // Rivalry
  const riv = $('score-rivalry');
  if (mode === '2p') {
    rivalry.local[w]++;
    riv.textContent = `On this device: Coral ${rivalry.local[0]} · Teal ${rivalry.local[1]}`;
  } else if (mode === 'cpu') {
    soloResult(w === 0, ev.scores[0]);
  } else {
    const foe = names[1 - me] || 'Friend';
    const r = (rivalry.online[foe] ??= { w: 0, l: 0 });
    r[w === me ? 'w' : 'l']++;
    riv.textContent = `You vs ${foe}: ${r.w} – ${r.l}`;
  }
  saveRivalry();
  if (mode !== 'cpu') $('score-status').textContent = '';
  $('score-next').hidden = mode !== 'cpu';
  $('score-rematch').disabled = false;
  rematchKey = '';
  rematchPressedAt = -1e9;
  $('score-quit').textContent = online ? 'Leave room' : 'Title';
  live(`${title} ${ev.scores[0]} to ${ev.scores[1]}. ${$('score-status').textContent} Rematch is focused.`);
  show('score', { push: false });
}

// The record against this CPU, an unlock if this win earned one, and the next step:
// after a win, the next opponent up; otherwise the picker.
function soloResult(won, roundsWon) {
  const l = levelInfo(cpuLevel);
  const riv = $('score-rivalry');
  $('score-status').textContent = '';
  const { record, fresh } = solo.result(l.id, won, roundsWon);
  if (record) riv.textContent = `You vs ${l.name}: ${record.w} – ${record.l}`;
  else riv.textContent = "Practice doesn't count toward your record.";
  if (fresh.length) {
    $('score-status').textContent = `${fresh[0].name} is unlocked: ${fresh[0].line}`;
    setTimeout(() => sfx.unlock(), 700);
  }
  const up = fresh[0] ?? solo.nextUp(l.id, won);
  const next = $('score-next');
  next.textContent = up ? `Take on ${up.name}` : 'Change opponent';
  next.dataset.level = up ? up.id : '';
}

function rematch() {
  if (!match) return;
  sfx.uiConfirm();
  if (mode === 'online') {
    match.rematch();
    rematchPressedAt = performance.now();
    rematchKey = '';
    syncRematch();
    return;
  }
  match.rematch();
  renderer.reset();
  hideScreens();
}

// Online, the Rematch button and its status line are rebuilt from the room's view (who
// has pressed it), not kept as local state: a press lost while the room was paused, or
// a friend who pressed first, always shows correctly.
let rematchPressedAt = -1e9;
let rematchKey = '';
function syncRematch() {
  if (mode !== 'online' || !match) return;
  const s = match.session;
  const v = s.view;
  const rd = v?.st === 'end' ? (v.rd ?? []) : [];
  const inFlight = performance.now() - rematchPressedAt < 1500;
  const mine = rd.includes(s.pid) || inFlight;
  const theirs = rd.some((p) => p !== s.pid);
  const key = `${mine}|${theirs}|${s.phase}`;
  if (key === rematchKey) return;
  rematchKey = key;
  const other = names[1 - match.mySlot] || 'your friend';
  $('score-rematch').disabled = mine;
  $('score-status').textContent = mine
    ? s.phase === 'paused'
      ? `${other}'s screen went to sleep. Your Rematch counts when they're back.`
      : `Waiting for ${other} to press Rematch…`
    : theirs
      ? `${other} wants a rematch!`
      : '';
}

// ---------- online ----------
function openOnline() {
  sfx.uiConfirm();
  // Opened from the Home Screen with no connection: the game works, rooms can't.
  // A copy on a static host (GitHub Pages) has no room server of its own until config.js names one.
  const noServer = !ROOM_SERVER && !onTailnet() && !onThisComputer();
  $('online-status').textContent = noServer
    ? "Online rooms aren't switched on for this link yet. Play vs Computer and 2 players here work."
    : navigator.onLine === false ? "You're offline. Online rooms need the room server, so connect (and turn on Tailscale) first. Play vs Computer works offline." : '';
  $('online-where').textContent = friendAddress('where');
  show('online');
}

// Where a friend points their browser. A localhost address is this computer to anyone
// else, so it's only ever printed for a ts.net page.
const onTailnet = () => location.hostname.endsWith('.ts.net');
const onThisComputer = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
function friendAddress(where) {
  if (onTailnet()) return where === 'where' ? `Your friend opens ${location.origin} on their own device (with Tailscale on: see the README).` : `Tell your friend this code. They open ${location.origin}, choose Online, and type it in.`;
  if (onThisComputer()) {
    const fix = 'This address only works on this computer. Run tailscale serve (see the README) and send your friend your https://<machine>.<tailnet>.ts.net link.';
    return where === 'where' ? fix : `Tell your friend this code. ${fix} They choose Online and type the code in.`;
  }
  return where === 'where' ? '' : 'Tell your friend this code. They open this game, choose Online, and type it in.';
}

function startOnline(code, create, rejoin = null) {
  teardown();
  lobbyNote = '';
  setQuiet(false);
  mode = 'online';
  names = ['Coral', 'Teal'];
  setNames('Coral', 'Teal');
  renderer.reset();
  const lagArg = DEBUG && params.get('lag');
  const lag = lagArg ? Object.fromEntries(['latencyMs', 'jitterMs', 'loss'].map((k, i) => [k, Number(lagArg.split(',')[i] ?? 0)])) : null;
  $('online-status').textContent = 'Connecting…';
  guardBack();
  match = createOnlineMatch({
    code,
    create,
    name: settings.name,
    controls,
    renderer,
    stage,
    debug: DEBUG,
    lag,
    rejoin,
    events: {
      ...matchEvents,
      status(status, text, detail) {
        if (status === 'online') {
          $('netline').hidden = true;
          if (match.session.phase === 'lobby') showLobby();
          return;
        }
        if (status === 'reconnecting') {
          $('netline').hidden = false;
          $('netline').textContent = text;
          return;
        }
        if (['gone', 'replaced', 'new-code', 'blocked', 'unavailable'].includes(status)) {
          const retry = status === 'unavailable';
          // 4010: this copy is older than the server's. A plain reload would come from
          // the old cache, so hand over to the new version first (js/pwa.js).
          const updated = status === 'gone' && detail?.code === 4010;
          message('Online', text, [
            ...(retry ? [{ label: 'Try again', onClick: () => (hideScreens(), match?.session.net.reconnectNow()) }] : []),
            ...(updated ? [{ label: 'Reload', onClick: () => pwa.updateNow() }] : []),
            { label: 'Back to title', onClick: () => toTitle() },
          ]);
          return;
        }
        if (screen === 'online') $('online-status').textContent = text;
      },
      roster() {
        refreshNames();
        if (screen === 'lobby') showLobby();
      },
      opponent(kind, r) {
        const n = displayName(r);
        if (kind === 'joined' || kind === 'back') {
          sfx.joined();
          live(`${n} ${kind === 'joined' ? 'joined' : 'is back'}.`);
          $('netline').hidden = true;
        } else if (kind === 'dropped') {
          sfx.dropped();
          live(`${n} lost connection. Their seat is held for 20 seconds.`);
          $('netline').hidden = false;
          $('netline').textContent = `${n} lost connection… waiting for them (20 s)`;
        } else if (kind === 'left') {
          // The words come with the lobby ("Your friend left the room…"), read by its status line.
          sfx.dropped();
          $('netline').hidden = true;
        }
      },
      phase(phase, why) {
        if (phase === 'playing') {
          $('netline').hidden = true;
          $('hud').hidden = false;
          if (screen === 'lobby' || screen === 'online') hideScreens();
        } else if (phase === 'paused') {
          $('netline').hidden = false;
          $('netline').textContent = why === 'away' ? 'Paused: your friend switched away for a moment…' : 'Paused until your friend reconnects…';
        } else if (phase === 'lobby') {
          $('hud').hidden = true;
          showLobby(why === 'opponent left' ? 'Your friend left the room. They can join again with the same code.' : '');
        }
      },
    },
  });
  refreshNames();
}

function displayName(r) {
  if (!r) return 'Your friend';
  if (r.kind === 2) return levelInfo('normal').name; // the room's CPU seat is Skipper
  const slot = match?.session.view?.sl?.[r.pid] ?? r.team ?? 0;
  return !r.name || r.name === 'Player' ? TEAM[slot]?.name ?? 'Friend' : r.name;
}
function refreshNames() {
  if (mode !== 'online' || !match) return;
  const s = match.session;
  const n = ['Coral', 'Teal'];
  for (const r of s.roster.values()) {
    const slot = r.team ?? 0;
    n[slot] = r.pid === s.pid ? (settings.name ? `${settings.name} (you)` : 'You') : displayName(r);
  }
  // Keep the last name we saw for a slot, so a friend who just left is still named.
  names = [0, 1].map((slot) => {
    const r = [...s.roster.values()].find((x) => x.team === slot);
    return r ? (r.pid === s.pid ? 'You' : displayName(r)) : names[slot];
  });
  setNames(n[0], n[1]);
}

function showLobby(note = '') {
  if (!match || mode !== 'online') return;
  const s = match.session;
  $('lobby-h').textContent = s.net.status === 'online' ? codeOf(s) : '----';
  $('lobby-h').setAttribute('aria-label', `Room code ${[...codeOf(s)].join(' ')}`);
  $('lobby-tell').textContent = friendAddress('lobby');
  const ul = $('lobby-roster');
  ul.textContent = '';
  for (const r of s.roster.values()) {
    const li = document.createElement('li');
    li.className = `s${r.team}`;
    li.textContent = `${TEAM[r.team]?.name ?? ''}: ${r.pid === s.pid ? 'you' : r.kind === 2 ? `${displayName(r)} (CPU)` : displayName(r)}${r.online ? '' : ' (reconnecting)'}`;
    ul.append(li);
  }
  // Only seats that are online count: a friend in their grace window isn't "here".
  const seated = [...s.roster.values()].filter((r) => r.kind !== 1);
  const two = seated.filter((r) => r.online).length >= 2;
  const back = seated.find((r) => !r.online && r.pid !== s.pid);
  // A note ("Your friend left the room…") stays through later roster and status
  // updates, until someone takes the empty seat.
  if (note) lobbyNote = note;
  if (seated.length >= 2) lobbyNote = '';
  $('lobby-status').textContent = lobbyNote || (two ? 'Both here. Starting…' : back ? `${displayName(back)} is reconnecting…` : 'Waiting for your friend…');
  $('lobby-cpu').hidden = !s.isHost || seated.length >= 2;
  if (screen !== 'lobby') show('lobby', { push: false });
}
let lobbyNote = '';
let lobbyCode = '';
const codeOf = () => lobbyCode;

// ---------- settings screen ----------
function openSettings() {
  sfx.uiConfirm();
  $('set-volume').value = String(Math.round(getVolume() * 100));
  $('set-mute').checked = isMuted();
  $('set-motion').value = settings.motion;
  $('set-shake').value = String(Math.round(settings.shake * 100));
  $('set-name').value = settings.name;
  $('set-touch').value = settings.touch;
  $('set-swap').checked = settings.swap;
  $('set-tsize').value = settings.tsize;
  $('set-stick').value = settings.stick;
  $('set-easy').checked = settings.easy;
  // Only iPhone and iPad Safari let a page choose to mix with music (navigator.audioSession).
  $('row-music').hidden = !('audioSession' in navigator);
  $('set-music').checked = playsOverMusic();
  $('row-haptics').hidden = !hapticsAvailable();
  $('set-haptics').checked = hapticsOn();
  buildBinds();
  show('settings');
}
const ACTION_NAMES = { up: 'Up', left: 'Left', down: 'Down', right: 'Right', dash: 'Dash (hold to charge)' };
let listening = null;
function buildBinds() {
  const box = $('binds');
  box.textContent = '';
  const blank = document.createElement('span');
  const h0 = document.createElement('span');
  h0.className = 'head c0';
  h0.textContent = 'Coral (P1)';
  const h1 = document.createElement('span');
  h1.className = 'head c1';
  h1.textContent = 'Teal (P2)';
  box.append(blank, h0, h1);
  const b = controls.bindings();
  for (const a of ACTIONS) {
    const label = document.createElement('span');
    label.className = 'act';
    label.textContent = ACTION_NAMES[a];
    box.append(label);
    for (const slot of [0, 1]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn bind';
      btn.textContent = b[slot][a].map(keyLabel).join(' / ');
      btn.setAttribute('aria-label', `${TEAM[slot].name} ${ACTION_NAMES[a]}: ${btn.textContent}. Press to change.`);
      btn.addEventListener('click', () => {
        listening = { slot, action: a, btn };
        btn.classList.add('listening');
        btn.textContent = 'Press a key…';
        $('bind-msg').textContent = `Press the new key for ${TEAM[slot].name} ${ACTION_NAMES[a].toLowerCase()}, or Esc to cancel.`;
      });
      box.append(btn);
    }
  }
}
window.addEventListener(
  'keydown',
  (e) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    const { slot, action } = listening;
    listening = null;
    if (e.code !== 'Escape') {
      if (controls.bind(slot, action, e.code)) {
        $('bind-msg').textContent = `${TEAM[slot].name} ${ACTION_NAMES[action].toLowerCase()} is now ${keyLabel(e.code)}.`;
        saveSettings();
        controlsLine();
      } else $('bind-msg').textContent = `${e.code.replace(/Left|Right/, '')} can't be used: Shift, Esc, Tab, M and P are kept free.`;
    } else $('bind-msg').textContent = 'Cancelled.';
    buildBinds();
    $('binds').querySelectorAll('button')[ACTIONS.indexOf(action) * 2 + slot]?.focus();
  },
  { capture: true, signal: ac.signal },
);
$('set-volume').addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));
$('set-volume').addEventListener('change', () => sfx.uiMove());
$('set-mute').addEventListener('change', (e) => setMuted(e.target.checked));
$('set-motion').addEventListener('change', (e) => {
  settings.motion = e.target.value;
  applyMotionAttr();
  saveSettings();
});
$('set-shake').addEventListener('input', (e) => {
  settings.shake = Number(e.target.value) / 100;
  saveSettings();
});
$('set-touch').addEventListener('change', (e) => {
  settings.touch = e.target.value;
  saveSettings();
  updateTouch();
});
$('set-swap').addEventListener('change', (e) => {
  settings.swap = e.target.checked;
  saveSettings();
  relayout();
});
$('set-tsize').addEventListener('change', (e) => {
  settings.tsize = e.target.value;
  saveSettings();
  applyTouchOptions();
});
$('set-stick').addEventListener('change', (e) => {
  settings.stick = e.target.value;
  saveSettings();
  applyTouchOptions();
});
$('set-easy').addEventListener('change', (e) => {
  settings.easy = e.target.checked;
  saveSettings();
  applyTouchOptions();
});
$('set-music').addEventListener('change', (e) => setOverMusic(e.target.checked));
$('set-haptics').addEventListener('change', (e) => {
  setHaptics(e.target.checked);
  if (e.target.checked) feel.hit(0.6);
});
$('set-name').addEventListener('change', (e) => {
  settings.name = e.target.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  e.target.value = settings.name;
  saveSettings();
});

// ---------- buttons ----------
stage.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  switch (act) {
    case 'solo':
      return openCpuPicker();
    case 'cpu': {
      const id = b.dataset.level;
      if (!unlocked(id)) {
        sfx.uiBack();
        $('cpu-status').textContent = `${levelInfo(id).name} is locked. ${lockedLine(levelInfo(id))}`;
        return;
      }
      return startLocal('cpu', id);
    }
    case 'next':
      if (b.dataset.level) return startLocal('cpu', b.dataset.level);
      return openCpuPicker({ push: false });
    case 'play2p':
      return startLocal('2p');
    case 'online':
      return openOnline();
    case 'settings':
      return openSettings();
    case 'back':
      return goBack();
    case 'resetkeys':
      controls.reset();
      saveSettings();
      controlsLine();
      buildBinds();
      $('bind-msg').textContent = 'Keys reset.';
      return;
    case 'resume':
      return resume();
    case 'restart':
      return startLocal(mode);
    case 'quit':
      sfx.uiBack();
      return toTitle();
    case 'rematch':
      return rematch();
    case 'rejoin': {
      const room = savedRoom();
      if (!room) {
        sfx.uiBack();
        refreshTitle();
        live('That seat has expired. Make or join a room again.');
        return;
      }
      lobbyCode = room.code;
      sfx.uiConfirm();
      return startOnline(room.code, false, room);
    }
    case 'make': {
      lobbyCode = makeJoinCode();
      sfx.uiConfirm();
      return startOnline(lobbyCode, true);
    }
    case 'addcpu':
      sfx.uiConfirm();
      return match?.addCpu();
    case 'leave':
      sfx.uiBack();
      return toTitle();
    case 'sound':
      // A click is a user gesture, so turning sound on can start audio right here.
      setMuted(!isMuted());
      if (!isMuted()) sfx.uiConfirm();
      live(isMuted() ? 'Sound off.' : 'Sound on.');
      return;
    case 'pause':
      return pause();
    case 'update':
      return pwa.reload();
  }
});
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normalizeJoinCode($('join-code').value);
  if (!isJoinCode(code)) {
    $('online-status').textContent = 'Room codes are 4 letters or numbers, like K7Q0.';
    sfx.uiBack();
    $('join-code').focus();
    return;
  }
  lobbyCode = code;
  sfx.uiConfirm();
  startOnline(code, false);
});

// A dash key still held when a menu opens (Space, or Enter for Teal) must not press
// the button that just got focus: ignore its auto-repeat, and the release of a key that
// went down before the menu appeared.
const keyDownAt = new Map();
let shownAt = 0;
const ACTIVATE = new Set(['Space', 'Enter', 'NumpadEnter']);
window.addEventListener(
  'keydown',
  (e) => {
    if (!e.repeat) keyDownAt.set(e.code, performance.now());
    if (screen && e.repeat && ACTIVATE.has(e.code)) e.preventDefault();
  },
  { capture: true, signal: ac.signal },
);
window.addEventListener(
  'keyup',
  (e) => {
    if (screen && ACTIVATE.has(e.code) && (keyDownAt.get(e.code) ?? 0) < shownAt) e.preventDefault();
    keyDownAt.delete(e.code);
  },
  { capture: true, signal: ac.signal },
);

// Arrow keys move between a screen's buttons; Esc goes back; M mutes anywhere.
window.addEventListener(
  'keydown',
  (e) => {
    if (listening) return;
    const typing = e.target instanceof Element && e.target.closest('input[type="text"], select, input[type="range"]');
    if (e.code === 'KeyM' && !typing && !e.ctrlKey && !e.metaKey) {
      setMuted(!isMuted());
      if ($('set-mute')) $('set-mute').checked = isMuted();
      live(isMuted() ? 'Sound off.' : 'Sound on.');
      return;
    }
    if (e.code === 'Backquote' && mode === 'online') return match?.toggleOverlay();
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (typing && e.code === 'KeyP') return;
      e.preventDefault();
      if (screen) return goBack();
      return pause();
    }
    if (!screen || typing) return;
    const dirs = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (e.code in dirs) {
      e.preventDefault();
      moveFocus(dirs[e.code]);
    }
  },
  { signal: ac.signal },
);
function moveFocus(d) {
  const panel = $(`scr-${screen}`);
  const items = [...panel.querySelectorAll('button, input, select')].filter((el) => !el.hidden && !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = items[(i + d + items.length) % items.length];
  next.focus();
  sfx.uiMove();
}
stage.addEventListener('focusin', (e) => {
  if (screen && e.target.matches('button') && e.relatedTarget) sfx.uiMove();
});

// Gamepads in menus: d-pad moves, A presses, B goes back, Start pauses.
controls.onJoin((slot) => {
  sfx.uiConfirm();
  live(`Controller joined as ${TEAM[slot].name}.`);
  $('pad-hint').textContent = `Controller ${slot + 1} ready. Press A again to start.`;
});
controls.onPadButton((btn) => {
  if (!screen) {
    if (btn === 'start') pause();
    return;
  }
  if (btn === 'up' || btn === 'left') moveFocus(-1);
  else if (btn === 'down' || btn === 'right') moveFocus(1);
  else if (btn === 'a') {
    const el = document.activeElement;
    if (el && el.closest(`#scr-${screen}`) && el.tagName === 'BUTTON') el.click();
    else $(`scr-${screen}`).querySelector('.btn-primary')?.focus();
  } else if (btn === 'b' && screen !== 'title') goBack();
});

// ---------- touch ----------
// The on-screen controls show while someone plays by touch: from the start on a touch
// screen (pointer: coarse), or from the first touch anywhere. A key or a gamepad
// button hides them again; Settings can force them on or off.
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
controls.setDevice(coarse ? 'touch' : 'keys');
const touchLayer = $('touch');
const touchVisuals = createTouchVisuals(touchLayer, { radius: () => router.radius });
const router = createTouchRouter({ controls, onVisual: touchVisuals.onVisual });
function applyTouchOptions() {
  router.setOptions({ size: settings.tsize, stick: settings.stick, easy: settings.easy });
  touchLayer.dataset.tsize = settings.tsize;
  touchLayer.dataset.stick = settings.stick;
  for (const el of touchLayer.querySelectorAll('.tpad-dash small')) el.textContent = settings.easy ? 'tap · tap again' : 'tap · hold';
}
applyTouchOptions();
attachTouch(touchLayer, router, { signal: ac.signal });
const padEls = [...touchLayer.querySelectorAll('.tpad')];
let touchKind = ''; // '', 'solo', 'split-v' or 'split-h'
const stageSize = { w: 0, h: 0 };
const safe = { t: 0, r: 0, b: 0, l: 0 };

const touchWanted = () => (settings.touch === 'auto' ? controls.device === 'touch' : settings.touch === 'on');
const touchShown = () => !touchLayer.hidden;
function onDeviceChange(d) {
  document.documentElement.dataset.device = d;
  $('sub-2p').textContent = d === 'touch' ? 'Share this screen: one end each' : 'One keyboard or two controllers';
  controlsLine();
  updateTouch();
}
controls.onDevice(onDeviceChange);
// A touch that lands anywhere (a menu button too) means this is a touch player now.
window.addEventListener('pointerdown', (e) => e.pointerType !== 'mouse' && controls.useDevice('touch'), { capture: true, signal: ac.signal });

function updateTouch() {
  const playing = !!match && mode !== 'title' && !screen;
  const show = playing && touchWanted();
  if (show && !stageSize.w) measure(); // which way up the screen is decides the shared layout
  const kind = !show ? '' : mode === '2p' ? (stageSize.h > stageSize.w ? 'split-v' : 'split-h') : 'solo';
  touchLayer.hidden = !show;
  $('corner').hidden = !playing;
  document.documentElement.classList.toggle('playing', playing);
  if (kind !== touchKind) {
    touchKind = kind;
    touchLayer.dataset.layout = kind || 'solo';
    stage.dataset.layout = kind;
    relayout();
  }
}

// Where the floe goes and where each player's pad is. Runs on resize and when the
// controls change, never in the frame loop.
let padsFor = '';
function measure() {
  stageSize.w = stage.clientWidth;
  stageSize.h = stage.clientHeight;
  const cs = getComputedStyle(safeProbe);
  safe.t = parseFloat(cs.paddingTop) || 0;
  safe.r = parseFloat(cs.paddingRight) || 0;
  safe.b = parseFloat(cs.paddingBottom) || 0;
  safe.l = parseFloat(cs.paddingLeft) || 0;
}
function relayout() {
  // Normally the ResizeObserver has measured already; before its first callback (or in
  // a background tab, where it waits for a frame) measure once here.
  if (!stageSize.w || !stageSize.h) measure();
  const { w, h } = stageSize;
  if (!w || !h) return;
  // Only a different layout lets go of held fingers; a resize of the same one keeps them.
  const which = `${touchKind}|${settings.swap}`;
  const keep = which === padsFor;
  padsFor = which;
  router.setPads(layoutPads(touchKind, w, h, { swap: settings.swap }), { keep });
  if (!keep) touchVisuals.reset();
  touchLayer.toggleAttribute('data-swap', settings.swap);
  const hudH = w <= 520 ? 54 : 46; // narrow: the HUD stacks names over pips
  let insets;
  if (touchKind === 'split-v') insets = { top: h * 0.21, bottom: h * 0.21, left: safe.l + 4, right: safe.r + 4 };
  else if (touchKind === 'split-h') insets = { top: safe.t + 4, bottom: safe.b + 4, left: w * 0.21, right: w * 0.21 };
  else {
    insets = { top: Math.max(safe.t + hudH + 6, h * 0.089), bottom: safe.b + 6, left: safe.l + 6, right: safe.r + 6 };
    // Upright phone: the thumbs live under the floe, so lift it clear of them.
    if (touchKind === 'solo' && h > w * 1.15) insets.bottom = Math.max(insets.bottom, Math.min(h * 0.28, 240));
  }
  renderer.setView({ insets, split: touchKind === 'split-v' ? 'v' : touchKind === 'split-h' ? 'h' : null });
  // Two players sharing the screen: sound and pause sit just off the floe, so they never
  // cover the ice (below it when upright, beside it when sideways).
  const v = renderer.view;
  stage.style.setProperty('--corner-x', `${Math.round(v.cx + 330 * v.scale + 6)}px`);
  stage.style.setProperty('--corner-y', `${Math.round(v.cy + 300 * v.scale + 4)}px`);
}
const safeProbe = document.createElement('div');
safeProbe.className = 'safe-probe';
safeProbe.setAttribute('aria-hidden', 'true');
stage.append(safeProbe);
new ResizeObserver(() => {
  measure();
  if (screen === 'title') checkStrip();
  // Turning the device mid-match swaps the shared-screen layout.
  const kind = touchKind && mode === '2p' ? (stageSize.h > stageSize.w ? 'split-v' : 'split-h') : touchKind;
  if (kind !== touchKind) {
    touchKind = kind;
    touchLayer.dataset.layout = kind;
    stage.dataset.layout = kind;
  }
  relayout();
}).observe(stage);

// Per drawn frame: each pad's charge ring and its round-1 "put your thumb here" ring.
const teachShown = [null, null];
function drawTouch(scene) {
  if (!touchKind) return;
  const pads = touchKind === 'solo' ? [0] : [0, 1];
  for (const s of pads) {
    // Solo: the pad drives you, whichever colour you are online.
    const f = scene.fighters[touchKind === 'solo' ? (mode === 'online' ? match.mySlot : 0) : s];
    touchVisuals.charge(s, f && f.ph === PH.CHARGE ? f.charge : 0);
    const teach = (scene.round ?? 0) <= 1 && !controls.used(s);
    if (teach !== teachShown[s]) {
      teachShown[s] = teach;
      padEls[s].classList.toggle('teach', teach);
    }
  }
}

// iPhone: block pinch-zoom (Safari's own gesture events) and rubber-banding while a
// match is on. Pointer events still arrive. Menus scroll and zoom as normal.
const playingNow = () => document.documentElement.classList.contains('playing');
document.addEventListener('gesturestart', (e) => playingNow() && e.preventDefault(), { passive: false, signal: ac.signal });
stage.addEventListener('touchmove', (e) => playingNow() && e.cancelable && e.preventDefault(), { passive: false, signal: ac.signal });
// Leaving the page lets go of every finger (an online match keeps running meanwhile).
const letGo = () => {
  router.releaseAll();
  touchVisuals.reset();
};
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && letGo(), { signal: ac.signal });
window.addEventListener('blur', letGo, { signal: ac.signal });
// iOS only shows :active on buttons when the page listens for touches.
document.addEventListener('touchstart', () => {}, { passive: true, signal: ac.signal });

// Sound, everywhere: the corner button while playing, and on the title and pause menus.
function syncSound() {
  for (const b of document.querySelectorAll('[data-act="sound"]')) {
    b.setAttribute('aria-pressed', String(!isMuted()));
    const st = b.querySelector('.sound-state');
    if (st) st.textContent = isMuted() ? 'off' : 'on';
  }
}
onMuteChange(syncSound);
syncSound();
onDeviceChange(controls.device);
relayout(); // the floe's first fit, before the ResizeObserver's first callback

// Offline play and updates (js/pwa.js): the service worker, and a "new version" toast
// that only ever shows in the menus, never over a match.
const pwa = setupOffline({ toast: $('update'), canShow: () => !!screen });

// Pausing local play when the tab is hidden or the window loses focus. Online
// play keeps going (online.js tells the server we're away).
let debugHold = false; // ?debug: freeze the sim while frames keep drawing
// On a phone that's the lock button, a call, or swiping to another app: the match
// waits on the pause screen with Resume focused.
const autoPause = () => !debugHold && mode !== 'online' && mode !== 'title' && !screen && pause();
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && autoPause(), { signal: ac.signal });
window.addEventListener('blur', autoPause, { signal: ac.signal });
window.addEventListener('pagehide', autoPause, { signal: ac.signal });

// ---------- the loop ----------
const strip = $('strip');
let lastRender = 0;
let demoFrame = 0;
let stripShown = true;
// Checked when the stage resizes and when a screen opens, never in the frame loop.
const checkStrip = () => (stripShown = strip.offsetParent !== null && strip.getClientRects().length > 0);
const loop = createLoop({
  hz: TUNING.tickHz, // the same 60 Hz step the server runs
  maxFps: coarse ? 60 : 0, // a 120 Hz phone draws every other frame; the sim is unaffected
  update() {
    if (!match || debugHold) return;
    if (mode === 'online' || mode === 'title' || (!paused && !screen)) match.update();
  },
  render(alpha) {
    const now = performance.now();
    const frameMs = lastRender ? now - lastRender : 1000 / 60;
    lastRender = now;
    controls.pollMenus();
    // The title's demo match behind a menu panel is drawn at half rate: it's mostly covered.
    const behindMenu = mode === 'title' && !!screen && (demoFrame++ & 1) === 1;
    if (match && !behindMenu) {
      const scene = match.scene(alpha, now, frameMs);
      renderer.draw(scene, now);
      if (mode !== 'title') hud.set(scene);
      drawTouch(scene);
      // Online rematch: both pressed, the next round is counting down.
      if (screen === 'score' && mode === 'online' && (match.state === 'cd' || match.state === 'fight')) hideScreens();
      else if (screen === 'score' && mode === 'online') syncRematch();
    }
    // The strip is hidden on phones (portrait under 560 px, short screens): don't draw it.
    if (screen === 'title' && stripShown && !behindMenu) renderer.drawStrip(strip, now);
  },
});

if (DEBUG) {
  window.__game = {
    get state() {
      return match?.debugState?.() ?? { mode, online: match?.session?.view };
    },
    step(n = 1) {
      for (let i = 0; i < n; i++) match?.update();
    },
    // Draw one frame now (a hidden or throttled tab may not be painting).
    draw: () => loop.advance(0),
    hold(on = true) {
      debugHold = !!on;
    },
    audio: audioState,
    controls,
    touch: router,
    view: () => renderer.view,
  };
  const box = $('debug');
  box.hidden = false;
  const fields = $('debug-fields');
  const skip = new Set(['tickHz', 'snapshotHz', 'inputSendHz', 'maxInputsPerTick', 'inputBurst', 'maxQueuedInputs', 'graceMs', 'hexSize', 'rings']);
  for (const [k, v] of Object.entries(TUNING)) {
    if (skip.has(k) || typeof v !== 'number') continue;
    const label = document.createElement('label');
    label.textContent = k;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = String(v);
    input.addEventListener('change', () => {
      if (mode === 'online') return void (input.value = String(TUNING[k]));
      setTuning({ [k]: Number(input.value) });
    });
    label.append(input);
    fields.append(label);
  }
}

controlsLine();
toTitle();
loop.start();
