// Network debug overlay. Build this before chasing any sync bug: most "it stutters"
// reports are answered by one of these numbers.
//
//   rtt            round trip from ping/pong; best = the least-queued sample
//   update age     ms since the last snapshot arrived; should hover under one gap
//   gap            ms between the last two snapshots; jumps here are stalls
//   server tick    measured from snapshots; below tickHz means the server is overloaded
//   depth          snapshots buffered ahead of the render time; 0 means stutter is coming
//   states         share of remote draws that interpolated / extrapolated / held
//   corrections/s  local prediction disagreed with the server about our own step: ~0, or a bug
//   server changes the server changed us on purpose (a pickup, a stomp): expected
//   decode errors  messages we could not read: a bug or a stale roster, not the network
//
// Toggle with the ` key (or show it with ?debug). Text only, no inline styles, so it
// works under Cougar Arcade's CSP; style .net-overlay in the game's CSS file.

export function createNetOverlay(parent, session, { visible = false } = {}) {
  const el = document.createElement('pre');
  el.className = 'net-overlay';
  el.setAttribute('aria-hidden', 'true'); // diagnostic noise for screen readers
  el.hidden = !visible;
  parent.appendChild(el);

  let lastAt = 0;
  let lastCorrections = 0;
  let corrRate = 0;
  const counts = { interp: 0, extrap: 0, hold: 0, waiting: 0 };
  let depthMin = Infinity;
  let depthSum = 0;
  let depthN = 0;

  return {
    toggle() {
      el.hidden = !el.hidden;
    },
    get visible() {
      return !el.hidden;
    },
    // Call every frame with the remotes you drew (so the numbers describe what was on screen).
    update(nowMs, remotes) {
      if (el.hidden) return;
      for (const r of remotes) {
        counts[r.state]++;
        depthMin = Math.min(depthMin, r.depth);
        depthSum += r.depth;
        depthN++;
      }
      if (nowMs - lastAt < 250) return;
      const dt = (nowMs - lastAt) / 1000;
      lastAt = nowMs;
      const net = session.net;
      const p = session.predictor;
      const s = session.stats;
      const c = p?.corrections ?? 0;
      corrRate = dt > 0 && dt < 5 ? (c - lastCorrections) / dt : 0;
      lastCorrections = c;
      const total = counts.interp + counts.extrap + counts.hold + counts.waiting || 1;
      const pct = (n) => Math.round((100 * n) / total);
      const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '-');
      el.textContent = [
        `${net.status}  ${session.phase}  ${session.pid ?? ''}`,
        `rtt ${ms(net.clock.rtt)} (best ${ms(net.clock.rttMin)})`,
        `update age ${s.lastSnapshotAt ? ms(nowMs - s.lastSnapshotAt) : '-'}  gap ${ms(s.snapshotGapMs)}`,
        `server tick #${s.serverTick}  ${s.serverTickHz ? s.serverTickHz.toFixed(1) : '-'} Hz`,
        `depth avg ${depthN ? (depthSum / depthN).toFixed(1) : '-'} min ${depthN ? depthMin : '-'}  delay ${Math.round(session.interpDelayMs)} ms`,
        `remote ${pct(counts.interp)}% interp ${pct(counts.extrap)}% extrap ${pct(counts.hold)}% hold`,
        `pending ${p?.pending ?? 0}  corrections ${corrRate.toFixed(1)}/s  server changes ${p?.serverChanges ?? 0}  snaps ${p?.snaps ?? 0}`,
        `decode errors ${net.stats.decodeErrors}  roster asks ${s.rosterAsks}  reconnects ${net.stats.reconnects}  skipped ${net.stats.skippedSends}`,
      ].join('\n');
      counts.interp = counts.extrap = counts.hold = counts.waiting = 0;
      depthMin = Infinity;
      depthSum = depthN = 0;
    },
    destroy() {
      el.remove();
    },
  };
}
