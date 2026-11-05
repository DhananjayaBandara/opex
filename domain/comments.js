// Operational comment rules (C070, C071; decisions D66, D67): a short note on a factory, optionally a
// line and shift, with employees tagged. Pure functions; lookups and scope live in
// services/comments.js. Browser-safe: no Node imports.
import { validateDate } from "./organization.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const BODY_MAX = 1000;
export const MENTION_MAX = 10;
export const REASON_MAX = 300;

// Tab and line feed stay; other control characters are dropped.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function validateBody(value) {
  const text = typeof value === "string" ? value.replace(CONTROL, "").trim() : "";
  if (text.length === 0 || text.length > BODY_MAX) {
    throw fail("invalid_comment", `a comment is 1 to ${BODY_MAX} characters`);
  }
  return text;
}

export function validateReason(value) {
  const text = typeof value === "string" ? value.replace(CONTROL, "").trim() : "";
  if (text.length === 0 || text.length > REASON_MAX) {
    throw fail("reason_required", `a reason of 1 to ${REASON_MAX} characters is required`);
  }
  return text;
}

// The date a note is about: a real date, not after today (the business date of the organization).
export function validateOnDate(value, today) {
  const date = validateDate(value);
  if (date > today) throw fail("future_date", "a comment cannot be about a day that has not come");
  return date;
}

// A list of employee ids, no repeats, at most ten.
export function validateMentionIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id === "")) {
    throw fail("invalid_mentions", "mentions are a list of employee ids");
  }
  const ids = [...new Set(value)];
  if (ids.length > MENTION_MAX) {
    throw fail("too_many_mentions", `a comment can tag at most ${MENTION_MAX} employees`);
  }
  return ids;
}

// A line and a shift are given together or not at all.
export function requireAreaPair(lineId, shiftId) {
  const hasLine = lineId !== undefined && lineId !== null && lineId !== "";
  const hasShift = shiftId !== undefined && shiftId !== null && shiftId !== "";
  if (hasLine !== hasShift) {
    throw fail("line_and_shift_together", "name both a line and a shift, or neither");
  }
  return hasLine;
}
