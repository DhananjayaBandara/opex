// AC-1.5 Settings, features and targets (SRS 4.4, 10.4; FR-TEN-007, FR-SCR-002; UC-TEN-02;
// architecture 24.2; decisions D17, D23, D24). Company profile and branding, effective-dated module
// entitlements set by the platform, and effective-dated KPI targets that resolve System, then
// Tenant, then Factory. Authorization is WHAT (permission) plus WHERE (factory scope); the tenant
// always comes from the context, never from the payload.
import test from "node:test";
import assert from "node:assert/strict";
import { optional, need } from "./harness.mjs";
import { createWorld, expectCode } from "./world.mjs";
import { FEATURES, PERMISSIONS } from "../domain/permissions.js";
import { resolveTargets } from "../domain/calculations.js";

const config = await optional("../domain/configuration.js");
const CSRC = "domain/configuration.js";

const ADMIN_A = "admin@felix.example";
const ADMIN_B = "admin@orbit.example";
const DAY = 24 * 60 * 60 * 1000;
const FIRST_DAY = "2026-11-02";

// The calendar date `n` days after the first day of the scenario.
const day = (n) =>
  new Date(Date.parse(`${FIRST_DAY}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function setup() {
  const world = createWorld();
  const platform = world.bootstrap();
  const a = world.openTenant(platform);
  const b = world.openTenant(platform, {
    name: "Orbit Apparel",
    slug: "orbit",
    admin: { email: ADMIN_B, name: "Orbit Admin" },
  });
  const adminA = world.signInTenant(ADMIN_A, "felix");
  const adminB = world.signInTenant(ADMIN_B, "orbit");
  // A missing service fails as an assertion about the contract, not as a TypeError.
  const settings = () => {
    const service = world.app.settings;
    assert.equal(
      typeof service?.profile,
      "function",
      "services/index.js must expose settings.profile() - the contract is not implemented"
    );
    return service;
  };
  const org = world.app.organization;
  const permissionsOf = (ctx) => world.app.identity.whoami(ctx).permissions;
  return { world, platform, a, b, adminA, adminB, settings, org, permissionsOf };
}

const featurePermissions = (feature) =>
  PERMISSIONS.filter((permission) => permission.feature === feature).map(({ id }) => id);

// ---- Pure domain rules ---------------------------------------------------------------------

test("AC-1.5 target values use known keys and a percentage above 0 and at most 100", () => {
  const validateTargetValues = need(config, "validateTargetValues", CSRC);
  assert.deepEqual(validateTargetValues({ efficiency: 80, qco: 92.5 }), {
    efficiency: 80,
    qco: 92.5,
  });
  assert.deepEqual(validateTargetValues({ defectRate: 100, firstHour: 0.1 }), {
    defectRate: 100,
    firstHour: 0.1,
  });
  const bad = [
    {},
    null,
    undefined,
    [],
    "efficiency",
    { effciency: 80 },
    { efficiency: 0 },
    { efficiency: -1 },
    { efficiency: 100.5 },
    { efficiency: "80" },
    { efficiency: NaN },
    { efficiency: Infinity },
    { efficiency: null },
    { efficiency: undefined },
    { efficiency: 80, qco: 0 },
  ];
  for (const values of bad) {
    expectCode(() => validateTargetValues(values), "invalid_target", JSON.stringify(values));
  }
});

test("AC-1.5 the system defaults are version 1 of the chain and resolve on any business date", () => {
  const validateTargetValues = need(config, "validateTargetValues", CSRC);
  const system = config.SYSTEM_TARGETS;
  assert.ok(Array.isArray(system), `${CSRC} must export SYSTEM_TARGETS`);
  assert.equal(system.length, 1);
  assert.equal(system[0].version, 1);
  assert.equal(system[0].effectiveTo, null);
  assert.deepEqual(validateTargetValues(system[0].values), system[0].values);
  assert.deepEqual(system[0].values, { efficiency: 75, firstHour: 85, defectRate: 3, qco: 90 });
  for (const asOf of ["2020-01-01", FIRST_DAY, "2040-12-31"]) {
    const { values, sources } = resolveTargets({ system }, asOf);
    assert.deepEqual(values, system[0].values, asOf);
    for (const key of Object.keys(values)) {
      assert.deepEqual(sources[key], { level: "system", version: 1 }, `${asOf} ${key}`);
    }
  }
});

test("AC-1.5 a module is entitled on a date only while an enabled version covers it", () => {
  const entitledOn = need(config, "entitledOn", CSRC);
  const versions = [
    { feature: "production", enabled: true, effectiveFrom: "2026-01-01", effectiveTo: null },
    { feature: "orders", enabled: true, effectiveFrom: "2026-01-01", effectiveTo: "2026-03-31" },
    { feature: "finance", enabled: true, effectiveFrom: "2026-12-01", effectiveTo: null },
    { feature: "attendance", enabled: false, effectiveFrom: "2026-01-01", effectiveTo: null },
    // Two versions both active on the same date cannot be told apart: fail closed.
    { feature: "performance", enabled: true, effectiveFrom: "2026-01-01", effectiveTo: null },
    { feature: "performance", enabled: false, effectiveFrom: "2026-06-01", effectiveTo: null },
    { feature: "teleport", enabled: true, effectiveFrom: "2026-01-01", effectiveTo: null },
  ];
  assert.deepEqual(entitledOn(versions, "2026-02-01"), ["production", "performance", "orders"]);
  assert.deepEqual(entitledOn(versions, "2026-03-31"), ["production", "performance", "orders"]);
  assert.deepEqual(entitledOn(versions, "2026-04-01"), ["production", "performance"]);
  assert.deepEqual(entitledOn(versions, "2026-07-01"), ["production"]);
  assert.deepEqual(
    entitledOn(
      [...versions].reverse().filter((version) => version.feature !== "teleport"),
      "2026-07-01"
    ),
    ["production"],
    "a disabled version closes the module whatever the order of the versions"
  );
  assert.deepEqual(entitledOn(versions, "2026-12-01"), ["production", "finance"]);
  assert.deepEqual(entitledOn([], "2026-02-01"), []);
  // The answer follows the catalogue order of the modules.
  assert.deepEqual(
    entitledOn(
      [...versions].reverse().filter((version) => version.feature !== "teleport"),
      "2026-02-01"
    ),
    ["production", "performance", "orders"]
  );
  assert.ok(FEATURES.indexOf("performance") < FEATURES.indexOf("orders"));
});

test("AC-1.5 profile fields are normalized and refused with a specific error", () => {
  const validateProfilePatch = need(config, "validateProfilePatch", CSRC);
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.deepEqual(
    validateProfilePatch({
      name: "  Felix Fashions Lanka ",
      legalName: " Felix Fashions (Pvt) Ltd ",
      locale: "en-LK",
      currency: "lkr",
      primaryColor: "#1A2B3C",
      logo: png,
    }),
    {
      name: "Felix Fashions Lanka",
      legalName: "Felix Fashions (Pvt) Ltd",
      locale: "en-LK",
      currency: "LKR",
      primaryColor: "#1a2b3c",
      logo: png,
    }
  );
  assert.deepEqual(validateProfilePatch({ locale: "si" }), { locale: "si" });
  assert.deepEqual(
    validateProfilePatch({ legalName: null, currency: null, primaryColor: null, logo: null }),
    { legalName: null, currency: null, primaryColor: null, logo: null }
  );
  assert.deepEqual(validateProfilePatch({ legalName: "  " }), { legalName: null });
  assert.deepEqual(validateProfilePatch({ unrelated: 1 }), {}, "unknown fields are ignored");
  assert.deepEqual(validateProfilePatch({}), {});

  const cases = [
    ["invalid_name", { name: "" }],
    ["invalid_name", { name: "x".repeat(121) }],
    ["invalid_name", { name: null }],
    ["invalid_field", { legalName: "x".repeat(121) }],
    ["invalid_field", { legalName: 5 }],
    ["invalid_locale", { locale: "english" }],
    ["invalid_locale", { locale: "en_LK" }],
    ["invalid_locale", { locale: "EN" }],
    ["invalid_locale", { locale: null }],
    ["invalid_currency", { currency: "LK" }],
    ["invalid_currency", { currency: "LKRR" }],
    ["invalid_currency", { currency: "12A" }],
    ["invalid_color", { primaryColor: "red" }],
    ["invalid_color", { primaryColor: "#12345" }],
    ["invalid_color", { primaryColor: "#GGGGGG" }],
    ["invalid_color", { primaryColor: "1a2b3c" }],
    ["invalid_logo", { logo: "http://example.test/logo.png" }],
    ["invalid_logo", { logo: "data:image/gif;base64,AAAA" }],
    ["invalid_logo", { logo: "data:image/svg+xml;base64,AAAA" }],
    ["invalid_logo", { logo: "data:image/png;base64," }],
    ["invalid_logo", { logo: `data:image/png;base64,${"A".repeat(65_536)}` }],
  ];
  for (const [expected, patch] of cases) {
    expectCode(() => validateProfilePatch(patch), expected, JSON.stringify(patch).slice(0, 60));
  }
});

// ---- Company profile and branding ----------------------------------------------------------

test("AC-1.5 the company profile starts from provisioning and any member can read it", () => {
  const { world, a, adminA, adminB, settings } = setup();
  assert.deepEqual(settings().profile(adminA), {
    name: "Felix Fashions",
    timeZone: "Asia/Colombo",
    legalName: null,
    locale: "en",
    currency: null,
    primaryColor: null,
    logo: null,
  });
  assert.equal(settings().profile(adminB).name, "Orbit Apparel");
  const viewer = world.addMember(a.tenant.id, {
    email: "viewer@felix.example",
    permissions: ["dashboard.view"],
    all: true,
  });
  assert.ok(viewer.userId);
  const viewerCtx = world.signInTenant("viewer@felix.example", "felix");
  assert.equal(settings().profile(viewerCtx).name, "Felix Fashions");
  assert.ok(Object.isFrozen(settings().profile(adminA)));
});

test("AC-1.5 updating the profile validates, audits and mirrors the name to the registry", () => {
  const { world, platform, a, b, adminA, adminB, settings } = setup();
  const profileRow = () =>
    world.tenantRows(a.tenant.id, "settings").find((r) => r.kind === "profile");
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const before = world.tenantAudit(a.tenant.id, {
    entityType: "settings",
    entityId: profileRow().id,
  }).length;

  const updated = settings().updateProfile(adminA, {
    name: "Felix Fashions Lanka",
    legalName: "Felix Fashions (Pvt) Ltd",
    locale: "en-LK",
    currency: "lkr",
    primaryColor: "#1A2B3C",
    logo: png,
  });
  assert.deepEqual(updated, {
    name: "Felix Fashions Lanka",
    timeZone: "Asia/Colombo",
    legalName: "Felix Fashions (Pvt) Ltd",
    locale: "en-LK",
    currency: "LKR",
    primaryColor: "#1a2b3c",
    logo: png,
  });
  assert.deepEqual(settings().profile(adminA), updated);

  const events = world.tenantAudit(a.tenant.id, {
    entityType: "settings",
    entityId: profileRow().id,
  });
  assert.equal(events.length, before + 1, "one audit event for the one change");
  const event = events.at(-1);
  assert.equal(event.action, "update");
  assert.equal(event.actorId, a.admin.userId);
  assert.equal(event.changes.name.before, "Felix Fashions");
  assert.equal(event.changes.name.after, "Felix Fashions Lanka");
  assert.equal(event.changes.currency.after, "LKR");

  // The registry the platform sees carries the same name, changed in the same operation.
  const registry = world.platformRows("tenants").find((row) => row.id === a.tenant.id);
  assert.equal(registry.name, "Felix Fashions Lanka");
  assert.equal(registry.slug, "felix");
  const registryEvents = world.platformAudit({ entityType: "tenants", entityId: a.tenant.id });
  assert.equal(registryEvents.at(-1).actorId, a.admin.userId);
  assert.equal(registryEvents.at(-1).changes.name.after, "Felix Fashions Lanka");
  assert.equal(world.app.identity.whoami(adminA).tenantName, "Felix Fashions Lanka");
  assert.equal(world.app.tenancy.get(platform, a.tenant.id).name, "Felix Fashions Lanka");

  // The other tenant is untouched.
  assert.equal(settings().profile(adminB).name, "Orbit Apparel");
  assert.equal(
    world.platformRows("tenants").find((row) => row.id === b.tenant.id).name,
    "Orbit Apparel"
  );

  // Changing nothing writes nothing.
  const again = world.tenantAudit(a.tenant.id, {
    entityType: "settings",
    entityId: profileRow().id,
  });
  settings().updateProfile(adminA, { name: "Felix Fashions Lanka", locale: "en-LK" });
  settings().updateProfile(adminA, {});
  assert.equal(
    world.tenantAudit(a.tenant.id, { entityType: "settings", entityId: profileRow().id }).length,
    again.length
  );

  // Optional branding can be cleared again.
  const cleared = settings().updateProfile(adminA, { logo: null, primaryColor: null });
  assert.equal(cleared.logo, null);
  assert.equal(cleared.primaryColor, null);
});

test("AC-1.5 an invalid profile change is refused whole and leaves no trace", () => {
  const { world, a, adminA, settings } = setup();
  const snapshot = () => ({
    rows: JSON.stringify(world.tenantRows(a.tenant.id, "settings")),
    audit: world.tenantAudit(a.tenant.id, {}).length,
    registry: JSON.stringify(world.platformRows("tenants")),
    registryAudit: world.platformAudit({}).length,
  });
  const before = snapshot();
  const attempts = [
    ["invalid_name", { name: "" }],
    ["invalid_locale", { name: "Valid Name", locale: "xx_YY" }],
    ["invalid_currency", { currency: "ABCD" }],
    ["invalid_color", { primaryColor: "blue" }],
    ["invalid_logo", { logo: "https://example.test/a.png" }],
  ];
  for (const [expected, patch] of attempts) {
    expectCode(() => settings().updateProfile(adminA, patch), expected, JSON.stringify(patch));
  }
  assert.deepEqual(snapshot(), before);
});

test("AC-1.5 the time zone is fixed at provisioning and cannot be edited", () => {
  const { world, a, adminA, settings } = setup();
  expectCode(() => settings().updateProfile(adminA, { timeZone: "UTC" }), "immutable_field");
  expectCode(
    () => settings().updateProfile(adminA, { timeZone: "Asia/Colombo" }),
    "immutable_field",
    "even restating the same value"
  );
  // A change that includes it changes nothing at all.
  expectCode(
    () => settings().updateProfile(adminA, { name: "Renamed", timeZone: "UTC" }),
    "immutable_field"
  );
  assert.equal(settings().profile(adminA).name, "Felix Fashions");
  assert.equal(settings().profile(adminA).timeZone, "Asia/Colombo");
  assert.equal(
    world.platformRows("tenants").find((r) => r.id === a.tenant.id).timeZone,
    "Asia/Colombo"
  );
});

test("AC-1.5 unknown fields and a stated tenant are ignored: the context decides the tenant", () => {
  const { world, a, b, adminA, adminB, settings } = setup();
  settings().updateProfile(adminA, {
    tenantId: b.tenant.id,
    slug: "hacked",
    status: "deactivated",
    name: "Felix Two",
  });
  assert.equal(settings().profile(adminA).name, "Felix Two");
  assert.equal(settings().profile(adminB).name, "Orbit Apparel");
  const registry = world.platformRows("tenants");
  assert.equal(registry.find((row) => row.id === a.tenant.id).slug, "felix");
  assert.equal(registry.find((row) => row.id === a.tenant.id).status, "active");
  assert.equal(registry.find((row) => row.id === b.tenant.id).name, "Orbit Apparel");
});

test("AC-1.5 changing the profile needs the permission, every factory and a real tenant context", () => {
  const { world, platform, a, adminA, settings } = setup();
  const fa = world.app.organization.create(adminA, "factory", { code: "A1", name: "Factory A1" });
  const attempt = (email) => {
    const ctx = world.signInTenant(email, "felix");
    return () => settings().updateProfile(ctx, { name: "Changed" });
  };
  world.addMember(a.tenant.id, {
    email: "viewer@felix.example",
    permissions: ["dashboard.view"],
    all: true,
  });
  world.addMember(a.tenant.id, {
    email: "onefactory@felix.example",
    permissions: ["tenant_settings.manage"],
    factoryIds: [fa.id],
  });
  world.addMember(a.tenant.id, {
    email: "assigned@felix.example",
    permissions: ["tenant_settings.manage"],
    all: true,
    assignmentScoped: true,
  });
  expectCode(attempt("viewer@felix.example"), "forbidden", "no permission");
  expectCode(attempt("onefactory@felix.example"), "forbidden", "company data is tenant-wide");
  expectCode(attempt("assigned@felix.example"), "forbidden", "assignment-scoped");
  expectCode(() => settings().updateProfile(platform, { name: "Changed" }), "forbidden");
  expectCode(() => settings().updateProfile({ ...adminA }, { name: "Changed" }), "invalid_context");
  expectCode(() => settings().updateProfile(undefined, { name: "Changed" }), "invalid_context");
  assert.equal(settings().profile(adminA).name, "Felix Fashions");

  // The permission, not the administrator template, is what allows it.
  world.addMember(a.tenant.id, {
    email: "manager@felix.example",
    permissions: ["tenant_settings.manage"],
    all: true,
  });
  attempt("manager@felix.example")();
  assert.equal(settings().profile(adminA).name, "Changed");
});

test("AC-1.5 a suspended organization cannot read or change its profile", () => {
  const { world, platform, a, adminA, settings } = setup();
  world.app.tenancy.transition(platform, a.tenant.id, { to: "suspended", reason: "invoice" });
  expectCode(() => settings().profile(adminA), "tenant_inactive");
  expectCode(() => settings().updateProfile(adminA, { name: "X" }), "tenant_inactive");
});

// ---- Module entitlements -------------------------------------------------------------------

test("AC-1.5 a tenant starts with its provisioned modules and its administrator can see them", () => {
  const { adminA, settings, permissionsOf } = setup();
  const view = settings().entitlements(adminA);
  assert.deepEqual(
    view.map(({ feature }) => feature),
    [...FEATURES]
  );
  const entitled = view.filter((item) => item.entitled).map(({ feature }) => feature);
  assert.deepEqual(entitled, ["production", "performance", "attendance"]);
  assert.deepEqual(view.find((item) => item.feature === "production").history, [
    { enabled: true, effectiveFrom: FIRST_DAY, effectiveTo: null },
  ]);
  assert.deepEqual(view.find((item) => item.feature === "orders").history, []);
  const permissions = permissionsOf(adminA);
  assert.ok(permissions.includes("production.view"));
  assert.ok(permissions.includes("user.manage"));
  assert.ok(!permissions.includes("order.manage"), "orders are not enabled yet");
});

test("AC-1.5 enabling a module adds exactly its permissions and only for that tenant", () => {
  const { world, platform, a, b, adminA, adminB, settings, permissionsOf } = setup();
  const before = permissionsOf(adminA);
  const row = settings().setEntitlement(platform, a.tenant.id, {
    feature: "orders",
    enabled: true,
  });
  assert.deepEqual(row, {
    feature: "orders",
    enabled: true,
    effectiveFrom: FIRST_DAY,
    effectiveTo: null,
  });
  const after = permissionsOf(adminA);
  assert.deepEqual(
    after.filter((permission) => !before.includes(permission)).sort(),
    featurePermissions("orders").sort()
  );
  assert.ok(after.includes("order.manage"));
  assert.ok(!permissionsOf(adminB).includes("order.manage"), "the other tenant is untouched");
  assert.ok(
    settings()
      .entitlements(adminA)
      .find((item) => item.feature === "orders").entitled
  );
  assert.ok(
    !settings()
      .entitlements(adminB)
      .find((item) => item.feature === "orders").entitled
  );

  const events = world.tenantAudit(a.tenant.id, { entityType: "featureVersions" });
  const created = events.filter((event) => event.action === "create").at(-1);
  assert.equal(created.actorId, world.app.identity.whoami(platform).userId);
  assert.equal(created.changes.feature.after, "orders");
  assert.equal(world.tenantAudit(b.tenant.id, { entityType: "featureVersions" }).length, 3);
});

test("AC-1.5 a disabled module removes its permissions from its date, and history is reconstructable", () => {
  const { world, platform, a, adminA, settings, permissionsOf, org } = setup();
  const productionPermissions = featurePermissions("production");
  assert.ok(productionPermissions.length > 0);
  world.advance(DAY); // 2026-11-03, a day after the modules were provisioned
  settings().setEntitlement(platform, a.tenant.id, { feature: "production", enabled: false });
  const without = permissionsOf(adminA);
  for (const permission of productionPermissions) {
    assert.ok(!without.includes(permission), `${permission} is withdrawn with its module`);
  }
  assert.ok(without.includes("factory.manage"), "core permissions are not tied to a module");
  org.create(adminA, "factory", { code: "A1", name: "Factory A1" });

  // Re-enabling is scheduled: the module stays off until its date, then returns.
  settings().setEntitlement(platform, a.tenant.id, {
    feature: "production",
    enabled: true,
    effectiveFrom: day(4),
  });
  assert.ok(!permissionsOf(adminA).includes("production.view"));
  world.advance(2 * DAY); // day(3), the last day it is off
  assert.ok(!permissionsOf(adminA).includes("production.view"));
  world.advance(DAY); // day(4)
  assert.ok(permissionsOf(adminA).includes("production.view"));

  const production = settings()
    .entitlements(adminA)
    .find((item) => item.feature === "production");
  assert.deepEqual(production.history, [
    { enabled: true, effectiveFrom: day(0), effectiveTo: day(0) },
    { enabled: false, effectiveFrom: day(1), effectiveTo: day(3) },
    { enabled: true, effectiveFrom: day(4), effectiveTo: null },
  ]);
  const wasEntitled = (asOf) =>
    settings()
      .entitlements(adminA, { asOf })
      .find((item) => item.feature === "production").entitled;
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((n) => wasEntitled(day(n))),
    [true, false, false, false, true]
  );
  assert.deepEqual(
    settings()
      .tenantEntitlements(platform, a.tenant.id, { asOf: day(2) })
      .find((item) => item.feature === "production"),
    { feature: "production", entitled: false, history: production.history }
  );
  expectCode(() => settings().entitlements(adminA, { asOf: "2026-02-30" }), "invalid_range");
});

test("AC-1.5 a tenant administrator can see entitlements but not change them", () => {
  const { world, platform, a, adminA, settings } = setup();
  const before = JSON.stringify(world.tenantRows(a.tenant.id, "featureVersions"));
  expectCode(
    () => settings().setEntitlement(adminA, a.tenant.id, { feature: "orders", enabled: true }),
    "forbidden"
  );
  expectCode(() => settings().tenantEntitlements(adminA, a.tenant.id), "forbidden");
  world.app.tenancy.addPlatformUser(platform, {
    email: "support@opex.example",
    name: "Support",
    roleKeys: ["support_engineer"],
  });
  const support = world.signInPlatform("support@opex.example");
  expectCode(
    () => settings().setEntitlement(support, a.tenant.id, { feature: "orders", enabled: true }),
    "forbidden"
  );
  expectCode(() => settings().tenantEntitlements(support, a.tenant.id), "forbidden");
  assert.equal(JSON.stringify(world.tenantRows(a.tenant.id, "featureVersions")), before);
});

test("AC-1.5 an entitlement change is checked before it is written", () => {
  const { world, platform, a, settings } = setup();
  const set =
    (input, tenantId = a.tenant.id) =>
    () =>
      settings().setEntitlement(platform, tenantId, input);
  const rows = () => JSON.stringify(world.tenantRows(a.tenant.id, "featureVersions"));
  const before = rows();
  expectCode(set({ feature: "teleport", enabled: true }), "unknown_feature");
  expectCode(set({ feature: "orders", enabled: "yes" }), "invalid_field");
  expectCode(set({ feature: "orders" }), "invalid_field");
  expectCode(set({ feature: "orders", enabled: true }, "no-such-tenant"), "not_found");
  expectCode(
    set({ feature: "orders", enabled: true, effectiveFrom: "2026-13-01" }),
    "invalid_range"
  );
  expectCode(
    set({ feature: "orders", enabled: true, effectiveFrom: day(-1) }),
    "past_effective_date",
    "history is not rewritten"
  );
  // The module version that started today is already in effect.
  expectCode(set({ feature: "production", enabled: false }), "version_in_effect");
  assert.equal(rows(), before);
  expectCode(() => settings().setEntitlement(platform, a.tenant.id), "unknown_feature");
});

test("AC-1.5 a scheduled entitlement change can be revised until it takes effect", () => {
  const { world, platform, a, settings } = setup();
  const history = () =>
    settings()
      .tenantEntitlements(platform, a.tenant.id)
      .find((item) => item.feature === "orders").history;
  settings().setEntitlement(platform, a.tenant.id, { feature: "orders", enabled: true });
  settings().setEntitlement(platform, a.tenant.id, {
    feature: "orders",
    enabled: false,
    effectiveFrom: day(8),
  });
  assert.deepEqual(history(), [
    { enabled: true, effectiveFrom: day(0), effectiveTo: day(7) },
    { enabled: false, effectiveFrom: day(8), effectiveTo: null },
  ]);
  const scheduled = world
    .tenantRows(a.tenant.id, "featureVersions")
    .find((row) => row.feature === "orders" && row.enabled === false);

  // Something is already scheduled after day 4, so an earlier open-ended change would overlap it.
  expectCode(
    () =>
      settings().setEntitlement(platform, a.tenant.id, {
        feature: "orders",
        enabled: false,
        effectiveFrom: day(4),
      }),
    "overlap"
  );

  // Setting the same date again revises the scheduled row in place (here: cancelling the switch-off).
  settings().setEntitlement(platform, a.tenant.id, {
    feature: "orders",
    enabled: true,
    effectiveFrom: day(8),
  });
  assert.equal(history().length, 2, "no extra row");
  assert.equal(history()[1].enabled, true);
  const events = world.tenantAudit(a.tenant.id, {
    entityType: "featureVersions",
    entityId: scheduled.id,
  });
  assert.equal(events.at(-1).action, "update");
  assert.equal(events.at(-1).changes.enabled.before, false);
  assert.equal(events.at(-1).changes.enabled.after, true);
});

test("AC-1.5 the platform can read any tenant's entitlements and each tenant has its own history", () => {
  const { platform, a, b, adminB, settings } = setup();
  settings().setEntitlement(platform, a.tenant.id, { feature: "finance", enabled: true });
  const platformView = settings().tenantEntitlements(platform, a.tenant.id);
  assert.ok(platformView.find((item) => item.feature === "finance").entitled);
  const other = settings().tenantEntitlements(platform, b.tenant.id);
  assert.ok(!other.find((item) => item.feature === "finance").entitled);
  assert.deepEqual(other, settings().entitlements(adminB));
  expectCode(() => settings().tenantEntitlements(platform, "no-such-tenant"), "not_found");
});

test("AC-1.5 a change cannot start before a version that is already scheduled, even with nothing earlier", () => {
  const { world, platform, a, adminA, settings } = setup();
  const before = () => JSON.stringify(world.tenantRows(a.tenant.id, "featureVersions"));
  settings().setEntitlement(platform, a.tenant.id, {
    feature: "orders",
    enabled: true,
    effectiveFrom: day(10),
  });
  const scheduled = before();
  expectCode(
    () =>
      settings().setEntitlement(platform, a.tenant.id, {
        feature: "orders",
        enabled: true,
        effectiveFrom: day(5),
      }),
    "overlap"
  );
  assert.equal(before(), scheduled);

  settings().setTargets(adminA, { values: { efficiency: 80 }, effectiveFrom: day(10) });
  const targets = () => JSON.stringify(world.tenantRows(a.tenant.id, "targetVersions"));
  const scheduledTargets = targets();
  expectCode(
    () => settings().setTargets(adminA, { values: { efficiency: 70 }, effectiveFrom: day(5) }),
    "overlap"
  );
  assert.equal(targets(), scheduledTargets);
});

test("AC-1.5 the business date of a platform change is the tenant's, not UTC's", () => {
  const { world, platform, a, adminA, settings } = setup();
  // 20:00 UTC is already the next morning in Asia/Colombo (UTC+05:30).
  world.setNow("2026-11-02T20:00:00.000Z");
  const row = settings().setEntitlement(platform, a.tenant.id, {
    feature: "orders",
    enabled: true,
  });
  assert.equal(row.effectiveFrom, day(1), "starts on the tenant's date");
  const orders = (view) => view.find((item) => item.feature === "orders");
  assert.equal(orders(settings().tenantEntitlements(platform, a.tenant.id)).entitled, true);
  assert.equal(orders(settings().entitlements(adminA)).entitled, true);
  assert.equal(
    orders(settings().tenantEntitlements(platform, a.tenant.id, { asOf: day(0) })).entitled,
    false
  );
  expectCode(
    () =>
      settings().setEntitlement(platform, a.tenant.id, {
        feature: "finance",
        enabled: true,
        effectiveFrom: day(0),
      }),
    "past_effective_date",
    "day(0) is already yesterday there"
  );
});

test("AC-1.5 an organization with no modules shows none, and still refuses an invalid date", () => {
  const { world, platform, settings } = setup();
  world.openTenant(platform, {
    name: "Bare Works",
    slug: "bare",
    features: [],
    admin: { email: "admin@bare.example", name: "Bare Admin" },
  });
  const bare = world.signInTenant("admin@bare.example", "bare");
  const view = settings().entitlements(bare);
  assert.deepEqual(
    view.map(({ feature }) => feature),
    [...FEATURES]
  );
  assert.ok(view.every((item) => item.entitled === false && item.history.length === 0));
  expectCode(() => settings().entitlements(bare, { asOf: "2026-02-30" }), "invalid_range");
  expectCode(() => settings().entitlements(bare, { asOf: 5 }), "invalid_range");
});

// ---- Targets -------------------------------------------------------------------------------

test("AC-1.5 with nothing configured the system defaults apply and say so", () => {
  const { adminA, settings } = setup();
  const resolved = settings().targets(adminA);
  assert.equal(resolved.asOf, FIRST_DAY);
  assert.equal(resolved.factoryId, null);
  assert.deepEqual(resolved.values, { efficiency: 75, firstHour: 85, defectRate: 3, qco: 90 });
  for (const key of Object.keys(resolved.values)) {
    assert.deepEqual(resolved.sources[key], { level: "system", version: 1 }, key);
  }
  assert.deepEqual(settings().targetVersions(adminA), []);
});

test("AC-1.5 targets resolve System, then Tenant, then Factory, each value with its source", () => {
  const { adminA, settings, org } = setup();
  const fa = org.create(adminA, "factory", { code: "A1", name: "Factory A1" });
  const fb = org.create(adminA, "factory", { code: "B1", name: "Factory B1" });

  const tenantVersion = settings().setTargets(adminA, { values: { efficiency: 80, qco: 92 } });
  const { id, ...tenantRow } = tenantVersion;
  assert.ok(id);
  assert.deepEqual(tenantRow, {
    scope: "tenant",
    factoryId: null,
    version: 1,
    values: { efficiency: 80, qco: 92 },
    effectiveFrom: FIRST_DAY,
    effectiveTo: null,
  });
  settings().setTargets(adminA, { factoryId: fa.id, values: { efficiency: 90 } });

  const tenantLevel = settings().targets(adminA);
  assert.deepEqual(tenantLevel.values, { efficiency: 80, firstHour: 85, defectRate: 3, qco: 92 });
  assert.deepEqual(tenantLevel.sources.efficiency, { level: "tenant", version: 1 });
  assert.deepEqual(tenantLevel.sources.qco, { level: "tenant", version: 1 });
  assert.deepEqual(tenantLevel.sources.firstHour, { level: "system", version: 1 });

  const forA = settings().targets(adminA, { factoryId: fa.id });
  assert.equal(forA.factoryId, fa.id);
  assert.deepEqual(forA.values, { efficiency: 90, firstHour: 85, defectRate: 3, qco: 92 });
  assert.deepEqual(forA.sources.efficiency, { level: "factory", version: 1 });
  assert.deepEqual(forA.sources.qco, { level: "tenant", version: 1 });
  assert.deepEqual(forA.sources.defectRate, { level: "system", version: 1 });

  // A factory with no override of its own follows the tenant.
  const forB = settings().targets(adminA, { factoryId: fb.id });
  assert.deepEqual(forB.values, tenantLevel.values);
  assert.deepEqual(forB.sources, tenantLevel.sources);
});

test("AC-1.5 target versions are effective-dated and a past date can be reproduced", () => {
  const { world, adminA, settings } = setup();
  settings().setTargets(adminA, { values: { efficiency: 80 } });
  world.advance(8 * DAY); // day(8)
  const second = settings().setTargets(adminA, { values: { efficiency: 85 } });
  assert.equal(second.version, 2);
  assert.equal(second.effectiveFrom, day(8));
  settings().setTargets(adminA, { values: { efficiency: 88 }, effectiveFrom: day(18) });

  const efficiencyAt = (asOf) => {
    const resolved = settings().targets(adminA, { asOf });
    return [resolved.values.efficiency, resolved.sources.efficiency];
  };
  assert.deepEqual(efficiencyAt(day(5)), [80, { level: "tenant", version: 1 }]);
  assert.deepEqual(efficiencyAt(day(8)), [85, { level: "tenant", version: 2 }]);
  assert.deepEqual(efficiencyAt(day(17)), [85, { level: "tenant", version: 2 }]);
  assert.deepEqual(efficiencyAt(day(18)), [88, { level: "tenant", version: 3 }]);
  assert.deepEqual(
    efficiencyAt(day(-1)),
    [75, { level: "system", version: 1 }],
    "before the tenant set any target"
  );
  assert.deepEqual(settings().targets(adminA).values.efficiency, 85, "today is version 2");

  assert.deepEqual(
    settings()
      .targetVersions(adminA)
      .map(({ version, effectiveFrom, effectiveTo }) => [version, effectiveFrom, effectiveTo]),
    [
      [1, day(0), day(7)],
      [2, day(8), day(17)],
      [3, day(18), null],
    ]
  );

  // Later changes never alter what an earlier date resolved to.
  world.advance(20 * DAY); // day(28)
  settings().setTargets(adminA, { values: { efficiency: 70 } });
  assert.deepEqual(efficiencyAt(day(5)), [80, { level: "tenant", version: 1 }]);
  assert.deepEqual(efficiencyAt(day(20)), [88, { level: "tenant", version: 3 }]);
  assert.deepEqual(efficiencyAt(day(28)), [70, { level: "tenant", version: 4 }]);
  expectCode(() => settings().targets(adminA, { asOf: "2026-02-30" }), "invalid_range");
  expectCode(() => settings().targets(adminA, { asOf: 20261102 }), "invalid_range");
});

test("AC-1.5 a version in effect is never rewritten; a scheduled one can be revised", () => {
  const { world, a, adminA, settings } = setup();
  settings().setTargets(adminA, { values: { efficiency: 80 } });
  world.advance(5 * DAY);
  settings().setTargets(adminA, { values: { efficiency: 85 } });
  const scheduled = settings().setTargets(adminA, {
    values: { efficiency: 88 },
    effectiveFrom: day(15),
  });
  const rows = () => world.tenantRows(a.tenant.id, "targetVersions");
  const inEffect = JSON.stringify(rows().filter((row) => row.version < 3));

  expectCode(
    () => settings().setTargets(adminA, { values: { efficiency: 70 }, effectiveFrom: day(5) }),
    "version_in_effect",
    "version 2 started today"
  );
  expectCode(
    () => settings().setTargets(adminA, { values: { efficiency: 70 }, effectiveFrom: day(2) }),
    "past_effective_date"
  );
  expectCode(
    () => settings().setTargets(adminA, { values: { efficiency: 70 }, effectiveFrom: day(9) }),
    "overlap",
    "version 3 is already scheduled after that date"
  );
  assert.equal(JSON.stringify(rows().filter((row) => row.version < 3)), inEffect);

  const revised = settings().setTargets(adminA, {
    values: { efficiency: 90, qco: 95 },
    effectiveFrom: day(15),
  });
  assert.equal(revised.id, scheduled.id, "same version, revised in place");
  assert.equal(revised.version, 3);
  assert.deepEqual(revised.values, { efficiency: 90, qco: 95 }, "values are replaced, not merged");
  assert.equal(settings().targetVersions(adminA).length, 3);
  assert.equal(JSON.stringify(rows().filter((row) => row.version < 3)), inEffect);
  const events = world.tenantAudit(a.tenant.id, {
    entityType: "targetVersions",
    entityId: scheduled.id,
  });
  assert.deepEqual(
    events.map((event) => event.action),
    ["create", "update"]
  );
});

test("AC-1.5 a target change is checked before it is written", () => {
  const { world, a, b, adminA, adminB, settings, org } = setup();
  const fa = org.create(adminA, "factory", { code: "A1", name: "Factory A1" });
  const fOrbit = org.create(adminB, "factory", { code: "O1", name: "Orbit One" });
  const inactive = org.create(adminA, "factory", { code: "Z9", name: "Closed" });
  org.setActive(adminA, "factory", inactive.id, false);
  const rows = () => JSON.stringify(world.tenantRows(a.tenant.id, "targetVersions"));
  const before = rows();
  const audit = world.tenantAudit(a.tenant.id, {}).length;

  expectCode(() => settings().setTargets(adminA, { values: {} }), "invalid_target");
  expectCode(
    () => settings().setTargets(adminA, { values: { efficiency: 101 } }),
    "invalid_target"
  );
  expectCode(() => settings().setTargets(adminA, { values: { speed: 50 } }), "invalid_target");
  expectCode(() => settings().setTargets(adminA), "invalid_target");
  expectCode(
    () => settings().setTargets(adminA, { values: { efficiency: 80 }, effectiveFrom: "tomorrow" }),
    "invalid_range"
  );
  expectCode(
    () => settings().setTargets(adminA, { factoryId: "missing", values: { efficiency: 80 } }),
    "not_found"
  );
  expectCode(
    () => settings().setTargets(adminA, { factoryId: fOrbit.id, values: { efficiency: 80 } }),
    "not_found",
    "another tenant's factory does not exist here"
  );
  expectCode(
    () => settings().setTargets(adminA, { factoryId: inactive.id, values: { efficiency: 80 } }),
    "inactive_parent"
  );
  expectCode(() => settings().targets(adminA, { factoryId: fOrbit.id }), "not_found");
  assert.equal(rows(), before);
  assert.equal(world.tenantAudit(a.tenant.id, {}).length, audit);
  assert.equal(world.tenantRows(b.tenant.id, "targetVersions").length, 0);
  assert.ok(fa.id);
});

test("AC-1.5 targets follow permission and factory scope, and a tenant never sees another's", () => {
  const { world, a, b, adminA, adminB, settings, org } = setup();
  const fa = org.create(adminA, "factory", { code: "A1", name: "Factory A1" });
  const fb = org.create(adminA, "factory", { code: "B1", name: "Factory B1" });
  world.addMember(a.tenant.id, {
    email: "manager@felix.example",
    permissions: ["tenant_settings.manage", "dashboard.view"],
    factoryIds: [fa.id],
  });
  world.addMember(a.tenant.id, {
    email: "viewer@felix.example",
    permissions: ["dashboard.view"],
    all: true,
  });
  world.addMember(a.tenant.id, {
    email: "assigned@felix.example",
    permissions: ["tenant_settings.manage"],
    all: true,
    assignmentScoped: true,
  });
  const manager = world.signInTenant("manager@felix.example", "felix");
  const viewer = world.signInTenant("viewer@felix.example", "felix");
  const assigned = world.signInTenant("assigned@felix.example", "felix");

  // WHAT and WHERE both hold for the manager's own factory and nowhere else.
  const own = settings().setTargets(manager, { factoryId: fa.id, values: { efficiency: 82 } });
  assert.equal(own.factoryId, fa.id);
  expectCode(
    () => settings().setTargets(manager, { factoryId: fb.id, values: { efficiency: 82 } }),
    "forbidden",
    "another factory"
  );
  expectCode(
    () => settings().setTargets(manager, { values: { efficiency: 82 } }),
    "forbidden",
    "the tenant default is tenant-wide"
  );
  expectCode(
    () => settings().setTargets(viewer, { factoryId: fa.id, values: { efficiency: 82 } }),
    "forbidden",
    "no permission"
  );
  expectCode(
    () => settings().setTargets(assigned, { factoryId: fa.id, values: { efficiency: 82 } }),
    "forbidden",
    "assignment-scoped users fail closed"
  );

  // Reading follows the same factory scope; the tenant-level answer is open to every member.
  assert.equal(settings().targets(manager, { factoryId: fa.id }).values.efficiency, 82);
  expectCode(() => settings().targets(manager, { factoryId: fb.id }), "forbidden");
  assert.equal(settings().targets(manager).values.efficiency, 75);
  assert.equal(settings().targets(viewer, { factoryId: fb.id }).values.efficiency, 75);
  expectCode(() => settings().targetVersions(manager, { factoryId: fb.id }), "forbidden");
  assert.equal(settings().targetVersions(manager, { factoryId: fa.id }).length, 1);

  // The other tenant is unaffected and cannot reach this one's data.
  assert.deepEqual(settings().targets(adminB).sources.efficiency, { level: "system", version: 1 });
  assert.equal(world.tenantRows(b.tenant.id, "targetVersions").length, 0);
  expectCode(() => settings().targets(adminB, { factoryId: fa.id }), "not_found");
});

test("AC-1.5 every target change is one audit event by the person who made it", () => {
  const { world, a, adminA, settings, org } = setup();
  const fa = org.create(adminA, "factory", { code: "A1", name: "Factory A1" });
  const audited = (id) =>
    world.tenantAudit(a.tenant.id, { entityType: "targetVersions", entityId: id });
  const created = settings().setTargets(adminA, { factoryId: fa.id, values: { efficiency: 82 } });
  assert.equal(audited(created.id).length, 1);
  assert.equal(audited(created.id)[0].action, "create");
  assert.equal(audited(created.id)[0].actorId, a.admin.userId);
  assert.deepEqual(audited(created.id)[0].changes.values.after, { efficiency: 82 });

  world.advance(DAY);
  const next = settings().setTargets(adminA, { factoryId: fa.id, values: { efficiency: 84 } });
  // Starting version 2 ends version 1 the day before; both changes are on the record.
  assert.equal(audited(next.id).length, 1);
  const ended = audited(created.id).at(-1);
  assert.equal(ended.action, "update");
  assert.equal(ended.changes.effectiveTo.after, day(0));
  assert.equal(world.tenantAudit(a.tenant.id, { entityType: "targetVersions" }).length, 3);
});

test("AC-1.5 the tenant default and each factory override are separate chains of versions", () => {
  const { world, a, adminA, settings, org } = setup();
  const fa = org.create(adminA, "factory", { code: "A1", name: "Factory A1" });
  const fb = org.create(adminA, "factory", { code: "B1", name: "Factory B1" });
  settings().setTargets(adminA, { values: { efficiency: 80 } });
  settings().setTargets(adminA, { factoryId: fa.id, values: { efficiency: 90 } });
  settings().setTargets(adminA, { factoryId: fb.id, values: { efficiency: 85 } });
  world.advance(DAY);
  settings().setTargets(adminA, { factoryId: fa.id, values: { efficiency: 92 } });

  const summary = (options) =>
    settings()
      .targetVersions(adminA, options)
      .map(({ scope, factoryId, version, values }) => [
        scope,
        factoryId,
        version,
        values.efficiency,
      ]);
  assert.deepEqual(summary(), [["tenant", null, 1, 80]]);
  assert.deepEqual(summary({ factoryId: fa.id }), [
    ["factory", fa.id, 1, 90],
    ["factory", fa.id, 2, 92],
  ]);
  assert.deepEqual(summary({ factoryId: fb.id }), [["factory", fb.id, 1, 85]]);
  assert.equal(world.tenantRows(a.tenant.id, "targetVersions").length, 4);
});

test("AC-1.5 storage itself refuses a second version number or a second same-day module version", () => {
  const { world, a, b } = setup();
  const insert = (tenantId, collection, row) =>
    world.store.session({ tenantId, actorId: "arrange" }).insert(collection, row);
  const target = (subject, version) => ({
    subject,
    scope: subject === "tenant" ? "tenant" : "factory",
    factoryId: subject === "tenant" ? null : subject,
    version,
    values: { efficiency: 80 },
    effectiveFrom: FIRST_DAY,
    effectiveTo: null,
  });
  insert(a.tenant.id, "targetVersions", target("tenant", 1));
  expectCode(() => insert(a.tenant.id, "targetVersions", target("tenant", 1)), "duplicate");
  insert(a.tenant.id, "targetVersions", target("tenant", 2));
  insert(a.tenant.id, "targetVersions", target("factory-1", 1));
  insert(b.tenant.id, "targetVersions", target("tenant", 1));

  const module = (feature, effectiveFrom) => ({
    feature,
    enabled: true,
    effectiveFrom,
    effectiveTo: null,
  });
  // Provisioning already started production on the first day.
  expectCode(
    () => insert(a.tenant.id, "featureVersions", module("production", FIRST_DAY)),
    "duplicate"
  );
  insert(a.tenant.id, "featureVersions", module("production", day(3)));
  insert(a.tenant.id, "featureVersions", module("orders", FIRST_DAY));
});
