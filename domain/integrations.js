// Integration connections (SRS 14.4; architecture 17; decisions D98 to D100): the types, the
// lifecycle of a connection, credential references, and the rules of the simulated sync and
// inbound webhook. Everything here is SIMULATED: no request ever leaves the browser. Pure
// functions. Browser-safe: no Node imports.
import { redact } from "./audit.js";
import { fingerprint } from "./fingerprint.js";

function fail(code, message, fields) {
  const error = new Error(message);
  error.code = code;
  if (fields !== undefined) error.fields = fields;
  return error;
}

// What each kind of connection exchanges. `collection` is the OPEX+ data a sync reads (never writes);
// `blocked` are the statuses of a record the external system must not receive.
export const INTEGRATION_TYPES = Object.freeze({
  accounting_erp: Object.freeze({
    label: "Accounting or ERP",
    collection: "invoices",
    records: "invoices",
    prefix: "ACC",
    blocked: Object.freeze({
      draft: "A draft invoice is not sent",
      cancelled: "A cancelled invoice is not sent",
    }),
  }),
  supplier: Object.freeze({
    label: "Supplier",
    collection: "purchaseOrders",
    records: "purchase orders",
    prefix: "SUP",
    blocked: Object.freeze({
      draft: "A draft purchase order is not sent",
      cancelled: "A cancelled purchase order is not sent",
    }),
  }),
  hr_payroll: Object.freeze({
    label: "HR or payroll",
    collection: "employees",
    records: "employees",
    prefix: "HRP",
    blocked: Object.freeze({ inactive: "An inactive employee is not sent" }),
  }),
  shop_floor: Object.freeze({
    label: "Shop-floor device",
    collection: "productionDays",
    records: "production days",
    prefix: "SHF",
    blocked: Object.freeze({}),
  }),
  email: Object.freeze({
    label: "Email provider",
    collection: "notificationDeliveries",
    records: "notification deliveries",
    prefix: "EML",
    blocked: Object.freeze({}),
  }),
});
export const TYPE_KEYS = Object.freeze(Object.keys(INTEGRATION_TYPES));

export const DIRECTIONS = Object.freeze({
  outbound: "Outbound (OPEX+ sends)",
  inbound: "Inbound (OPEX+ receives)",
  both: "Both directions",
});

export const STATUSES = Object.freeze({ paused: "Paused", active: "Active", disabled: "Disabled" });

// Paused is the state a connection is born in and the state an administrator reaches before editing.
const TRANSITIONS = Object.freeze({
  enable: Object.freeze({ from: ["paused", "disabled"], to: "active", past: "enabled" }),
  pause: Object.freeze({ from: ["active"], to: "paused", past: "paused" }),
  disable: Object.freeze({ from: ["active", "paused"], to: "disabled", past: "disabled" }),
});
export const TRANSITION_ACTIONS = Object.freeze(Object.keys(TRANSITIONS));

export function requireTransition(action, status, reason) {
  const rule = TRANSITIONS[action];
  if (rule === undefined) {
    throw fail("invalid_action", `an integration can be ${TRANSITION_ACTIONS.join(", ")}d`);
  }
  if (!rule.from.includes(status)) {
    throw fail(
      "invalid_transition",
      `a ${STATUSES[status].toLowerCase()} connection cannot be ${rule.past}`
    );
  }
  let note = null;
  if (action === "disable") {
    note = typeof reason === "string" ? reason.trim() : "";
    if (note.length === 0 || note.length > 200) {
      throw fail("reason_required", "say why it is disabled (1 to 200 characters)", {
        reason: ["Give a reason (up to 200 characters)"],
      });
    }
  }
  return { status: rule.to, statusReason: note };
}

export const requireEditable = (status) => {
  if (status === "active") {
    throw fail("integration_active", "pause the connection before editing it");
  }
};

const ENDPOINT_MAX = 200;
export function validateEndpoint(value) {
  const text = typeof value === "string" ? value.trim() : "";
  let url = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  const problem = (message) => fail("invalid_endpoint", message, { endpoint: [message] });
  if (url === null || text.length > ENDPOINT_MAX) {
    throw problem(`Enter a full https address of at most ${ENDPOINT_MAX} characters`);
  }
  if (url.protocol !== "https:") throw problem("The address must start with https://");
  if (url.hostname === "") throw problem("The address needs a host name");
  // A credential belongs in a credential reference, never in an address.
  if (url.username !== "" || url.password !== "") {
    throw problem("Do not put a user name or password in the address");
  }
  if (url.search !== "")
    throw problem("Do not put a query string (it may carry a key) in the address");
  return text;
}

function pick(value, allowed, label, code) {
  if (typeof value !== "string" || !Object.hasOwn(allowed, value)) {
    throw fail(code, `${label} must be one of ${Object.keys(allowed).join(", ")}`, {
      [code.replace("invalid_", "")]: [`Choose a ${label}`],
    });
  }
  return value;
}

function scheduleNote(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.trim().length > 120) {
    throw fail("invalid_schedule", "the schedule note is at most 120 characters", {
      schedule: ["At most 120 characters"],
    });
  }
  return value.trim();
}

function connectionName(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (name.length === 0 || name.length > 80) {
    throw fail("invalid_name", "a name is 1 to 80 characters", {
      name: ["Enter 1 to 80 characters"],
    });
  }
  return { name, nameKey: name.toLowerCase() };
}

// The fields a new connection is made from. Credentials are never part of it (D98).
export function validateConnection(input) {
  const source = typeof input === "object" && input !== null ? input : {};
  return {
    ...connectionName(source.name),
    type: pick(source.type, INTEGRATION_TYPES, "type", "invalid_type"),
    direction: pick(source.direction ?? "outbound", DIRECTIONS, "direction", "invalid_direction"),
    endpoint: validateEndpoint(source.endpoint),
    schedule: scheduleNote(source.schedule),
  };
}

// What may change after creation. The type is fixed: its mappings describe one kind of record.
export function validateEdit(input, current) {
  const source = typeof input === "object" && input !== null ? input : {};
  const next = {};
  if (source.name !== undefined) Object.assign(next, connectionName(source.name));
  if (source.direction !== undefined) {
    next.direction = pick(source.direction, DIRECTIONS, "direction", "invalid_direction");
  }
  if (source.endpoint !== undefined) next.endpoint = validateEndpoint(source.endpoint);
  if (source.schedule !== undefined) next.schedule = scheduleNote(source.schedule);
  if (source.type !== undefined && source.type !== current.type) {
    throw fail("type_fixed", "the type of a connection cannot change; add a new connection", {
      type: ["The type cannot change"],
    });
  }
  return next;
}

// A credential reference names a secret held elsewhere; it never contains one (architecture 17.1).
export const credentialRef = (tenantId, integrationId, version) =>
  `secret-ref/tenants/${tenantId}/integrations/${integrationId}/v${version}`;

// ---- Simulated sync -----------------------------------------------------------------------------------

export const MAX_ATTEMPTS = 3;
export const MAX_RECORDS = 25;
export const RUN_STATUSES = Object.freeze({
  succeeded: "Succeeded",
  failed: "Failed",
  abandoned: "Abandoned",
  accepted: "Accepted",
  rejected: "Rejected",
  duplicate: "Duplicate",
});
export const SIMULATED_FAILURE = "Simulated failure: the external system did not answer in time";

// An external id the simulated system would assign: stable for a connection and a record.
export const externalIdFor = (type, integrationId, entityId) =>
  `${INTEGRATION_TYPES[type].prefix}-${fingerprint(`${integrationId}:${entityId}`).slice(0, 8).toUpperCase()}`;

// null when the record can be sent; otherwise why it cannot.
export function mappingProblem(type, row) {
  const blocked = INTEGRATION_TYPES[type].blocked;
  return typeof row.status === "string" && Object.hasOwn(blocked, row.status)
    ? blocked[row.status]
    : null;
}

export function requireRetryable(run) {
  if (run.kind !== "sync") throw fail("not_retryable", "only a sync run can be retried");
  if (run.status === "abandoned" || run.attempt >= MAX_ATTEMPTS) {
    throw fail("retry_exhausted", `this run failed ${MAX_ATTEMPTS} times and was abandoned`);
  }
  if (run.status !== "failed") throw fail("not_retryable", "only a failed run can be retried");
  if (run.retriedBy !== null) throw fail("already_retried", "this run was already retried");
}

// ---- Inbound webhooks ---------------------------------------------------------------------------------

export const EXCERPT_MAX = 240;
export const BODY_MAX = 20_000;
const TENANT_FIELDS = ["tenant", "tenantId", "tenant_id", "organization", "organizationId"];

// What a delivery's body may reveal: a redacted excerpt, a fingerprint, the number of items it
// carries, and whether it names an organization (which is then ignored, D100).
export function readDelivery(body) {
  if (typeof body !== "string" || body.length === 0 || body.length > BODY_MAX) {
    throw fail("invalid_body", `a delivery body is text of 1 to ${BODY_MAX} characters`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const base = { fingerprint: fingerprint(body), bytes: new TextEncoder().encode(body).length };
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ...base,
      valid: false,
      excerpt: "(not JSON; excerpt withheld)",
      items: 0,
      namedTenant: null,
    };
  }
  const shown = JSON.stringify(redact(parsed));
  const list = Array.isArray(parsed) ? parsed : (parsed.events ?? parsed.records ?? null);
  const namedField = TENANT_FIELDS.find(
    (field) => !Array.isArray(parsed) && typeof parsed[field] === "string"
  );
  return {
    ...base,
    valid: true,
    excerpt: shown.length > EXCERPT_MAX ? `${shown.slice(0, EXCERPT_MAX)}…` : shown,
    items: Array.isArray(list) ? list.length : 1,
    namedTenant: namedField === undefined ? null : parsed[namedField],
  };
}

export function sampleBody(integration, deliveryId) {
  return JSON.stringify({
    event: "sample.updated",
    deliveryId,
    connection: integration.name,
    events: [{ reference: "SIM-001", status: "ok" }],
  });
}
