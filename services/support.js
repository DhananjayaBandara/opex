// Platform support access (FR-TEN-010, UC-TEN-04; decision D19).
//
// Platform staff have no tenant data by default. A support engineer asks for access with a reason and
// a duration of at most eight hours; someone in the tenant who holds `support_access.approve` (and is
// not the requester) approves or denies it. An approved grant gives a read-only context for that
// tenant until it expires or is revoked by either side; the gate re-checks the grant on every call and
// writes a `support_access_used` event to the tenant's audit log each time it is used. Grants live in
// the tenant's own partition, so the tenant sees and audits all of them.
// Browser-safe: no Node imports.
import { fail } from "./errors.js";

export const MAX_SUPPORT_MINUTES = 480;
const REQUEST = "support_access.request";
const APPROVE = "support_access.approve";
const MAX_REASON = 500;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function createSupport({ store, gate, clock, notifier }) {
  const tenantSession = (tenantId, actorId) => store.session({ tenantId, actorId });

  // The stored status plus the passage of time: an approved grant past its end reads as expired.
  const statusOf = (grant) =>
    grant.status === "approved" && clock() >= grant.expiresAt ? "expired" : grant.status;

  function view(grant, users, tenantName = null) {
    const requester = users.get("users", grant.requestedBy);
    return Object.freeze({
      id: grant.id,
      tenantId: grant.tenantId,
      tenantName,
      requestedBy: Object.freeze({
        id: grant.requestedBy,
        name: requester?.name ?? null,
        email: requester?.email ?? null,
      }),
      reason: grant.reason,
      durationMinutes: grant.durationMinutes,
      status: statusOf(grant),
      requestedAt: grant.requestedAt,
      decidedAt: grant.decidedAt ?? null,
      expiresAt: grant.expiresAt ?? null,
      revokedAt: grant.revokedAt ?? null,
    });
  }

  const grantRow = (session, grantId) => {
    const row = typeof grantId === "string" ? session.get("supportGrants", grantId) : null;
    if (row === null) throw fail("not_found", "that support request was not found");
    return row;
  };

  const isOpen = (grant) => ["pending", "approved"].includes(statusOf(grant));

  const record = (tx, grant, action, changes = {}) =>
    tx.record({ action, entityType: "supportGrants", entityId: grant.id, changes });

  return Object.freeze({
    // Platform support asks to see one tenant, for a stated reason and a bounded time.
    request(context, input) {
      const actor = gate.requirePlatform(context, REQUEST);
      const request = isObject(input) ? input : {};
      const registry = store.platformSession({ actorId: actor.user.id });
      const tenant =
        typeof request.tenantId === "string" ? registry.get("tenants", request.tenantId) : null;
      if (tenant === null) throw fail("not_found", "that tenant was not found");
      if (tenant.status !== "active")
        throw fail("tenant_inactive", "this organization is not active");
      const reason = typeof request.reason === "string" ? request.reason.trim() : "";
      if (reason.length === 0 || reason.length > MAX_REASON) {
        throw fail("reason_required", `a reason of 1 to ${MAX_REASON} characters is required`);
      }
      const minutes = request.durationMinutes;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SUPPORT_MINUTES) {
        throw fail(
          "invalid_duration",
          `access lasts between 1 and ${MAX_SUPPORT_MINUTES} minutes (eight hours)`
        );
      }
      return tenantSession(tenant.id, actor.user.id).transaction((tx) => {
        if (
          tx.list("supportGrants", (g) => g.requestedBy === actor.user.id && isOpen(g)).length > 0
        ) {
          throw fail("duplicate", "you already have an open support request for this tenant");
        }
        const grant = tx.insert("supportGrants", {
          requestedBy: actor.user.id,
          reason,
          durationMinutes: minutes,
          status: "pending",
          requestedAt: clock(),
          decidedBy: null,
          decidedAt: null,
          expiresAt: null,
          revokedAt: null,
        });
        notifier.supportRequested(tx, {
          tenantId: tenant.id,
          grant,
          requesterName: actor.user.name,
        });
        return view(grant, registry, tenant.name);
      });
    },

    // A tenant approver sees the tenant's requests; platform support sees their own across tenants.
    list(context) {
      const resolved = gate.resolve(context);
      if (resolved.kind === "platform") {
        gate.requirePlatform(context, REQUEST);
        const registry = store.platformSession({ actorId: resolved.user.id });
        return Object.freeze(
          registry
            .list("tenants")
            .flatMap((tenant) =>
              tenantSession(tenant.id, resolved.user.id)
                .list("supportGrants", (g) => g.requestedBy === resolved.user.id)
                .map((grant) => view(grant, registry, tenant.name))
            )
            .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
        );
      }
      const tenantContext = gate.requireTenant(context);
      gate.authorizeTenantWide(tenantContext, APPROVE);
      const registry = store.platformSession({ actorId: resolved.user.id });
      return Object.freeze(
        tenantSession(tenantContext.tenant.id, resolved.user.id)
          .list("supportGrants")
          .map((grant) => view(grant, registry, tenantContext.tenant.name))
      );
    },

    approve(context, grantId) {
      return decide(context, grantId, "approved", "support_access_approved");
    },

    deny(context, grantId) {
      return decide(context, grantId, "denied", "support_access_denied");
    },

    // Either side can end access at once: the tenant's approver, or the requesting engineer.
    revoke(context, grantId) {
      const resolved = gate.resolve(context);
      if (resolved.kind === "platform") {
        gate.requirePlatform(context, REQUEST);
        const registry = store.platformSession({ actorId: resolved.user.id });
        for (const tenant of registry.list("tenants")) {
          const session = tenantSession(tenant.id, resolved.user.id);
          const grant = typeof grantId === "string" ? session.get("supportGrants", grantId) : null;
          if (grant !== null && grant.requestedBy === resolved.user.id) {
            return end(session, grant, registry, tenant.name);
          }
        }
        throw fail("not_found", "that support request was not found");
      }
      const tenantContext = gate.requireTenant(context);
      gate.authorizeTenantWide(tenantContext, APPROVE);
      const registry = store.platformSession({ actorId: resolved.user.id });
      const session = tenantSession(tenantContext.tenant.id, resolved.user.id);
      return end(session, grantRow(session, grantId), registry, tenantContext.tenant.name);
    },

    // The support engineer opens the read-only tenant context an approved grant allows. Every later
    // call through it is re-checked and audited by the gate.
    enter(context, grantId) {
      const actor = gate.requirePlatform(context, REQUEST);
      const registry = store.platformSession({ actorId: actor.user.id });
      for (const tenant of registry.list("tenants")) {
        const session = tenantSession(tenant.id, actor.user.id);
        const grant = typeof grantId === "string" ? session.get("supportGrants", grantId) : null;
        if (grant === null || grant.requestedBy !== actor.user.id) continue;
        if (tenant.status !== "active")
          throw fail("tenant_inactive", "this organization is not active");
        const status = statusOf(grant);
        if (status !== "approved") {
          throw fail(`support_${status}`, `this support request is ${status}, not approved`);
        }
        session.record({
          action: "support_access_entered",
          entityType: "supportGrants",
          entityId: grant.id,
          changes: {},
        });
        return gate.issue({
          kind: "tenant",
          userId: actor.user.id,
          sessionId: context.sessionId,
          tenantId: tenant.id,
          grantId: grant.id,
        });
      }
      throw fail("not_found", "that support request was not found");
    },
  });

  function decide(context, grantId, outcome, action) {
    const resolved = gate.requireTenant(context);
    gate.authorizeTenantWide(resolved, APPROVE);
    const registry = store.platformSession({ actorId: resolved.user.id });
    return tenantSession(resolved.tenant.id, resolved.user.id).transaction((tx) => {
      const grant = grantRow(tx, grantId);
      if (grant.status !== "pending") {
        throw fail("invalid_transition", `that request is ${statusOf(grant)}, not pending`);
      }
      if (grant.requestedBy === resolved.user.id) {
        throw fail("forbidden", "you cannot decide your own request");
      }
      const now = clock();
      const patch =
        outcome === "approved"
          ? {
              status: "approved",
              decidedBy: resolved.user.id,
              decidedAt: now,
              expiresAt: new Date(Date.parse(now) + grant.durationMinutes * 60000).toISOString(),
            }
          : { status: "denied", decidedBy: resolved.user.id, decidedAt: now };
      const updated = tx.update("supportGrants", grant.id, patch);
      record(tx, grant, action, { status: { before: "pending", after: outcome } });
      return view(updated, registry, resolved.tenant.name);
    });
  }

  function end(session, grant, registry, tenantName) {
    return session.transaction((tx) => {
      if (!isOpen(grant)) return view(grant, registry, tenantName);
      const updated = tx.update("supportGrants", grant.id, {
        status: "revoked",
        revokedAt: clock(),
      });
      record(tx, grant, "support_access_revoked", {
        status: { before: grant.status, after: "revoked" },
      });
      return view(updated, registry, tenantName);
    });
  }
}
