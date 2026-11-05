// Effective-dating helpers (architecture 7.2-7.4, SRS 8.3).
// A range is { effectiveFrom, effectiveTo } of inclusive ISO dates (YYYY-MM-DD);
// effectiveTo = null means open-ended. All functions are pure and never mutate input.
// Browser-safe: no Node imports.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const POLICIES = ["warn", "block", "allow"];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseIso(value, label) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw fail("invalid_range", `${label} must be an ISO date (YYYY-MM-DD), got ${String(value)}`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const exact =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!exact) throw fail("invalid_range", `${label} is not a real calendar date: ${value}`);
  return date;
}

function formatIso(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDate, days) {
  const date = parseIso(isoDate, "date");
  date.setUTCDate(date.getUTCDate() + days);
  return formatIso(date);
}

export function validateRange(range) {
  parseIso(range?.effectiveFrom, "effectiveFrom");
  const to = range.effectiveTo ?? null;
  if (to !== null) {
    parseIso(to, "effectiveTo");
    if (to < range.effectiveFrom) {
      throw fail(
        "invalid_range",
        `effectiveTo ${to} is before effectiveFrom ${range.effectiveFrom}`
      );
    }
  }
  return range;
}

// ISO dates compare correctly as strings once validated.
const endOf = (range) => range.effectiveTo ?? null;

export function overlaps(a, b) {
  validateRange(a);
  validateRange(b);
  const aEndsBeforeBStarts = endOf(a) !== null && endOf(a) < b.effectiveFrom;
  const bEndsBeforeAStarts = endOf(b) !== null && endOf(b) < a.effectiveFrom;
  return !aEndsBeforeBStarts && !bEndsBeforeAStarts;
}

export function isAdjacent(a, b) {
  validateRange(a);
  validateRange(b);
  const startsDayAfter = (first, second) =>
    endOf(first) !== null && addDays(endOf(first), 1) === second.effectiveFrom;
  return startsDayAfter(a, b) || startsDayAfter(b, a);
}

export function activeOn(range, isoDate) {
  validateRange(range);
  parseIso(isoDate, "date");
  return range.effectiveFrom <= isoDate && (endOf(range) === null || isoDate <= endOf(range));
}

export function endDate(range, isoDate) {
  validateRange(range);
  parseIso(isoDate, "end date");
  if (isoDate < range.effectiveFrom) {
    throw fail(
      "invalid_range",
      `cannot end on ${isoDate}, before the start ${range.effectiveFrom}`
    );
  }
  return { ...range, effectiveTo: isoDate };
}

function requireSubjectMatcher(sameSubject) {
  if (typeof sameSubject !== "function") {
    throw fail(
      "invalid_argument",
      "sameSubject(a, b) must be provided to say which rows are replaced"
    );
  }
}

// SRS 8.3: end-date the previous assignment the day before the new one starts, keep history.
export function replaceAssignment(rows, incoming, { sameSubject } = {}) {
  requireSubjectMatcher(sameSubject);
  validateRange(incoming);
  const overlapping = rows.filter((row) => sameSubject(row, incoming) && overlaps(row, incoming));
  const predecessors = overlapping.filter((row) => row.effectiveFrom < incoming.effectiveFrom);
  const successors = overlapping.filter((row) => row.effectiveFrom >= incoming.effectiveFrom);

  if (successors.some((row) => row.effectiveFrom === incoming.effectiveFrom)) {
    throw fail(
      "invalid_replacement",
      "a row already starts on that date; replacing it would erase history"
    );
  }
  if (predecessors.length === 0 && successors.length > 0) {
    throw fail("invalid_replacement", "the new assignment starts before the row it would replace");
  }
  if (predecessors.length > 1 || (predecessors.length === 1 && successors.length > 0)) {
    throw fail("overlap", "the new assignment overlaps more than one existing row");
  }

  const ended = predecessors.map((row) => endDate(row, addDays(incoming.effectiveFrom, -1)));
  const endedById = new Map(predecessors.map((row, index) => [row, ended[index]]));
  const next = rows.map((row) => endedById.get(row) ?? row);
  return { rows: [...next, { ...incoming }], ended };
}

// Configuration versions: exactly one applies on a date, or none.
export function versionAt(versions, isoDate) {
  const matching = versions.filter((version) => activeOn(version, isoDate));
  if (matching.length > 1) {
    throw fail("ambiguous_versions", `${matching.length} versions apply on ${isoDate}`);
  }
  return matching[0] ?? null;
}

// FR-SUPA-003: overlap is a tenant policy: warn (default), block or allow.
export function evaluateOverlap(existing, incoming, { sameSubject, policy = "warn" } = {}) {
  requireSubjectMatcher(sameSubject);
  if (!POLICIES.includes(policy)) {
    throw fail("invalid_policy", `overlap policy must be one of ${POLICIES.join(", ")}`);
  }
  validateRange(incoming);
  const conflicts = existing.filter((row) => sameSubject(row, incoming) && overlaps(row, incoming));
  if (conflicts.length === 0 || policy === "allow") return { status: "ok", conflicts };
  return { status: policy === "block" ? "blocked" : "warning", conflicts };
}
