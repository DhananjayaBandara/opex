// Tenant-scoped, transactional, audited store (AC-0.2, AC-0.4; SRS 9.1, 11; architecture 8, 9).
// Every operation runs through a session bound to one tenant and actor. The tenant comes from the
// session, never from a payload (FR-TEN-004). Each mutation and its audit event are written to a
// working copy that is persisted as one unit, so a failure leaves neither (atomic with the mutation).
// The platform (tenant registry, global user identities) lives in one reserved partition that no
// tenant session can address (SRS 5.1, architecture 5.4). A unit of work spans partitions atomically.
// Browser-safe: no Node imports; storage is injected (LocalStorage in the app, memory in tests).

import { randomUuid } from "./ids.js";

export const STORAGE_KEY = "opex-prototype:v1";
const SCHEMA_VERSION = 1;
const AUDIT = "audit";
const PLATFORM = "platform";
const SYSTEM_FIELDS = ["id", "tenantId"];
const STORE_ACTIONS = ["create", "update", "delete"];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A readable name for a collection or field: "attendanceRecords" -> "attendance record",
// "employeeCode" -> "employee code".
const words = (name) => name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const singular = (text) =>
  text.endsWith("ies") ? `${text.slice(0, -3)}y` : text.replace(/s$/, "");

// What a person is told when a uniqueness rule is broken. Fields that only scope the rule (a
// factory id) and the internal "Key" suffix of compared names are left out: the message names what
// the person typed.
function describeClash(collection, fields) {
  const typed = fields.filter((field) => !field.endsWith("Id")).map((f) => f.replace(/Key$/, ""));
  const named = (typed.length > 0 ? typed : fields.map((f) => f.replace(/Id$/, ""))).map(words);
  return `Another ${singular(words(collection))} already uses this ${named.join(" and ")}`;
}

const copy = (value) => structuredClone(value);
// What storage would hold: keeps memory identical to a reload (no undefined, dates as strings).
const asStored = (value) => JSON.parse(JSON.stringify(value));

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

function stripSystemFields(payload) {
  const clean = asStored(payload);
  for (const field of SYSTEM_FIELDS) delete clean[field];
  return clean;
}

function requireCollection(name) {
  if (name === AUDIT) {
    throw fail("reserved_collection", "the audit log is append-only and written only by the store");
  }
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw fail("invalid_collection", `invalid collection name: ${String(name)}`);
  }
}

function requireContext(context) {
  const { tenantId, actorId } = context ?? {};
  for (const [label, value] of [
    ["tenantId", tenantId],
    ["actorId", actorId],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw fail("invalid_context", `a session needs a non-empty ${label}`);
    }
  }
  return Object.freeze({ tenantId, actorId });
}

export function createStore({
  storage,
  clock = () => new Date().toISOString(),
  newId = randomUuid,
  uniques = {},
}) {
  const empty = () => ({ schemaVersion: SCHEMA_VERSION, tables: {}, audit: [] });
  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  let recovery = null;

  // Unreadable or foreign storage is kept under a quarantine key and never trusted (persistence
  // recovery): the store opens empty and reports why, instead of failing to start.
  const quarantine = (raw, reason) => {
    const quarantineKey = `${STORAGE_KEY}:quarantine:${clock()}`;
    storage.setItem(quarantineKey, raw);
    storage.removeItem(STORAGE_KEY);
    recovery = Object.freeze({ reason, quarantineKey });
    return empty();
  };

  const load = () => {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return empty();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return quarantine(raw, "unreadable");
    }
    if (!isObject(parsed) || !isObject(parsed.tables) || !Array.isArray(parsed.audit)) {
      return quarantine(raw, "unreadable");
    }
    return parsed.schemaVersion === SCHEMA_VERSION ? parsed : quarantine(raw, "schema_version");
  };
  let db = load();

  // While a trial is running, writes change only the in-memory copy, which is put back afterwards.
  let trial = 0;
  // While a batch is running, writes are kept in memory and saved once when the outermost batch ends.
  let deferred = 0;
  let unsaved = false;
  const commit = (draft) => {
    if (trial === 0 && deferred === 0) storage.setItem(STORAGE_KEY, JSON.stringify(draft));
    else if (trial === 0) unsaved = true;
    db = draft;
  };

  // Runs `work`, whose writes are each atomic as usual but are saved to storage once at the end
  // instead of after every write (a CSV commit creates up to 50 rows per batch). Whatever `work`
  // returns or throws is passed on, and what was written before a throw is still saved.
  function batch(work) {
    deferred += 1;
    try {
      return work();
    } finally {
      deferred -= 1;
      if (deferred === 0 && unsaved) {
        unsaved = false;
        storage.setItem(STORAGE_KEY, JSON.stringify(db));
      }
    }
  }

  // Runs `work` and then discards everything it wrote, in memory and in storage (nothing is saved
  // and no audit event survives). Used to check an import row exactly as a real write would, without
  // writing it. Whatever `work` returns or throws is passed on.
  function trialRun(work) {
    const kept = db;
    trial += 1;
    try {
      return work();
    } finally {
      trial -= 1;
      db = kept;
    }
  }

  // Operations act on `unit.draft`; writes set `unit.changed` so no-ops persist nothing.
  function operations(context, unit) {
    const rowsOf = (collection) => (unit.draft.tables[collection] ??= []);
    const findRow = (collection, id) =>
      rowsOf(collection).find((row) => row.tenantId === context.tenantId && row.id === id);

    const requireRow = (collection, id) => {
      const row = findRow(collection, id);
      if (!row) throw fail("not_found", `${collection} ${String(id)} was not found`);
      return row;
    };

    const checkUnique = (collection, candidate) => {
      for (const fields of uniques[collection] ?? []) {
        if (fields.some((field) => candidate[field] === null || candidate[field] === undefined))
          continue;
        const clash = rowsOf(collection).find(
          (row) =>
            row.tenantId === context.tenantId &&
            row.id !== candidate.id &&
            fields.every((field) => sameValue(row[field], candidate[field]))
        );
        if (clash) throw fail("duplicate", describeClash(collection, fields));
      }
    };

    const audit = (action, collection, entityId, changes) => {
      const event = {
        id: newId(),
        tenantId: context.tenantId,
        actorId: context.actorId,
        timestamp: clock(),
        action,
        entityType: collection,
        entityId,
        changes,
      };
      unit.draft.audit.push(event);
      unit.changed = true;
    };

    return {
      insert(collection, payload) {
        requireCollection(collection);
        const row = { id: newId(), tenantId: context.tenantId, ...stripSystemFields(payload) };
        checkUnique(collection, row);
        rowsOf(collection).push(row);
        const changes = {};
        for (const [field, value] of Object.entries(row)) {
          if (!SYSTEM_FIELDS.includes(field)) changes[field] = { before: null, after: value };
        }
        audit("create", collection, row.id, changes);
        return copy(row);
      },

      update(collection, id, patch) {
        requireCollection(collection);
        const existing = requireRow(collection, id);
        const clean = stripSystemFields(patch);
        const changes = {};
        for (const [field, value] of Object.entries(clean)) {
          if (!sameValue(existing[field] ?? null, value ?? null)) {
            changes[field] = { before: existing[field] ?? null, after: value };
          }
        }
        if (Object.keys(changes).length === 0) return copy(existing);
        const next = { ...existing, ...clean };
        checkUnique(collection, next);
        Object.assign(existing, next);
        audit("update", collection, id, changes);
        return copy(existing);
      },

      remove(collection, id) {
        requireCollection(collection);
        const existing = requireRow(collection, id);
        const rows = rowsOf(collection);
        rows.splice(rows.indexOf(existing), 1);
        const changes = {};
        for (const [field, value] of Object.entries(existing)) {
          if (!SYSTEM_FIELDS.includes(field)) changes[field] = { before: value, after: null };
        }
        audit("delete", collection, id, changes);
        return copy(existing);
      },

      get(collection, id) {
        requireCollection(collection);
        const row = findRow(collection, id);
        return row ? copy(row) : null;
      },

      list(collection, predicate) {
        requireCollection(collection);
        return rowsOf(collection)
          .filter((row) => row.tenantId === context.tenantId)
          .map(copy)
          .filter((row) => (predicate ? predicate(row) : true));
      },

      // A domain audit event (SRS 15.4: ASSIGN, APPROVE, LOGIN_SECURITY_EVENT ...) written
      // atomically with the surrounding unit. The store's own actions stay reserved.
      record({ action, entityType, entityId, changes = {} } = {}) {
        if (typeof action !== "string" || !/^[a-z][a-z_]*$/.test(action)) {
          throw fail("invalid_action", "an audit action is lowercase words joined by underscores");
        }
        if (STORE_ACTIONS.includes(action)) {
          throw fail("reserved_action", `${action} is recorded by the store itself`);
        }
        requireCollection(entityType);
        if (typeof entityId !== "string" || entityId.length === 0) {
          throw fail("invalid_entity", "an audit event needs the id of the entity it concerns");
        }
        audit(action, entityType, entityId, asStored(changes));
      },

      auditLog({ entityType, entityId } = {}) {
        return unit.draft.audit
          .filter(
            (event) =>
              event.tenantId === context.tenantId &&
              (entityType === undefined || event.entityType === entityType) &&
              (entityId === undefined || event.entityId === entityId)
          )
          .map(copy);
      },
    };
  }

  function bind(context) {
    const run =
      (name, write) =>
      (...args) => {
        const unit = { draft: write ? copy(db) : db, changed: false };
        const result = operations(context, unit)[name](...args);
        if (write && unit.changed) commit(unit.draft);
        return result;
      };
    const transaction = (work) => {
      const unit = { draft: copy(db), changed: false };
      const result = work(
        Object.freeze({ ...operations(context, unit), transaction: (inner) => inner() })
      );
      if (unit.changed) commit(unit.draft);
      return result;
    };
    return Object.freeze({
      insert: run("insert", true),
      update: run("update", true),
      remove: run("remove", true),
      record: run("record", true),
      get: run("get", false),
      list: run("list", false),
      auditLog: run("auditLog", false),
      transaction,
    });
  }

  function reservedCheck(context) {
    if (context.tenantId === PLATFORM) {
      throw fail("reserved_tenant", "the platform partition cannot be opened as a tenant");
    }
    return context;
  }

  const session = (rawContext) => bind(reservedCheck(requireContext(rawContext)));
  const platformSession = (rawActor) =>
    bind(requireContext({ tenantId: PLATFORM, actorId: rawActor?.actorId }));

  // One working copy for several partitions: everything commits, or nothing does.
  function unitOfWork(rawActor, work) {
    const { actorId } = requireContext({ tenantId: PLATFORM, actorId: rawActor?.actorId });
    const unit = { draft: copy(db), changed: false };
    const open = (context) =>
      Object.freeze({ ...operations(context, unit), transaction: (inner) => inner() });
    const result = work(
      Object.freeze({
        platform: open({ tenantId: PLATFORM, actorId }),
        tenant: (tenantId) => open(reservedCheck(requireContext({ tenantId, actorId }))),
      })
    );
    if (unit.changed) commit(unit.draft);
    return result;
  }

  return Object.freeze({ session, platformSession, unitOfWork, trialRun, batch, recovery });
}
