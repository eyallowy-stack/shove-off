// Live-object counters for the mount/unmount leak check. Each lib module counts
// what it starts (loops, inputs, canvases, sounds) and uncounts it on cleanup,
// so after unmount every count is back where it was before mount. The host's
// ?debug hook reads liveCounts() after cycling a game many times.

const counts = new Map();

export function track(kind) {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    counts.set(kind, counts.get(kind) - 1);
  };
}

export const liveCounts = () => Object.fromEntries(counts);
