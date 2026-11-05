// Users, roles and memberships (SRS 5.2, 5.3; FR-TEN-003, FR-TEN-004; decisions D16, D25).
//
// Users and roles are organization-wide data, so every call needs the permission (WHAT) and a scope
// of every factory without assignment limits (WHERE); the tenant always comes from the context. The
// five seeded roles are fixed. Nobody can hand on a permission they do not hold, and a change that
// would leave the organization with no administrator is refused. Each write is one transaction with
// its audit event, so a refused call leaves neither a row nor an event.
// Browser-safe: no Node imports.
import { administrators, missingPermissions, validateScope } from "../domain/administration.js";
import { validatePermissions } from "../domain/permissions.js";
import { normalizeEmail, validateName } from "../domain/tenancy.js";
import { fail } from "./errors.js";

const ROLES = "role.manage";
const USERS = "user.manage";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const scopeView = (scope) =>
  scope.all === true
    ? Object.freeze({ all: true })
    : Object.freeze({ factoryIds: [...scope.factoryIds] });

export function createAdministration({ store, gate, newToken }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  // WHAT: one of the permissions; WHERE: organization-wide. The same refusal either way, and before
  // the request is looked at, so a refusal reveals nothing about it.
  function admin(context, ...permissions) {
    const resolved = gate.requireTenant(context);
    const needed = permissions.find((id) => resolved.permissions.includes(id)) ?? permissions[0];
    gate.authorizeTenantWide(resolved, needed);
    return resolved;
  }

  const roleViewOf = (role, memberships) =>
    Object.freeze({
      id: role.id,
      name: role.name,
      templateKey: role.templateKey ?? null,
      system: role.system === true,
      permissions: Object.freeze([...role.permissions]),
      members: memberships.filter(
        (membership) => membership.status === "active" && membership.roleIds.includes(role.id)
      ).length,
    });

  function memberViewOf(membership, user, roles) {
    return Object.freeze({
      userId: membership.userId,
      email: user.email,
      name: user.name,
      status: membership.status,
      statusReason: membership.statusReason ?? null,
      roles: Object.freeze(
        membership.roleIds.map((id) => {
          const role = roles.find((candidate) => candidate.id === id);
          return Object.freeze({ id, name: role?.name ?? id });
        })
      ),
      factoryScope: scopeView(membership.factoryScope),
      assignmentScoped: membership.assignmentScoped === true,
    });
  }

  const roleRow = (tx, roleId) => {
    const row = typeof roleId === "string" ? tx.get("roles", roleId) : null;
    if (row === null) throw fail("not_found", "that role was not found");
    return row;
  };

  const membershipOf = (tx, userId) => {
    const row =
      typeof userId === "string"
        ? tx.list("memberships", (candidate) => candidate.userId === userId)[0]
        : undefined;
    if (row === undefined) throw fail("not_found", "that member was not found");
    return row;
  };

  // Nobody can grant what they do not hold, counting the stored permissions of their roles.
  function requireHeld(resolved, roles, wanted) {
    const held = new Set();
    for (const roleId of resolved.membership.roleIds) {
      for (const id of roles.find((role) => role.id === roleId)?.permissions ?? []) held.add(id);
    }
    const missing = missingPermissions([...held], wanted);
    if (missing.length > 0) {
      throw fail("cannot_grant", `you cannot grant what you do not hold: ${missing.join(", ")}`);
    }
  }

  // D16: a change may not leave the organization without an administrator.
  function keepAnAdministrator(tx, change) {
    const standing = () =>
      administrators({ roles: tx.list("roles"), memberships: tx.list("memberships") });
    const hadOne = standing().length > 0;
    const result = change();
    if (hadOne && standing().length === 0) {
      throw fail("last_administrator", "the organization must keep at least one administrator");
    }
    return result;
  }

  function requireRoleIds(value) {
    if (!Array.isArray(value) || value.length === 0) {
      throw fail("invalid_roles", "choose at least one role");
    }
    if (value.some((id) => typeof id !== "string")) {
      throw fail("invalid_roles", "roles are chosen by id");
    }
    return [...new Set(value)];
  }

  function requireFlag(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean")
      throw fail("invalid_field", "assignmentScoped is true or false");
    return value;
  }

  // Every factory in a scope must exist in this organization and be active.
  function checkScope(tx, scope) {
    for (const id of scope.factoryIds ?? []) {
      const factory = tx.get("factories", id);
      if (factory === null) throw fail("not_found", "that factory was not found");
      if (factory.active === false) throw fail("inactive_parent", "that factory is inactive");
    }
  }

  const setStanding = (tx, userId, patch, action, changes) => {
    const membership = membershipOf(tx, userId);
    const updated = tx.update("memberships", membership.id, patch);
    tx.record({ action, entityType: "memberships", entityId: membership.id, changes });
    return updated;
  };

  return Object.freeze({
    // ---- Roles --------------------------------------------------------------------------------

    roles(context) {
      const resolved = admin(context, ROLES, USERS);
      const session = sessionFor(resolved);
      const memberships = session.list("memberships");
      return Object.freeze(session.list("roles").map((role) => roleViewOf(role, memberships)));
    },

    createRole(context, input) {
      const resolved = admin(context, ROLES);
      const request = isObject(input) ? input : {};
      const name = validateName(request.name, "role name");
      const permissions = validatePermissions(request.permissions, "tenant");
      return sessionFor(resolved).transaction((tx) => {
        requireHeld(resolved, tx.list("roles"), permissions);
        const row = tx.insert("roles", {
          name,
          nameKey: name.toLowerCase(),
          templateKey: null,
          permissions,
          system: false,
        });
        return roleViewOf(row, tx.list("memberships"));
      });
    },

    // A rename needs nothing more; adding a permission needs the editor to hold it. Taking
    // permissions away can leave the organization without an administrator, which is refused.
    updateRole(context, roleId, patch) {
      const resolved = admin(context, ROLES);
      const request = isObject(patch) ? patch : {};
      return sessionFor(resolved).transaction((tx) => {
        const role = roleRow(tx, roleId);
        if (role.system) throw fail("system_role", "the standard roles cannot be changed");
        const changes = {};
        if (request.name !== undefined) {
          const name = validateName(request.name, "role name");
          Object.assign(changes, { name, nameKey: name.toLowerCase() });
        }
        if (request.permissions !== undefined) {
          const permissions = validatePermissions(request.permissions, "tenant");
          requireHeld(
            resolved,
            tx.list("roles"),
            permissions.filter((id) => !role.permissions.includes(id))
          );
          changes.permissions = permissions;
        }
        const updated = keepAnAdministrator(tx, () => tx.update("roles", role.id, changes));
        return roleViewOf(updated, tx.list("memberships"));
      });
    },

    deleteRole(context, roleId) {
      const resolved = admin(context, ROLES);
      return sessionFor(resolved).transaction((tx) => {
        const role = roleRow(tx, roleId);
        if (role.system) throw fail("system_role", "the standard roles cannot be removed");
        const memberships = tx.list("memberships");
        if (memberships.some((membership) => membership.roleIds.includes(role.id))) {
          throw fail("role_in_use", "members or former members still hold that role");
        }
        tx.remove("roles", role.id);
        return roleViewOf(role, memberships);
      });
    },

    // ---- Members ------------------------------------------------------------------------------

    members(context) {
      const resolved = admin(context, USERS);
      const session = sessionFor(resolved);
      const roles = session.list("roles");
      const registry = store.platformSession({ actorId: resolved.user.id });
      return Object.freeze(
        session
          .list("memberships")
          .map((membership) =>
            memberViewOf(membership, registry.get("users", membership.userId), roles)
          )
      );
    },

    // One identity per email (FR-TEN-003): a person already known to the platform joins as themselves
    // and keeps their name, and the answer does not reveal whether they existed.
    addMember(context, input) {
      const resolved = admin(context, USERS);
      const request = isObject(input) ? input : {};
      const email = normalizeEmail(request.email);
      const roleIds = requireRoleIds(request.roleIds);
      const scope = validateScope(request.factoryScope);
      const assignmentScoped = requireFlag(request.assignmentScoped, false);
      return store.unitOfWork({ actorId: resolved.user.id }, ({ platform, tenant }) => {
        const inTenant = tenant(resolved.tenant.id);
        const roles = inTenant.list("roles");
        const chosen = roleIds.map((id) => roleRow(inTenant, id));
        requireHeld(
          resolved,
          roles,
          chosen.flatMap((role) => role.permissions)
        );
        checkScope(inTenant, scope);
        const existing = platform.list("users", (user) => user.email === email)[0];
        if (
          existing !== undefined &&
          inTenant.list("memberships", (row) => row.userId === existing.id).length > 0
        ) {
          throw fail("duplicate", "that person is already a member; restore them if revoked");
        }
        const user =
          existing ??
          platform.insert("users", {
            email,
            name: validateName(request.name),
            status: "active",
            platformRoles: [],
            mfaSecret: newToken(),
            credentialVersion: 1,
          });
        const membership = inTenant.insert("memberships", {
          userId: user.id,
          status: "active",
          roleIds,
          factoryScope: scope,
          assignmentScoped,
        });
        return memberViewOf(membership, user, roles);
      });
    },

    updateMember(context, userId, patch) {
      const resolved = admin(context, USERS);
      const request = isObject(patch) ? patch : {};
      return store.unitOfWork({ actorId: resolved.user.id }, ({ platform, tenant }) => {
        const inTenant = tenant(resolved.tenant.id);
        const membership = membershipOf(inTenant, userId);
        if (membership.status !== "active") {
          throw fail("member_revoked", "restore this member before changing them");
        }
        const roles = inTenant.list("roles");
        const changes = {};
        if (request.roleIds !== undefined) {
          const roleIds = requireRoleIds(request.roleIds);
          const chosen = roleIds.map((id) => roleRow(inTenant, id));
          requireHeld(
            resolved,
            roles,
            chosen
              .filter((role) => !membership.roleIds.includes(role.id))
              .flatMap((role) => role.permissions)
          );
          changes.roleIds = roleIds;
        }
        if (request.factoryScope !== undefined) {
          changes.factoryScope = validateScope(request.factoryScope);
          checkScope(inTenant, changes.factoryScope);
        }
        if (request.assignmentScoped !== undefined) {
          changes.assignmentScoped = requireFlag(request.assignmentScoped);
        }
        const updated = keepAnAdministrator(inTenant, () =>
          inTenant.update("memberships", membership.id, changes)
        );
        return memberViewOf(updated, platform.get("users", updated.userId), roles);
      });
    },

    // Access ends on the member's next request; the record, its history and its role stay.
    revokeMember(context, userId, input) {
      const resolved = admin(context, USERS);
      const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
      if (reason.length === 0) throw fail("reason_required", "a reason is required to revoke");
      return store.unitOfWork({ actorId: resolved.user.id }, ({ platform, tenant }) => {
        const inTenant = tenant(resolved.tenant.id);
        const membership = membershipOf(inTenant, userId);
        const roles = inTenant.list("roles");
        const view = (row) => memberViewOf(row, platform.get("users", row.userId), roles);
        if (membership.status === "revoked") return view(membership);
        const updated = keepAnAdministrator(inTenant, () =>
          setStanding(
            inTenant,
            userId,
            { status: "revoked", statusReason: reason },
            "membership_revoked",
            { reason: { before: null, after: reason } }
          )
        );
        return view(updated);
      });
    },

    // Restoring hands the old roles back, so the restorer must hold what they carry.
    restoreMember(context, userId) {
      const resolved = admin(context, USERS);
      return store.unitOfWork({ actorId: resolved.user.id }, ({ platform, tenant }) => {
        const inTenant = tenant(resolved.tenant.id);
        const membership = membershipOf(inTenant, userId);
        const roles = inTenant.list("roles");
        const view = (row) => memberViewOf(row, platform.get("users", row.userId), roles);
        if (membership.status === "active") return view(membership);
        requireHeld(
          resolved,
          roles,
          membership.roleIds.flatMap(
            (id) => roles.find((role) => role.id === id)?.permissions ?? []
          )
        );
        return view(
          setStanding(
            inTenant,
            userId,
            { status: "active", statusReason: null },
            "membership_restored",
            { status: { before: "revoked", after: "active" } }
          )
        );
      });
    },
  });
}
