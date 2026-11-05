// Integration connections (SRS 14.4; architecture 17; decisions D98 to D100). SIMULATED: a connection
// holds an address, a credential reference and a status; a sync and a webhook delivery are
// recorded as runs, and no request ever leaves the browser.
//
// A connection never holds a secret: it names one by reference (`secret-ref/...`) and no call takes
// or returns a secret value. Inbound deliveries are routed by an endpoint key kept in a
// platform-level registry, so the organization is found from the key and never from the payload.
// Browser-safe: no Node imports.
import { signatureMatches, simulatedSignature } from "../domain/fingerprint.js";
import {
  DIRECTIONS,
  INTEGRATION_TYPES,
  MAX_ATTEMPTS,
  MAX_RECORDS,
  RUN_STATUSES,
  SIMULATED_FAILURE,
  STATUSES,
  credentialRef,
  externalIdFor,
  mappingProblem,
  readDelivery,
  requireEditable,
  requireRetryable,
  requireTransition,
  sampleBody,
  validateConnection,
  validateEdit,
} from "../domain/integrations.js";
import { validateKey } from "../domain/reports.js";
import { SYSTEM_ACTOR } from "./context.js";
import { fail } from "./errors.js";

const VIEW = "integration.view";
const MANAGE = "integration.manage";
const RUNS_SHOWN = 50;
const MAPPINGS_SHOWN = 100;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const notFound = () => fail("not_found", "that connection was not found");
const inactive = () =>
  fail("integration_not_active", "this connection is paused or disabled; enable it first");

function optionalKey(value) {
  return value === undefined || value === null || value === "" ? null : validateKey(value);
}

export function createIntegrations({ store, gate, clock, newId, newToken }) {
  function reader(context, permission) {
    const resolved = gate.requireTenant(context, permission);
    gate.authorizeTenantWide(resolved, permission);
    const session = store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });
    return { resolved, session };
  }

  const connection = (row, tenantId, extra = {}) =>
    Object.freeze({
      id: row.id,
      name: row.name,
      type: row.type,
      typeLabel: INTEGRATION_TYPES[row.type].label,
      exchanges: INTEGRATION_TYPES[row.type].records,
      direction: row.direction,
      directionLabel: DIRECTIONS[row.direction],
      endpoint: row.endpoint,
      schedule: row.schedule,
      status: row.status,
      statusLabel: STATUSES[row.status],
      statusReason: row.statusReason,
      credentialVersion: row.credentialVersion,
      credentialRef: credentialRef(tenantId, row.id, row.credentialVersion),
      endpointKey: row.endpointKey,
      acceptsDeliveries: row.direction !== "outbound",
      simulated: true,
      ...extra,
    });

  const runView = (run) =>
    Object.freeze({
      id: run.id,
      integrationId: run.integrationId,
      kind: run.kind,
      status: run.status,
      statusLabel: RUN_STATUSES[run.status],
      attempt: run.attempt,
      retryOfId: run.retryOfId,
      retriedBy: run.retriedBy,
      idempotencyKey: run.idempotencyKey,
      deliveryId: run.deliveryId ?? run.claimedDeliveryId,
      duplicateOfId: run.duplicateOfId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      processed: run.processed,
      errors: run.errors,
      error: run.error,
      note: run.note,
      excerpt: run.excerpt,
      fingerprint: run.fingerprint,
      simulated: true,
    });

  // Rows are kept in the order they were written, so reversing first makes ties newest-first too.
  const newestFirst = (rows) =>
    [...rows]
      .reverse()
      .sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? 1 : -1));
  // A failed run waits in the queue until something retries it; an abandoned one stays there.
  const inQueue = (run) =>
    run.kind === "sync" &&
    ((run.status === "failed" && run.retriedBy === null) || run.status === "abandoned");

  function load(session, integrationId) {
    const row =
      typeof integrationId === "string" ? session.get("integrations", integrationId) : null;
    if (row === null) throw notFound();
    return row;
  }

  // ---- Runs ---------------------------------------------------------------------------------------

  const baseRun = (integration, fields) => ({
    integrationId: integration.id,
    kind: "sync",
    attempt: 1,
    retryOfId: null,
    retriedBy: null,
    idempotencyKey: null,
    deliveryId: null,
    claimedDeliveryId: null,
    duplicateOfId: null,
    processed: 0,
    errors: 0,
    error: null,
    note: null,
    excerpt: null,
    fingerprint: null,
    ...fields,
  });

  // Creates or refreshes one mapping per record of the connection's kind. The internal records are
  // only read: a sync never changes them (D99).
  function refreshMappings(tx, integration, at) {
    const spec = INTEGRATION_TYPES[integration.type];
    const records = tx.list(spec.collection).slice(0, MAX_RECORDS);
    const known = new Map(
      tx
        .list("integrationMappings", (row) => row.integrationId === integration.id)
        .map((row) => [row.entityId, row])
    );
    let errors = 0;
    for (const record of records) {
      const problem = mappingProblem(integration.type, record);
      if (problem !== null) errors += 1;
      const fields = {
        lastSyncAt: at,
        status: problem === null ? "synced" : "error",
        error: problem,
      };
      const existing = known.get(record.id);
      if (existing === undefined) {
        tx.insert("integrationMappings", {
          integrationId: integration.id,
          entityType: spec.collection,
          entityId: record.id,
          externalId: externalIdFor(integration.type, integration.id, record.id),
          ...fields,
        });
      } else {
        tx.update("integrationMappings", existing.id, fields);
      }
    }
    return { processed: records.length - errors, errors };
  }

  // One simulated attempt on an Active connection.
  function attempt(tx, integration, { simulateFailure, idempotencyKey, retryOf }) {
    if (idempotencyKey !== null) {
      const first = tx.list(
        "integrationRuns",
        (row) => row.integrationId === integration.id && row.idempotencyKey === idempotencyKey
      )[0];
      if (first !== undefined) return { run: first, replayed: true };
    }
    if (retryOf !== null) requireRetryable(retryOf);
    if (integration.status !== "active") throw inactive();
    const number = retryOf === null ? 1 : retryOf.attempt + 1;
    const startedAt = clock();
    let result;
    if (simulateFailure) {
      result = {
        status: number >= MAX_ATTEMPTS ? "abandoned" : "failed",
        processed: 0,
        errors: 0,
        error: SIMULATED_FAILURE,
      };
    } else {
      result = { status: "succeeded", ...refreshMappings(tx, integration, startedAt), error: null };
    }
    const run = tx.insert(
      "integrationRuns",
      baseRun(integration, {
        ...result,
        attempt: number,
        retryOfId: retryOf === null ? null : retryOf.id,
        idempotencyKey,
        startedAt,
        endedAt: clock(),
      })
    );
    if (retryOf !== null) tx.update("integrationRuns", retryOf.id, { retriedBy: run.id });
    return { run, replayed: false };
  }

  // ---- Inbound ------------------------------------------------------------------------------------

  // The registry is read-only here and holds no tenant data: a key, its organization and connection.
  function routeOf(endpointKey) {
    if (typeof endpointKey !== "string" || endpointKey.length === 0) {
      throw fail("unknown_endpoint", "no connection uses that endpoint key");
    }
    const platform = store.platformSession({ actorId: SYSTEM_ACTOR });
    const route = platform.list("webhookEndpoints", (row) => row.endpointKey === endpointKey)[0];
    if (route === undefined) throw fail("unknown_endpoint", "no connection uses that endpoint key");
    const tenant = platform.get("tenants", route.ownerTenantId);
    if (tenant === null || tenant.status !== "active") throw inactive();
    return { route, tenant };
  }

  function receive(input) {
    const { endpointKey, deliveryId, signature, body } = isObject(input) ? input : {};
    const { route, tenant } = routeOf(endpointKey);
    if (typeof deliveryId !== "string" || !/^[\w.:-]{1,80}$/.test(deliveryId)) {
      throw fail("invalid_delivery_id", "a delivery id is 1 to 80 letters, digits or . : _ -");
    }
    const delivery = readDelivery(body);
    const tx = store.session({ tenantId: route.ownerTenantId, actorId: SYSTEM_ACTOR });
    return tx.transaction((unit) => {
      const integration = unit.get("integrations", route.integrationId);
      if (integration === null || integration.status !== "active") throw inactive();
      if (integration.direction === "outbound") {
        throw fail("wrong_direction", "this connection sends only and takes no deliveries");
      }
      const at = clock();
      const record = (fields) =>
        unit.insert(
          "integrationRuns",
          baseRun(integration, {
            kind: "webhook",
            claimedDeliveryId: deliveryId,
            fingerprint: delivery.fingerprint,
            excerpt: delivery.excerpt,
            startedAt: at,
            endedAt: at,
            ...fields,
          })
        );
      const answer = (run, extra = {}) =>
        Object.freeze({
          status: run.status,
          statusLabel: RUN_STATUSES[run.status],
          runId: run.id,
          processed: run.processed,
          note: run.note,
          error: run.error,
          ...extra,
        });
      if (!signatureMatches(endpointKey, body, signature)) {
        return answer(
          record({
            status: "rejected",
            error: "The signature does not match the body; nothing was processed",
          })
        );
      }
      const first = unit.list(
        "integrationRuns",
        (row) => row.integrationId === integration.id && row.deliveryId === deliveryId
      )[0];
      if (first !== undefined) {
        const run = record({
          status: "duplicate",
          duplicateOfId: first.id,
          note: "This delivery id was already accepted; nothing was processed again",
        });
        return answer(run, {
          firstOutcome: Object.freeze({
            runId: first.id,
            status: first.status,
            statusLabel: RUN_STATUSES[first.status],
            processed: first.processed,
          }),
        });
      }
      if (!delivery.valid) {
        return answer(
          record({ status: "rejected", error: "The body is not JSON; nothing was processed" })
        );
      }
      const foreign =
        delivery.namedTenant !== null &&
        delivery.namedTenant !== route.ownerTenantId &&
        delivery.namedTenant !== tenant.slug;
      const run = record({
        status: "accepted",
        deliveryId,
        processed: delivery.items,
        note: foreign
          ? `The payload named another organization (${String(delivery.namedTenant).slice(0, 40)}); it was ignored and the delivery was routed by its endpoint key`
          : null,
      });
      return answer(run);
    });
  }

  return Object.freeze({
    list(context) {
      const { resolved, session } = reader(context, VIEW);
      const runs = session.list("integrationRuns");
      const mappings = session.list("integrationMappings");
      return Object.freeze(
        session
          .list("integrations")
          .sort((a, b) => a.nameKey.localeCompare(b.nameKey))
          .map((row) => {
            const own = newestFirst(runs.filter((run) => run.integrationId === row.id));
            const last = own[0];
            return connection(row, resolved.tenant.id, {
              lastRun: last === undefined ? null : runView(last),
              queued: own.filter(inQueue).length,
              mappings: mappings.filter((mapping) => mapping.integrationId === row.id).length,
            });
          })
      );
    },

    get(context, integrationId) {
      const { resolved, session } = reader(context, VIEW);
      const row = load(session, integrationId);
      const runs = newestFirst(
        session.list("integrationRuns", (run) => run.integrationId === row.id)
      );
      const mappings = session
        .list("integrationMappings", (mapping) => mapping.integrationId === row.id)
        .reverse()
        .sort((a, b) => (a.lastSyncAt === b.lastSyncAt ? 0 : a.lastSyncAt < b.lastSyncAt ? 1 : -1));
      return Object.freeze({
        connection: connection(row, resolved.tenant.id),
        runs: Object.freeze(runs.slice(0, RUNS_SHOWN).map(runView)),
        runCount: runs.length,
        queue: Object.freeze(runs.filter(inQueue).map(runView)),
        mappings: Object.freeze(
          mappings.slice(0, MAPPINGS_SHOWN).map((m) => Object.freeze({ ...m }))
        ),
        mappingCount: mappings.length,
      });
    },

    // A new connection is Paused, with its credential reference at v1 and an endpoint key registered
    // in the platform registry in the same unit of work.
    create(context, input) {
      const { resolved } = reader(context, MANAGE);
      const fields = validateConnection(input);
      const tenantId = resolved.tenant.id;
      return store.unitOfWork({ actorId: resolved.user.id }, ({ platform, tenant }) => {
        const tx = tenant(tenantId);
        const row = tx.insert("integrations", {
          ...fields,
          status: "paused",
          statusReason: null,
          credentialVersion: 1,
          endpointKey: `whk_${newToken()}`,
        });
        platform.insert("webhookEndpoints", {
          endpointKey: row.endpointKey,
          ownerTenantId: tenantId,
          integrationId: row.id,
        });
        return connection(row, tenantId);
      });
    },

    update(context, integrationId, input) {
      const { resolved, session } = reader(context, MANAGE);
      return session.transaction((tx) => {
        const row = load(tx, integrationId);
        requireEditable(row.status);
        const next = validateEdit(input, row);
        return connection(tx.update("integrations", row.id, next), resolved.tenant.id);
      });
    },

    transition(context, integrationId, action, options = {}) {
      const { resolved, session } = reader(context, MANAGE);
      return session.transaction((tx) => {
        const row = load(tx, integrationId);
        const next = requireTransition(action, row.status, options?.reason);
        const updated = tx.update("integrations", row.id, next);
        tx.record({
          action: `integration_${action}d`,
          entityType: "integrations",
          entityId: row.id,
          changes: { from: row.status, to: next.status, reason: next.statusReason },
        });
        return connection(updated, resolved.tenant.id);
      });
    },

    // Moves to the next reference. The old and new references go to the audit log; no secret does.
    rotateCredential(context, integrationId) {
      const { resolved, session } = reader(context, MANAGE);
      return session.transaction((tx) => {
        const row = load(tx, integrationId);
        if (row.status === "disabled") {
          throw fail("integration_disabled", "a disabled connection cannot be rotated");
        }
        const tenantId = resolved.tenant.id;
        const updated = tx.update("integrations", row.id, {
          credentialVersion: row.credentialVersion + 1,
        });
        tx.record({
          action: "credential_rotated",
          entityType: "integrations",
          entityId: row.id,
          changes: {
            previousReference: credentialRef(tenantId, row.id, row.credentialVersion),
            newReference: credentialRef(tenantId, row.id, updated.credentialVersion),
          },
        });
        return connection(updated, tenantId);
      });
    },

    // One simulated sync. The same Idempotency-Key returns the first run and creates nothing.
    runSync(context, integrationId, options = {}) {
      const { session } = reader(context, MANAGE);
      const input = isObject(options) ? options : {};
      const idempotencyKey = optionalKey(input.idempotencyKey);
      return session.transaction((tx) => {
        const row = load(tx, integrationId);
        const { run, replayed } = attempt(tx, row, {
          simulateFailure: input.simulateFailure === true,
          idempotencyKey,
          retryOf: null,
        });
        return Object.freeze({ ...runView(run), replayed });
      });
    },

    // Retries a failed run: a new run that links to it. Three attempts in all; the third failure is
    // Abandoned.
    retry(context, runId, options = {}) {
      const { session } = reader(context, MANAGE);
      const input = isObject(options) ? options : {};
      const idempotencyKey = optionalKey(input.idempotencyKey);
      return session.transaction((tx) => {
        const original = typeof runId === "string" ? tx.get("integrationRuns", runId) : null;
        if (original === null) throw fail("not_found", "that run was not found");
        const row = load(tx, original.integrationId);
        const { run, replayed } = attempt(tx, row, {
          simulateFailure: input.simulateFailure === true,
          idempotencyKey,
          retryOf: original,
        });
        return Object.freeze({ ...runView(run), replayed });
      });
    },

    // Sends a delivery to this connection's own endpoint as an outside system would: correctly signed,
    // or with a tampered signature. The delivery then goes through the same path as any other.
    sendTestWebhook(context, integrationId, options = {}) {
      const { session } = reader(context, MANAGE);
      const input = isObject(options) ? options : {};
      const row = load(session, integrationId);
      const deliveryId =
        typeof input.deliveryId === "string" && input.deliveryId.trim() !== ""
          ? input.deliveryId.trim()
          : `test-${newId()}`;
      const body = typeof input.body === "string" ? input.body : sampleBody(row, deliveryId);
      const signature = simulatedSignature(
        row.endpointKey,
        input.tamper === true ? `${body} ` : body
      );
      return receive({ endpointKey: row.endpointKey, deliveryId, signature, body });
    },

    // The public side of a webhook: no context, only the endpoint key in the address, a delivery id,
    // a signature and the body. The organization comes from the key.
    receiveWebhook: receive,
  });
}
