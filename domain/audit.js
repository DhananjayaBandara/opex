// Audit log reading rules (SRS 15.4; D97): redaction of sensitive fields, readable wording for an
// event and the filters. Pure functions. Browser-safe: no Node imports.
import { zonedInstant } from "./reports.js";
import { validateDate } from "./organization.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const REDACTED = "[redacted]";

// A field named like a secret is never shown (SRS 15.4: sensitive fields redacted). Credential
// references are not secrets; only a credential's value is.
const SENSITIVE =
  /secret|token|password|passcode|signing[_-]?key|api[_-]?key|private[_-]?key|credential[_-]?value/i;

export const isSensitive = (name) => SENSITIVE.test(String(name));

// A copy of a value with every sensitive field replaced, at any depth.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const clean = {};
  for (const [name, inner] of Object.entries(value)) {
    clean[name] = isSensitive(name) ? REDACTED : redact(inner);
  }
  return clean;
}

const words = (name) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase();
const singular = (text) =>
  text.endsWith("ies") ? `${text.slice(0, -3)}y` : text.replace(/s$/, "");
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// "buyerOrders" -> "Buyer order".
export const entityLabel = (entityType) => capital(singular(words(entityType)));

const VERBS = Object.freeze({ create: "Created", update: "Updated", delete: "Deleted" });

// "create" -> "Created"; a domain action such as "import_committed" -> "Import committed".
export const actionLabel = (action) => VERBS[action] ?? capital(words(action));

// The first of these fields that an event holds names the record in a summary.
const NAMING = ["name", "number", "reference", "code", "employeeCode", "title", "label", "email"];

// A payload is a before/after pair (store events) or a plain value (domain events).
const isPair = (change) =>
  typeof change === "object" &&
  change !== null &&
  Object.hasOwn(change, "before") &&
  Object.hasOwn(change, "after");

function nameOf(changes) {
  for (const field of NAMING) {
    const change = changes?.[field];
    if (change === undefined) continue;
    const shown = isPair(change) ? (change.after ?? change.before) : change;
    if (typeof shown === "string" || typeof shown === "number") return String(shown);
  }
  return null;
}

// One line for the list: what happened to which record, and for an update which fields changed.
export function summarize(event) {
  const label = entityLabel(event.entityType).toLowerCase();
  const name = nameOf(event.changes);
  const target = name === null ? label : `${label} ${name}`;
  if (event.action === "update") {
    const fields = Object.keys(event.changes ?? {}).map(words);
    return `Updated ${target}${fields.length > 0 ? `: ${fields.slice(0, 4).join(", ")}${fields.length > 4 ? ` and ${fields.length - 4} more` : ""}` : ""}`;
  }
  if (VERBS[event.action] !== undefined) return `${VERBS[event.action]} ${target}`;
  return `${actionLabel(event.action)}: ${target}`;
}

// Before and after, field by field, with sensitive fields redacted. Domain events whose payload is
// not a before/after pair are listed as an "after" value only.
export function detailOf(changes) {
  const rows = [];
  for (const [field, change] of Object.entries(changes ?? {})) {
    const pair = isPair(change);
    const before = pair ? change.before : null;
    const after = pair ? change.after : change;
    rows.push({
      field,
      label: capital(words(field)),
      before: isSensitive(field) ? REDACTED : redact(before),
      after: isSensitive(field) ? REDACTED : redact(after),
    });
  }
  return rows;
}

const SHAPE = /^[a-z][a-z_]*$/;
const ENTITY = /^[A-Za-z][A-Za-z0-9_]*$/;

function text(value, label, shape) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 80 || (shape && !shape.test(value))) {
    throw fail("invalid_filter", `${label} is not a valid filter`);
  }
  return value;
}

function day(value, label) {
  if (value === undefined || value === null || value === "") return null;
  try {
    return validateDate(value);
  } catch {
    throw fail("invalid_filter", `${label} must be a date written YYYY-MM-DD`);
  }
}

export function readLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw fail("invalid_limit", `a page is 1 to ${MAX_LIMIT} events`);
  }
  return value;
}

// The filters of a list call. Dates are business dates in the organization's zone and become the
// instants at which that zone's first day starts and its last day ends.
export function readFilters(input, timeZone) {
  const source = typeof input === "object" && input !== null ? input : {};
  const filters = {
    actorId: text(source.actorId, "the actor"),
    action: text(source.action, "the action", SHAPE),
    entityType: text(source.entityType, "the kind of record", ENTITY),
    entityId: text(source.entityId, "the record id"),
    before: text(source.before, "the page position"),
    from: day(source.from, "the from date"),
    to: day(source.to, "the to date"),
  };
  if (filters.from !== null && filters.to !== null && filters.from > filters.to) {
    throw fail("invalid_filter", "the from date is after the to date");
  }
  const next = (date) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    ...filters,
    startsAt:
      filters.from === null ? null : zonedInstant(filters.from, "00:00", timeZone).toISOString(),
    endsBefore:
      filters.to === null ? null : zonedInstant(next(filters.to), "00:00", timeZone).toISOString(),
  };
}

export function matchesFilters(event, filters) {
  return (
    (filters.actorId === null || event.actorId === filters.actorId) &&
    (filters.action === null || event.action === filters.action) &&
    (filters.entityType === null || event.entityType === filters.entityType) &&
    (filters.entityId === null || event.entityId === filters.entityId) &&
    (filters.startsAt === null || event.timestamp >= filters.startsAt) &&
    (filters.endsBefore === null || event.timestamp < filters.endsBefore)
  );
}
