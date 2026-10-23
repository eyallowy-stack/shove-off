// Estimate the server's clock from ping/pong samples, so remote players can be drawn
// at a server time instead of at whenever their packets happened to arrive.
//
// NTP's on-wire formula (RFC 5905): with t1 = client send, t2 = server receive,
// t3 = server send, t4 = client receive,
//   offset = ((t2 - t1) + (t3 - t4)) / 2      round trip = (t4 - t1) - (t3 - t2)
// It assumes the trip out and back took equally long. Samples with the shortest
// round trip waited in the fewest queues, so they fit that assumption best: keep
// a few recent samples and average the faster half.

export function createClock({ keep = 8 } = {}) {
  const samples = [];
  let offset = 0;
  let hasSample = false;
  let lastRtt = NaN;

  return {
    addSample(t1, t2, t3, t4) {
      const rtt = t4 - t1 - (t3 - t2);
      if (!(rtt >= 0)) return; // clock went backwards (sleep, tab freeze): ignore
      const theta = (t2 - t1 + (t3 - t4)) / 2;
      lastRtt = rtt;
      samples.push({ rtt, theta });
      if (samples.length > keep) samples.shift();
      const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, samples.length >> 1));
      offset = best.reduce((s, x) => s + x.theta, 0) / best.length;
      hasSample = true;
    },
    // Before the first pong, a snapshot's server time is a rough guess (it ignores latency).
    seed(serverTime, clientNow) {
      if (!hasSample) offset = serverTime - clientNow;
    },
    // Call when the page becomes visible again or wakes from sleep. performance.now()
    // keeps counting through sleep only on some platforms, so old samples may be wrong.
    reset() {
      samples.length = 0;
      hasSample = false;
    },
    serverNow: (clientNow) => clientNow + offset,
    get offset() {
      return offset;
    },
    get rtt() {
      return lastRtt;
    },
    get rttMin() {
      return samples.length ? Math.min(...samples.map((s) => s.rtt)) : NaN;
    },
    get ready() {
      return hasSample;
    },
  };
}
