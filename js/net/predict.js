// Client-side prediction and reconciliation for the LOCAL player only.
//
// Every fixed tick the client applies its own input immediately (so the controls feel
// instant), sends it with a sequence number, and keeps it until the server says it
// has processed it. Each snapshot carries the server's whole state for us and the
// last input it applied (ack). We restart from that state, drop acknowledged
// inputs, and replay the rest through the same shared step.
//
// The state is whatever the game's sim.js says it is (position, velocity, timers),
// as long as it has x and y (drawn), warp (bumped by the server on a teleport) and
// rev (bumped by the server when it changes us outside the step: a pickup, a
// knockback, a stomp). Replays start from the whole state, so a jump keeps its speed.
//
// Other players are never predicted: they are drawn from the snapshot buffer.

const EPSILON = 1e-6;

function sameState(a, b) {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) return false;
  return true;
}

export function createPredictor({
  step, // the game's shared stepPlayer(state, input)
  isNeutral, // input changes nothing...
  atRest = () => true, // ...when the state is at rest, so that tick is neither stepped nor sent
  start, // the server's state for us
  snapDistance = 120, // corrections bigger than this jump instead of easing
  skipAtRest = true, // false: send every tick, even neutral ones at rest (Shove Off, see session.js)
  maxPending = 240, // 4 s at 60 Hz; beyond this the server is not hearing us
}) {
  let state = { ...start };
  let prev = state; // state one tick ago, for render interpolation
  let offset = { x: 0, y: 0 }; // visual error being eased out after a correction
  let seq = 0;
  const pending = [];
  let corrections = 0; // the server disagreed with our own step: a bug to find
  let serverChanges = 0; // the server changed us on purpose (rev moved): expected
  let snaps = 0;
  let lastError = 0;

  return {
    // Apply one tick of local input. Returns the input (with its seq) to send, or
    // null when there is nothing to send. A neutral input while at rest is skipped
    // on both sides: the server doesn't step a player it has no input for, and the
    // step would change nothing anyway, so a parked player costs zero messages.
    // While anything is still moving (a jump, a slide), every tick is stepped and sent.
    // Also null once the server has gone quiet for maxPending ticks.
    apply(input) {
      prev = state;
      if ((skipAtRest && isNeutral(input) && atRest(state)) || pending.length >= maxPending) return null;
      const sent = { ...input, seq: ++seq };
      pending.push(sent);
      state = step(state, sent);
      return sent;
    },

    // The server's word on our whole state after input #ack.
    reconcile(server, ack) {
      while (pending.length && pending[0].seq <= ack) pending.shift();
      let replay = { ...server };
      for (const input of pending) replay = step(replay, input);
      const ex = state.x - replay.x;
      const ey = state.y - replay.y;
      lastError = Math.sqrt(ex * ex + ey * ey);
      if (server.warp !== state.warp || lastError > snapDistance) {
        offset = { x: 0, y: 0 }; // respawn or a big desync: jump there, nothing to ease
        prev = replay;
        snaps++;
      } else if (!sameState(replay, state)) {
        if (server.rev !== state.rev) serverChanges++;
        else corrections++;
        if (lastError > EPSILON) {
          // Keep the drawn position where it was and ease the difference out over a
          // few frames, so a small correction reads as a nudge rather than a jump.
          offset = { x: offset.x + ex, y: offset.y + ey };
          prev = { ...prev, x: prev.x - ex, y: prev.y - ey };
        }
      }
      state = replay;
      return lastError;
    },

    // Drawn position: between the last two ticks (alpha from createLoop's render),
    // plus the correction still being eased out.
    renderPos(alpha) {
      return {
        x: prev.x + (state.x - prev.x) * alpha + offset.x,
        y: prev.y + (state.y - prev.y) * alpha + offset.y,
      };
    },

    // Call once per rendered frame. halfLifeMs: time to remove half the visual error.
    decay(dtMs, halfLifeMs = 60) {
      const k = Math.pow(0.5, dtMs / halfLifeMs);
      offset = { x: offset.x * k, y: offset.y * k };
    },

    // A new match, a rejoin, or a tab that was hidden: forget unacknowledged inputs
    // and stand where the server says.
    resetTo(server) {
      pending.length = 0;
      state = { ...server };
      prev = state;
      offset = { x: 0, y: 0 };
    },

    get state() {
      return state;
    },
    get pending() {
      return pending.length;
    },
    get corrections() {
      return corrections;
    },
    get serverChanges() {
      return serverChanges;
    },
    get snaps() {
      return snaps;
    },
    get lastError() {
      return lastError;
    },
  };
}
