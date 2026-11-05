// Simulated multi-factor code (decision D18, level S). The prototype stores no passwords and sends no
// real second factor: a code is derived from a per-user secret and a 30-second window so that the
// sign-in flow, its failures and its audit events can be demonstrated and tested deterministically.
// This is NOT cryptography and must not be mistaken for it; the Limits page says so.
// Browser-safe: no Node imports.
const WINDOW_MS = 30 * 1000;

function digest(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function codeFor(secret, window) {
  return String(digest(`${secret}:${window}`) % 1_000_000).padStart(6, "0");
}

const windowOf = (instant) => Math.floor(Date.parse(instant) / WINDOW_MS);

export function mfaCode(secret, instant) {
  return codeFor(secret, windowOf(instant));
}

// The current and the previous window are accepted, so a code typed just after a tick still works.
export function verifyMfaCode(secret, code, instant) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const current = windowOf(instant);
  return [current, current - 1].some((window) => codeFor(secret, window) === code);
}
