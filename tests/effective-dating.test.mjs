// AC-0.5 Effective-dating helpers (architecture 7.2-7.4). Ranges are inclusive ISO dates;
// effectiveTo = null means open-ended.
import test from "node:test";
import assert from "node:assert/strict";
import { optional, need } from "./harness.mjs";

const ed = await optional("../domain/effective-dating.js");
const SRC = "domain/effective-dating.js";
const range = (effectiveFrom, effectiveTo = null, extra = {}) => ({
  effectiveFrom,
  effectiveTo,
  ...extra,
});
const code = (expected) => (error) => error?.code === expected;

test("AC-0.5 addDays is calendar-exact across month ends, leap days and year ends", () => {
  const addDays = need(ed, "addDays", SRC);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-31", -89), "2026-01-01");
});

test("AC-0.5 validateRange rejects reversed ranges and impossible dates", () => {
  const validateRange = need(ed, "validateRange", SRC);
  assert.doesNotThrow(() => validateRange(range("2026-01-01")));
  assert.doesNotThrow(() => validateRange(range("2026-01-01", "2026-01-01")));
  assert.throws(() => validateRange(range("2026-02-01", "2026-01-31")), code("invalid_range"));
  assert.throws(() => validateRange(range("2026-13-01")), code("invalid_range"));
  assert.throws(() => validateRange(range("2026-02-30")), code("invalid_range"));
  assert.throws(() => validateRange(range(null)), code("invalid_range"));
});

test("AC-0.5 overlaps is inclusive and treats a null end as open-ended", () => {
  const overlaps = need(ed, "overlaps", SRC);
  assert.equal(
    overlaps(range("2026-01-01", "2026-01-31"), range("2026-01-31", "2026-02-15")),
    true
  );
  assert.equal(
    overlaps(range("2026-01-01", "2026-01-31"), range("2026-02-01", "2026-02-15")),
    false
  );
  assert.equal(overlaps(range("2026-01-01"), range("2030-01-01", "2030-01-02")), true);
  assert.equal(overlaps(range("2026-01-01", "2026-01-31"), range("2026-06-01")), false);
  assert.equal(overlaps(range("2026-06-01"), range("2026-01-01", "2026-01-31")), false);
});

test("AC-0.5 isAdjacent is true only when one range starts the day after the other ends", () => {
  const isAdjacent = need(ed, "isAdjacent", SRC);
  assert.equal(isAdjacent(range("2026-01-01", "2026-01-31"), range("2026-02-01")), true);
  assert.equal(isAdjacent(range("2026-02-01"), range("2026-01-01", "2026-01-31")), true);
  assert.equal(isAdjacent(range("2026-01-01", "2026-01-31"), range("2026-02-02")), false);
  assert.equal(isAdjacent(range("2026-01-01", "2026-01-31"), range("2026-01-31")), false);
});

test("AC-0.5 activeOn includes both boundary days", () => {
  const activeOn = need(ed, "activeOn", SRC);
  const r = range("2026-01-01", "2026-03-31");
  assert.equal(activeOn(r, "2025-12-31"), false);
  assert.equal(activeOn(r, "2026-01-01"), true);
  assert.equal(activeOn(r, "2026-03-31"), true);
  assert.equal(activeOn(r, "2026-04-01"), false);
  assert.equal(activeOn(range("2026-01-01"), "2099-01-01"), true);
});

test("AC-0.5 endDate returns an ended copy, never mutates, and cannot end before the start", () => {
  const endDate = need(ed, "endDate", SRC);
  const original = range("2026-01-01", null, { id: "a1" });
  const ended = endDate(original, "2026-02-28");
  assert.equal(ended.effectiveTo, "2026-02-28");
  assert.equal(ended.id, "a1");
  assert.equal(original.effectiveTo, null);
  assert.throws(() => endDate(original, "2025-12-31"), code("invalid_range"));
});

test("AC-0.5 replacement end-dates the previous assignment the day before and keeps history", () => {
  const replaceAssignment = need(ed, "replaceAssignment", SRC);
  const rows = [range("2026-01-01", null, { id: "old", key: "ss-1" })];
  const result = replaceAssignment(rows, range("2026-03-01", null, { id: "new", key: "ss-1" }), {
    sameSubject: (a, b) => a.key === b.key,
  });
  assert.equal(result.rows.length, 2);
  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  assert.equal(byId.old.effectiveTo, "2026-02-28");
  assert.equal(byId.new.effectiveFrom, "2026-03-01");
  assert.equal(byId.new.effectiveTo, null);
  assert.deepEqual(
    result.ended.map((row) => row.id),
    ["old"]
  );
  assert.equal(rows[0].effectiveTo, null, "input rows must not be mutated");
});

test("AC-0.5 replacement leaves unrelated subjects and already-closed history untouched", () => {
  const replaceAssignment = need(ed, "replaceAssignment", SRC);
  const rows = [
    range("2025-01-01", "2025-12-31", { id: "closed", key: "ss-1" }),
    range("2026-01-01", null, { id: "other", key: "ss-2" }),
  ];
  const result = replaceAssignment(rows, range("2026-03-01", null, { id: "new", key: "ss-1" }), {
    sameSubject: (a, b) => a.key === b.key,
  });
  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  assert.equal(byId.closed.effectiveTo, "2025-12-31");
  assert.equal(byId.other.effectiveTo, null);
  assert.deepEqual(result.ended, []);
});

test("AC-0.5 replacement that would erase history or overlap a later row is rejected untouched", () => {
  const replaceAssignment = need(ed, "replaceAssignment", SRC);
  const sameSubject = (a, b) => a.key === b.key;
  const rows = [range("2026-03-01", null, { id: "old", key: "ss-1" })];
  assert.throws(
    () =>
      replaceAssignment(rows, range("2026-03-01", null, { id: "n", key: "ss-1" }), { sameSubject }),
    code("invalid_replacement")
  );
  assert.throws(
    () =>
      replaceAssignment(rows, range("2026-02-01", null, { id: "n", key: "ss-1" }), { sameSubject }),
    code("invalid_replacement")
  );
  const future = [
    range("2026-01-01", "2026-05-31", { id: "a", key: "ss-1" }),
    range("2026-06-01", null, { id: "b", key: "ss-1" }),
  ];
  assert.throws(
    () =>
      replaceAssignment(future, range("2026-03-01", null, { id: "n", key: "ss-1" }), {
        sameSubject,
      }),
    code("overlap")
  );
  assert.equal(future[0].effectiveTo, "2026-05-31");
});

test("AC-0.5 versionAt reconstructs the version that applied on a date", () => {
  const versionAt = need(ed, "versionAt", SRC);
  const versions = [
    range("2026-01-01", "2026-03-31", { version: 1 }),
    range("2026-04-01", null, { version: 2 }),
  ];
  assert.equal(versionAt(versions, "2026-03-31").version, 1);
  assert.equal(versionAt(versions, "2026-04-01").version, 2);
  assert.equal(versionAt(versions, "2025-12-31"), null);
  const ambiguous = [range("2026-01-01", "2026-06-30"), range("2026-06-01")];
  assert.throws(() => versionAt(ambiguous, "2026-06-15"), code("ambiguous_versions"));
});

test("AC-0.5 evaluateOverlap follows the configured policy: warn (default), block or allow", () => {
  const evaluateOverlap = need(ed, "evaluateOverlap", SRC);
  const existing = [range("2026-01-01", null, { id: "x", key: "ss-1" })];
  const incoming = range("2026-03-01", null, { id: "y", key: "ss-1" });
  const sameSubject = (a, b) => a.key === b.key;
  const warn = evaluateOverlap(existing, incoming, { sameSubject });
  assert.equal(warn.status, "warning");
  assert.deepEqual(
    warn.conflicts.map((row) => row.id),
    ["x"]
  );
  assert.equal(
    evaluateOverlap(existing, incoming, { sameSubject, policy: "block" }).status,
    "blocked"
  );
  assert.equal(evaluateOverlap(existing, incoming, { sameSubject, policy: "allow" }).status, "ok");
  const clear = range("2025-01-01", "2025-12-31", { id: "z", key: "ss-1" });
  assert.equal(evaluateOverlap(existing, clear, { sameSubject }).status, "ok");
  assert.throws(() => evaluateOverlap(existing, incoming, { sameSubject, policy: "bogus" }));
});
