// Snapshot buffer for REMOTE players and world entities. Each sample is stamped
// with the server time it describes. The game draws them at playback.now() minus
// the interpolation delay, between the two samples on either side of that time.
// The playback clock (below) is timed from when snapshots arrive, so the delay is
// measured from the newest snapshot this client could have, and one-way latency
// never eats into the buffer. A sample's arrival time is never used to place it,
// so jitter, a late packet or a slow poll changes nothing about apparent speed.
//
// The delay should cover two to three snapshot intervals: then one late or lost
// update still leaves a later sample to interpolate toward.

export function interpolationDelayMs(snapshotHz, intervals = 2.5) {
  return (1000 / snapshotHz) * intervals;
}

// The timeline remote players are drawn on. It follows the snapshots as they arrive,
// so the delay above is measured from the newest snapshot we could have, not from
// the server's "now": one-way latency would otherwise eat into the buffer, and a
// player with a slow connection would see stutter at the same settings.
//
// offset = server time - local time, taken from the snapshots that arrived fastest
// in the last couple of seconds (jitter only ever makes a snapshot later). When
// that changes, the timeline speeds up or slows down by a few percent rather than
// jumping, which nobody notices.
export function createPlaybackClock({ windowMs = 2000, slew = 0.05, jumpMs = 250 } = {}) {
  const recent = []; // { at, off }
  let target = null;
  let offset = null;
  let lastNow = null;
  return {
    onSnapshot(serverTime, clientNow) {
      recent.push({ at: clientNow, off: serverTime - clientNow });
      while (recent.length > 1 && recent[0].at < clientNow - windowMs) recent.shift();
      target = Math.max(...recent.map((r) => r.off));
      if (offset === null) offset = target;
    },
    // Server time to draw at, before subtracting the interpolation delay.
    now(clientNow) {
      if (offset === null) return null;
      const dt = lastNow === null ? 0 : Math.max(0, clientNow - lastNow);
      lastNow = clientNow;
      const gap = target - offset;
      if (Math.abs(gap) > jumpMs) offset = target; // a big change (new route, resync): jump once
      else offset += Math.max(-slew * dt, Math.min(slew * dt, gap));
      return clientNow + offset;
    },
    reset() {
      recent.length = 0;
      target = offset = lastNow = null;
    },
  };
}

export function createSnapshotBuffer({
  maxExtrapolateMs = 100, // past the newest sample, keep moving this long, then hold
  snapDistance = 200, // a jump bigger than this between samples is a teleport: don't slide
  keepMs = 3000,
} = {}) {
  const tracks = new Map(); // id -> { warp, samples: [{ t, x, y, extra }] } in time order
  let outOfOrder = 0;

  return {
    // extra: the row's game fields (hasFlag, facing...), handed back from the newest sample.
    push(pid, t, x, y, warp = 0, extra = []) {
      let track = tracks.get(pid);
      if (!track) tracks.set(pid, (track = { warp, samples: [] }));
      const s = track.samples;
      const last = s[s.length - 1];
      if (last && t <= last.t) {
        outOfOrder++; // possible with polling; we render in the past, so dropping it is safe
        return;
      }
      const jumped = last && (x - last.x) ** 2 + (y - last.y) ** 2 > snapDistance * snapDistance;
      if (warp !== track.warp || jumped) {
        track.warp = warp;
        s.length = 0; // start the track again at the new place
      }
      s.push({ t, x, y, extra });
      while (s.length > 2 && s[1].t < t - keepMs) s.shift();
    },

    // state: 'interp' (normal), 'extrap' (briefly past the newest), 'hold' (stale,
    // standing still), 'waiting' (render time is before the first sample).
    sample(pid, renderT) {
      const s = tracks.get(pid)?.samples;
      if (!s || s.length === 0) return null;
      if (renderT <= s[0].t) return { x: s[0].x, y: s[0].y, extra: s[0].extra, state: 'waiting' };
      for (let i = s.length - 1; i > 0; i--) {
        const a = s[i - 1];
        const b = s[i];
        if (renderT >= a.t) {
          if (renderT > b.t) break;
          const k = (renderT - a.t) / (b.t - a.t);
          return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, extra: b.extra, state: 'interp' };
        }
      }
      const last = s[s.length - 1];
      if (s.length < 2) return { x: last.x, y: last.y, extra: last.extra, state: 'hold' };
      // Dead reckoning, capped: players stop and turn without warning, so guessing
      // further ahead than this produces visible rubber-banding when the truth arrives.
      const prev = s[s.length - 2];
      const over = renderT - last.t;
      const k = Math.min(over, maxExtrapolateMs) / (last.t - prev.t);
      return {
        x: last.x + (last.x - prev.x) * k,
        y: last.y + (last.y - prev.y) * k,
        extra: last.extra,
        state: over > maxExtrapolateMs ? 'hold' : 'extrap',
      };
    },

    // Samples newer than the render time, for the debug overlay. Healthy is 1 to 3;
    // 0 means the delay is too short for the update rate (or updates stopped).
    depth(pid, renderT) {
      const s = tracks.get(pid)?.samples ?? [];
      let n = 0;
      for (let i = s.length - 1; i >= 0 && s[i].t > renderT; i--) n++;
      return n;
    },

    has: (pid) => tracks.has(pid),
    pids: () => [...tracks.keys()],
    remove: (pid) => tracks.delete(pid),
    // Players who left: drop their tracks, or they linger as ghosts at their last spot.
    // keep(id) says which ids to leave alone (entity tracks are managed separately).
    removeMissing(pidSet, keep = () => false) {
      for (const pid of tracks.keys()) if (!pidSet.has(pid) && !keep(pid)) tracks.delete(pid);
    },
    clear() {
      tracks.clear();
    },
    get outOfOrder() {
      return outOfOrder;
    },
  };
}
