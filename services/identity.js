// Sign-in, organization selection and password reset (SRS 4.2, 15.1; decisions D15, D18).
// Authentication is simulated (level S): no password is stored or checked. What is real is the flow
// around it: multi-factor for platform users and tenant administrators, a uniform failure for an
// unknown or disabled user, tenant resolution from the selector or host only, and sessions that end
// on sign-out and on password reset.
// Browser-safe: no Node imports.
import { verifyMfaCode } from "../domain/mfa.js";
import { normalizeEmail } from "../domain/tenancy.js";
import { fail } from "./errors.js";
import { SYSTEM_ACTOR } from "./context.js";

const RESET_MINUTES = 30;
const ADMINISTRATION = ["user.manage", "role.manage"];
const INVALID_CREDENTIALS = "the email or sign-in code is not valid";
const UNAVAILABLE = "that organization is not available to you";

export function createIdentity({ store, gate, clock, newToken, baseDomain }) {
  const platformReader = () => store.platformSession({ actorId: SYSTEM_ACTOR });
  const userByEmail = (address) =>
    platformReader().list("users", (user) => user.email === address)[0];

  // Platform users, and anyone who can manage users or roles in some organization.
  function requiresMfa(user) {
    if ((user.platformRoles ?? []).length > 0) return true;
    for (const tenant of platformReader().list("tenants")) {
      const reader = store.session({ tenantId: tenant.id, actorId: SYSTEM_ACTOR });
      const membership = reader.list(
        "memberships",
        (row) => row.userId === user.id && row.status === "active"
      )[0];
      if (!membership) continue;
      const administers = reader
        .list("roles", (role) => membership.roleIds.includes(role.id))
        .some((role) => role.permissions.some((id) => ADMINISTRATION.includes(id)));
      if (administers) return true;
    }
    return false;
  }

  function activeMembership(tenant, userId) {
    return store
      .session({ tenantId: tenant.id, actorId: userId })
      .list("memberships", (row) => row.userId === userId && row.status === "active")[0];
  }

  // The tenant is named by the organization selector (slug) or by the host label. A tenant id in the
  // payload is not a selector and is ignored (FR-TEN-004).
  function slugOf(selector) {
    if (typeof selector?.host === "string") {
      const host = selector.host.toLowerCase();
      const suffix = `.${baseDomain}`;
      if (!host.endsWith(suffix)) return null;
      const label = host.slice(0, -suffix.length);
      return label.length > 0 && !label.includes(".") ? label : null;
    }
    return typeof selector?.slug === "string" ? selector.slug.toLowerCase() : null;
  }

  return Object.freeze({
    authenticate({ email, mfaCode } = {}) {
      let address = null;
      try {
        address = normalizeEmail(email);
      } catch {
        // falls through to the same refusal as an unknown user
      }
      const user = address === null ? undefined : userByEmail(address);
      if (!user || user.status !== "active") throw fail("invalid_credentials", INVALID_CREDENTIALS);
      if (requiresMfa(user)) {
        if (mfaCode === undefined || mfaCode === null || mfaCode === "") {
          throw fail("mfa_required", "a multi-factor code is required for this account");
        }
        if (!verifyMfaCode(user.mfaSecret, mfaCode, clock())) {
          store.platformSession({ actorId: user.id }).record({
            action: "sign_in_failed",
            entityType: "users",
            entityId: user.id,
            changes: { reason: { before: null, after: "invalid_mfa" } },
          });
          throw fail("invalid_mfa", "the multi-factor code is not valid");
        }
      }
      const session = store.platformSession({ actorId: user.id }).transaction((tx) => {
        const row = tx.insert("sessions", {
          userId: user.id,
          credentialVersion: user.credentialVersion,
          status: "active",
          startedAt: clock(),
          endedAt: null,
        });
        tx.record({ action: "sign_in", entityType: "sessions", entityId: row.id, changes: {} });
        return row;
      });
      return gate.issue({ kind: "user", userId: user.id, sessionId: session.id });
    },

    signOut(context) {
      const { session, user } = gate.resolveSession(context);
      store.platformSession({ actorId: user.id }).transaction((tx) => {
        tx.update("sessions", session.id, { status: "ended", endedAt: clock() });
        tx.record({
          action: "sign_out",
          entityType: "sessions",
          entityId: session.id,
          changes: {},
        });
      });
      return Object.freeze({ status: "signed_out" });
    },

    // The organization selector: active memberships in active tenants only.
    organizations(context) {
      const { user } = gate.requireUser(context);
      return platformReader()
        .list("tenants", (tenant) => tenant.status === "active")
        .filter((tenant) => activeMembership(tenant, user.id) !== undefined)
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((tenant) =>
          Object.freeze({ tenantId: tenant.id, slug: tenant.slug, name: tenant.name })
        );
    },

    // A non-member gets the same refusal for a tenant that exists and one that does not.
    enterTenant(context, selector) {
      const { user } = gate.requireUser(context);
      const slug = slugOf(selector);
      const tenant =
        slug === null ? undefined : platformReader().list("tenants", (row) => row.slug === slug)[0];
      const membership = tenant === undefined ? undefined : activeMembership(tenant, user.id);
      if (tenant === undefined || membership === undefined)
        throw fail("tenant_unavailable", UNAVAILABLE);
      if (tenant.status !== "active") {
        throw fail("tenant_inactive", "this organization is not active");
      }
      store.session({ tenantId: tenant.id, actorId: user.id }).record({
        action: "tenant_entered",
        entityType: "memberships",
        entityId: membership.id,
        changes: {},
      });
      return gate.issue({
        kind: "tenant",
        userId: user.id,
        sessionId: context.sessionId,
        tenantId: tenant.id,
      });
    },

    enterPlatform(context) {
      const { user } = gate.requireUser(context);
      if (gate.platformPermissions(user).length === 0) {
        throw fail("forbidden", "this user has no platform role");
      }
      store.platformSession({ actorId: user.id }).record({
        action: "platform_entered",
        entityType: "users",
        entityId: user.id,
        changes: {},
      });
      return gate.issue({ kind: "platform", userId: user.id, sessionId: context.sessionId });
    },

    whoami(context) {
      const resolved = gate.resolve(context);
      const { user } = resolved;
      const base = { kind: resolved.kind, userId: user.id, email: user.email, name: user.name };
      if (resolved.kind === "platform") {
        return Object.freeze({
          ...base,
          roles: [...user.platformRoles],
          permissions: [...resolved.permissions],
        });
      }
      if (resolved.kind === "tenant") {
        const { tenant, access } = resolved;
        return Object.freeze({
          ...base,
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          tenantName: tenant.name,
          timeZone: tenant.timeZone,
          today: resolved.today,
          permissions: [...access.permissions],
          factoryScope: access.factoryScope,
          assignmentScoped: access.assignmentScoped,
          sectionShiftIds: [...access.sectionShiftIds],
          support: resolved.support ?? null,
        });
      }
      return Object.freeze({ ...base, platformAccess: gate.platformPermissions(user).length > 0 });
    },

    // The answer is the same whether or not the address is known (no account enumeration). Only a
    // known, active user gets a message in the simulated outbox.
    requestPasswordReset({ email } = {}) {
      let address = null;
      try {
        address = normalizeEmail(email);
      } catch {
        // an invalid address gets the same answer as an unknown one
      }
      const user = address === null ? undefined : userByEmail(address);
      if (user && user.status === "active") {
        const expiresAt = new Date(Date.parse(clock()) + RESET_MINUTES * 60 * 1000).toISOString();
        store.platformSession({ actorId: user.id }).transaction((tx) => {
          const row = tx.insert("outbox", {
            kind: "password_reset",
            to: user.email,
            userId: user.id,
            token: newToken(),
            createdAt: clock(),
            expiresAt,
            usedAt: null,
          });
          tx.record({
            action: "password_reset_requested",
            entityType: "users",
            entityId: user.id,
            changes: { outbox: { before: null, after: row.id } },
          });
        });
      }
      return Object.freeze({ status: "sent" });
    },

    // Single use. A reset invalidates every session of the user by bumping the credential version.
    completePasswordReset({ token } = {}) {
      const row =
        typeof token === "string"
          ? platformReader().list(
              "outbox",
              (entry) => entry.kind === "password_reset" && entry.token === token
            )[0]
          : undefined;
      if (!row || row.usedAt !== null) throw fail("invalid_token", "this reset link is not valid");
      if (Date.parse(row.expiresAt) <= Date.parse(clock())) {
        throw fail("token_expired", "this reset link has expired; request a new one");
      }
      store.platformSession({ actorId: row.userId }).transaction((tx) => {
        const user = tx.get("users", row.userId);
        tx.update("outbox", row.id, { usedAt: clock() });
        tx.update("users", user.id, { credentialVersion: user.credentialVersion + 1 });
        for (const session of tx.list(
          "sessions",
          (entry) => entry.userId === user.id && entry.status === "active"
        )) {
          tx.update("sessions", session.id, { status: "ended", endedAt: clock() });
        }
        tx.record({
          action: "password_reset",
          entityType: "users",
          entityId: user.id,
          changes: {},
        });
      });
      return Object.freeze({ status: "reset" });
    },
  });
}
