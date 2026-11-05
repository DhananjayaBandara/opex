// AC-0.3 effective_access = membership + role permissions + factory scope + assignment scope
// + feature entitlement (architecture 5.3). A role's code or name is never an input.
import test from "node:test";
import assert from "node:assert/strict";
import { optional, need } from "./harness.mjs";

const auth = await optional("../domain/authorization.js");
const SRC = "domain/authorization.js";

const REGISTRY = {
  "dashboard.view": "production",
  "production.view": "production",
  "production.enter": "production",
  "production.approve": "production",
  "scorecard.view_all": "performance",
  "attendance.manage": "attendance",
  "user.manage": null,
};
const role = (id, tenantId, code, permissions) => ({ id, tenantId, code, name: code, permissions });
const SUPERVISOR = ["dashboard.view", "production.view", "production.enter"];
const membership = (overrides = {}) => ({
  tenantId: "tenant-a",
  userId: "user-1",
  status: "active",
  roleIds: ["role-sup"],
  factoryScope: { all: true },
  assignmentScoped: false,
  ...overrides,
});
const input = (overrides = {}) => ({
  tenantId: "tenant-a",
  userId: "user-1",
  asOf: "2026-03-15",
  permissionFeatures: REGISTRY,
  entitlements: ["production", "performance", "attendance"],
  roles: [role("role-sup", "tenant-a", "supervisor", SUPERVISOR)],
  memberships: [membership()],
  assignments: [],
  platformRoles: [],
  ...overrides,
});
const resolve = (overrides) => need(auth, "resolveAccess", SRC)(input(overrides));
const can = (access, permission, resource) =>
  need(auth, "canAccess", SRC)(access, permission, resource);
const inA = { tenantId: "tenant-a", factoryId: "f1", sectionShiftId: "ss-1" };

test("AC-0.3 an active member gets exactly the permissions of their roles", () => {
  const access = resolve();
  assert.equal(access.active, true);
  assert.deepEqual(access.permissions, [...SUPERVISOR].sort());
  assert.equal(can(access, "production.enter", inA), true);
  assert.equal(can(access, "production.approve", inA), false);
});

test("AC-0.3 permissions from several roles are unioned", () => {
  const access = resolve({
    roles: [
      role("role-sup", "tenant-a", "supervisor", SUPERVISOR),
      role("role-x", "tenant-a", "extra", ["production.approve", "dashboard.view"]),
    ],
    memberships: [membership({ roleIds: ["role-sup", "role-x"] })],
  });
  assert.deepEqual(access.permissions, [...SUPERVISOR, "production.approve"].sort());
});

test("AC-0.3 tenant boundary: a permission never reaches another tenant's resource", () => {
  const access = resolve();
  assert.equal(
    can(access, "production.view", {
      tenantId: "tenant-b",
      factoryId: "f1",
      sectionShiftId: "ss-1",
    }),
    false
  );
  assert.equal(
    can(access, "production.view", { factoryId: "f1", sectionShiftId: "ss-1" }),
    false,
    "a resource without a tenant fails closed"
  );
});

test("AC-0.3 tenant boundary: membership in tenant A grants nothing when resolving tenant B", () => {
  const access = resolve({
    tenantId: "tenant-b",
    roles: [role("role-sup", "tenant-a", "supervisor", SUPERVISOR)],
    memberships: [membership()],
  });
  assert.equal(access.active, false);
  assert.deepEqual(access.permissions, []);
});

test("AC-0.3 a user with memberships in two tenants gets only the resolved tenant's roles", () => {
  const roles = [
    role("role-sup", "tenant-a", "supervisor", SUPERVISOR),
    role("role-b", "tenant-b", "supervisor", ["production.approve"]),
  ];
  const memberships = [membership(), membership({ tenantId: "tenant-b", roleIds: ["role-b"] })];
  assert.deepEqual(resolve({ roles, memberships }).permissions, [...SUPERVISOR].sort());
  assert.deepEqual(resolve({ roles, memberships, tenantId: "tenant-b" }).permissions, [
    "production.approve",
  ]);
});

test("AC-0.3 a role from another tenant contributes nothing even if a membership lists it", () => {
  const access = resolve({
    roles: [role("role-b", "tenant-b", "admin", ["user.manage", "production.approve"])],
    memberships: [membership({ roleIds: ["role-b"] })],
  });
  assert.deepEqual(access.permissions, []);
});

test("AC-0.3 only an active membership grants access", () => {
  for (const status of ["invited", "suspended", "removed", undefined]) {
    const access = resolve({ memberships: [membership({ status })] });
    assert.equal(access.active, false, `status ${status}`);
    assert.deepEqual(access.permissions, [], `status ${status}`);
    assert.equal(can(access, "production.view", inA), false, `status ${status}`);
  }
  assert.equal(resolve({ memberships: [] }).active, false);
});

test("AC-0.3 feature entitlement removes the permissions of a disabled feature only", () => {
  const roles = [
    role("role-sup", "tenant-a", "supervisor", [
      ...SUPERVISOR,
      "scorecard.view_all",
      "user.manage",
    ]),
  ];
  const access = resolve({ roles, entitlements: ["production"] });
  assert.equal(
    access.permissions.includes("scorecard.view_all"),
    false,
    "performance feature is off"
  );
  assert.equal(access.permissions.includes("production.view"), true);
  assert.equal(
    access.permissions.includes("user.manage"),
    true,
    "an always-available permission stays"
  );
});

test("AC-0.3 a permission that is not in the registry is never granted", () => {
  const access = resolve({
    roles: [role("role-sup", "tenant-a", "supervisor", [...SUPERVISOR, "made.up"])],
  });
  assert.equal(access.permissions.includes("made.up"), false);
  assert.equal(can(access, "made.up", inA), false);
  assert.equal(can(access, "never.registered", inA), false);
});

test("AC-0.3 the role code is never an input: a custom role equals the seeded role", () => {
  const seeded = resolve();
  const custom = resolve({ roles: [role("role-sup", "tenant-a", "line_lead_custom", SUPERVISOR)] });
  assert.deepEqual(custom, seeded);
  const renamed = resolve({
    roles: [
      { ...role("role-sup", "tenant-a", "tenant_admin", SUPERVISOR), name: "Tenant Administrator" },
    ],
  });
  assert.deepEqual(renamed, seeded, "calling a role tenant_admin grants nothing by itself");
  assert.equal(
    JSON.stringify(seeded).includes("supervisor"),
    false,
    "the result must not carry role codes"
  );
});

test("AC-0.3 removing one permission removes exactly the matching access", () => {
  const all = [...SUPERVISOR, "production.approve", "attendance.manage"];
  const full = resolve({ roles: [role("role-sup", "tenant-a", "r", all)] });
  const reduced = resolve({
    roles: [
      role(
        "role-sup",
        "tenant-a",
        "r",
        all.filter((p) => p !== "production.approve")
      ),
    ],
  });
  const granted = (access) => Object.keys(REGISTRY).filter((p) => can(access, p, inA));
  const lost = granted(full).filter((p) => !granted(reduced).includes(p));
  assert.deepEqual(lost, ["production.approve"]);
});

test("AC-0.3 factory scope: a same-tenant user is denied outside their factories", () => {
  const restricted = resolve({
    memberships: [membership({ factoryScope: { factoryIds: ["f1"] } })],
  });
  assert.equal(can(restricted, "production.view", { tenantId: "tenant-a", factoryId: "f1" }), true);
  assert.equal(
    can(restricted, "production.view", { tenantId: "tenant-a", factoryId: "f2" }),
    false
  );
  assert.equal(
    can(restricted, "production.view", { tenantId: "tenant-a" }),
    false,
    "a factory-restricted user cannot read an unscoped (tenant-wide) resource"
  );
  const all = resolve();
  assert.equal(can(all, "production.view", { tenantId: "tenant-a", factoryId: "f2" }), true);
  assert.equal(can(all, "production.view", { tenantId: "tenant-a" }), true);
});

const assignment = (overrides = {}) => ({
  tenantId: "tenant-a",
  userId: "user-1",
  sectionShiftId: "ss-1",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-03-31",
  ...overrides,
});
const scoped = (overrides = {}) =>
  resolve({
    memberships: [membership({ assignmentScoped: true })],
    assignments: [assignment()],
    ...overrides,
  });

test("AC-0.3 assignment scope: access follows the effective-dated SectionShift assignment", () => {
  assert.equal(can(scoped({ asOf: "2026-03-31" }), "production.enter", inA), true);
  assert.equal(can(scoped({ asOf: "2026-04-01" }), "production.enter", inA), false);
  assert.equal(can(scoped({ asOf: "2025-12-31" }), "production.enter", inA), false);
  assert.equal(can(scoped(), "production.enter", { ...inA, sectionShiftId: "ss-2" }), false);
  assert.equal(
    can(scoped(), "production.enter", { tenantId: "tenant-a", factoryId: "f1" }),
    false,
    "an assignment-scoped user cannot access a resource that names no SectionShift"
  );
});

test("AC-0.3 assignment scope ignores other users' and other tenants' assignments", () => {
  const access = scoped({
    assignments: [assignment({ userId: "user-2" }), assignment({ tenantId: "tenant-b" })],
  });
  assert.equal(can(access, "production.enter", inA), false);
});

test("AC-0.3 a reassigned supervisor loses the old SectionShift and gains the new one from the change date", () => {
  const assignments = [
    assignment({ effectiveTo: "2026-02-28" }),
    assignment({ sectionShiftId: "ss-2", effectiveFrom: "2026-03-01", effectiveTo: null }),
  ];
  const access = scoped({ assignments, asOf: "2026-03-01" });
  assert.equal(can(access, "production.enter", inA), false);
  assert.equal(can(access, "production.enter", { ...inA, sectionShiftId: "ss-2" }), true);
});

test("AC-0.3 a platform principal without a tenant membership has no tenant access", () => {
  const access = resolve({ memberships: [], platformRoles: ["platform_admin"] });
  assert.equal(access.active, false);
  assert.deepEqual(access.permissions, []);
  assert.equal(can(access, "production.view", inA), false);
});
