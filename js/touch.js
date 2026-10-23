// Touch controls for Shove Off: a floating stick for the left thumb that appears where
// the thumb lands, and a big DASH button for the right thumb (tap to jab, hold to
// charge, let go to launch). Fingers go to js/controls.js (touchStick / touchDash) and
// from there through the same deviceInput call as the keyboard, pads and the CPU.
//
// The router is plain logic over plain points, so node:test drives it with simulated
// pointer events (tests/touch.test.mjs). attachTouch() wires it to real Pointer
// Events, and createTouchVisuals() moves the knob and fills the charge ring.
//
// Layouts ('solo', or two players sharing one screen):
//   solo     one player: the left half of the screen is the stick, the right half DASH
//   split-v  two players at the top and bottom edges (a phone or tablet held upright)
//   split-h  two players at the left and right edges (held sideways)
// Each pad is a box turned toward its player (rot 0: sitting at the bottom edge, 180:
// the top, 90: the left, -90: the right). In that player's own frame the left half is
// the stick and the right half is DASH, so both players get the same hands.
//
// The stick vector is in screen space, unrotated: drag toward where you want to go on
// the screen and your fighter goes there, whichever edge you're sitting at.

export const TOUCH = {
  radius: 52, // CSS px of thumb travel for a full push (about 8 mm on a phone)
  deadzone: 0.18, // share of the radius where a resting thumb does nothing
  follow: 1.35, // past this many radii the stick's centre trails the thumb, so reversing is instant
};
// Settings: the size of the on-screen controls (a scale on the stick's travel, the DASH
// button and the thumb ring), a fixed stick instead of the floating one, and an easy
// charge (tap DASH to start charging, tap again to launch) for anyone who can't hold.
export const TOUCH_SIZES = { s: 0.85, m: 1, l: 1.25 };

// A drag (dx, dy) in px -> a stick vector with length 0..1. The dead zone is radial and
// scaled: no movement inside it, then 0 rising smoothly to 1 at the rim, so a small
// push is a slow walk instead of a jump to 18% speed. Direction is kept exactly.
export function stickVector(dx, dy, { radius = TOUCH.radius, deadzone = TOUCH.deadzone } = {}, out = { x: 0, y: 0 }) {
  const m = Math.hypot(dx, dy) / radius;
  if (!(m > deadzone)) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const len = Math.min(1, (m - deadzone) / (1 - deadzone));
  const k = len / (m * radius);
  out.x = dx * k;
  out.y = dy * k;
  return out;
}

// Pads for a layout, in stage px. w and h are the pad's size in its own (turned) frame.
export function layoutPads(kind, w, h, { swap = false } = {}) {
  if (kind === 'solo') return [{ slot: 0, cx: w / 2, cy: h / 2, w, h, rot: 0, swap }];
  if (kind === 'split-v')
    return [
      { slot: 0, cx: w / 2, cy: (h * 3) / 4, w, h: h / 2, rot: 0, swap },
      { slot: 1, cx: w / 2, cy: h / 4, w, h: h / 2, rot: 180, swap },
    ];
  if (kind === 'split-h')
    return [
      { slot: 0, cx: w / 4, cy: h / 2, w: h, h: w / 2, rot: 90, swap },
      { slot: 1, cx: (w * 3) / 4, cy: h / 2, w: h, h: w / 2, rot: -90, swap },
    ];
  return [];
}

// A stage point in a pad's own frame (x to its player's right, y toward its player).
export function toPad(p, x, y) {
  const a = (p.rot * Math.PI) / 180;
  const c = Math.round(Math.cos(a) * 1e9) / 1e9;
  const s = Math.round(Math.sin(a) * 1e9) / 1e9;
  const dx = x - p.cx;
  const dy = y - p.cy;
  return [c * dx + s * dy, -s * dx + c * dy];
}

// Which pad a stage point lands in, and which half: 'stick' or 'dash'.
export function hitPad(pads, x, y) {
  for (const p of pads) {
    const [lx, ly] = toPad(p, x, y);
    if (Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2) return { pad: p, part: lx < 0 !== !!p.swap ? 'stick' : 'dash', lx, ly };
  }
  return null;
}

// Fingers -> controls. One finger per stick and one per DASH button, tracked by
// pointerId, so a thumb on the stick and a thumb on DASH work at the same time, and a
// finger that slides into the other half (or the other player's half) keeps doing what
// it started doing. Extra fingers are ignored rather than stealing a control.
// onVisual(kind, slot, state): 'stick' with { ox, oy, x, y, kx, ky } or null on release,
// and 'dash' with true or false.
export function createTouchRouter({ controls, onVisual = () => {}, stick: stickIn = TOUCH } = {}) {
  let pads = [];
  let stick = { ...stickIn };
  let fixed = false;
  let easy = false;
  const latched = new Set(); // slots whose DASH is held by an easy-charge tap
  const fingers = new Map(); // pointerId -> { slot, part }
  const sticks = new Map(); // slot -> { id, ox, oy, x, y, kx, ky }
  const dashes = new Map(); // slot -> pointerId
  const v = { x: 0, y: 0 };

  function release(id) {
    const f = fingers.get(id);
    if (!f) return false;
    fingers.delete(id);
    if (f.part === 'stick') {
      sticks.delete(f.slot);
      controls.touchStick(f.slot, 0, 0, false);
      onVisual('stick', f.slot, null);
    } else {
      dashes.delete(f.slot);
      // Easy charge: lifting the finger doesn't let go; the next tap does.
      if (latched.has(f.slot)) return true;
      controls.touchDash(f.slot, false);
      onVisual('dash', f.slot, false);
    }
    return true;
  }
  function unlatch(slot) {
    if (!latched.delete(slot)) return;
    controls.touchDash(slot, false);
    onVisual('dash', slot, false);
  }
  // Where a fixed stick sits: over the thumb ring, in the pad's lower outer corner.
  function fixedCentre(p) {
    const side = p.swap ? 1 : -1;
    const lx = side * (p.w / 2 - 24 - stick.radius);
    const ly = p.h / 2 - 18 - stick.radius;
    const a = (p.rot * Math.PI) / 180;
    const c = Math.round(Math.cos(a) * 1e9) / 1e9;
    const sn = Math.round(Math.sin(a) * 1e9) / 1e9;
    return { x: p.cx + c * lx - sn * ly, y: p.cy + sn * lx + c * ly };
  }

  return {
    // A finger lands. Returns true if a control took it (the host then captures it).
    down({ pointerId, x, y }) {
      if (fingers.has(pointerId)) return true;
      const hit = hitPad(pads, x, y);
      if (!hit) return false;
      const { slot } = hit.pad;
      if (hit.part === 'stick') {
        if (sticks.has(slot)) return false;
        const o = fixed ? fixedCentre(hit.pad) : { x, y };
        const st = { id: pointerId, ox: o.x, oy: o.y, x, y, kx: 0, ky: 0 };
        sticks.set(slot, st);
        fingers.set(pointerId, { slot, part: 'stick' });
        controls.touchStick(slot, 0, 0, true);
        if (fixed) this.move({ pointerId, x, y });
        else onVisual('stick', slot, st);
      } else {
        if (dashes.has(slot)) return false;
        dashes.set(slot, pointerId);
        fingers.set(pointerId, { slot, part: 'dash' });
        if (easy && latched.has(slot)) {
          // Second tap: launch.
          unlatch(slot);
          return true;
        }
        if (easy) latched.add(slot);
        controls.touchDash(slot, true);
        onVisual('dash', slot, true);
      }
      return true;
    },
    move({ pointerId, x, y }) {
      const f = fingers.get(pointerId);
      if (!f || f.part !== 'stick') return;
      const st = sticks.get(f.slot);
      let dx = x - st.ox;
      let dy = y - st.oy;
      const d = Math.hypot(dx, dy);
      const lim = stick.radius * stick.follow;
      if (d > lim && !fixed) {
        // The centre follows the thumb: swing the other way and you turn at once,
        // instead of first dragging back across the whole old push.
        st.ox = x - (dx / d) * lim;
        st.oy = y - (dy / d) * lim;
        dx = x - st.ox;
        dy = y - st.oy;
      }
      st.x = x;
      st.y = y;
      stickVector(dx, dy, stick, v);
      st.kx = v.x;
      st.ky = v.y;
      controls.touchStick(f.slot, v.x, v.y, true);
      onVisual('stick', f.slot, st);
    },
    // pointerup, pointercancel and lostpointercapture all end a finger: the browser
    // cancels pointers for system gestures, rotation and palm rejection, and a control
    // that only listened for pointerup would stay stuck on.
    up({ pointerId }) {
      return release(pointerId);
    },
    cancel({ pointerId }) {
      return release(pointerId);
    },
    releaseAll() {
      for (const id of [...fingers.keys()]) release(id);
      for (const slot of [...latched]) unlatch(slot);
    },
    // size: 's' | 'm' | 'l'; stick: 'float' | 'fixed'; easy: tap to charge, tap to launch.
    setOptions({ size = 'm', stick: mode = 'float', easy: e = false } = {}) {
      this.releaseAll();
      stick = { ...stickIn, radius: stickIn.radius * (TOUCH_SIZES[size] ?? 1) };
      fixed = mode === 'fixed';
      easy = !!e;
    },
    get radius() {
      return stick.radius;
    },
    // A new layout (rotation, a different mode): let go of everything first, so no
    // finger stays attached to a control that moved out from under it. The same layout
    // at a new size (a browser bar sliding, a split-view resize) keeps held fingers.
    setPads(next, { keep = false } = {}) {
      if (!keep) this.releaseAll();
      pads = next;
    },
    get pads() {
      return pads;
    },
    get fingers() {
      return fingers.size;
    },
    stickOf: (slot) => sticks.get(slot) ?? null,
    dashDown: (slot) => dashes.has(slot),
  };
}

// ---------------------------------------------------------------------------
// Browser wiring. layer is the full-stage touch surface (touch-action: none in CSS).
export function attachTouch(layer, router, { signal } = {}) {
  let rect = null;
  const pt = (e) => ({ pointerId: e.pointerId, x: e.clientX - rect.left, y: e.clientY - rect.top });
  const opts = { signal };
  layer.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Read once per finger, in the event, never in the frame loop.
      rect = layer.getBoundingClientRect();
      if (!router.down(pt(e))) return;
      e.preventDefault();
      try {
        layer.setPointerCapture(e.pointerId);
      } catch {
        /* a synthetic event, or the pointer already ended */
      }
    },
    opts,
  );
  layer.addEventListener('pointermove', (e) => rect && router.move(pt(e)), opts);
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) layer.addEventListener(t, (e) => router.up(e), opts);
  // Android's long-press menu and iOS's callout would otherwise pop up under a held thumb.
  layer.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
}

// The knob, the stick's ring and the DASH button's charge ring. Everything moves with
// transform and opacity, so nothing here causes layout; charge() writes the ring's
// stroke offset only when the value visibly changes.
export function createTouchVisuals(root, { radius = () => TOUCH.radius } = {}) {
  const stickEls = [0, 1].map((s) => root.querySelector(`[data-stick="${s}"]`));
  const dashEls = [0, 1].map((s) => root.querySelector(`[data-dash="${s}"]`));
  const rings = dashEls.map((el) => el?.querySelector('.ring') ?? null);
  const shown = [-1, -1];
  const full = [false, false];
  return {
    onVisual(kind, slot, state) {
      if (kind === 'stick') {
        const el = stickEls[slot];
        if (!el) return;
        if (!state) {
          el.classList.remove('on');
          return;
        }
        el.classList.add('on');
        el.style.transform = `translate3d(${state.ox}px, ${state.oy}px, 0)`;
        // The knob sits under the thumb, held to the ring's edge.
        let dx = state.x - state.ox;
        let dy = state.y - state.oy;
        const d = Math.hypot(dx, dy);
        const r = radius();
        if (d > r) {
          dx *= r / d;
          dy *= r / d;
        }
        const knob = el.firstElementChild;
        if (knob) knob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      } else dashEls[slot]?.classList.toggle('down', !!state);
    },
    // Once per drawn frame with each player's charge (0..1) from the scene.
    charge(slot, c) {
      const el = dashEls[slot];
      if (!el) return;
      const q = Math.round(c * 40) / 40;
      if (q !== shown[slot]) {
        shown[slot] = q;
        // The ring is drawn with pathLength 100: offset 100 is empty, 0 is a full circle.
        if (rings[slot]) rings[slot].style.strokeDashoffset = String(100 - q * 100);
      }
      const isFull = c >= 0.999;
      if (isFull !== full[slot]) {
        full[slot] = isFull;
        el.classList.toggle('full', isFull);
      }
    },
    reset() {
      for (const el of stickEls) el?.classList.remove('on');
      for (let s = 0; s < 2; s++) {
        dashEls[s]?.classList.remove('down', 'full');
        if (rings[s]) rings[s].style.strokeDashoffset = '100';
        shown[s] = 0;
        full[s] = false;
      }
    },
  };
}
