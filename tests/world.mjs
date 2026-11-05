// Shared fixture for the service-level contract tests (not a test file). It builds the real
// services over the real store with in-memory storage, a controllable clock and deterministic ids,
// so a test can arrange a platform and two or more tenants through the public service API.
import assert from "node:assert/strict";
import { memoryStorage, optional, need } from "./harness.mjs";

const mod = await optional("../services/index.js");
const SRC = "services/index.js";

export const START = "2026-11-02T09:00:00.000Z";

export function createWorld(options = {}) {
  let now = options.now ?? START;
  let ids = 0;
  let tokens = 0;
  const storage = options.storage ?? memoryStorage();
  const app = need(
    mod,
    "createServices",
    SRC
  )({
    storage,
    clock: () => now,
    newId: () => `id-${++ids}`,
    newToken: () => `token-${++tokens}`,
    baseDomain: "opex.example",
  });
  const world = {
    app,
    storage,
    store: app.internals.store,
    now: () => now,
    setNow(instant) {
      now = instant;
    },
    advance(milliseconds) {
      now = new Date(Date.parse(now) + milliseconds).toISOString();
    },
    // Sign in with the simulated MFA code when the identity needs one (D18).
    signIn(email, { mfa = true } = {}) {
      const base = { email };
      try {
        return app.identity.authenticate(base);
      } catch (error) {
        if (error.code !== "mfa_required" || !mfa) throw error;
        return app.identity.authenticate({ ...base, mfaCode: app.prototypeTools.mfaCode(email) });
      }
    },
    signInPlatform(email) {
      return app.identity.enterPlatform(world.signIn(email));
    },
    signInTenant(email, slug) {
      return app.identity.enterTenant(world.signIn(email), { slug });
    },
    // First platform administrator and a signed-in platform context.
    bootstrap(email = "root@opex.example") {
      app.tenancy.bootstrapPlatform({ email, name: "Platform Root" });
      return world.signInPlatform(email);
    },
    provision(platform, overrides = {}) {
      const spec = {
        name: "Felix Fashions",
        slug: "felix",
        timeZone: "Asia/Colombo",
        admin: { email: "admin@felix.example", name: "Felix Admin" },
        ...overrides,
      };
      return app.tenancy.provision(platform, spec);
    },
    activate(platform, tenantId) {
      return app.tenancy.transition(platform, tenantId, { to: "active" });
    },
    // A tenant provisioned and activated in one step.
    openTenant(platform, overrides) {
      const result = world.provision(platform, overrides);
      world.activate(platform, result.tenant.id);
      return result;
    },
    // A member with a custom role, arranged through the store (the administration service is
    // AC-1.6). `factoryIds` limits the WHERE; `all` gives every factory.
    addMember(
      tenantId,
      { email, permissions, factoryIds = [], all = false, assignmentScoped = false }
    ) {
      const user = world.store.platformSession({ actorId: "arrange" }).insert("users", {
        email,
        name: "Member",
        status: "active",
        platformRoles: [],
        mfaSecret: "member-secret",
        credentialVersion: 1,
      });
      const tenant = world.store.session({ tenantId, actorId: "arrange" });
      const role = tenant.insert("roles", {
        name: `Role of ${email}`,
        templateKey: null,
        permissions: [...permissions],
        system: false,
      });
      tenant.insert("memberships", {
        userId: user.id,
        status: "active",
        roleIds: [role.id],
        factoryScope: all ? { all: true } : { factoryIds: [...factoryIds] },
        assignmentScoped,
      });
      return { userId: user.id };
    },
    // Test-only reads of the underlying partitions.
    tenantRows(tenantId, collection) {
      return world.store.session({ tenantId, actorId: "test-reader" }).list(collection);
    },
    tenantAudit(tenantId, filter) {
      return world.store.session({ tenantId, actorId: "test-reader" }).auditLog(filter);
    },
    platformRows(collection) {
      return world.store.platformSession({ actorId: "test-reader" }).list(collection);
    },
    platformAudit(filter) {
      return world.store.platformSession({ actorId: "test-reader" }).auditLog(filter);
    },
  };
  return world;
}

export const code = (expected) => (error) => error?.code === expected;

export function expectCode(work, expected, label = "") {
  assert.throws(work, code(expected), `${label} expected error code ${expected}`);
}
