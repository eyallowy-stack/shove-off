// Vibration on hits, full charge and ring-outs, where the browser has it (Chrome on
// Android). iPhone Safari has no navigator.vibrate, so there it does nothing at all.
// Never the only feedback: every buzz has a sound and a picture already. Chrome only
// vibrates after the player has touched the page, which a match always follows.

import { read, write } from './lib/storage.js';

const can = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
let on = read('haptics', true) !== false;

export const hapticsAvailable = () => can;
export const hapticsOn = () => can && on;
export function setHaptics(v) {
  on = !!v;
  write('haptics', on);
}

function buzz(pattern) {
  if (!can || !on) return;
  // Chrome refuses (and logs an error) until the page has been tapped at least once.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* blocked in this frame or not allowed yet */
  }
}

// Short and sized by power: a jab barely ticks, a full shove thumps.
export const feel = {
  hit: (pw = 0) => buzz(Math.round(14 + 36 * pw)),
  clash: () => buzz([22, 40, 22]),
  full: () => buzz(10),
  fall: () => buzz([18, 50, 70]),
};
