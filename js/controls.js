// Input for Shove Off, by player and action, never by key in the game code.
//
//   const controls = createControls({ bindings, signal });
//   controls.step();                 // once per fixed tick, before sampling
//   controls.sample(0) -> { mx, my, b }   // the shared sim's input shape
//
// Keyboard: by KeyboardEvent.code, so WASD stays WASD on AZERTY. Two players share
// one keyboard with disjoint keys, and nothing is bound to Shift (sticky-keys
// prompts on Windows, and some laptops drop chords with it).
// Gamepads: a pad joins by pressing A, taking the first free player.
// Touch: js/touch.js turns fingers into a stick vector and a DASH button per player
// (touchStick / touchDash below), one player's pad or two on a shared screen.
// Every device ends in sim.js's deviceInput, the same call the CPU's virtual pad makes.
//
// The last device used is tracked (keys, pad or touch), so the page can show the
// on-screen controls only while someone is actually playing by touch.
//
// Edges are aligned to the fixed step: a dash tap shorter than one tick still
// counts once (the sim sees "pressed" without "held" and fires a jab).

import { deviceInput } from './game/sim.js';

export const ACTIONS = ['up', 'left', 'down', 'right', 'dash'];
export const DEFAULT_BINDINGS = {
  0: { up: ['KeyW'], left: ['KeyA'], down: ['KeyS'], right: ['KeyD'], dash: ['Space', 'KeyF'] },
  // Enter is a second Teal dash that's easier to hold while steering with the arrows
  // than / or . on a laptop, and nowhere near Coral (not playtested yet).
  1: { up: ['ArrowUp'], left: ['ArrowLeft'], down: ['ArrowDown'], right: ['ArrowRight'], dash: ['Slash', 'Enter', 'Period', 'Numpad0'] },
};
const FORBIDDEN = new Set(['ShiftLeft', 'ShiftRight', 'Escape', 'Tab', 'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'KeyM', 'KeyP', 'CapsLock']);
export const isBindable = (code) => typeof code === 'string' && !FORBIDDEN.has(code) && /^(Key[A-Z]|Digit\d|Numpad\w+|Arrow\w+|Space|Slash|Period|Comma|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote|Enter|Backspace|IntlBackslash)$/.test(code);

export function codeLabel(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const names = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Space: 'Space',
    Slash: '/',
    Period: '.',
    Comma: ',',
    Semicolon: ';',
    Quote: "'",
    Numpad0: 'Num 0',
    Enter: 'Enter',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
  };
  return names[code] ?? code.replace(/^Numpad/, 'Num ');
}

// Chromium can say what each physical key prints on this layout (secure contexts).
let layout = null;
if (typeof navigator !== 'undefined') {
  navigator.keyboard?.getLayoutMap?.().then(
    (m) => (layout = m),
    () => {},
  );
}
export function keyLabel(code) {
  const k = layout?.get?.(code);
  return typeof k === 'string' && k.length === 1 && k.trim() && /^Key|^Digit/.test(code) ? k.toUpperCase() : codeLabel(code);
}

export function cleanBindings(saved) {
  const out = { 0: {}, 1: {} };
  for (const slot of [0, 1]) {
    for (const a of ACTIONS) {
      const keys = saved?.[slot]?.[a];
      out[slot][a] = Array.isArray(keys) && keys.length && keys.every(isBindable) ? keys.slice(0, 4) : [...DEFAULT_BINDINGS[slot][a]];
    }
  }
  return out;
}

const PAD_A = 0;
const PAD_B = 1;
const PAD_RT = 7;
const DEADZONE = 0.22;

export function createControls({ bindings = DEFAULT_BINDINGS, signal } = {}) {
  let binds = cleanBindings(bindings);
  let byCode = new Map(); // code -> [{ slot, action }]
  const reindex = () => {
    byCode = new Map();
    for (const slot of [0, 1]) for (const a of ACTIONS) for (const c of binds[slot][a]) byCode.set(c, [...(byCode.get(c) ?? []), { slot, action: a }]);
  };
  reindex();

  const down = new Set();
  const pendingPress = [false, false];
  const used = [false, false]; // has this player touched their keys yet (tutorial hints)
  const pads = [null, null]; // slot -> gamepad index
  const padPrev = new Map(); // index -> { dash, a, b, up, down }
  const padEdges = new Map();
  // Per player: the stick vector (already dead-zoned, length <= 1) and DASH.
  const touch = [0, 1].map(() => ({ active: false, x: 0, y: 0, dash: false, pressed: false }));
  let enabled = false; // the game ignores input while a menu is open
  let merged = false; // CPU and online: every key set drives player 0
  let onJoin = () => {};
  let onPadButton = () => {};
  let device = null; // 'keys' | 'pad' | 'touch': the last one used
  let onDevice = () => {};
  const noteDevice = (d) => {
    if (d === device) return;
    device = d;
    onDevice(d);
  };

  const isTyping = (e) => e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
  function onKeyDown(e) {
    if (e.isComposing || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!/^(Shift|Control|Alt|Meta|OS)/.test(e.code)) noteDevice('keys');
    const bound = byCode.get(e.code);
    if (!bound || !enabled) return;
    // While playing, our keys are the game's: no page scroll, no button activation.
    e.preventDefault();
    if (e.repeat) return;
    for (const { slot, action } of bound) {
      const s = merged ? 0 : slot;
      used[s] = true;
      if (action === 'dash' && !dashHeldKeys(slot)) pendingPress[s] = true;
    }
    down.add(e.code);
  }
  function onKeyUp(e) {
    if (e.key === 'Meta') return down.clear(); // macOS drops keyups while Cmd is held
    down.delete(e.code);
  }
  const releaseAll = () => {
    down.clear();
    for (const t of touch) {
      t.active = t.dash = t.pressed = false;
      t.x = t.y = 0;
    }
  };
  // In Node (tests) there is no window: the touch and pad paths still work.
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown, { signal });
    window.addEventListener('keyup', onKeyUp, { signal });
    window.addEventListener('blur', releaseAll, { signal });
    document.addEventListener('visibilitychange', releaseAll, { signal });
  }

  const anyDown = (keys) => keys.some((k) => down.has(k));
  const dashHeldKeys = (slot) => anyDown(binds[slot].dash);

  function keyVector(slot) {
    const b = binds[slot];
    return [(anyDown(b.right) ? 1 : 0) - (anyDown(b.left) ? 1 : 0), (anyDown(b.down) ? 1 : 0) - (anyDown(b.up) ? 1 : 0)];
  }

  function readPads() {
    try {
      return navigator.getGamepads?.() ?? [];
    } catch {
      return [];
    }
  }

  // Poll pads: joins (A on an unassigned pad), menu buttons, and this step's edges.
  function pollPads() {
    padEdges.clear();
    for (const p of readPads()) {
      if (!p || !p.connected) continue;
      const prev = padPrev.get(p.index) ?? { dash: false, a: false, b: false, up: false, down: false, left: false, right: false };
      const a = !!p.buttons[PAD_A]?.pressed;
      const dash = a || (p.buttons[PAD_RT]?.value ?? 0) > 0.4;
      const bBtn = !!p.buttons[PAD_B]?.pressed;
      const y = p.axes[1] ?? 0;
      const x = p.axes[0] ?? 0;
      const up = !!p.buttons[12]?.pressed || y < -0.6;
      const dn = !!p.buttons[13]?.pressed || y > 0.6;
      const lf = !!p.buttons[14]?.pressed || x < -0.6;
      const rt = !!p.buttons[15]?.pressed || x > 0.6;
      const now = { dash, a, b: bBtn, up, down: dn, left: lf, right: rt };
      if (dash || a || bBtn || up || dn || lf || rt || p.buttons.some((b) => b?.pressed)) noteDevice('pad');
      padEdges.set(p.index, { dash: dash && !prev.dash });
      if (a && !prev.a) {
        if (!pads.includes(p.index)) {
          const slot = pads[0] === null ? 0 : pads[1] === null ? 1 : -1;
          if (slot >= 0) {
            pads[slot] = p.index;
            onJoin(slot, p.index);
          }
        }
        onPadButton('a', p.index);
      }
      if (bBtn && !prev.b) onPadButton('b', p.index);
      if (up && !prev.up) onPadButton('up', p.index);
      if (dn && !prev.down) onPadButton('down', p.index);
      if (lf && !prev.left) onPadButton('left', p.index);
      if (rt && !prev.right) onPadButton('right', p.index);
      if (p.buttons[9]?.pressed && !prev.start) onPadButton('start', p.index);
      now.start = !!p.buttons[9]?.pressed;
      padPrev.set(p.index, now);
    }
  }

  function padState(slot) {
    const idx = merged ? (pads[0] ?? pads[1]) : pads[slot];
    if (idx === null || idx === undefined) return null;
    const p = readPads()[idx];
    if (!p || !p.connected) return null;
    let x = p.axes[0] ?? 0;
    let y = p.axes[1] ?? 0;
    const m = Math.hypot(x, y);
    if (m <= DEADZONE) x = y = 0;
    else {
      const k = Math.min(1, (m - DEADZONE) / (1 - DEADZONE)) / m;
      x *= k;
      y *= k;
    }
    const dx = (p.buttons[15]?.pressed ? 1 : 0) - (p.buttons[14]?.pressed ? 1 : 0);
    const dy = (p.buttons[13]?.pressed ? 1 : 0) - (p.buttons[12]?.pressed ? 1 : 0);
    if (dx || dy) {
      x = dx;
      y = dy;
    }
    const dash = !!p.buttons[PAD_A]?.pressed || (p.buttons[PAD_RT]?.value ?? 0) > 0.4;
    return { x, y, dash, pressed: !!padEdges.get(idx)?.dash };
  }

  const edges = [false, false];
  const api = {
    // Once per fixed tick, before sample().
    step() {
      pollPads();
      for (const s of [0, 1]) {
        edges[s] = pendingPress[s] || touch[s].pressed;
        pendingPress[s] = false;
        touch[s].pressed = false;
      }
    },
    sample(slot) {
      if (!enabled) return { mx: 0, my: 0, b: 0 };
      let [kx, ky] = merged ? keyVector(0).map((v, i) => v || keyVector(1)[i]) : keyVector(slot);
      let held = merged ? dashHeldKeys(0) || dashHeldKeys(1) : dashHeldKeys(slot);
      let pressed = edges[slot];
      const pad = padState(slot);
      if (pad) {
        if (!kx && !ky) [kx, ky] = [pad.x, pad.y];
        held ||= pad.dash;
        pressed ||= pad.pressed;
      }
      const t = touch[slot];
      if (t.active && !kx && !ky) {
        kx = t.x;
        ky = t.y;
      }
      if (t.dash) held = true;
      if (pressed) used[slot] = true;
      // The one way any device becomes the sim's input (the CPU's pad uses it too).
      const input = deviceInput(kx, ky, held, pressed);
      if (input.mx || input.my) used[slot] = true;
      return input;
    },
    setEnabled(v) {
      enabled = !!v;
      if (!enabled) {
        pendingPress[0] = pendingPress[1] = false;
        touch[0].pressed = touch[1].pressed = false;
      }
    },
    get enabled() {
      return enabled;
    },
    setMerged(v) {
      merged = !!v;
    },
    releaseAll,
    used: (slot) => used[slot],
    resetUsed() {
      used[0] = used[1] = false;
    },
    // Remapping: the key replaces this action's keys; it's taken off anything else.
    bind(slot, action, code) {
      if (!isBindable(code)) return false;
      for (const s of [0, 1]) for (const a of ACTIONS) binds[s][a] = binds[s][a].filter((c) => c !== code);
      binds[slot][action] = [code];
      for (const s of [0, 1]) for (const a of ACTIONS) if (!binds[s][a].length) binds[s][a] = [...DEFAULT_BINDINGS[s][a]].filter((c) => !byCodeHas(c, s, a));
      reindex();
      down.clear();
      return true;
    },
    reset() {
      binds = cleanBindings(DEFAULT_BINDINGS);
      reindex();
    },
    bindings: () => JSON.parse(JSON.stringify(binds)),
    labels: (slot, action) => binds[slot][action].map(keyLabel),
    // Touch (js/touch.js): a player's stick, x and y in -1..1 after the dead zone,
    // and their DASH button. A press that goes up before the next tick still counts
    // once, as a jab, exactly like a key tap.
    touchStick(slot, x, y, active = true) {
      const t = touch[slot];
      if (!t) return;
      noteDevice('touch');
      t.active = !!active;
      t.x = active ? x : 0;
      t.y = active ? y : 0;
      if (active && (x || y)) used[slot] = true;
    },
    touchDash(slot, isDown) {
      const t = touch[slot];
      if (!t) return;
      noteDevice('touch');
      if (isDown && !t.dash && enabled) t.pressed = true;
      t.dash = !!isDown;
      if (isDown) used[slot] = true;
    },
    get device() {
      return device;
    },
    // fn(device) whenever a different kind of device is used; setDevice seeds it.
    onDevice(fn) {
      onDevice = fn;
    },
    setDevice(d) {
      device = d;
    },
    useDevice: (d) => noteDevice(d),
    pads: () => [...pads],
    padCount: () => [...readPads()].filter((p) => p && p.connected).length,
    unassignPads() {
      pads[0] = pads[1] = null;
    },
    onJoin(fn) {
      onJoin = fn;
    },
    onPadButton(fn) {
      onPadButton = fn;
    },
    // Menus poll pads every frame even while the game isn't stepping.
    pollMenus() {
      if (!enabled) pollPads();
    },
  };
  function byCodeHas(code, s, a) {
    return [0, 1].some((ss) => ACTIONS.some((aa) => !(ss === s && aa === a) && binds[ss][aa].includes(code)));
  }
  return api;
}
