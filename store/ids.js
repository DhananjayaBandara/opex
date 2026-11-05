// A random version 4 UUID that works in every browser context. `crypto.randomUUID` exists only in
// secure contexts (HTTPS, localhost, 127.0.0.1), so opening the prototype by LAN address or hostname
// over plain HTTP made it throw "crypto.randomUUID is not a function". `crypto.getRandomValues` is
// available everywhere, so it is the fallback and the ids stay random.
export function randomUuid() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
