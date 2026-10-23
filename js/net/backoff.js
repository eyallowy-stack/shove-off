// Capped exponential backoff with full jitter (Brooker, AWS Architecture Blog):
// a whole classroom that dropped at the same moment spreads out instead of
// hammering a just-restarted server in lockstep. Used by net.js and poller.js.
export function backoffDelay(attempt, { baseMs = 500, capMs = 10000, random = Math.random } = {}) {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}
