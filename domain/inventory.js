// Stock ledger and requisition rules (SRS 7.4; decisions D89 to D91; constraint C12, P19).
// Stock on hand is never stored or edited: it is the sum of the movements of a material at a
// factory. Movements are append-only; a correction is a new, opposite movement. Orchestration lives
// in services/inventory.js and services/procurement.js. Browser-safe: no Node imports.
import { validateDate } from "./organization.js";
import { MAX_QUANTITY, dateNotAfter, quantityOf, round3 } from "./procurement.js";
import { blank, optionalText, requireReason } from "./workforce.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---- Movements (D89, D90) -----------------------------------------------------------------------

export const MOVEMENT_TYPES = Object.freeze([
  "opening",
  "receipt",
  "issue",
  "adjustment_in",
  "adjustment_out",
  "return",
  "reversal",
]);

// What a person may record by hand; a receipt and a reversal come only from receipts (AC-9.10).
export const MANUAL_TYPES = Object.freeze([
  "opening",
  "issue",
  "return",
  "adjustment_in",
  "adjustment_out",
]);

const DIRECTIONS = Object.freeze({
  opening: "in",
  receipt: "in",
  issue: "out",
  adjustment_in: "in",
  adjustment_out: "out",
  return: "in",
});

export const directionOf = (type) => DIRECTIONS[type] ?? null;
export const signed = (movement) => (movement.direction === "in" ? 1 : -1) * movement.quantity;

export const balanceOf = (movements) =>
  round3(movements.reduce((sum, movement) => sum + signed(movement), 0));

// A manual movement (D90). A reason of 3 to 200 characters is mandatory for adjustments.
export function buildMovement(input, today) {
  if (!MANUAL_TYPES.includes(input.type)) {
    throw fail(
      "invalid_type",
      `record one of ${MANUAL_TYPES.join(", ").replaceAll("_", " ")}; receipts come from goods receipts`
    );
  }
  const adjustment = input.type === "adjustment_in" || input.type === "adjustment_out";
  const reason = adjustment
    ? requireReason(input.reason, "a reason for the adjustment")
    : optionalText(input.reason, "the note", 200);
  if (reason !== null && (reason.length < 3 || reason.length > 200)) {
    throw fail("invalid_field", "the reason must be 3 to 200 characters");
  }
  return {
    type: input.type,
    direction: directionOf(input.type),
    quantity: quantityOf(input.quantity),
    date: dateNotAfter(input.date, today, "the date"),
    reason,
  };
}

// Whether a type puts stock into the store (it needs an active material) or takes it out.
export const addsStock = (type) => directionOf(type) === "in";

// The opposite of a movement, for a reversed receipt (D88).
export function reversalOf(movement, date, reason) {
  return {
    type: "reversal",
    direction: movement.direction === "in" ? "out" : "in",
    quantity: movement.quantity,
    date,
    reason,
    reversesId: movement.id,
  };
}

// Days the stock would last at the daily use estimate, one decimal; null without an estimate.
export function coverDays(balance, dailyUse) {
  if (dailyUse === null || dailyUse === undefined || !(dailyUse > 0)) return null;
  return Math.max(0, Math.round((balance / dailyUse) * 10) / 10);
}

export const INDICATORS = Object.freeze(["out_of_stock", "below_reorder", "no_estimate", "ok"]);

// Always a word, never colour alone (AC-9.9).
export function stockIndicator(balance, reorderLevel, dailyUse) {
  if (balance <= 0) return "out_of_stock";
  if (balance < reorderLevel) return "below_reorder";
  if (dailyUse === null || dailyUse === undefined || !(dailyUse > 0)) return "no_estimate";
  return "ok";
}

export const INDICATOR_LABELS = Object.freeze({
  out_of_stock: "Out of stock",
  below_reorder: "Below reorder level",
  no_estimate: "No estimate for cover",
  ok: "OK",
});

export function requireEnough(balance, quantity, materialName) {
  if (round3(balance - quantity) < 0) {
    throw fail(
      "insufficient_stock",
      `only ${balance} of ${materialName} is on hand; ${quantity} cannot be taken out`
    );
  }
}

// ---- Requisitions (D91) -------------------------------------------------------------------------

export const REQUISITION_STATUSES = Object.freeze([
  "draft",
  "submitted",
  "approved",
  "rejected",
  "issued",
  "cancelled",
]);
export const CANCELLABLE_REQUISITION = Object.freeze(["draft", "submitted", "approved"]);

export function buildRequisition(input) {
  return {
    neededBy: blank(input.neededBy) ? null : validateDate(input.neededBy),
    note: optionalText(input.note, "the note", 300),
  };
}

export function changeRequisition(patch) {
  return {
    ...(patch.neededBy !== undefined && {
      neededBy: blank(patch.neededBy) ? null : validateDate(patch.neededBy),
    }),
    ...(patch.note !== undefined && { note: optionalText(patch.note, "the note", 300) }),
  };
}

export const buildRequisitionLine = (input) => ({ quantity: quantityOf(input.quantity) });

export function requireRequisitionStatus(row, expected, action) {
  if (!expected.includes(row.status)) {
    throw fail("invalid_transition", `a ${row.status} requisition cannot be ${action}`);
  }
}

export { MAX_QUANTITY };
