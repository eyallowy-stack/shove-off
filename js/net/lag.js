// A WebSocket wrapper that adds latency, jitter and loss on the client side, so
// bots can be pointed at any server (local, Render, Cloudflare) under a bad network,
// and so can a real page: online-tag.js wraps its socket with this when the URL
// has ?debug&lag=60,20,0.02 (one-way ms, jitter ms, loss).
//
// Model loss the way the transport experiences it. WebSocket runs on TCP, which
// never drops or reorders a message: a lost packet is retransmitted after a
// timeout, and every message behind it waits. So for WebSockets, "loss" is a
// stall followed by a burst, and that is what `mode: 'tcp'` produces. Injecting
// random drops into a WebSocket test creates failures production can't have and
// misses the one it does. `mode: 'datagram'` (real drops, reordering) is for
// unreliable WebRTC DataChannels.

export function createLagProfile({
  latencyMs = 40, // one way; round trip is twice this
  jitterMs = 15, // uniform 0..jitterMs added per message
  loss = 0, // probability per message
  stallMs = [200, 1000], // tcp mode: how long a "lost" message holds up the stream
  mode = 'tcp',
  random = Math.random,
} = {}) {
  let blackoutUntil = 0;
  return {
    mode,
    // When a message sent now arrives, given when the previous one arrived.
    arrival(nowMs, prevArrival) {
      let t = nowMs + latencyMs + random() * jitterMs;
      const lost = random() < loss;
      if (mode === 'tcp') {
        if (lost) t += stallMs[0] + random() * (stallMs[1] - stallMs[0]);
        t = Math.max(t, prevArrival, blackoutUntil); // in order, always
        return t;
      }
      if (lost || nowMs < blackoutUntil) return null; // dropped
      return t; // datagrams may overtake each other
    },
    // Nothing gets through for ms (Wi-Fi blip, elevator), then it all arrives at once.
    blackout(ms, nowMs = performance.now()) {
      blackoutUntil = nowMs + ms;
    },
  };
}

// Delivers callbacks at given times, in time order, ties in arrival order. One timer
// per direction, because separate setTimeouts with nearly equal deadlines can fire
// out of order, which would make a TCP stream reorder: something it never does.
function createPipe(now) {
  const queue = [];
  let timer = null;
  let last = 0;
  function pump() {
    timer = null;
    while (queue.length && queue[0].at <= now() + 0.5) queue.shift().fn();
    if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].at - now()));
  }
  return {
    get last() {
      return last;
    },
    push(at, fn) {
      last = Math.max(last, at);
      let i = queue.length;
      while (i > 0 && queue[i - 1].at > at) i--;
      queue.splice(i, 0, { at, fn });
      if (timer) clearTimeout(timer);
      timer = setTimeout(pump, Math.max(0, queue[0].at - now()));
    },
  };
}

export function laggyWebSocketClass(profile, { now = () => performance.now(), Base = globalThis.WebSocket } = {}) {
  return class LaggyWebSocket {
    constructor(url, options) {
      this.inner = options ? new Base(url, options) : new Base(url);
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.down = createPipe(now);
      this.up = createPipe(now);
      this.queuedUp = 0;
      const deliver = (fn) => {
        const at = profile.arrival(now(), this.down.last);
        if (at !== null) this.down.push(at, fn);
      };
      this.inner.onopen = () => deliver(() => this.onopen?.({}));
      this.inner.onmessage = (ev) => deliver(() => this.onmessage?.({ data: ev.data }));
      // Close events queue behind messages already in flight, like a real stream.
      this.inner.onclose = (ev) => {
        const { code, reason, wasClean } = ev;
        this.down.push(Math.max(now(), this.down.last), () => this.onclose?.({ code, reason, wasClean }));
      };
      this.inner.onerror = () => this.onerror?.({});
    }
    get readyState() {
      return this.inner.readyState;
    }
    get bufferedAmount() {
      return this.inner.bufferedAmount + this.queuedUp;
    }
    send(text) {
      const at = profile.arrival(now(), this.up.last);
      if (at === null) return;
      this.queuedUp += text.length;
      this.up.push(at, () => {
        this.queuedUp -= text.length;
        if (this.inner.readyState === 1) this.inner.send(text);
      });
    }
    // Like a real socket, close() goes out after anything already sent.
    close(code, reason) {
      this.up.push(Math.max(now(), this.up.last), () => this.inner.close(code, reason));
    }
  };
}
