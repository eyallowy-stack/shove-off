// Installable and offline (sw.js): after one visit, Shove Off opens from the Home
// Screen and plays against the computer with no connection. Online rooms still need
// the room server.
//
// Updates never swap files under a running match: a new version downloads in the
// background, all files at once, and a "new version ready" toast appears in the
// menus. Reload hands over to it.
//
// On localhost the worker is off unless the URL has ?sw: while you're editing the
// game on this laptop, a cache would only ever show you yesterday's files.

export function setupOffline({ toast, canShow = () => true } = {}) {
  let waiting = null;
  let reloading = false;
  let registration = null;
  const api = {
    // The page calls this whenever a menu screen opens, and hides the toast for play.
    menusShown() {
      if (waiting && toast && canShow()) toast.hidden = false;
    },
    hide() {
      if (toast) toast.hidden = true;
    },
    reload() {
      if (!waiting) return location.reload();
      reloading = true;
      waiting.postMessage({ t: 'skip-waiting' });
      // If the worker can't take over for some reason, reload anyway.
      setTimeout(() => location.reload(), 3000);
    },
    // The room server says this copy is out of date (close 4010). A plain reload would be
    // served by the old worker from the old cache, so fetch the new worker first, hand
    // over to it, then reload. If no worker is around (localhost), just reload.
    async updateNow() {
      if (waiting) return api.reload();
      if (!registration) return location.reload();
      try {
        await registration.update();
      } catch {
        /* offline: the reload below is the best we can do */
      }
      const w = registration.waiting ?? registration.installing;
      if (!w) return location.reload();
      if (w.state === 'installed') {
        waiting = w;
        return api.reload();
      }
      w.addEventListener('statechange', () => {
        if (w.state === 'installed') {
          waiting = w;
          api.reload();
        }
      });
      setTimeout(() => location.reload(), 5000);
    },
    get updateReady() {
      return !!waiting;
    },
  };
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return api;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const wanted = window.isSecureContext && (!local || new URLSearchParams(location.search).has('sw'));
  // An app installed from this laptop opens its start_url without ?sw; removing the
  // worker then would throw away the offline copy, so leave an installed app alone.
  const installed = typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches);
  if (!wanted && !(local && installed && window.isSecureContext)) {
    if (local && !installed) navigator.serviceWorker.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()), () => {});
    return api;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
  navigator.serviceWorker.register('sw.js', { scope: './' }).then(
    (reg) => {
      registration = reg;
      const offer = (w) => {
        waiting = w;
        api.menusShown();
      };
      // Only an update needs offering: on the very first visit there's nothing older.
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => w.state === 'installed' && navigator.serviceWorker.controller && offer(w));
      });
      // A Home Screen app can stay open for days: look for a new version on each return.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine !== false) reg.update().catch(() => {});
      });
    },
    () => {
      /* private window, or blocked: the game works the same, just not offline */
    },
  );
  return api;
}
