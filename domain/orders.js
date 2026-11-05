// Order and planning rules (SRS 7.2, 9; decisions D72 to D82).
// Pure validation and arithmetic for buyers, buyer orders and their lines, time-and-action templates
// and milestones, buyer approvals and capacity bookings. Orchestration (authorization, lookups,
// transactions, audit) lives in services/orders.js. Browser-safe: no Node imports.
import { addDays } from "./effective-dating.js";
import { isWorkingDay, normalizeCode, validateDate } from "./organization.js";
import { normalizeEmail, validateName } from "./tenancy.js";
import { blank, optionalText, requireReason } from "./workforce.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function toNumber(value, label) {
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (isNumber(value)) return value;
  throw fail("invalid_number", `${label} must be a number`);
}

function wholeNumber(value, label, { min = 0, max = 1_000_000 } = {}) {
  const number = toNumber(value, label);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw fail("invalid_number", `${label} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

function decimal(value, label, { min, max }) {
  const number = toNumber(value, label);
  if (!(number >= min) || number > max) {
    throw fail("invalid_number", `${label} must be from ${min} to ${max}`);
  }
  return number;
}

const flag = (value, label) => {
  if (typeof value !== "boolean") throw fail("invalid_field", `${label} must be true or false`);
  return value;
};

const nameFields = (value, label) => {
  const name = validateName(value, label);
  return { name, nameKey: name.toLowerCase() };
};

const present = (patch, field) => patch[field] !== undefined;
const round2 = (value) => Math.round(value * 100) / 100;

// ---- Buyers (D73) -------------------------------------------------------------------------------

export function buildBuyer(input) {
  return {
    code: normalizeCode(input.code),
    ...nameFields(input.name, "the buyer name"),
    country: optionalText(input.country, "the country", 60),
    contactName: optionalText(input.contactName, "the contact name", 80),
    contactEmail: blank(input.contactEmail) ? null : normalizeEmail(input.contactEmail),
    active: true,
  };
}

export function changeBuyer(patch) {
  return {
    ...(present(patch, "code") && { code: normalizeCode(patch.code) }),
    ...(present(patch, "name") && nameFields(patch.name, "the buyer name")),
    ...(present(patch, "country") && { country: optionalText(patch.country, "the country", 60) }),
    ...(present(patch, "contactName") && {
      contactName: optionalText(patch.contactName, "the contact name", 80),
    }),
    ...(present(patch, "contactEmail") && {
      contactEmail: blank(patch.contactEmail) ? null : normalizeEmail(patch.contactEmail),
    }),
  };
}

// ---- Orders (D74, D75) --------------------------------------------------------------------------

export const ORDER_STATUSES = Object.freeze([
  "draft",
  "confirmed",
  "in_production",
  "shipped",
  "closed",
  "cancelled",
]);

// One step at a time; an order is cancelled (with a reason) until it has shipped.
const NEXT = Object.freeze({
  draft: "confirmed",
  confirmed: "in_production",
  in_production: "shipped",
  shipped: "closed",
});
const CANCELLABLE = Object.freeze(["draft", "confirmed", "in_production"]);

// The orders still being worked: their milestones, approvals and bookings count (D81).
export const ACTIVE_ORDER_STATUSES = Object.freeze(["draft", "confirmed", "in_production"]);
export const LOCKED_ORDER_STATUSES = Object.freeze(["shipped", "closed", "cancelled"]);

export const isActiveOrder = (status) => ACTIVE_ORDER_STATUSES.includes(status);
export const nextOrderStatus = (status) => NEXT[status] ?? null;
export const canCancelOrder = (status) => CANCELLABLE.includes(status);

export function requireOrderTransition(from, to, reason) {
  if (!ORDER_STATUSES.includes(to)) {
    throw fail("invalid_status", `${String(to)} is not an order status`);
  }
  if (to === "cancelled") {
    if (!canCancelOrder(from)) {
      throw fail("invalid_transition", "a shipped, closed or cancelled order cannot be cancelled");
    }
    return { status: "cancelled", cancelReason: requireReason(reason, "a reason for cancelling") };
  }
  if (NEXT[from] !== to) {
    throw fail("invalid_transition", `an order moves from ${from} to ${NEXT[from] ?? "nothing"}`);
  }
  return { status: to, cancelReason: null };
}

function validCurrency(value) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) {
    throw fail("invalid_currency", "a currency is a three-letter code such as USD");
  }
  return code;
}

function validDates(orderDate, shipDate) {
  validateDate(orderDate);
  validateDate(shipDate);
  if (shipDate < orderDate) {
    throw fail("invalid_dates", "the ship date cannot be before the order date");
  }
}

export function buildOrder(input, defaultCurrency) {
  validDates(input.orderDate, input.shipDate);
  return {
    reference: normalizeCode(input.reference),
    buyerPo: optionalText(input.buyerPo, "the buyer's PO number", 40),
    orderDate: input.orderDate,
    shipDate: input.shipDate,
    currency: validCurrency(blank(input.currency) ? defaultCurrency : input.currency),
    note: optionalText(input.note, "the note", 300),
  };
}

// The editable fields of an order; the ship date is checked against the order date it ends up with.
export function changeOrder(patch, current) {
  const values = {
    ...(present(patch, "buyerPo") && {
      buyerPo: optionalText(patch.buyerPo, "the buyer's PO number", 40),
    }),
    ...(present(patch, "orderDate") && { orderDate: validateDate(patch.orderDate) }),
    ...(present(patch, "shipDate") && { shipDate: validateDate(patch.shipDate) }),
    ...(present(patch, "currency") && { currency: validCurrency(patch.currency) }),
    ...(present(patch, "note") && { note: optionalText(patch.note, "the note", 300) }),
  };
  validDates(values.orderDate ?? current.orderDate, values.shipDate ?? current.shipDate);
  return values;
}

// ---- Order lines (D74) --------------------------------------------------------------------------

export const LINE_STATUSES = Object.freeze(["open", "completed", "cancelled"]);
export const MAX_QUANTITY = 10_000_000;

function optionalPrice(value) {
  if (blank(value)) return null;
  const price = decimal(value, "the unit price", { min: 0, max: 1_000_000 });
  if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) {
    throw fail("invalid_number", "the unit price has at most two decimals");
  }
  return round2(price);
}

export function buildLine(input) {
  return {
    quantity: wholeNumber(input.quantity, "the quantity", { min: 1, max: MAX_QUANTITY }),
    unitPrice: optionalPrice(input.unitPrice),
  };
}

export function changeLine(patch) {
  return {
    ...(present(patch, "quantity") && {
      quantity: wholeNumber(patch.quantity, "the quantity", { min: 1, max: MAX_QUANTITY }),
    }),
    ...(present(patch, "unitPrice") && { unitPrice: optionalPrice(patch.unitPrice) }),
  };
}

export function requireLineStatus(status, reason) {
  if (status !== "completed" && status !== "cancelled" && status !== "open") {
    throw fail("invalid_status", `${String(status)} is not a line status`);
  }
  return {
    status,
    cancelReason: status === "cancelled" ? requireReason(reason, "a reason for cancelling") : null,
  };
}

// Pieces made against a line (D76): the figures come from the service; this adds what is left and
// the share done (above 100 when more was made than ordered).
export function lineProgress(line, produced) {
  const made = produced ?? 0;
  return Object.freeze({
    produced: made,
    remaining: Math.max(0, line.quantity - made),
    percent: Math.round((made / line.quantity) * 1000) / 10,
  });
}

// ---- Time-and-action templates and milestones (D77) --------------------------------------------

export function buildTemplate(input) {
  return {
    ...nameFields(input.name, "the template name"),
    description: optionalText(input.description, "the description", 300),
    active: true,
  };
}

export function changeTemplate(patch) {
  return {
    ...(present(patch, "name") && nameFields(patch.name, "the template name")),
    ...(present(patch, "description") && {
      description: optionalText(patch.description, "the description", 300),
    }),
  };
}

const offsetDays = (value) => wholeNumber(value, "the offset", { min: -365, max: 730 });
const sequenceNumber = (value) => wholeNumber(value, "the sequence", { min: 1, max: 999 });

export function buildDefinition(input) {
  return {
    code: normalizeCode(input.code),
    name: validateName(input.name, "the milestone name"),
    offsetDays: offsetDays(input.offsetDays ?? 0),
    blocking: blank(input.blocking) ? false : flag(input.blocking, "blocking"),
    responsibleRole: optionalText(input.responsibleRole, "the responsible role", 60),
    active: true,
  };
}

export function changeDefinition(patch) {
  return {
    ...(present(patch, "code") && { code: normalizeCode(patch.code) }),
    ...(present(patch, "name") && { name: validateName(patch.name, "the milestone name") }),
    ...(present(patch, "offsetDays") && { offsetDays: offsetDays(patch.offsetDays) }),
    ...(present(patch, "blocking") && { blocking: flag(patch.blocking, "blocking") }),
    ...(present(patch, "responsibleRole") && {
      responsibleRole: optionalText(patch.responsibleRole, "the responsible role", 60),
    }),
  };
}

export const sequenceOf = (value) => sequenceNumber(value);

export const MILESTONE_STATUSES = Object.freeze([
  "not_started",
  "in_progress",
  "blocked",
  "completed",
]);
// What is stored, and what a person may set by hand (completing has its own action).
export const MANUAL_MILESTONE_STATUSES = Object.freeze(["not_started", "in_progress", "blocked"]);

// A milestone copies the template line so a later template edit never rewrites it (D77).
export function milestoneFromDefinition(definition, orderDate) {
  return {
    definitionId: definition.id,
    code: definition.code,
    name: definition.name,
    sequence: definition.sequence,
    blocking: definition.blocking === true,
    responsibleRole: definition.responsibleRole ?? null,
    plannedDate: addDays(orderDate, definition.offsetDays),
  };
}

export function buildMilestone(input) {
  return {
    code: normalizeCode(input.code),
    name: validateName(input.name, "the milestone name"),
    plannedDate: validateDate(input.plannedDate),
    blocking: blank(input.blocking) ? false : flag(input.blocking, "blocking"),
    responsibleRole: optionalText(input.responsibleRole, "the responsible role", 60),
    note: optionalText(input.note, "the note", 300),
  };
}

// The date a milestone is held to: the revised date once one was agreed.
export const dueOf = (milestone) => milestone.revisedDate ?? milestone.plannedDate;

// What to show: "late" is worked out from today, so it can never be stale (D77).
export function milestoneState(milestone, today) {
  if (milestone.status === "completed") return "completed";
  return dueOf(milestone) < today ? "late" : milestone.status;
}

export function reviseDate(input) {
  return {
    revisedDate: validateDate(input.revisedDate),
    revisionReason: requireReason(input.reason),
  };
}

export function requireManualMilestoneStatus(status) {
  if (!MANUAL_MILESTONE_STATUSES.includes(status)) {
    throw fail("invalid_status", "set not started, in progress or blocked; use Complete to finish");
  }
  return status;
}

// ---- Buyer approvals (D78) ----------------------------------------------------------------------

export const APPROVAL_STATUSES = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "revision_requested",
]);
export const DECISIONS = Object.freeze(["approved", "rejected", "revision_requested"]);

export function buildApprovalType(input) {
  return {
    code: normalizeCode(input.code),
    ...nameFields(input.name, "the approval name"),
    description: optionalText(input.description, "the description", 300),
    blocking: blank(input.blocking) ? false : flag(input.blocking, "blocking"),
    active: true,
  };
}

export function changeApprovalType(patch) {
  return {
    ...(present(patch, "code") && { code: normalizeCode(patch.code) }),
    ...(present(patch, "name") && nameFields(patch.name, "the approval name")),
    ...(present(patch, "description") && {
      description: optionalText(patch.description, "the description", 300),
    }),
    ...(present(patch, "blocking") && { blocking: flag(patch.blocking, "blocking") }),
  };
}

export function buildRequest(input) {
  return {
    dueDate: validateDate(input.dueDate),
    note: optionalText(input.note, "the note", 300),
  };
}

export function validateDecision(input) {
  if (!DECISIONS.includes(input.decision)) {
    throw fail("invalid_decision", "decide approved, rejected or revision requested");
  }
  return { decision: input.decision, remarks: requireReason(input.remarks, "the remarks") };
}

// A resubmission is possible only after a revision was requested (D78).
export function requireResubmittable(approval) {
  if (approval.status !== "revision_requested") {
    throw fail(
      "invalid_transition",
      "only an approval with a revision requested can be resubmitted"
    );
  }
}

export function requireDecidable(approval) {
  if (approval.status !== "pending") {
    throw fail("invalid_transition", "only a pending approval can be decided");
  }
}

// ---- Capacity bookings (D79, D80) ---------------------------------------------------------------

export const BOOKING_STATUSES = Object.freeze(["planned", "confirmed", "completed", "cancelled"]);
export const ACTIVE_BOOKING_STATUSES = Object.freeze(["planned", "confirmed"]);
export const MAX_BOOKING_DAYS = 366;

export const isActiveBooking = (status) => ACTIVE_BOOKING_STATUSES.includes(status);

export function validateBookingRange(startDate, endDate) {
  validateDate(startDate);
  validateDate(endDate);
  if (endDate < startDate) throw fail("invalid_dates", "the end date cannot be before the start");
  if (addDays(startDate, MAX_BOOKING_DAYS - 1) < endDate) {
    throw fail("invalid_dates", `a booking covers at most ${MAX_BOOKING_DAYS} days`);
  }
}

export function buildBooking(input) {
  validateBookingRange(input.startDate, input.endDate);
  return {
    startDate: input.startDate,
    endDate: input.endDate,
    operators: wholeNumber(input.operators, "the operators", { min: 1, max: 10_000 }),
    efficiency: decimal(blank(input.efficiency) ? 80 : input.efficiency, "the efficiency", {
      min: 1,
      max: 100,
    }),
    hoursPerDay: decimal(blank(input.hoursPerDay) ? 8 : input.hoursPerDay, "the hours per day", {
      min: 0.1,
      max: 24,
    }),
    note: optionalText(input.note, "the note", 300),
  };
}

// The dates in the range the calendar works (a dated exception wins over the weekly pattern).
export function workingDatesBetween(calendar, exceptions, startDate, endDate) {
  validateBookingRange(startDate, endDate);
  const dates = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    if (isWorkingDay(calendar, exceptions, date)) dates.push(date);
  }
  return dates;
}

// What a booking needs and what it has, in minutes (D79). Rounded to two decimals.
export function bookingFigures({
  quantity,
  smv,
  operators,
  efficiency,
  hoursPerDay,
  workingDates,
}) {
  const requiredMinutes = round2(quantity * smv);
  const dailyCapacityMinutes = round2((operators * hoursPerDay * 60 * efficiency) / 100);
  const availableMinutes = round2(dailyCapacityMinutes * workingDates.length);
  return { requiredMinutes, dailyCapacityMinutes, availableMinutes };
}

export const isOverloaded = (booking) => booking.requiredMinutes > booking.availableMinutes;

// Another active booking on the same production line (and the same shift when both name one) that
// shares a working date (D79).
export function conflictsOf(booking, others) {
  const dates = new Set(booking.workingDates);
  return others.filter(
    (other) =>
      other.id !== booking.id &&
      isActiveBooking(other.status) &&
      other.productionLineId === booking.productionLineId &&
      (other.shiftId === null || booking.shiftId === null || other.shiftId === booking.shiftId) &&
      other.workingDates.some((date) => dates.has(date))
  );
}

// The part of a booking that falls in a period: its working dates there, the minutes it needs in
// them (spread evenly over its working dates) and the minutes it has (D80).
export function loadIn(booking, from, to) {
  const inside = booking.workingDates.filter((date) => date >= from && date <= to);
  const share = booking.workingDates.length === 0 ? 0 : inside.length / booking.workingDates.length;
  return {
    days: inside.length,
    requiredMinutes: round2(booking.requiredMinutes * share),
    availableMinutes: round2(booking.dailyCapacityMinutes * inside.length),
  };
}

export const utilization = (required, available) =>
  available > 0 ? Math.round((required / available) * 1000) / 10 : null;

// ---- The orders card (D81) ----------------------------------------------------------------------

export const SOON_DAYS = 14;

// The figures of the tenant dashboard's orders card, from rows already limited to the caller's scope.
export function ordersSummary({ orders, milestones, approvals, bookings, today }) {
  const active = new Map(orders.filter((o) => isActiveOrder(o.status)).map((o) => [o.id, o]));
  const soonEnd = addDays(today, SOON_DAYS);
  const byStatus = Object.fromEntries(ACTIVE_ORDER_STATUSES.map((status) => [status, 0]));
  for (const order of active.values()) byStatus[order.status] += 1;
  const pending = approvals.filter((a) => a.status === "pending" && active.has(a.orderId));
  return Object.freeze({
    byStatus: Object.freeze(byStatus),
    open: active.size,
    shippingSoon: [...active.values()].filter((o) => o.shipDate >= today && o.shipDate <= soonEnd)
      .length,
    shipOverdue: [...active.values()].filter((o) => o.shipDate < today).length,
    lateMilestones: milestones.filter(
      (m) => active.has(m.orderId) && milestoneState(m, today) === "late"
    ).length,
    pendingApprovals: pending.length,
    overdueApprovals: pending.filter((a) => a.dueDate < today).length,
    overloadedBookings: bookings.filter(
      (b) => isActiveBooking(b.status) && active.has(b.orderId) && isOverloaded(b)
    ).length,
    soonDays: SOON_DAYS,
  });
}
