// Business date (D20): the calendar date in the tenant's IANA timezone, never the server's or the
// browser's. Attendance, production days and assignments are dated this way, so an event at 20:30
// UTC is already tomorrow's business date in Asia/Colombo (SRS 15.4: audit timestamps stay UTC).
// Pure functions; the instant is always passed in. Browser-safe: no Node imports.

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A zone name such as Asia/Colombo or UTC. Fixed offsets (+05:30) are not IANA zones.
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !ZONE_NAME.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// An instant is a Date or an ISO date-time that states its offset. A date-time without an offset is
// ambiguous (local or UTC?) and a bare date has no time, so both are refused.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function toDate(instant) {
  const date =
    instant instanceof Date
      ? instant
      : typeof instant === "string" && INSTANT.test(instant)
        ? new Date(instant)
        : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw fail("invalid_instant", `${String(instant)} is not an instant with an offset`);
  }
  return date;
}

export function businessDate(instant, timeZone) {
  if (!isValidTimeZone(timeZone)) {
    throw fail("invalid_timezone", `${String(timeZone)} is not an IANA timezone`);
  }
  const date = toDate(instant);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((candidate) => candidate.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
