// Tenant lifecycle and provisioning rules (decisions D15, D20; FR-TEN-001; architecture 4.8).
//
//   provisioned -> active <-> suspended
//   active | suspended -> deactivated -> active (restore)
//
// A tenant is reachable interactively only while it is active. Suspending or deactivating needs a
// stated reason. Pure functions; no storage. Browser-safe: no Node imports.
import { FEATURES } from "./permissions.js";
import { isValidTimeZone } from "./time.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const TENANT_STATUSES = Object.freeze(["provisioned", "active", "suspended", "deactivated"]);

const TRANSITIONS = Object.freeze({
  provisioned: Object.freeze(["active"]),
  active: Object.freeze(["suspended", "deactivated"]),
  suspended: Object.freeze(["active", "deactivated"]),
  deactivated: Object.freeze(["active"]),
});

const ACTIONS = Object.freeze({
  "provisioned>active": "activate",
  "active>suspended": "suspend",
  "suspended>active": "resume",
  "active>deactivated": "deactivate",
  "suspended>deactivated": "deactivate",
  "deactivated>active": "restore",
});

const REASON_REQUIRED = Object.freeze(["suspended", "deactivated"]);

export function canTransition(from, to) {
  return Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

// The audit action name of an allowed transition (SRS 15.4).
export function transitionAction(from, to) {
  return ACTIONS[`${from}>${to}`];
}

// Validates a requested transition and normalizes its reason.
export function assertTransition({ from, to, reason } = {}) {
  if (!canTransition(from, to)) {
    throw fail("invalid_transition", `a ${String(from)} tenant cannot become ${String(to)}`);
  }
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (REASON_REQUIRED.includes(to) && trimmed === "") {
    throw fail("reason_required", `a reason is required to make a tenant ${to}`);
  }
  return Object.freeze({ to, reason: trimmed === "" ? null : trimmed });
}

// ---- Provisioning input ----------------------------------------------------------------------

// Slugs become the host label (<slug>.<base domain>) and so are DNS-safe: lowercase letters, digits
// and hyphens, starting with a letter and ending with a letter or digit, 3 to 30 characters.
const SLUG = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
export const RESERVED_SLUGS = Object.freeze([
  "platform",
  "admin",
  "www",
  "api",
  "app",
  "support",
  "status",
  "mail",
  "static",
  "assets",
]);

export const DEFAULT_FEATURES = Object.freeze(["production", "performance", "attendance"]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
  const address = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (address.length === 0 || address.length > 254 || !EMAIL.test(address)) {
    throw fail("invalid_email", "a valid email address is required");
  }
  return address;
}

export function validateName(value, label = "name") {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > 120) {
    throw fail("invalid_name", `${label} must be 1 to 120 characters`);
  }
  return name;
}

export function validateSlug(value) {
  if (typeof value !== "string" || !SLUG.test(value)) {
    throw fail("invalid_slug", "a slug is 3 to 30 lowercase letters, digits or hyphens");
  }
  if (RESERVED_SLUGS.includes(value)) throw fail("reserved_slug", `${value} is reserved`);
  return value;
}

function validateFeatures(features) {
  if (features === undefined) return [...DEFAULT_FEATURES];
  if (!Array.isArray(features) || features.some((feature) => !FEATURES.includes(feature))) {
    throw fail("invalid_features", `features must be a list drawn from ${FEATURES.join(", ")}`);
  }
  return [...new Set(features)].sort();
}

// Everything a new tenant needs before anything is written; timezone is required (D20).
export function validateProvision(spec) {
  const name = validateName(spec?.name, "the company name");
  const slug = validateSlug(spec?.slug);
  if (!isValidTimeZone(spec?.timeZone)) {
    throw fail("invalid_timezone", "an IANA timezone such as Asia/Colombo is required");
  }
  const email = normalizeEmail(spec?.admin?.email);
  const adminName = validateName(spec?.admin?.name, "the administrator name");
  return Object.freeze({
    name,
    slug,
    timeZone: spec.timeZone,
    admin: Object.freeze({ email, name: adminName }),
    features: Object.freeze(validateFeatures(spec.features)),
  });
}
