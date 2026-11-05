// AC-1.3 Tenancy and identity (SRS 4.2, FR-TEN-001/003/004, UC-TEN-01; architecture 4.8, 5.1;
// decisions D15 tenant lifecycle, D18 simulated authentication, D20 timezone).
// Services run over the real store with two or more tenants; contexts are issued by sign-in and a
// service never reads a tenant id from its input.
import test from "node:test";
import assert from "node:assert/strict";
import { optional, need } from "./harness.mjs";
import { createWorld, expectCode } from "./world.mjs";
import { roleTemplate, ROLE_TEMPLATES } from "../domain/permissions.js";

const domain = await optional("../domain/tenancy.js");
const DSRC = "domain/tenancy.js";
const MINUTE = 60 * 1000;

const ADMIN_A = "admin@felix.example";
const ADMIN_B = "admin@orbit.example";

// Two tenants with different admins, both active.
function twoTenants() {
  const world = createWorld();
  const platform = world.bootstrap();
  const felix = world.openTenant(platform);
  const orbit = world.openTenant(platform, {
    name: "Orbit Apparel",
    slug: "orbit",
    timeZone: "America/New_York",
    admin: { email: ADMIN_B, name: "Orbit Admin" },
  });
  return { world, platform, felix, orbit };
}

// Arranged through the store: a non-administrator member (the administration service is AC-1.6).
function addViewer(world, tenantId, email) {
  const user = world.store.platformSession({ actorId: "arrange" }).insert("users", {
    email,
    name: "Viewer",
    status: "active",
    platformRoles: [],
    mfaSecret: "viewer-secret",
    credentialVersion: 1,
  });
  const tenant = world.store.session({ tenantId, actorId: "arrange" });
  const role = tenant.list("roles").find((candidate) => candidate.templateKey === "viewer");
  tenant.insert("memberships", {
    userId: user.id,
    status: "active",
    roleIds: [role.id],
    factoryScope: { all: true },
    assignmentScoped: false,
  });
  return user;
}

// ---- D15 lifecycle table (pure domain) ----------------------------------------------------

test("AC-1.3 D15 the tenant lifecycle allows only the agreed transitions", () => {
  const can = need(domain, "canTransition", DSRC);
  const allowed = [
    ["provisioned", "active"],
    ["active", "suspended"],
    ["suspended", "active"],
    ["active", "deactivated"],
    ["suspended", "deactivated"],
    ["deactivated", "active"],
  ];
  for (const [from, to] of allowed) assert.equal(can(from, to), true, `${from} -> ${to}`);
  const statuses = ["provisioned", "active", "suspended", "deactivated"];
  const rejected = statuses.flatMap((from) =>
    statuses
      .filter((to) => !allowed.some(([a, b]) => a === from && b === to))
      .map((to) => [from, to])
  );
  assert.equal(rejected.length, 10);
  for (const [from, to] of rejected) assert.equal(can(from, to), false, `${from} -> ${to}`);
  assert.equal(can("active", "archived"), false);
  assert.equal(can("gone", "active"), false);
});

test("AC-1.3 D15 suspending or deactivating needs a reason", () => {
  const assertTransition = need(domain, "assertTransition", DSRC);
  assert.deepEqual(assertTransition({ from: "active", to: "suspended", reason: " unpaid " }), {
    to: "suspended",
    reason: "unpaid",
  });
  assert.deepEqual(assertTransition({ from: "suspended", to: "active" }), {
    to: "active",
    reason: null,
  });
  for (const reason of [undefined, "", "   ", 7])
    for (const to of ["suspended", "deactivated"])
      expectCode(
        () => assertTransition({ from: "active", to, reason }),
        "reason_required",
        `${to} ${String(reason)}`
      );
  expectCode(
    () => assertTransition({ from: "provisioned", to: "suspended", reason: "x" }),
    "invalid_transition"
  );
});

// ---- Platform bootstrap and sign-in --------------------------------------------------------

test("AC-1.3 the first platform administrator is created once and signs in with MFA", () => {
  const world = createWorld();
  const result = world.app.tenancy.bootstrapPlatform({ email: "root@opex.example", name: "Root" });
  assert.ok(result.userId);
  expectCode(
    () => world.app.tenancy.bootstrapPlatform({ email: "second@opex.example", name: "Two" }),
    "already_bootstrapped"
  );
  const platform = world.signInPlatform("root@opex.example");
  const me = world.app.identity.whoami(platform);
  assert.equal(me.kind, "platform");
  assert.equal(me.userId, result.userId);
  assert.deepEqual(me.permissions, [...roleTemplate("platform_admin").permissions]);
});

test("AC-1.3 D18 platform sign-in needs the MFA code and a wrong code is audited", () => {
  const world = createWorld();
  world.app.tenancy.bootstrapPlatform({ email: "root@opex.example", name: "Root" });
  const email = "root@opex.example";
  expectCode(() => world.app.identity.authenticate({ email }), "mfa_required");
  expectCode(() => world.app.identity.authenticate({ email, mfaCode: "000000" }), "invalid_mfa");
  const failed = world.platformAudit().filter((event) => event.action === "sign_in_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].tenantId, "platform");
  const session = world.app.identity.authenticate({
    email,
    mfaCode: world.app.prototypeTools.mfaCode(email),
  });
  assert.equal(session.kind, "user");
  const signedIn = world.platformAudit().filter((event) => event.action === "sign_in");
  assert.equal(signedIn.length, 1);
  assert.equal(signedIn[0].actorId, session.userId);
});

test("AC-1.3 an unknown email and a disabled user fail in the same way", () => {
  const world = createWorld();
  world.app.tenancy.bootstrapPlatform({ email: "root@opex.example", name: "Root" });
  const platform = world.store.platformSession({ actorId: "arrange" });
  const disabled = platform.insert("users", {
    email: "gone@opex.example",
    name: "Gone",
    status: "disabled",
    platformRoles: [],
    mfaSecret: "s",
    credentialVersion: 1,
  });
  assert.ok(disabled.id);
  const message = (email) => {
    try {
      world.app.identity.authenticate({ email });
    } catch (error) {
      return `${error.code}: ${error.message}`;
    }
    return "signed in";
  };
  assert.match(message("nobody@opex.example"), /^invalid_credentials:/);
  assert.equal(message("gone@opex.example"), message("nobody@opex.example"));
  assert.equal(message("GONE@opex.example"), message("nobody@opex.example"), "case is ignored");
});

// ---- Provisioning --------------------------------------------------------------------------

test("AC-1.3 provisioning creates the tenant, seeded roles, settings, administrator and audit", () => {
  const world = createWorld();
  const platform = world.bootstrap();
  const platformUserId = platform.userId;
  const { tenant, admin } = world.provision(platform);
  assert.equal(tenant.status, "provisioned");
  assert.equal(tenant.slug, "felix");
  assert.equal(tenant.timeZone, "Asia/Colombo");

  const roles = world.tenantRows(tenant.id, "roles");
  const tenantTemplates = ROLE_TEMPLATES.filter((entry) => entry.audience === "tenant");
  assert.deepEqual(
    roles.map((role) => role.name).sort(),
    tenantTemplates.map((entry) => entry.label).sort()
  );
  for (const template of tenantTemplates) {
    const role = roles.find((candidate) => candidate.templateKey === template.key);
    assert.deepEqual(role.permissions, [...template.permissions], template.key);
    assert.equal(role.tenantId, tenant.id);
  }

  const memberships = world.tenantRows(tenant.id, "memberships");
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].userId, admin.userId);
  assert.equal(memberships[0].status, "active");
  assert.deepEqual(memberships[0].factoryScope, { all: true });
  assert.deepEqual(memberships[0].roleIds, [
    roles.find((role) => role.templateKey === "tenant_admin").id,
  ]);

  const settings = world.tenantRows(tenant.id, "settings");
  assert.deepEqual(settings.map((row) => row.kind).sort(), ["policies", "profile"]);
  assert.equal(settings.find((row) => row.kind === "profile").timeZone, "Asia/Colombo");
  assert.equal(settings.find((row) => row.kind === "policies").overlapPolicy, "warn");

  const features = world.tenantRows(tenant.id, "featureVersions");
  assert.deepEqual(
    features
      .filter((row) => row.enabled)
      .map((row) => row.feature)
      .sort(),
    ["attendance", "performance", "production"]
  );
  assert.ok(
    features.every((row) => row.effectiveFrom === "2026-11-02" && row.effectiveTo === null)
  );

  const platformEvents = world.platformAudit({ entityType: "tenants" });
  assert.deepEqual(
    platformEvents.map((event) => event.action),
    ["create", "provision"]
  );
  assert.equal(platformEvents[0].actorId, platformUserId);
  const tenantCreates = world.tenantAudit(tenant.id).filter((event) => event.action === "create");
  const count = (type) => tenantCreates.filter((event) => event.entityType === type).length;
  assert.deepEqual(
    [count("roles"), count("settings"), count("memberships"), count("featureVersions")],
    [tenantTemplates.length, 2, 1, 3]
  );
  assert.ok(tenantCreates.every((event) => event.actorId === platformUserId));
});

test("AC-1.3 provisioning is all-or-nothing", () => {
  const world = createWorld();
  const platform = world.bootstrap();
  world.provision(platform);
  const before = world.storage.raw();
  const bad = (overrides) => () => world.provision(platform, overrides);
  expectCode(bad({}), "duplicate", "same slug");
  expectCode(bad({ slug: "Felix Fashions" }), "invalid_slug");
  expectCode(bad({ slug: "x" }), "invalid_slug");
  expectCode(bad({ slug: "-orbit" }), "invalid_slug");
  expectCode(bad({ slug: "o".repeat(40) }), "invalid_slug");
  for (const reserved of ["platform", "admin", "www", "api"])
    expectCode(bad({ slug: reserved }), "reserved_slug", reserved);
  expectCode(bad({ slug: "orbit", timeZone: "Mars/Olympus" }), "invalid_timezone");
  expectCode(bad({ slug: "orbit", timeZone: undefined }), "invalid_timezone");
  expectCode(bad({ slug: "orbit", name: "  " }), "invalid_name");
  expectCode(bad({ slug: "orbit", admin: { email: "nope", name: "A" } }), "invalid_email");
  expectCode(bad({ slug: "orbit", admin: undefined }), "invalid_email");
  expectCode(bad({ slug: "orbit", admin: { email: "a@b.example", name: "" } }), "invalid_name");
  assert.equal(world.storage.raw(), before, "nothing was written by any refused provisioning");
});

test("AC-1.3 only a platform principal with tenant_registry.manage can provision or list tenants", () => {
  const { world, platform, felix } = twoTenants();
  world.app.tenancy.addPlatformUser(platform, {
    email: "support@opex.example",
    name: "Support",
    roleKeys: ["support_engineer"],
  });
  const support = world.signInPlatform("support@opex.example");
  const tenantCtx = world.signInTenant(ADMIN_A, "felix");
  const userCtx = world.signIn(ADMIN_A);
  const spec = {
    name: "Nova",
    slug: "nova",
    timeZone: "UTC",
    admin: { email: "a@nova.example", name: "Nova Admin" },
  };
  for (const [label, ctx] of [
    ["support engineer", support],
    ["tenant administrator", tenantCtx],
    ["user session", userCtx],
  ]) {
    expectCode(() => world.app.tenancy.provision(ctx, spec), "forbidden", label);
    expectCode(() => world.app.tenancy.list(ctx), "forbidden", label);
    expectCode(
      () => world.app.tenancy.transition(ctx, felix.tenant.id, { to: "suspended", reason: "x" }),
      "forbidden",
      label
    );
  }
  assert.deepEqual(
    world.app.tenancy
      .list(platform)
      .map((entry) => entry.slug)
      .sort(),
    ["felix", "orbit"]
  );
  assert.equal(world.app.tenancy.get(platform, felix.tenant.id).slug, "felix");
  expectCode(() => world.app.tenancy.get(platform, "id-missing"), "not_found");
});

test("AC-1.3 one global user can administer two tenants (FR-TEN-003)", () => {
  const world = createWorld();
  const platform = world.bootstrap();
  world.openTenant(platform);
  world.openTenant(platform, {
    name: "Orbit Apparel",
    slug: "orbit",
    admin: { email: ADMIN_A, name: "Same Person" },
  });
  const users = world.platformRows("users").filter((user) => user.email === ADMIN_A);
  assert.equal(users.length, 1, "one identity");
  const selector = world.app.identity.organizations(world.signIn(ADMIN_A));
  assert.deepEqual(selector.map((entry) => entry.slug).sort(), ["felix", "orbit"]);
});

// ---- Lifecycle through the service ---------------------------------------------------------

test("AC-1.3 lifecycle transitions follow D15, need reasons and are audited", () => {
  const world = createWorld();
  const platform = world.bootstrap();
  const { tenant } = world.provision(platform);
  const move = (to, reason) => world.app.tenancy.transition(platform, tenant.id, { to, reason });
  const status = () => world.app.tenancy.get(platform, tenant.id).status;

  expectCode(() => move("suspended", "early"), "invalid_transition");
  assert.equal(status(), "provisioned");
  move("active");
  expectCode(() => move("suspended", "   "), "reason_required");
  expectCode(() => move("active"), "invalid_transition");
  assert.equal(status(), "active");
  move("suspended", "unpaid invoice");
  move("active");
  move("deactivated", "contract ended");
  expectCode(() => move("suspended", "late"), "invalid_transition");
  move("active");
  assert.equal(status(), "active");

  const lifecycle = world
    .platformAudit({ entityType: "tenants" })
    .filter((event) => event.action !== "create" && event.action !== "update");
  assert.deepEqual(
    lifecycle.map((event) => event.action),
    ["provision", "activate", "suspend", "resume", "deactivate", "restore"]
  );
  const suspend = lifecycle.find((event) => event.action === "suspend");
  assert.deepEqual(suspend.changes.status, { before: "active", after: "suspended" });
  assert.equal(suspend.changes.reason.after, "unpaid invoice");
  assert.equal(suspend.timestamp, world.now());
});

// ---- Tenant resolution ---------------------------------------------------------------------

test("AC-1.3 the organization selector lists only active memberships in active tenants", () => {
  const { world, platform, felix, orbit } = twoTenants();
  const extra = world.provision(platform, {
    name: "Nova",
    slug: "nova",
    admin: { email: ADMIN_A, name: "Same Person" },
  });
  const ctx = world.signIn(ADMIN_A);
  assert.deepEqual(
    world.app.identity.organizations(ctx).map((entry) => entry.slug),
    ["felix"],
    "nova is only provisioned"
  );
  world.activate(platform, extra.tenant.id);
  assert.deepEqual(
    world.app.identity
      .organizations(ctx)
      .map((entry) => entry.slug)
      .sort(),
    ["felix", "nova"]
  );
  world.app.tenancy.transition(platform, felix.tenant.id, { to: "suspended", reason: "audit" });
  assert.deepEqual(
    world.app.identity.organizations(ctx).map((entry) => entry.slug),
    ["nova"]
  );
  assert.ok(orbit.tenant.id);
  assert.deepEqual(world.app.identity.organizations(ctx)[0].name, "Nova");
});

test("AC-1.3 entering a tenant uses the selector or host and ignores any payload tenant id", () => {
  const { world, felix, orbit } = twoTenants();
  const user = world.signIn(ADMIN_A);
  const ctx = world.app.identity.enterTenant(user, { slug: "felix", tenantId: orbit.tenant.id });
  assert.equal(ctx.kind, "tenant");
  assert.equal(ctx.tenantId, felix.tenant.id);
  assert.equal(ctx.userId, user.userId);
  expectCode(
    () => world.app.identity.enterTenant(user, { tenantId: felix.tenant.id }),
    "tenant_unavailable",
    "a tenant id is never a selector"
  );
  const byHost = world.app.identity.enterTenant(user, { host: "felix.opex.example" });
  assert.equal(byHost.tenantId, felix.tenant.id);
  for (const host of ["felix.evil.example", "opex.example", "a.felix.opex.example", ""])
    expectCode(
      () => world.app.identity.enterTenant(user, { host }),
      "tenant_unavailable",
      `host ${host}`
    );
});

test("AC-1.3 a non-member cannot tell whether a tenant exists", () => {
  const { world } = twoTenants();
  const outsider = world.signIn(ADMIN_B);
  const outcome = (slug) => {
    try {
      world.app.identity.enterTenant(outsider, { slug });
    } catch (error) {
      return `${error.code}: ${error.message}`;
    }
    return "entered";
  };
  assert.match(outcome("felix"), /^tenant_unavailable:/, "exists, not a member");
  assert.equal(outcome("felix"), outcome("no-such-tenant"));
  assert.equal(outcome("felix"), outcome("PLATFORM"));
});

test("AC-1.3 D15 access is interactive only while the tenant is active", () => {
  const { world, platform, felix } = twoTenants();
  const member = world.signIn(ADMIN_A);
  const outsider = world.signIn(ADMIN_B);
  for (const [to, reason] of [
    ["suspended", "unpaid"],
    ["deactivated", "ended"],
  ]) {
    world.app.tenancy.transition(platform, felix.tenant.id, { to, reason });
    expectCode(
      () => world.app.identity.enterTenant(member, { slug: "felix" }),
      "tenant_inactive",
      `member of a ${to} tenant`
    );
    expectCode(
      () => world.app.identity.enterTenant(outsider, { slug: "felix" }),
      "tenant_unavailable",
      `non-member of a ${to} tenant`
    );
    if (to === "suspended")
      world.app.tenancy.transition(platform, felix.tenant.id, { to: "active" });
  }
  world.app.tenancy.transition(platform, felix.tenant.id, { to: "active" });
  assert.equal(world.app.identity.enterTenant(member, { slug: "felix" }).tenantId, felix.tenant.id);
});

test("AC-1.3 a revoked member cannot enter and is not listed", () => {
  const { world, felix } = twoTenants();
  const viewer = addViewer(world, felix.tenant.id, "viewer@felix.example");
  const session = world.signIn("viewer@felix.example", { mfa: false });
  assert.equal(world.app.identity.enterTenant(session, { slug: "felix" }).userId, viewer.id);
  const tenant = world.store.session({ tenantId: felix.tenant.id, actorId: "arrange" });
  const membership = tenant.list("memberships").find((row) => row.userId === viewer.id);
  tenant.update("memberships", membership.id, { status: "revoked" });
  expectCode(
    () => world.app.identity.enterTenant(session, { slug: "felix" }),
    "tenant_unavailable"
  );
  assert.deepEqual(world.app.identity.organizations(session), []);
});

test("AC-1.3 switching tenants gives separate contexts and neither reaches the other", () => {
  const world = createWorld();
  const platform = world.bootstrap();
  const felix = world.openTenant(platform);
  const orbit = world.openTenant(platform, {
    name: "Orbit Apparel",
    slug: "orbit",
    admin: { email: ADMIN_A, name: "Same Person" },
  });
  const user = world.signIn(ADMIN_A);
  const inFelix = world.app.identity.enterTenant(user, { slug: "felix" });
  const inOrbit = world.app.identity.enterTenant(user, { slug: "orbit" });
  const a = world.app.identity.whoami(inFelix);
  const b = world.app.identity.whoami(inOrbit);
  assert.equal(a.tenantId, felix.tenant.id);
  assert.equal(b.tenantId, orbit.tenant.id);
  assert.notEqual(a.tenantId, b.tenantId);
  assert.equal(a.tenantSlug, "felix");
  assert.equal(b.tenantSlug, "orbit");
  assert.equal(inFelix.sessionId, inOrbit.sessionId, "one sign-in, two organization contexts");
});

test("AC-1.3 a forged or copied context is rejected", () => {
  const { world, platform } = twoTenants();
  const real = world.signInTenant(ADMIN_A, "felix");
  const forgeries = [
    { ...real },
    structuredClone(real),
    Object.assign({}, real),
    JSON.parse(JSON.stringify(real)),
    { kind: "tenant", tenantId: real.tenantId, userId: real.userId, sessionId: real.sessionId },
    null,
    undefined,
    "tenant-context",
  ];
  for (const forged of forgeries)
    expectCode(() => world.app.identity.whoami(forged), "invalid_context", JSON.stringify(forged));
  const forgedPlatform = {
    kind: "platform",
    userId: platform.userId,
    sessionId: platform.sessionId,
  };
  expectCode(() => world.app.tenancy.list(forgedPlatform), "invalid_context");
  assert.equal(world.app.identity.whoami(real).tenantSlug, "felix", "the real context still works");
});

test("AC-1.3 a context from one application instance is not valid in another", () => {
  const first = twoTenants();
  const second = twoTenants();
  const ctx = first.world.signInTenant(ADMIN_A, "felix");
  expectCode(() => second.world.app.identity.whoami(ctx), "invalid_context");
});

test("AC-1.3 whoami reports effective access: role permissions, scope and module entitlements", () => {
  const { world, felix } = twoTenants();
  const me = world.app.identity.whoami(world.signInTenant(ADMIN_A, "felix"));
  assert.equal(me.userId, felix.admin.userId);
  assert.equal(me.email, ADMIN_A);
  assert.deepEqual(me.factoryScope, { all: true, factoryIds: [] });
  assert.equal(me.assignmentScoped, false);
  for (const id of ["user.manage", "role.manage", "production.enter", "support_access.approve"])
    assert.ok(me.permissions.includes(id), id);
  for (const id of ["order.manage", "po.manage", "invoice.issue"])
    assert.equal(me.permissions.includes(id), false, `${id}: its module is not entitled`);
  assert.equal(me.permissions.includes("tenant_registry.manage"), false, "no platform authority");
});

// ---- Existing contexts are re-checked on every call ----------------------------------------

test("AC-1.3 suspending the tenant stops an existing context on its next call", () => {
  const { world, platform, felix } = twoTenants();
  const ctx = world.signInTenant(ADMIN_A, "felix");
  assert.equal(world.app.identity.whoami(ctx).tenantSlug, "felix");
  world.app.tenancy.transition(platform, felix.tenant.id, { to: "suspended", reason: "unpaid" });
  expectCode(() => world.app.identity.whoami(ctx), "tenant_inactive");
  world.app.tenancy.transition(platform, felix.tenant.id, { to: "active" });
  assert.equal(world.app.identity.whoami(ctx).tenantSlug, "felix", "restored access");
});

test("AC-1.3 revoking the membership stops an existing context on its next call", () => {
  const { world, felix } = twoTenants();
  const viewer = addViewer(world, felix.tenant.id, "viewer@felix.example");
  const ctx = world.signInTenant("viewer@felix.example", "felix");
  assert.equal(world.app.identity.whoami(ctx).userId, viewer.id);
  const tenant = world.store.session({ tenantId: felix.tenant.id, actorId: "arrange" });
  const membership = tenant.list("memberships").find((row) => row.userId === viewer.id);
  tenant.update("memberships", membership.id, { status: "revoked" });
  expectCode(() => world.app.identity.whoami(ctx), "access_revoked");
});

test("AC-1.3 signing out ends the session and every context derived from it", () => {
  const { world } = twoTenants();
  const user = world.signIn(ADMIN_A);
  const tenantCtx = world.app.identity.enterTenant(user, { slug: "felix" });
  const other = world.signIn(ADMIN_A);
  world.app.identity.signOut(user);
  expectCode(() => world.app.identity.whoami(tenantCtx), "session_ended");
  expectCode(() => world.app.identity.organizations(user), "session_ended");
  expectCode(() => world.app.identity.enterTenant(user, { slug: "felix" }), "session_ended");
  assert.equal(world.app.identity.organizations(other).length, 1, "another sign-in is unaffected");
  const signOuts = world.platformAudit().filter((event) => event.action === "sign_out");
  assert.equal(signOuts.length, 1);
  assert.equal(signOuts[0].actorId, user.userId);
});

test("AC-1.3 entering a tenant is recorded in that tenant's audit log only", () => {
  const { world, felix, orbit } = twoTenants();
  const ctx = world.signInTenant(ADMIN_A, "felix");
  const entered = world
    .tenantAudit(felix.tenant.id)
    .filter((event) => event.action === "tenant_entered");
  assert.equal(entered.length, 1);
  assert.equal(entered[0].actorId, ctx.userId);
  assert.equal(entered[0].tenantId, felix.tenant.id);
  assert.deepEqual(
    world.tenantAudit(orbit.tenant.id).filter((event) => event.action === "tenant_entered"),
    []
  );
});

// ---- Authentication simulation (D18) -------------------------------------------------------

test("AC-1.3 D18 MFA is required for tenant administrators but not for other members", () => {
  const { world, felix } = twoTenants();
  expectCode(() => world.app.identity.authenticate({ email: ADMIN_A }), "mfa_required");
  addViewer(world, felix.tenant.id, "viewer@felix.example");
  const session = world.app.identity.authenticate({ email: "viewer@felix.example" });
  assert.equal(session.kind, "user");
});

test("AC-1.3 D18 a password reset is simulated: single-use, 30 minutes, and ends sessions", () => {
  const { world } = twoTenants();
  const existing = world.signInTenant(ADMIN_A, "felix");
  const requested = world.app.identity.requestPasswordReset({ email: ADMIN_A });
  assert.deepEqual(
    world.app.identity.requestPasswordReset({ email: "nobody@x.example" }),
    requested
  );
  assert.deepEqual(requested, { status: "sent" });

  const outbox = world.app.prototypeTools.outbox();
  assert.equal(outbox.length, 1, "nothing is sent to an unknown address");
  assert.equal(outbox[0].kind, "password_reset");
  assert.equal(outbox[0].to, ADMIN_A);
  assert.equal(outbox[0].expiresAt, new Date(Date.parse(world.now()) + 30 * MINUTE).toISOString());

  expectCode(() => world.app.identity.completePasswordReset({ token: "nope" }), "invalid_token");
  assert.deepEqual(world.app.identity.completePasswordReset({ token: outbox[0].token }), {
    status: "reset",
  });
  expectCode(() => world.app.identity.whoami(existing), "session_ended");
  expectCode(
    () => world.app.identity.completePasswordReset({ token: outbox[0].token }),
    "invalid_token",
    "single use"
  );
  assert.equal(world.signInTenant(ADMIN_A, "felix").kind, "tenant", "signing in again works");
  const resets = world.platformAudit().filter((event) => event.action === "password_reset");
  assert.equal(resets.length, 1);
  assert.equal(resets[0].actorId, existing.userId);

  world.app.identity.requestPasswordReset({ email: ADMIN_A });
  const second = world.app.prototypeTools.outbox().at(-1);
  world.advance(31 * MINUTE);
  expectCode(
    () => world.app.identity.completePasswordReset({ token: second.token }),
    "token_expired"
  );
});
