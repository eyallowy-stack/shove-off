// Solo play's return loop: this device's record against each CPU, and the one unlock.
// The Berg opens when you beat Skipper once, or after CLOSE_TO_UNLOCK matches against
// Skipper in which you took at least 2 rounds, so a player who is learning isn't stuck
// behind a wall. Pure, so it's tested in Node; main.js hands it the guarded read/write
// from js/lib/storage.js, which never throw.
//
//   const solo = createSoloRecord({ read, write, legacy });
//   solo.unlocked('hard')             false until Skipper is beaten, or pushed close 3 times
//   solo.result('normal', false, 2)   -> { record: { w, l, close }, fresh: [levels just unlocked] }
//   solo.progress('hard')             -> { close, need } toward the softer unlock

import { LEVELS, levelInfo } from './game/cpu.js';

const KEY = 'solo';
const IDS = LEVELS.map((l) => l.id);
const ok = (n) => (Number.isInteger(n) && n >= 0 && n < 1e6 ? n : 0);
export const CLOSE_TO_UNLOCK = 3; // matches against the level below with 2+ rounds won

export function createSoloRecord({ read, write, legacy = null }) {
  const saved = read(KEY, null);
  const rec = {};
  for (const l of LEVELS) if (l.record) rec[l.id] = { w: ok(saved?.rec?.[l.id]?.w), l: ok(saved?.rec?.[l.id]?.l), close: ok(saved?.rec?.[l.id]?.close) };
  // The first build had a single CPU; its tally carries over to Skipper, its closest match.
  if (!saved && legacy && (ok(legacy.w) || ok(legacy.l))) rec.normal = { w: ok(legacy.w), l: ok(legacy.l), close: 0 };
  let last = IDS.includes(saved?.last) ? saved.last : null;
  const told = Array.isArray(saved?.told) ? saved.told.filter((id) => IDS.includes(id)) : [];
  const save = () => write(KEY, { v: 1, rec, last, told });

  const unlocked = (id) => {
    const by = levelInfo(id).unlockedBy;
    return !by || (rec[by]?.w ?? 0) > 0 || (rec[by]?.close ?? 0) >= CLOSE_TO_UNLOCK;
  };

  return {
    rec,
    unlocked,
    get last() {
      return last;
    },
    play(id) {
      if (!IDS.includes(id)) return;
      last = id;
      save();
    },
    // A finished match, and how many rounds you took. Practice doesn't count. A loss
    // where you took 2 or more rounds counts toward the softer unlock.
    result(id, won, roundsWon = won ? 3 : 0) {
      const l = levelInfo(id);
      if (!l.record) return { record: null, fresh: [] };
      rec[l.id][won ? 'w' : 'l']++;
      if (!won && ok(roundsWon) >= 2) rec[l.id].close++;
      const fresh = LEVELS.filter((x) => x.unlockedBy && unlocked(x.id) && !told.includes(x.id));
      for (const x of fresh) told.push(x.id);
      save();
      return { record: { ...rec[l.id] }, fresh };
    },
    // How close a locked level is to opening the softer way.
    progress(id) {
      const by = levelInfo(id).unlockedBy;
      return by ? { close: Math.min(CLOSE_TO_UNLOCK, rec[by]?.close ?? 0), need: CLOSE_TO_UNLOCK } : null;
    },
    // After a win, the next opponent up (if it's open); otherwise null.
    nextUp(id, won) {
      if (!won) return null;
      const i = IDS.indexOf(id);
      return LEVELS.slice(i + 1).find((x) => x.record && unlocked(x.id)) ?? null;
    },
    // The picker opens on the last one played, or the first one not yet beaten.
    pickDefault() {
      if (last && unlocked(last)) return last;
      return LEVELS.find((l) => l.record && unlocked(l.id) && !rec[l.id].w)?.id ?? 'easy';
    },
    // One line for the title screen, or null before the first solo match.
    summary() {
      const counted = LEVELS.filter((l) => l.record);
      if (!counted.some((l) => rec[l.id].w + rec[l.id].l > 0)) return null;
      return `Vs the computer: ${counted.map((l) => (unlocked(l.id) ? `${l.name} ${rec[l.id].w}–${rec[l.id].l}` : `${l.name} locked`)).join(' · ')}`;
    },
  };
}
