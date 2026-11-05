// What the prototype does not do for real, in one list (D108; SRS 11 and 12, architecture 11 and 16).
// Three levels, used by the parity manifest and shown on the Limits page:
//   D  works in the browser, with real rules and a real audit trail
//   S  simulated: the screen and the rules are real, the outside world is pretended and labelled
//   N  cannot be demonstrated in a browser; listed here with the document it comes from
// Browser-safe: no Node imports.

export const LEVELS = Object.freeze([
  Object.freeze({
    key: "D",
    label: "Works",
    meaning:
      "The screen follows the same rules as the real system and every change is written to the audit log.",
  }),
  Object.freeze({
    key: "S",
    label: "Simulated",
    meaning:
      "The screen and the rules are real, but whatever lies outside the browser is pretended and labelled as such.",
  }),
  Object.freeze({
    key: "N",
    label: "Cannot be shown",
    meaning:
      "Needs servers, a database or time that a page in a browser does not have. Listed here with its source.",
  }),
]);

// Simulated items: what is pretended, and what is still real.
export const SIMULATED = Object.freeze([
  Object.freeze({
    id: "mfa",
    title: "Sign-in codes",
    simulated:
      "The six-digit code is shown on the Prototype tools page and is not a cryptographic one-time password.",
    real: "A code is still required, expires and is refused when wrong.",
    source: "SRS 8 (authentication)",
  }),
  Object.freeze({
    id: "email",
    title: "E-mail and notifications",
    simulated:
      "No message leaves the browser; each one is recorded as delivered, failed or retried.",
    real: "Templates, recipients, preferences, delivery history and retries behave as specified.",
    source: "Architecture 16 (notifications)",
  }),
  Object.freeze({
    id: "integrations",
    title: "Integrations and webhooks",
    simulated:
      "A sync or a delivery makes no external request; the outcome (success, failure, duplicate, bad signature) is produced inside the prototype and every page says so.",
    real: "Connection settings, status rules, credential references, retries, idempotency and the history are real.",
    source: "Architecture 16 and 17",
  }),
  Object.freeze({
    id: "files",
    title: "Files",
    simulated:
      "Only the details of a file are kept (name, kind, size, who registered it). The content is not stored, scanned or served.",
    real: "The 5 MB limit, the allowed kinds, tenant-scoped storage keys and the audit trail are real.",
    source: "Architecture 16 (file storage)",
  }),
  Object.freeze({
    id: "storage",
    title: "Data storage",
    simulated:
      "Everything lives in this browser's LocalStorage (about 5 MB). It is not encrypted, not shared between devices and not tamper-proof.",
    real: "Each organization's data is separated by the services, and the audit log is append-only to the services.",
    source: "SRS 12 (data) and architecture 11",
  }),
  Object.freeze({
    id: "clock",
    title: "Scheduled work",
    simulated:
      "Nothing runs while the browser is closed. Scheduled reports, reminders and retries are processed when a page is open or when you use Run now on Prototype tools.",
    real: "Schedules, cadences, time zones and the history of runs behave as specified.",
    source: "SRS 12.2 (background jobs)",
  }),
]);

// Not demonstrable: the same four rows as the parity manifest, with the document each comes from.
export const LIMITS = Object.freeze([
  Object.freeze({
    id: "FR-TEN-008",
    title: "Caching and background jobs carry tenant context",
    reason:
      "Caching and background jobs need server processes (Celery and Redis). Files, exports and audit carry the organization under their own rows.",
    source: "SRS 9.1 FR-TEN-008 and SRS 12.2",
  }),
  Object.freeze({
    id: "FR-TEN-009",
    title: "PostgreSQL Row-Level Security as defense in depth",
    reason:
      "Row-Level Security needs a database. The prototype shows isolation through its organization-scoped store instead.",
    source: "SRS 9.1 FR-TEN-009 and SRS 12.2",
  }),
  Object.freeze({
    id: "SRS-11-OPERATIONS",
    title: "Availability, backup and restore, observability and load targets",
    reason:
      "The 99.5 percent availability target, backup and restore, monitoring and performance under load need deployed infrastructure.",
    source: "SRS 11",
  }),
  Object.freeze({
    id: "SRS-17-LATER",
    title: "Data migration and the enterprise dedicated database",
    reason: "Explicitly later or unscheduled work; the prototype loads demonstration data only.",
    source: "SRS 17 and decision D12",
  }),
]);
