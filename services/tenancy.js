// Tenant registry and provisioning (FR-TEN-001, UC-TEN-01; decisions D15, D20; architecture 4.8).
// Only a platform context holding the right platform permission can reach these calls. Provisioning
// writes the registry entry, the seeded roles, settings, entitlements and the first administrator
// in one unit of work: either all of it exists afterwards or none of it does.
// Browser-safe: no Node imports.
import { roleTemplate, ROLE_TEMPLATES } from "../domain/permissions.js";
import {
  assertTransition,
  normalizeEmail,
  transitionAction,
  validateName,
  validateProvision,
} from "../domain/tenancy.js";
import { businessDate } from "../domain/time.js";
import { fail } from "./errors.js";

const BOOTSTRAP_ACTOR = "bootstrap";

const view = (tenant) =>
  Object.freeze({
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    timeZone: tenant.timeZone,
    statusReason: tenant.statusReason ?? null,
  });

function platformRoleKeys(roleKeys) {
  if (!Array.isArray(roleKeys) || roleKeys.length === 0) {
    throw fail("unknown_template", "at least one platform role is required");
  }
  for (const key of roleKeys) {
    if (roleTemplate(key).audience !== "platform") {
      throw fail("wrong_audience", `${key} is not a platform role`);
    }
  }
  return [...new Set(roleKeys)].sort();
}

export function createTenancy({ store, gate, clock, newToken }) {
  // One global identity per email (FR-TEN-003): an existing user gains the roles, a new one is made.
  function upsertPlatformUser(tx, { email, name, roleKeys }) {
    const existing = tx.list("users", (user) => user.email === email)[0];
    if (existing) {
      tx.update("users", existing.id, {
        platformRoles: [...new Set([...(existing.platformRoles ?? []), ...roleKeys])].sort(),
      });
      return existing.id;
    }
    return tx.insert("users", {
      email,
      name,
      status: "active",
      platformRoles: [...roleKeys],
      mfaSecret: newToken(),
      credentialVersion: 1,
    }).id;
  }

  return Object.freeze({
    // The very first platform administrator; afterwards platform staff are added by a platform user.
    bootstrapPlatform({ email, name } = {}) {
      const reader = store.platformSession({ actorId: BOOTSTRAP_ACTOR });
      if (reader.list("users", (user) => (user.platformRoles ?? []).length > 0).length > 0) {
        throw fail("already_bootstrapped", "the platform already has an administrator");
      }
      const address = normalizeEmail(email);
      const label = validateName(name);
      const userId = reader.transaction((tx) => {
        const id = upsertPlatformUser(tx, {
          email: address,
          name: label,
          roleKeys: ["platform_admin"],
        });
        tx.record({
          action: "bootstrap_platform",
          entityType: "users",
          entityId: id,
          changes: { platformRoles: { before: null, after: ["platform_admin"] } },
        });
        return id;
      });
      return Object.freeze({ userId });
    },

    addPlatformUser(context, { email, name, roleKeys } = {}) {
      const actor = gate.requirePlatform(context, "platform_settings.manage");
      const address = normalizeEmail(email);
      const label = validateName(name);
      const keys = platformRoleKeys(roleKeys);
      const userId = store.platformSession({ actorId: actor.user.id }).transaction((tx) => {
        const id = upsertPlatformUser(tx, { email: address, name: label, roleKeys: keys });
        tx.record({
          action: "platform_user_added",
          entityType: "users",
          entityId: id,
          changes: { platformRoles: { before: null, after: keys } },
        });
        return id;
      });
      return Object.freeze({ userId });
    },

    provision(context, spec) {
      const actor = gate.requirePlatform(context, "tenant_registry.manage");
      const input = validateProvision(spec);
      const today = businessDate(clock(), input.timeZone);
      return store.unitOfWork({ actorId: actor.user.id }, ({ platform, tenant }) => {
        const row = platform.insert("tenants", {
          slug: input.slug,
          name: input.name,
          timeZone: input.timeZone,
          status: "provisioned",
          statusReason: null,
        });
        platform.record({
          action: "provision",
          entityType: "tenants",
          entityId: row.id,
          changes: { status: { before: null, after: "provisioned" } },
        });

        const existing = platform.list("users", (user) => user.email === input.admin.email)[0];
        const adminId =
          existing?.id ??
          platform.insert("users", {
            email: input.admin.email,
            name: input.admin.name,
            status: "active",
            platformRoles: [],
            mfaSecret: newToken(),
            credentialVersion: 1,
          }).id;

        const inTenant = tenant(row.id);
        const roles = ROLE_TEMPLATES.filter((template) => template.audience === "tenant").map(
          (template) =>
            inTenant.insert("roles", {
              name: template.label,
              nameKey: template.label.toLowerCase(),
              templateKey: template.key,
              permissions: [...template.permissions],
              system: true,
            })
        );
        inTenant.insert("settings", {
          kind: "profile",
          name: input.name,
          timeZone: input.timeZone,
        });
        inTenant.insert("settings", { kind: "policies", overlapPolicy: "warn" });
        inTenant.insert("memberships", {
          userId: adminId,
          status: "active",
          roleIds: [roles.find((role) => role.templateKey === "tenant_admin").id],
          factoryScope: { all: true },
          assignmentScoped: false,
        });
        for (const feature of input.features) {
          inTenant.insert("featureVersions", {
            feature,
            enabled: true,
            effectiveFrom: today,
            effectiveTo: null,
          });
        }
        return Object.freeze({
          tenant: view(row),
          admin: Object.freeze({
            userId: adminId,
            email: input.admin.email,
            existing: existing !== undefined,
          }),
        });
      });
    },

    transition(context, tenantId, { to, reason } = {}) {
      const actor = gate.requirePlatform(context, "tenant_registry.manage");
      return store.platformSession({ actorId: actor.user.id }).transaction((tx) => {
        const tenant = tx.get("tenants", tenantId);
        if (tenant === null) throw fail("not_found", "that tenant was not found");
        const change = assertTransition({ from: tenant.status, to, reason });
        const row = tx.update("tenants", tenant.id, {
          status: change.to,
          statusReason: change.reason,
        });
        tx.record({
          action: transitionAction(tenant.status, change.to),
          entityType: "tenants",
          entityId: tenant.id,
          changes: {
            status: { before: tenant.status, after: change.to },
            reason: { before: tenant.statusReason ?? null, after: change.reason },
          },
        });
        return view(row);
      });
    },

    list(context) {
      const actor = gate.requirePlatform(context, "tenant_registry.manage");
      return store
        .platformSession({ actorId: actor.user.id })
        .list("tenants")
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map(view);
    },

    // The active organizations, as a minimal name list, for platform staff who need to pick one: the
    // registry manager, and support staff who have no registry access but must name a tenant to ask
    // for support access.
    directory(context) {
      const resolved = gate.resolve(context);
      const allowed =
        resolved.kind === "platform" &&
        (resolved.permissions.includes("tenant_registry.manage") ||
          resolved.permissions.includes("support_access.request"));
      if (!allowed)
        throw fail("forbidden", "this call needs a platform permission to find tenants");
      return store
        .platformSession({ actorId: resolved.user.id })
        .list("tenants", (tenant) => tenant.status === "active")
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((tenant) => Object.freeze({ id: tenant.id, slug: tenant.slug, name: tenant.name }));
    },

    get(context, tenantId) {
      const actor = gate.requirePlatform(context, "tenant_registry.manage");
      const tenant = store.platformSession({ actorId: actor.user.id }).get("tenants", tenantId);
      if (tenant === null) throw fail("not_found", "that tenant was not found");
      return view(tenant);
    },
  });
}
