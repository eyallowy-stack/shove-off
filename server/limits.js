// Read at server creation so tests can override the environment without a reload.
// Invalid values keep the defaults; a typo must not silently remove a cap.
export function envLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
