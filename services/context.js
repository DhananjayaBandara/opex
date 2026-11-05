// Request contexts and the gate every service call passes through (SRS 4.2, FR-TEN-004).
//
// A context is issued only by sign-in or by entering an organization. It is frozen and remembered in
// a per-application WeakSet, so a copy, a clone, a hand-built object or a context from another
// application instance is refused as `invalid_context`. A context is never trusted on its own: every
// call re-reads the session, the user, the tenant status and the membership, so signing out,
// suspending a tenant or revoking a membership takes effect on the next call (architecture 5.1).
// The tenant a call acts on comes from the context, never from a payload.
// Browser-safe: no Node imports.
import { canAccess, resolveAccess } from "../domain/authorization.js";
import { entitledOn } from "../domain/configuration.js";
import { PERMISSIONS, permissionFeatures, readOnly, roleTemplate } from "../domain/permissions.js";
import { businessDate } from "../domain/time.js";
import { fail } from "./errors.js";

export const SYSTEM_ACTOR = "system";

// What a support grant allows: every tenant permission that only views (decision D19).
const SUPPORT_ROLE = "support";
const SUPPORT_PERMISSIONS = readOnly(
  PERMISSIONS.filter((permission) => permission.audience === "tenant").map(({ id }) => id)
);

export function createGate({ store, clock }) {
  const issued = new WeakSet();
  const features = permissionFeatures();
  const platformReader = () => store.platformSession({ actorId: SYSTEM_ACTOR });

  function issue(fields) {
    const context = Object.freeze({ ...fields });
    issued.add(context);
    return context;
  }

  // The session behind a context: valid only while it has not ended, the user is active and the
  // credentials have not been reset since the session began (password reset ends sessions, D18).
  function resolveSession(context) {
    if (typeof context !== "object" || context === null || !issued.has(context)) {
      throw fail("invalid_context", "this context was not issued by sign-in");
    }
    const reader = platformReader();
    // A run-as context (scheduled reports, D69) has no sign-in behind it: it stands for its user only
    // while that user is active, and the membership is re-read on every call like any other.
    if (context.runAs === true) {
      const owner = reader.get("users", context.userId);
      if (owner === null || owner.status !== "active") {
        throw fail("session_ended", "this user can no longer act");
      }
      return { session: null, user: owner };
    }
    const session = reader.get("sessions", context.sessionId);
    const user = reader.get("users", context.userId);
    const live =
      session !== null &&
      user !== null &&
      session.status === "active" &&
      session.userId === user.id &&
      user.status === "active" &&
      session.credentialVersion === user.credentialVersion;
    if (!live) throw fail("session_ended", "this session has ended; sign in again");
    return { session, user };
  }

  function requireUser(context) {
    const resolved = resolveSession(context);
    if (context.kind !== "user") {
      throw fail("forbidden", "this call needs the signed-in user context");
    }
    return resolved;
  }

  // Union of the permissions of the user's platform roles (architecture 5.4).
  function platformPermissions(user) {
    const granted = new Set();
    for (const key of user.platformRoles ?? []) {
      const template = roleTemplate(key);
      if (template.audience === "platform") for (const id of template.permissions) granted.add(id);
    }
    return [...granted].sort();
  }

  // The assignment rows `resolveAccess` reads: each active employee's assignments, keyed by the user
  // linked to the employee.
  function assignmentsOf(reader, tenantId, userId) {
    const employee = reader.list(
      "employees",
      (row) => row.userId === userId && row.status === "active"
    )[0];
    if (employee === undefined) return [];
    return reader
      .list("supervisorAssignments", (row) => row.employeeId === employee.id)
      .map(({ sectionShiftId, effectiveFrom, effectiveTo }) => ({
        tenantId,
        userId,
        sectionShiftId,
        effectiveFrom,
        effectiveTo,
      }));
  }

  // `support` swaps the user's own membership for the read-only one an approved grant allows.
  function tenantAccess(tenant, userId, support = false) {
    const reader = store.session({ tenantId: tenant.id, actorId: SYSTEM_ACTOR });
    const today = businessDate(clock(), tenant.timeZone);
    const memberships = support
      ? [
          {
            tenantId: tenant.id,
            userId,
            status: "active",
            roleIds: [SUPPORT_ROLE],
            factoryScope: { all: true },
            assignmentScoped: false,
          },
        ]
      : reader.list("memberships");
    const own = memberships.find(
      (candidate) => candidate.userId === userId && candidate.status === "active"
    );
    // An assignment-scoped member sees the section-shifts of the supervisor assignments in effect for
    // the employee linked to their user. An employee who is not active supervises nothing (D29), and
    // a support grant is never assignment-scoped.
    const assignments =
      own?.assignmentScoped === true && !support ? assignmentsOf(reader, tenant.id, userId) : [];
    const access = resolveAccess({
      tenantId: tenant.id,
      userId,
      asOf: today,
      permissionFeatures: features,
      entitlements: entitledOn(reader.list("featureVersions"), today),
      roles: support
        ? [{ id: SUPPORT_ROLE, tenantId: tenant.id, permissions: SUPPORT_PERMISSIONS }]
        : reader.list("roles"),
      memberships,
      assignments,
    });
    return { access, membership: own, today };
  }

  // A support context is valid only while its grant is approved, unexpired and unrevoked and the
  // engineer still holds the platform permission. Each call through it is written to the tenant's
  // audit log (D19).
  function resolveSupport(context, session, user, tenant) {
    const grant = store
      .session({ tenantId: tenant.id, actorId: user.id })
      .get("supportGrants", context.grantId);
    if (
      grant === null ||
      grant.requestedBy !== user.id ||
      grant.status !== "approved" ||
      !platformPermissions(user).includes("support_access.request")
    ) {
      throw fail("access_revoked", "support access was withdrawn");
    }
    if (clock() >= grant.expiresAt) throw fail("support_expired", "the support grant has expired");
    const { access, today } = tenantAccess(tenant, user.id, true);
    store.session({ tenantId: tenant.id, actorId: user.id }).record({
      action: "support_access_used",
      entityType: "supportGrants",
      entityId: grant.id,
      changes: {},
    });
    return Object.freeze({
      kind: "tenant",
      session,
      user,
      tenant,
      membership: null,
      access,
      today,
      permissions: access.permissions,
      support: Object.freeze({ grantId: grant.id, expiresAt: grant.expiresAt }),
    });
  }

  // Full resolution of any issued context, including the current standing of what it points at.
  function resolve(context) {
    const { session, user } = resolveSession(context);
    if (context.kind === "platform") {
      const permissions = platformPermissions(user);
      if (permissions.length === 0) throw fail("access_revoked", "platform access was withdrawn");
      return Object.freeze({ kind: "platform", session, user, permissions });
    }
    if (context.kind === "tenant") {
      const tenant = platformReader().get("tenants", context.tenantId);
      if (tenant === null || tenant.status !== "active") {
        throw fail("tenant_inactive", "this organization is not active");
      }
      if (context.grantId !== undefined) return resolveSupport(context, session, user, tenant);
      const { access, membership, today } = tenantAccess(tenant, user.id);
      if (!access.active) throw fail("access_revoked", "access to this organization was withdrawn");
      return Object.freeze({
        kind: "tenant",
        session,
        user,
        tenant,
        membership,
        access,
        today,
        permissions: access.permissions,
      });
    }
    return Object.freeze({ kind: "user", session, user });
  }

  // A platform call: the context must be a platform one holding the permission.
  function requirePlatform(context, permission) {
    const resolved = resolve(context);
    if (resolved.kind !== "platform" || !resolved.permissions.includes(permission)) {
      throw fail("forbidden", `this call needs the ${permission} platform permission`);
    }
    return resolved;
  }

  // A tenant call: the context must be a tenant one. When a permission is named it must be held (the
  // WHAT); the WHERE is checked against the resource with `authorize`.
  function requireTenant(context, permission = null) {
    const resolved = resolve(context);
    if (
      resolved.kind !== "tenant" ||
      (permission !== null && !resolved.permissions.includes(permission))
    ) {
      throw fail("forbidden", "you do not have access to that");
    }
    return resolved;
  }

  // The WHAT and the WHERE for one resource, failing closed (D14). The same refusal either way, so a
  // caller learns nothing about why.
  function authorize(resolved, permission, resource) {
    if (!canAccess(resolved.access, permission, { tenantId: resolved.tenant.id, ...resource })) {
      throw fail("forbidden", "you do not have access to that");
    }
  }

  // Reads need no permission, only that the factory is one the caller's membership covers (D21).
  function inFactoryScope({ access }, factoryId) {
    return access.factoryScope.all || access.factoryScope.factoryIds.includes(factoryId);
  }

  // Data that belongs to the whole organization (not one factory) is managed only by someone whose
  // scope is every factory and who is not limited to their own assignments.
  function authorizeTenantWide(resolved, permission) {
    const { access } = resolved;
    if (
      !access.permissions.includes(permission) ||
      !access.factoryScope.all ||
      access.assignmentScoped
    ) {
      throw fail("forbidden", "you do not have access to that");
    }
  }

  // ---- Other members' access (notifications, D61 and D63) ------------------------------------------

  // The access another member holds in a tenant right now, or null when they are not an active member
  // of an active organization. It reads and issues nothing; it only lets a service decide who a
  // notification is for and what a recipient may open.
  function accessOf(tenantId, userId) {
    const tenant = platformReader().get("tenants", tenantId);
    if (tenant === null || tenant.status !== "active") return null;
    const { access } = tenantAccess(tenant, userId);
    return access.active ? access : null;
  }

  // The active members of a tenant who hold a permission, each with their access.
  function holders(tenantId, permission) {
    const tenant = platformReader().get("tenants", tenantId);
    if (tenant === null || tenant.status !== "active") return [];
    const members = store
      .session({ tenantId, actorId: SYSTEM_ACTOR })
      .list("memberships", (row) => row.status === "active");
    return members
      .map((member) => ({
        userId: member.userId,
        access: tenantAccess(tenant, member.userId).access,
      }))
      .filter(({ access }) => access.active && access.permissions.includes(permission));
  }

  // The WHAT and the WHERE for a resource on an access obtained from `accessOf` or `holders`.
  const permits = (access, permission, resource) =>
    canAccess(access, permission, { tenantId: access.tenantId, ...resource });

  // A context that stands for an active member without a sign-in. Only the reports service is given
  // this (services/index.js): a scheduled report runs with its owner's current authority (D69).
  const runAs = (tenantId, userId) => issue({ kind: "tenant", tenantId, userId, runAs: true });

  return Object.freeze({
    issue,
    resolveSession,
    requireUser,
    resolve,
    requirePlatform,
    requireTenant,
    authorize,
    authorizeTenantWide,
    inFactoryScope,
    platformPermissions,
    accessOf,
    holders,
    permits,
    runAs,
  });
}
