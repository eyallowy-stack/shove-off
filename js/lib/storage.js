// localStorage that never throws, plus versioned saves that survive a schema
// change. Private windows, blocked site data and a full quota all make the raw
// API throw, and an unguarded call at load is a blank screen.
//
// Pick a PREFIX unique to this site: every project on <user>.github.io shares
// one origin, and every itch.io HTML game runs on the same embed host.

const PREFIX = 'shove-off:';
const KEY_OK = /^[\w:.-]{1,200}$/;

let backend;
function store() {
  if (backend !== undefined) return backend;
  try {
    backend = globalThis.localStorage ?? null; // the getter itself throws when site data is blocked
  } catch {
    backend = null;
  }
  return backend;
}

// Tests swap in a fake: useBackend(new Map-like { getItem, setItem, removeItem, key, length }).
export function useBackend(b) {
  backend = b;
}

export let lastError = null; // the last failed write (QuotaExceededError, SecurityError)

export function read(key, fallback = null) {
  try {
    const raw = store()?.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    if (!store()) return false;
    store().setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    lastError = err;
    return false;
  }
}

export function remove(key) {
  try {
    store()?.removeItem(PREFIX + key);
  } catch {
    /* storage unavailable */
  }
}

// Storage scoped to one game: namespaced('snake').get('settings', {}).
export function namespaced(ns) {
  return {
    get: (key, fallback = null) => read(`${ns}:${key}`, fallback),
    set: (key, value) => write(`${ns}:${key}`, value),
    remove: (key) => remove(`${ns}:${key}`),
    save: (opts) => createSave(ns, opts),
  };
}

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

// A versioned save. migrations[n] upgrades version n data to version n + 1;
// validate(data, defaults) returns clean data built only from fields it checked.
//
//   const save = createSave('catch', { version: 2, defaults: { best: 0, plays: 0 },
//     migrations: { 1: (d) => ({ best: d.highScore, plays: 0 }) },
//     validate: (d, def) => ({ best: finite(d.best, def.best, 0), plays: int(d.plays, 0, 0) }) });
export function createSave(ns, { version, defaults, migrations = {}, validate = (d) => d }) {
  const key = `${ns}:save`;
  let newer = false; // a save written by a newer version of the game: never overwrite it
  return {
    load() {
      newer = false;
      const raw = read(key, null);
      if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.v)) return clone(defaults);
      if (raw.v > version) {
        // A cached old build after a deploy can meet a save from the new build.
        newer = true;
        return clone(defaults);
      }
      let data = raw.data;
      try {
        for (let v = raw.v; v < version; v++) {
          if (!migrations[v]) return clone(defaults);
          data = migrations[v](data);
        }
        if (!data || typeof data !== 'object') return clone(defaults);
        return validate(data, clone(defaults)) ?? clone(defaults);
      } catch {
        return clone(defaults);
      }
    },
    save(data) {
      if (newer) return false;
      return write(key, { v: version, at: Date.now(), data });
    },
    clear() {
      newer = false;
      remove(key);
    },
  };
}

// Validators for validate(). JSON turns NaN and Infinity into null and a Set
// into {}, so check every field rather than trusting the shape.
export const finite = (v, fallback, min = -Infinity, max = Infinity) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
export const int = (v, fallback, min = -Infinity, max = Infinity) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback);
export const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
export const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
export const text = (v, fallback, maxLen = 64) => (typeof v === 'string' ? v.slice(0, maxLen) : fallback);

// Save on events (level clear, settings change) and when the page goes away.
// visibilitychange to hidden is the last event that reliably fires on phones;
// unload is unreliable there and blocks the back/forward cache.
export function saveOnHide(fn, signal) {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && fn(), { signal });
  window.addEventListener('pagehide', fn, { signal });
}

// Every key this site wrote, as one JSON text the player can keep.
export function exportAll() {
  const s = store();
  const keys = {};
  try {
    for (let i = 0; i < (s?.length ?? 0); i++) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX)) keys[k.slice(PREFIX.length)] = s.getItem(k);
    }
  } catch {
    /* storage unavailable */
  }
  return JSON.stringify({ format: `${PREFIX}save`, exported: new Date().toISOString(), keys });
}

// Restores an export. Returns the number of keys written, or -1 if the text
// isn't an export from this site. Each game's load() still validates contents.
export function importAll(textIn) {
  let parsed;
  try {
    parsed = JSON.parse(textIn);
  } catch {
    return -1;
  }
  if (parsed?.format !== `${PREFIX}save` || typeof parsed.keys !== 'object' || !parsed.keys) return -1;
  let n = 0;
  for (const [k, v] of Object.entries(parsed.keys)) {
    if (!KEY_OK.test(k) || typeof v !== 'string') continue;
    try {
      JSON.parse(v);
      store()?.setItem(PREFIX + k, v);
      n++;
    } catch {
      /* skip a corrupt value or a full quota */
    }
  }
  return n;
}

// Offer text as a file download (works in every browser, unlike showSaveFilePicker).
export function downloadText(filename, body) {
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Ask the browser not to evict this site's storage. Call from a button press
// (Firefox shows a prompt); Chrome and Safari decide silently by heuristics.
export async function requestPersist() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
