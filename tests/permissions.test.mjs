// AC-1.2 Permissions and time. The permission catalogue (architecture 5.2), the seeded role
// templates (SRS 5.4 matrix, architecture 5.4 platform versus tenant roles) and the business date
// (D20: the date in the tenant's IANA timezone).
import test from "node:test";
import assert from "node:assert/strict";
import { optional, need } from "./harness.mjs";

const perms = await optional("../domain/permissions.js");
const time = await optional("../domain/time.js");
const auth = await optional("../domain/authorization.js");
const PSRC = "domain/permissions.js";
const TSRC = "domain/time.js";
const code = (expected) => (error) => error?.code === expected;
// The harness's need() accepts functions only; the catalogue exports are lists.
const constant = (exports, name, source) => {
  assert.ok(Array.isArray(exports[name]), `${source} must export ${name} - not implemented`);
  return exports[name];
};

const catalogue = () => constant(perms, "PERMISSIONS", PSRC);
const ids = () => catalogue().map((entry) => entry.id);
const template = (key) => need(perms, "roleTemplate", PSRC)(key);
const holds = (key, permission) => template(key).permissions.includes(permission);

// Architecture 5.2, verbatim.
const ARCHITECTURE_5_2 = {
  Dashboard: ["dashboard.view", "scorecard.view_self", "scorecard.view_all"],
  Production: [
    "production.view",
    "production.enter",
    "production.submit",
    "production.approve",
    "production.edit_approved",
  ],
  Organization: ["factory.manage", "structure.manage", "section_shift.manage"],
  Workforce: ["employee.manage", "supervisor_assignment.manage", "attendance.manage"],
  "Orders / planning": ["order.manage", "planning.manage", "approval.decide", "capacity.manage"],
  "Procurement / stock": ["rfq.manage", "po.manage", "grn.post", "stock.adjust"],
  Finance: ["invoice.issue", "invoice.record_payment"],
  Administration: ["user.manage", "role.manage", "tenant_settings.manage"],
};

test("AC-1.2 the catalogue covers every architecture 5.2 family and permission", () => {
  for (const [family, expected] of Object.entries(ARCHITECTURE_5_2)) {
    for (const id of expected) {
      const entry = catalogue().find((candidate) => candidate.id === id);
      assert.ok(entry, `${id} is in the catalogue`);
      assert.equal(entry.family, family, `${id} belongs to ${family}`);
    }
  }
});

test("AC-1.2 every entry has a unique id, a label, a read or write kind and a feature gate", () => {
  const features = constant(perms, "FEATURES", PSRC);
  assert.ok(Array.isArray(features) && features.length > 0);
  assert.equal(new Set(ids()).size, ids().length, "ids are unique");
  for (const entry of catalogue()) {
    assert.match(entry.id, /^[a-z_]+\.[a-z_]+$/, entry.id);
    assert.ok(typeof entry.label === "string" && entry.label.length > 0, `${entry.id} label`);
    assert.ok(["read", "write"].includes(entry.kind), `${entry.id} kind`);
    assert.ok(["tenant", "platform"].includes(entry.audience), `${entry.id} audience`);
    assert.ok(entry.feature === null || features.includes(entry.feature), `${entry.id} feature`);
  }
  assert.equal(Object.isFrozen(catalogue()), true, "the catalogue cannot be edited at runtime");
  assert.equal(Object.isFrozen(catalogue()[0]), true);
});

test("AC-1.2 viewing permissions are reads and acting permissions are writes", () => {
  const kind = (id) => catalogue().find((entry) => entry.id === id).kind;
  for (const id of ["dashboard.view", "production.view", "scorecard.view_self", "audit.view"])
    assert.equal(kind(id), "read", id);
  for (const id of [
    "production.enter",
    "production.approve",
    "factory.manage",
    "user.manage",
    "grn.post",
    "invoice.issue",
    "support_access.approve",
  ])
    assert.equal(kind(id), "write", id);
});

test("AC-1.2 module-specific permissions are gated by a feature; core ones are not", () => {
  const feature = (id) => catalogue().find((entry) => entry.id === id).feature;
  assert.equal(feature("order.manage"), "orders");
  assert.equal(feature("po.manage"), "procurement");
  assert.equal(feature("invoice.issue"), "finance");
  assert.equal(feature("production.enter"), "production");
  assert.equal(feature("scorecard.view_all"), "performance");
  assert.equal(feature("attendance.manage"), "attendance");
  for (const id of ["user.manage", "role.manage", "factory.manage", "dashboard.view"])
    assert.equal(feature(id), null, `${id} is always available`);
});

test("AC-1.2 the registry feeds effective access: a disabled module removes only its permissions", () => {
  const registry = need(perms, "permissionFeatures", PSRC)();
  assert.deepEqual(Object.keys(registry).sort(), [...ids()].sort());
  const resolve = (entitlements) =>
    need(
      auth,
      "resolveAccess",
      "domain/authorization.js"
    )({
      tenantId: "tenant-a",
      userId: "user-1",
      asOf: "2026-11-02",
      permissionFeatures: registry,
      entitlements,
      roles: [
        {
          id: "role-1",
          tenantId: "tenant-a",
          permissions: template("tenant_admin").permissions,
        },
      ],
      memberships: [
        {
          tenantId: "tenant-a",
          userId: "user-1",
          status: "active",
          roleIds: ["role-1"],
          factoryScope: { all: true },
          assignmentScoped: false,
        },
      ],
      assignments: [],
    });
  const all = constant(perms, "FEATURES", PSRC);
  const full = resolve(all).permissions;
  const noOrders = resolve(all.filter((feature) => feature !== "orders")).permissions;
  assert.ok(full.includes("order.manage"));
  assert.deepEqual(
    full.filter((permission) => !noOrders.includes(permission)),
    // S6 added the read permission order.view (AC-8.1, D75) to the orders module, so it goes too.
    ["approval.decide", "capacity.manage", "order.manage", "order.view", "planning.manage"]
  );
  assert.ok(noOrders.includes("user.manage"), "core permissions survive");
});

// SRS 5.4. "Yes" and "Assigned factories" / "Own assignment scope" grant the permission (the scope
// is a separate dimension); "Optional/configurable" and "No by default" are not granted by default,
// but must exist in the catalogue so a custom role can add them.
const SRS_5_4 = [
  // [SRS permission, catalogue ids for admin, manager, supervisor]
  ["view_dashboard", ["dashboard.view"], ["dashboard.view"], ["dashboard.view"]],
  ["manage_org_structure", ["factory.manage", "structure.manage", "section_shift.manage"], [], []],
  ["manage_supervisor_assignments", ["supervisor_assignment.manage"], [], []],
  ["enter_production", ["production.enter"], ["production.enter"], ["production.enter"]],
  [
    "edit_own_unapproved_entry (part of production.enter)",
    ["production.enter"],
    ["production.enter"],
    ["production.enter"],
  ],
  ["edit_approved_entry", ["production.edit_approved"], [], []],
  ["approve_production_entry", ["production.approve"], ["production.approve"], []],
  [
    "view_supervisor_scorecards",
    ["scorecard.view_all"],
    ["scorecard.view_all"],
    ["scorecard.view_self"],
  ],
  ["manage_users_roles", ["user.manage", "role.manage"], [], []],
];

test("AC-1.2 the seeded templates match the SRS 5.4 matrix", () => {
  for (const [name, admin, manager, supervisor] of SRS_5_4) {
    for (const id of admin) assert.ok(holds("tenant_admin", id), `${name}: admin has ${id}`);
    for (const id of manager) assert.ok(holds("factory_manager", id), `${name}: manager ${id}`);
    for (const id of supervisor) assert.ok(holds("supervisor", id), `${name}: supervisor ${id}`);
  }
  // "No" / "Optional" cells: the matrix lists exactly which default rows are missing.
  const missing = (key, column) =>
    SRS_5_4.flatMap((row) => row[1].filter((id) => !row[column].includes(id)))
      .filter((id) => holds(key, id))
      .sort();
  assert.deepEqual(missing("factory_manager", 2), [], "manager has no default it should lack");
  assert.deepEqual(missing("supervisor", 3), [], "supervisor has no default it should lack");
  assert.equal(holds("supervisor", "scorecard.view_all"), false, "own scorecard only");
  assert.equal(holds("supervisor", "production.approve"), false);
  assert.equal(holds("factory_manager", "user.manage"), false);
  assert.equal(holds("factory_manager", "role.manage"), false);
});

test("AC-1.2 optional SRS 5.4 permissions exist so a custom role can add them", () => {
  for (const id of [
    "factory.manage",
    "structure.manage",
    "section_shift.manage",
    "supervisor_assignment.manage",
    "production.edit_approved",
  ])
    assert.ok(ids().includes(id), id);
});

test("AC-1.2 each template carries the default scope the matrix describes", () => {
  assert.equal(template("tenant_admin").defaultScope, "tenant");
  assert.equal(template("factory_manager").defaultScope, "factories");
  assert.equal(template("supervisor").defaultScope, "assignment");
  assert.equal(template("viewer").defaultScope, "factories");
});

test("AC-1.2 the viewer is read-only and the industrial engineer cannot administer or approve", () => {
  const kinds = new Map(catalogue().map((entry) => [entry.id, entry.kind]));
  assert.ok(holds("viewer", "dashboard.view"));
  // D70 (intentional specification change, S5.2): the viewer's "reports" (SRS 16.1) include a file of
  // the reports it can already read. export.create is classed as a write only so that read-only
  // support access cannot export; it changes no business record, so it is the one named exception.
  const readLikeWrites = new Set(["export.create"]);
  for (const id of template("viewer").permissions)
    if (!readLikeWrites.has(id))
      assert.equal(kinds.get(id), "read", `viewer holds only reads: ${id}`);
  assert.ok(holds("industrial_engineer", "production.enter"));
  for (const id of ["user.manage", "role.manage", "production.approve", "support_access.approve"])
    assert.equal(holds("industrial_engineer", id), false, id);
});

test("AC-1.2 the tenant administrator can run the tenant, including support approval", () => {
  for (const id of [
    "user.manage",
    "role.manage",
    "tenant_settings.manage",
    "support_access.approve",
  ])
    assert.ok(holds("tenant_admin", id), id);
  assert.equal(holds("factory_manager", "support_access.approve"), false);
});

test("AC-1.2 platform and tenant permissions never mix (architecture 5.4, FR-TEN-010)", () => {
  const audience = new Map(catalogue().map((entry) => [entry.id, entry.audience]));
  for (const key of ["platform_admin", "support_engineer"]) {
    assert.equal(template(key).audience, "platform");
    for (const id of template(key).permissions)
      assert.equal(audience.get(id), "platform", `${key} holds only platform permissions: ${id}`);
  }
  for (const key of ["tenant_admin", "factory_manager", "supervisor", "industrial_engineer"]) {
    assert.equal(template(key).audience, "tenant");
    for (const id of template(key).permissions)
      assert.equal(audience.get(id), "tenant", `${key} holds only tenant permissions: ${id}`);
  }
  assert.ok(holds("platform_admin", "tenant_registry.manage"));
  assert.ok(holds("platform_admin", "feature_entitlement.manage"));
  assert.ok(holds("support_engineer", "support_access.request"));
  assert.equal(holds("support_engineer", "tenant_registry.manage"), false);
});

test("AC-1.2 MFA is required for platform roles and tenant administrators only (D18)", () => {
  for (const key of ["platform_admin", "support_engineer", "tenant_admin"])
    assert.equal(template(key).requiresMfa, true, key);
  for (const key of ["factory_manager", "supervisor", "industrial_engineer", "viewer"])
    assert.equal(template(key).requiresMfa, false, key);
});

test("AC-1.2 every template permission is in the catalogue and templates are immutable", () => {
  const templates = constant(perms, "ROLE_TEMPLATES", PSRC);
  assert.deepEqual(templates.map((entry) => entry.key).sort(), [
    "factory_manager",
    "industrial_engineer",
    "platform_admin",
    "supervisor",
    "support_engineer",
    "tenant_admin",
    "viewer",
  ]);
  for (const entry of templates) {
    assert.ok(entry.label.length > 0);
    assert.equal(new Set(entry.permissions).size, entry.permissions.length, entry.key);
    for (const id of entry.permissions) assert.ok(ids().includes(id), `${entry.key}: ${id}`);
    assert.equal(Object.isFrozen(entry), true, `${entry.key} is frozen`);
    assert.equal(Object.isFrozen(entry.permissions), true, `${entry.key} permissions are frozen`);
  }
  assert.throws(() => need(perms, "roleTemplate", PSRC)("nope"), code("unknown_template"));
});

test("AC-1.2 validatePermissions normalizes, rejects unknown ids and cross-audience grants", () => {
  const validate = need(perms, "validatePermissions", PSRC);
  assert.deepEqual(validate(["user.manage", "dashboard.view", "user.manage"], "tenant"), [
    "dashboard.view",
    "user.manage",
  ]);
  assert.deepEqual(validate([], "tenant"), []);
  assert.throws(() => validate(["user.manage", "made.up"], "tenant"), code("unknown_permission"));
  assert.throws(() => validate("user.manage", "tenant"), code("invalid_permissions"));
  assert.throws(() => validate([7], "tenant"), code("unknown_permission"));
  assert.throws(
    () => validate(["tenant_registry.manage"], "tenant"),
    code("wrong_audience"),
    "a tenant role cannot hold a platform permission"
  );
  assert.throws(() => validate(["dashboard.view"], "platform"), code("wrong_audience"));
  assert.throws(() => validate(["dashboard.view"], "galaxy"), code("invalid_audience"));
});

test("AC-1.2 readOnly keeps only tenant read permissions, for read-only support access (D19)", () => {
  const readOnly = need(perms, "readOnly", PSRC);
  assert.deepEqual(
    readOnly(["production.enter", "production.view", "user.manage", "dashboard.view"]),
    ["dashboard.view", "production.view"]
  );
  assert.deepEqual(readOnly(["user.manage"]), []);
  assert.throws(() => readOnly(["made.up"]), code("unknown_permission"));
  assert.throws(() => readOnly(["tenant_registry.manage"]), code("wrong_audience"));
});

// ---- Business date (D20) -------------------------------------------------------------------

const businessDate = (instant, zone) => need(time, "businessDate", TSRC)(instant, zone);

test("AC-1.2 the business date is the date in the tenant timezone, across the UTC boundary", () => {
  assert.equal(businessDate("2026-11-02T20:30:00.000Z", "Asia/Colombo"), "2026-11-03");
  assert.equal(businessDate("2026-11-02T20:30:00.000Z", "UTC"), "2026-11-02");
  assert.equal(businessDate("2026-11-02T18:29:59.000Z", "Asia/Colombo"), "2026-11-02");
  assert.equal(businessDate("2026-11-02T18:30:00.000Z", "Asia/Colombo"), "2026-11-03");
  assert.equal(businessDate("2026-11-02T03:00:00.000Z", "America/New_York"), "2026-11-01");
  assert.equal(businessDate("2026-11-02T12:30:00.000Z", "Pacific/Auckland"), "2026-11-03");
});

test("AC-1.2 the business date accepts a Date and an instant with an offset", () => {
  assert.equal(businessDate(new Date("2026-11-02T20:30:00.000Z"), "Asia/Colombo"), "2026-11-03");
  assert.equal(businessDate("2026-11-03T02:00:00+05:30", "UTC"), "2026-11-02");
});

test("AC-1.2 a daylight-saving change does not shift the date by a day", () => {
  assert.equal(businessDate("2026-03-08T06:59:00.000Z", "America/New_York"), "2026-03-08");
  assert.equal(businessDate("2026-03-08T07:00:00.000Z", "America/New_York"), "2026-03-08");
  assert.equal(businessDate("2026-03-09T03:59:00.000Z", "America/New_York"), "2026-03-08");
  assert.equal(businessDate("2026-03-09T04:00:00.000Z", "America/New_York"), "2026-03-09");
});

test("AC-1.2 an invalid timezone or instant is rejected, never defaulted", () => {
  for (const zone of ["Mars/Olympus", "", "+05:30", null, undefined, 7])
    assert.throws(
      () => businessDate("2026-11-02T20:30:00.000Z", zone),
      code("invalid_timezone"),
      String(zone)
    );
  for (const instant of ["not a date", "2026-11-02", "2026-11-02T10:00:00", "", null, 7])
    assert.throws(
      () => businessDate(instant, "UTC"),
      code("invalid_instant"),
      `instant ${String(instant)}`
    );
  assert.throws(() => businessDate(new Date("nope"), "UTC"), code("invalid_instant"));
});

test("AC-1.2 isValidTimeZone says whether a name is an IANA timezone", () => {
  const valid = need(time, "isValidTimeZone", TSRC);
  assert.equal(valid("Asia/Colombo"), true);
  assert.equal(valid("UTC"), true);
  assert.equal(valid("Mars/Olympus"), false);
  assert.equal(valid("+05:30"), false);
  assert.equal(valid(""), false);
  assert.equal(valid(null), false);
});
