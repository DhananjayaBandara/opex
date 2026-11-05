// AC-1.4 Organization (SRS 6, FR-ORG-001..007, UC-ORG-01..05; architecture 6).
// Factories, sections, shifts (including overnight), SectionShifts, lines, designations and working
// calendars. Counts and names are never fixed: factories differ in structure. Authorization is WHAT
// (permission) plus WHERE (factory scope); a service never takes the tenant from its input.
import test from "node:test";
import assert from "node:assert/strict";
import { optional, need } from "./harness.mjs";
import { createWorld, expectCode } from "./world.mjs";
import { roleTemplate } from "../domain/permissions.js";

const domain = await optional("../domain/organization.js");
const DSRC = "domain/organization.js";

const ADMIN_A = "admin@felix.example";
const ADMIN_B = "admin@orbit.example";

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
  const org = () => {
    const service = world.app.organization;
    assert.equal(
      typeof service?.create,
      "function",
      "services/index.js must expose organization.create() - the contract is not implemented"
    );
    return service;
  };
  return { world, platform, a, b, adminA, adminB, org };
}

// A factory with the given sections and shifts, every section running every shift (the SRS 6.5 example).
function layout(org, ctx, code, sectionCodes, shifts) {
  const factory = org.create(ctx, "factory", { code, name: `Factory ${code}` });
  const sections = sectionCodes.map((sectionCode) =>
    org.create(ctx, "section", {
      factoryId: factory.id,
      code: sectionCode,
      name: `Section ${sectionCode}`,
    })
  );
  const made = shifts.map(([shiftCode, startTime, endTime]) =>
    org.create(ctx, "shift", {
      factoryId: factory.id,
      code: shiftCode,
      name: `Shift ${shiftCode}`,
      startTime,
      endTime,
    })
  );
  const sectionShifts = sections.flatMap((section) =>
    made.map((shift) =>
      org.create(ctx, "sectionShift", { sectionId: section.id, shiftId: shift.id })
    )
  );
  return { factory, sections, shifts: made, sectionShifts };
}

// ---- Pure domain rules ---------------------------------------------------------------------

test("AC-1.4 a shift span is its length in minutes and whether it crosses midnight", () => {
  const shiftSpan = need(domain, "shiftSpan", DSRC);
  assert.deepEqual(shiftSpan("08:00", "17:00"), { durationMinutes: 540, overnight: false });
  assert.deepEqual(shiftSpan("22:00", "06:00"), { durationMinutes: 480, overnight: true });
  assert.deepEqual(shiftSpan("00:00", "23:59"), { durationMinutes: 1439, overnight: false });
  expectCode(() => shiftSpan("08:00", "08:00"), "invalid_shift_times");
  for (const bad of ["8:00", "24:00", "12:60", "", null, 800, "08:00:00"]) {
    expectCode(() => shiftSpan(bad, "17:00"), "invalid_time", `start ${String(bad)}`);
    expectCode(() => shiftSpan("08:00", bad), "invalid_time", `end ${String(bad)}`);
  }
});

test("AC-1.4 codes are trimmed, upper-cased and restricted", () => {
  const normalizeCode = need(domain, "normalizeCode", DSRC);
  assert.equal(normalizeCode(" x-1 "), "X-1");
  assert.equal(normalizeCode("a_b"), "A_B");
  for (const bad of ["", "   ", "a b", "-a", "a".repeat(21), 5, null, undefined, "é"])
    expectCode(() => normalizeCode(bad), "invalid_code", String(bad));
});

test("AC-1.4 a working calendar has weekly off days and dated exceptions that win", () => {
  const isWorkingDay = need(domain, "isWorkingDay", DSRC);
  const calendar = { nonWorkingWeekdays: [0, 6] };
  // 2026-11-01 is a Sunday, 2026-11-02 a Monday, 2026-11-07 a Saturday.
  assert.equal(isWorkingDay(calendar, [], "2026-11-02"), true);
  assert.equal(isWorkingDay(calendar, [], "2026-11-01"), false);
  assert.equal(isWorkingDay(calendar, [], "2026-11-07"), false);
  assert.equal(isWorkingDay(calendar, [{ date: "2026-11-01", working: true }], "2026-11-01"), true);
  assert.equal(
    isWorkingDay(calendar, [{ date: "2026-11-02", working: false }], "2026-11-02"),
    false
  );
  assert.equal(
    isWorkingDay(calendar, [{ date: "2026-11-02", working: false }], "2026-11-03"),
    true,
    "an exception applies to its own date only"
  );
  assert.equal(isWorkingDay({ nonWorkingWeekdays: [] }, [], "2026-11-01"), true);
  expectCode(() => isWorkingDay(calendar, [], "2026-02-30"), "invalid_date");
  expectCode(() => isWorkingDay(calendar, [], "tomorrow"), "invalid_date");
});

// ---- Uniqueness, validation, hierarchy -----------------------------------------------------

test("AC-1.4 factory codes are unique within a tenant and independent across tenants", () => {
  const { a, b, adminA, adminB, org } = setup();
  const x = org().create(adminA, "factory", {
    code: " x ",
    name: "Factory X",
    location: "Colombo",
    tenantId: b.tenant.id,
    sortOrder: 99,
    active: false,
    id: "chosen-by-caller",
  });
  assert.equal(x.code, "X");
  assert.equal(x.tenantId, a.tenant.id, "a payload tenant id is ignored");
  assert.equal(x.active, true);
  assert.equal(x.sortOrder, 1);
  assert.notEqual(x.id, "chosen-by-caller");
  expectCode(() => org().create(adminA, "factory", { code: "x", name: "Again" }), "duplicate");
  const other = org().create(adminB, "factory", { code: "X", name: "Factory X" });
  assert.equal(other.tenantId, b.tenant.id);
  assert.equal(org().list(adminA, "factory").length, 1);
  assert.equal(org().list(adminB, "factory").length, 1);
});

test("AC-1.4 input is validated and unknown kinds are refused", () => {
  const { adminA, org } = setup();
  const bad = (input) => () => org().create(adminA, "factory", input);
  expectCode(bad({ code: "", name: "A" }), "invalid_code");
  expectCode(bad({ code: "has space", name: "A" }), "invalid_code");
  expectCode(bad({ code: "A", name: "" }), "invalid_name");
  expectCode(bad({ code: "A", name: "A", location: 5 }), "invalid_field");
  expectCode(bad(undefined), "invalid_code");
  expectCode(() => org().create(adminA, "warehouse", { name: "W" }), "unknown_kind");
  expectCode(() => org().list(adminA, "warehouse"), "unknown_kind");
});

test("AC-1.4 section code and name are unique within a factory, not across factories", () => {
  const { adminA, adminB, org } = setup();
  const fx = org().create(adminA, "factory", { code: "X", name: "X" });
  const fy = org().create(adminA, "factory", { code: "Y", name: "Y" });
  org().create(adminA, "section", { factoryId: fx.id, code: "A", name: "Section A" });
  expectCode(
    () => org().create(adminA, "section", { factoryId: fx.id, code: "a", name: "Other" }),
    "duplicate",
    "code, case ignored"
  );
  expectCode(
    () => org().create(adminA, "section", { factoryId: fx.id, code: "B", name: "Section A" }),
    "duplicate",
    "name"
  );
  expectCode(
    () => org().create(adminA, "section", { factoryId: fx.id, code: "B", name: " section a " }),
    "duplicate",
    "name, case and spacing ignored"
  );
  const sameInY = org().create(adminA, "section", {
    factoryId: fy.id,
    code: "A",
    name: "Section A",
  });
  assert.equal(sameInY.factoryId, fy.id);
  expectCode(
    () => org().create(adminA, "section", { factoryId: "id-missing", code: "C", name: "C" }),
    "not_found"
  );
  const foreign = org().create(adminB, "factory", { code: "X", name: "X" });
  expectCode(
    () => org().create(adminA, "section", { factoryId: foreign.id, code: "C", name: "C" }),
    "not_found",
    "another tenant's factory cannot be a parent"
  );
});

test("AC-1.4 shifts support overnight times and recompute when edited", () => {
  const { adminA, org } = setup();
  const fx = org().create(adminA, "factory", { code: "X", name: "X" });
  const shift = (input) => org().create(adminA, "shift", { factoryId: fx.id, ...input });
  const day = shift({ code: "P", name: "Day", startTime: "08:00", endTime: "17:00" });
  assert.deepEqual([day.overnight, day.durationMinutes], [false, 540]);
  const night = shift({ code: "Q", name: "Night", startTime: "22:00", endTime: "06:00" });
  assert.deepEqual([night.overnight, night.durationMinutes], [true, 480]);
  const longer = org().update(adminA, "shift", night.id, { endTime: "07:00" });
  assert.deepEqual([longer.overnight, longer.durationMinutes], [true, 540]);
  const flipped = org().update(adminA, "shift", night.id, { startTime: "05:00" });
  assert.deepEqual([flipped.overnight, flipped.durationMinutes], [false, 120]);
  expectCode(
    () => shift({ code: "R", name: "R", startTime: "9am", endTime: "17:00" }),
    "invalid_time"
  );
  expectCode(
    () => shift({ code: "R", name: "R", startTime: "08:00", endTime: "08:00" }),
    "invalid_shift_times"
  );
  expectCode(
    () => org().update(adminA, "shift", day.id, { endTime: "08:00" }),
    "invalid_shift_times",
    "an edit is validated against the stored start"
  );
});

test("AC-1.4 factories differ in structure and no count is fixed (SRS 6.1, 6.5)", () => {
  const { adminA, org } = setup();
  const x = layout(
    org(),
    adminA,
    "X",
    ["A", "B", "C"],
    [
      ["P", "06:00", "14:00"],
      ["Q", "14:00", "22:00"],
    ]
  );
  const y = layout(org(), adminA, "Y", ["A", "B", "C", "D", "E"], [["P", "08:00", "17:00"]]);
  const bridges = (factory) => org().list(adminA, "sectionShift", { factoryId: factory.id });
  assert.equal(bridges(x.factory).length, 6);
  assert.equal(bridges(y.factory).length, 5);
  assert.equal(org().list(adminA, "section", { factoryId: y.factory.id }).length, 5);
  assert.equal(org().list(adminA, "shift", { factoryId: x.factory.id }).length, 2);
});

test("AC-1.4 a SectionShift joins a section and a shift of the same factory, once", () => {
  const { adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "08:00", "17:00"]]);
  const y = layout(org(), adminA, "Y", ["A"], [["P", "08:00", "17:00"]]);
  const bridge = x.sectionShifts[0];
  assert.equal(bridge.factoryId, x.factory.id, "derived from the section, not supplied");
  assert.equal(bridge.active, true);
  expectCode(
    () =>
      org().create(adminA, "sectionShift", {
        sectionId: x.sections[0].id,
        shiftId: x.shifts[0].id,
      }),
    "duplicate"
  );
  expectCode(
    () =>
      org().create(adminA, "sectionShift", {
        sectionId: x.sections[0].id,
        shiftId: y.shifts[0].id,
      }),
    "cross_factory"
  );
  expectCode(
    () =>
      org().create(adminA, "sectionShift", {
        sectionId: y.sections[0].id,
        shiftId: x.shifts[0].id,
        factoryId: y.factory.id,
      }),
    "cross_factory",
    "a stated factory cannot rescue a cross-factory pair"
  );
  expectCode(
    () =>
      org().create(adminA, "sectionShift", { sectionId: "id-missing", shiftId: x.shifts[0].id }),
    "not_found"
  );
});

test("AC-1.4 a line belongs to one section and takes its factory from it", () => {
  const { adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A", "B"], [["P", "08:00", "17:00"]]);
  const y = layout(org(), adminA, "Y", ["A"], [["P", "08:00", "17:00"]]);
  const line = org().create(adminA, "line", {
    sectionId: x.sections[0].id,
    name: "Line 1",
    machineCount: 24,
  });
  assert.equal(line.factoryId, x.factory.id);
  assert.equal(line.machineCount, 24);
  assert.equal(
    org().create(adminA, "line", { sectionId: x.sections[0].id, name: "Line 2" }).machineCount,
    0
  );
  expectCode(
    () =>
      org().create(adminA, "line", {
        sectionId: x.sections[0].id,
        factoryId: y.factory.id,
        name: "Line 3",
      }),
    "cross_factory"
  );
  expectCode(
    () => org().create(adminA, "line", { sectionId: x.sections[0].id, name: "Line 1" }),
    "duplicate"
  );
  org().create(adminA, "line", { sectionId: x.sections[1].id, name: "Line 1" });
  for (const machineCount of [-1, 1.5, "24", null])
    expectCode(
      () => org().create(adminA, "line", { sectionId: x.sections[0].id, name: "L9", machineCount }),
      "invalid_machine_count",
      String(machineCount)
    );
});

test("AC-1.4 a parent link and the active flag cannot be edited", () => {
  const { adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A", "B"], [["P", "08:00", "17:00"]]);
  const y = layout(org(), adminA, "Y", ["A"], [["P", "08:00", "17:00"]]);
  const line = org().create(adminA, "line", { sectionId: x.sections[0].id, name: "Line 1" });
  const refused = (kind, id, patch) => () => org().update(adminA, kind, id, patch);
  expectCode(refused("section", x.sections[0].id, { factoryId: y.factory.id }), "immutable_field");
  expectCode(refused("line", line.id, { sectionId: x.sections[1].id }), "immutable_field");
  expectCode(refused("section", x.sections[0].id, { active: false }), "immutable_field");
  expectCode(refused("section", x.sections[0].id, { sortOrder: 9 }), "immutable_field");
  expectCode(refused("sectionShift", x.sectionShifts[0].id, { shiftId: "x" }), "immutable_field");
  assert.equal(org().get(adminA, "section", x.sections[0].id).factoryId, x.factory.id);
  const renamed = org().update(adminA, "section", x.sections[0].id, {
    name: "Cutting",
    tenantId: "ignored",
  });
  assert.equal(renamed.name, "Cutting");
});

// ---- Deactivate instead of delete ----------------------------------------------------------

test("AC-1.4 referenced master data cannot be deleted but unreferenced data can", () => {
  const { adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A", "B"], [["P", "08:00", "17:00"]]);
  const line = org().create(adminA, "line", { sectionId: x.sections[0].id, name: "Line 1" });
  expectCode(() => org().remove(adminA, "section", x.sections[0].id), "referenced", "has a line");
  expectCode(() => org().remove(adminA, "shift", x.shifts[0].id), "referenced", "has bridges");
  expectCode(() => org().remove(adminA, "factory", x.factory.id), "referenced", "has children");
  org().remove(adminA, "line", line.id);
  expectCode(() => org().get(adminA, "line", line.id), "not_found");
  expectCode(() => org().remove(adminA, "line", line.id), "not_found");
  // Section B has no line, but it still runs shift P.
  expectCode(() => org().remove(adminA, "section", x.sections[1].id), "referenced");
  org().remove(adminA, "sectionShift", x.sectionShifts[1].id);
  org().remove(adminA, "section", x.sections[1].id);
  assert.equal(org().list(adminA, "section", { factoryId: x.factory.id }).length, 1);
});

test("AC-1.4 deactivation keeps the row, hides it by default and needs inactive children", () => {
  const { adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "08:00", "17:00"]]);
  const section = x.sections[0];
  const line = org().create(adminA, "line", { sectionId: section.id, name: "Line 1" });
  expectCode(() => org().setActive(adminA, "section", section.id, false), "active_children");
  org().setActive(adminA, "line", line.id, false);
  org().setActive(adminA, "sectionShift", x.sectionShifts[0].id, false);
  const off = org().setActive(adminA, "section", section.id, false);
  assert.equal(off.active, false);
  assert.deepEqual(
    org()
      .list(adminA, "section", { factoryId: x.factory.id })
      .map((row) => row.id),
    []
  );
  assert.deepEqual(
    org()
      .list(adminA, "section", { factoryId: x.factory.id, includeInactive: true })
      .map((row) => row.id),
    [section.id]
  );
  assert.equal(org().get(adminA, "section", section.id).active, false, "history stays readable");
  assert.equal(org().setActive(adminA, "section", section.id, false).active, false, "idempotent");
});

test("AC-1.4 nothing can be created or revived under an inactive parent", () => {
  const { adminA, org } = setup();
  const factory = org().create(adminA, "factory", { code: "X", name: "X" });
  const section = org().create(adminA, "section", { factoryId: factory.id, code: "A", name: "A" });
  org().setActive(adminA, "section", section.id, false);
  org().setActive(adminA, "factory", factory.id, false);
  expectCode(
    () => org().create(adminA, "section", { factoryId: factory.id, code: "B", name: "B" }),
    "inactive_parent"
  );
  expectCode(() => org().setActive(adminA, "section", section.id, true), "inactive_parent");
  org().setActive(adminA, "factory", factory.id, true);
  assert.equal(org().setActive(adminA, "section", section.id, true).active, true);
});

// ---- Deterministic order -------------------------------------------------------------------

test("AC-1.4 reordering is deterministic, complete and audited as a change", () => {
  const { world, a, adminA, org } = setup();
  const [x, y, z] = ["X", "Y", "Z"].map((code) =>
    org().create(adminA, "factory", { code, name: code })
  );
  assert.deepEqual([x.sortOrder, y.sortOrder, z.sortOrder], [1, 2, 3]);
  const codes = () =>
    org()
      .list(adminA, "factory")
      .map((row) => row.code);
  org().reorder(adminA, "factory", [z.id, x.id, y.id]);
  assert.deepEqual(codes(), ["Z", "X", "Y"]);
  assert.deepEqual(
    org()
      .list(adminA, "factory")
      .map((row) => row.sortOrder),
    [1, 2, 3]
  );
  const eventsAfter = world.tenantAudit(a.tenant.id).length;
  org().reorder(adminA, "factory", [z.id, x.id, y.id]);
  assert.equal(
    world.tenantAudit(a.tenant.id).length,
    eventsAfter,
    "the same order changes nothing"
  );
  assert.equal(org().create(adminA, "factory", { code: "W", name: "W" }).sortOrder, 4);
  for (const ids of [[z.id, x.id], [z.id, x.id, y.id, y.id], [z.id, x.id, "id-missing"], []])
    expectCode(() => org().reorder(adminA, "factory", ids), "invalid_order", JSON.stringify(ids));
});

test("AC-1.4 sections and shifts reorder within one factory only", () => {
  const { adminA, org } = setup();
  const x = layout(
    org(),
    adminA,
    "X",
    ["A", "B", "C"],
    [
      ["P", "06:00", "14:00"],
      ["Q", "14:00", "22:00"],
    ]
  );
  const y = layout(org(), adminA, "Y", ["A", "B"], [["P", "08:00", "17:00"]]);
  const [sa, sb, sc] = x.sections;
  org().reorder(adminA, "section", [sc.id, sa.id, sb.id], { factoryId: x.factory.id });
  const names = (factory) =>
    org()
      .list(adminA, "section", { factoryId: factory.id })
      .map((row) => row.code);
  assert.deepEqual(names(x.factory), ["C", "A", "B"]);
  assert.deepEqual(names(y.factory), ["A", "B"], "another factory is untouched");
  expectCode(
    () =>
      org().reorder(adminA, "section", [y.sections[0].id, sa.id, sb.id], {
        factoryId: x.factory.id,
      }),
    "invalid_order",
    "a section of another factory"
  );
  org().reorder(adminA, "shift", [x.shifts[1].id, x.shifts[0].id], { factoryId: x.factory.id });
  assert.deepEqual(
    org()
      .list(adminA, "shift", { factoryId: x.factory.id })
      .map((row) => row.code),
    ["Q", "P"]
  );
});

// ---- Designations and calendars ------------------------------------------------------------

test("AC-1.4 designations are tenant-wide, unique by name and mark supervisor eligibility", () => {
  const { adminA, adminB, org } = setup();
  const supervisor = org().create(adminA, "designation", {
    name: "Supervisor",
    supervisorEligible: true,
  });
  assert.equal(supervisor.supervisorEligible, true);
  assert.equal(org().create(adminA, "designation", { name: "Operator" }).supervisorEligible, false);
  expectCode(() => org().create(adminA, "designation", { name: "Supervisor" }), "duplicate");
  expectCode(
    () => org().create(adminA, "designation", { name: "Checker", supervisorEligible: "yes" }),
    "invalid_field"
  );
  org().create(adminB, "designation", { name: "Supervisor" });
  assert.equal(
    org().update(adminA, "designation", supervisor.id, { supervisorEligible: false })
      .supervisorEligible,
    false
  );
});

test("AC-1.4 a calendar has weekly off days and one exception per date", () => {
  const { adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "08:00", "17:00"]]);
  const calendar = org().create(adminA, "calendar", {
    factoryId: x.factory.id,
    name: "Standard",
    nonWorkingWeekdays: [6, 0, 6],
  });
  assert.deepEqual(calendar.nonWorkingWeekdays, [0, 6], "sorted and de-duplicated");
  assert.equal(
    org().create(adminA, "calendar", { factoryId: x.factory.id, name: "Open" }).nonWorkingWeekdays
      .length,
    0
  );
  for (const nonWorkingWeekdays of [[7], [-1], ["a"], "0", [1.5]])
    expectCode(
      () =>
        org().create(adminA, "calendar", {
          factoryId: x.factory.id,
          name: "Bad",
          nonWorkingWeekdays,
        }),
      "invalid_weekdays",
      JSON.stringify(nonWorkingWeekdays)
    );
  expectCode(
    () => org().create(adminA, "calendar", { factoryId: x.factory.id, name: "Standard" }),
    "duplicate"
  );

  const holiday = org().create(adminA, "calendarException", {
    calendarId: calendar.id,
    date: "2026-12-25",
    working: false,
    reason: "Christmas",
  });
  assert.equal(holiday.factoryId, x.factory.id, "derived from the calendar");
  expectCode(
    () =>
      org().create(adminA, "calendarException", {
        calendarId: calendar.id,
        date: "2026-12-25",
        working: true,
      }),
    "duplicate"
  );
  expectCode(
    () =>
      org().create(adminA, "calendarException", {
        calendarId: calendar.id,
        date: "2026-02-30",
        working: true,
      }),
    "invalid_date"
  );
  expectCode(
    () =>
      org().create(adminA, "calendarException", {
        calendarId: calendar.id,
        date: "2026-12-26",
        working: "no",
      }),
    "invalid_field"
  );
  expectCode(() => org().remove(adminA, "calendar", calendar.id), "referenced", "has an exception");
  expectCode(
    () => org().update(adminA, "calendarException", holiday.id, { date: "2026-12-26" }),
    "immutable_field"
  );
  expectCode(
    () => org().setActive(adminA, "calendarException", holiday.id, false),
    "not_supported"
  );
  org().remove(adminA, "calendarException", holiday.id);
  org().remove(adminA, "calendar", calendar.id);
});

// ---- Authorization: WHAT and WHERE ---------------------------------------------------------

test("AC-1.4 WHAT: a member without the permission is denied but can read the structure", () => {
  const { world, a, adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "08:00", "17:00"]]);
  world.addMember(a.tenant.id, {
    email: "viewer@felix.example",
    permissions: roleTemplate("viewer").permissions,
    all: true,
  });
  const viewer = world.signInTenant("viewer@felix.example", "felix");
  const denied = (kind, input) => () => org().create(viewer, kind, input);
  expectCode(denied("factory", { code: "Z", name: "Z" }), "forbidden", "factory");
  expectCode(
    denied("section", { factoryId: x.factory.id, code: "B", name: "B" }),
    "forbidden",
    "section"
  );
  expectCode(
    denied("shift", {
      factoryId: x.factory.id,
      code: "Q",
      name: "Q",
      startTime: "08:00",
      endTime: "09:00",
    }),
    "forbidden",
    "shift"
  );
  expectCode(
    denied("sectionShift", { sectionId: x.sections[0].id, shiftId: x.shifts[0].id }),
    "forbidden",
    "sectionShift"
  );
  expectCode(denied("line", { sectionId: x.sections[0].id, name: "L" }), "forbidden", "line");
  expectCode(denied("designation", { name: "Op" }), "forbidden", "designation");
  expectCode(denied("calendar", { factoryId: x.factory.id, name: "Std" }), "forbidden", "calendar");
  expectCode(
    () => org().update(viewer, "section", x.sections[0].id, { name: "Hack" }),
    "forbidden"
  );
  expectCode(() => org().setActive(viewer, "section", x.sections[0].id, false), "forbidden");
  expectCode(() => org().remove(viewer, "sectionShift", x.sectionShifts[0].id), "forbidden");
  expectCode(() => org().reorder(viewer, "factory", [x.factory.id]), "forbidden");
  assert.equal(org().list(viewer, "section", { factoryId: x.factory.id }).length, 1);
  assert.equal(org().get(viewer, "factory", x.factory.id).code, "X");
});

test("AC-1.4 each kind needs its own permission", () => {
  const { world, a, adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "08:00", "17:00"]]);
  const only = (email, permissions) => {
    world.addMember(a.tenant.id, { email, permissions, all: true });
    return world.signInTenant(email, "felix");
  };
  const structureOnly = only("structure@felix.example", ["structure.manage"]);
  org().create(structureOnly, "section", { factoryId: x.factory.id, code: "B", name: "B" });
  expectCode(
    () => org().create(structureOnly, "factory", { code: "Z", name: "Z" }),
    "forbidden",
    "structure.manage is not factory.manage"
  );
  expectCode(
    () =>
      org().create(structureOnly, "sectionShift", {
        sectionId: x.sections[0].id,
        shiftId: x.shifts[0].id,
      }),
    "forbidden",
    "structure.manage is not section_shift.manage"
  );
  const bridging = only("bridge@felix.example", ["section_shift.manage"]);
  org().setActive(bridging, "sectionShift", x.sectionShifts[0].id, false);
  expectCode(
    () => org().create(bridging, "section", { factoryId: x.factory.id, code: "C", name: "C" }),
    "forbidden"
  );
  const factories = only("factories@felix.example", ["factory.manage"]);
  org().create(factories, "factory", { code: "Z", name: "Z" });
  const employees = only("employees@felix.example", ["employee.manage"]);
  org().create(employees, "designation", { name: "Operator" });
  expectCode(() => org().create(employees, "factory", { code: "Y", name: "Y" }), "forbidden");
});

test("AC-1.4 WHERE: a same-tenant manager outside the factory scope is denied", () => {
  const { world, a, adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A", "B"], [["P", "08:00", "17:00"]]);
  const y = layout(org(), adminA, "Y", ["A", "B"], [["P", "08:00", "17:00"]]);
  world.addMember(a.tenant.id, {
    email: "xmanager@felix.example",
    permissions: ["structure.manage", "section_shift.manage", "factory.manage"],
    factoryIds: [x.factory.id],
  });
  const manager = world.signInTenant("xmanager@felix.example", "felix");

  const inX = org().create(manager, "section", { factoryId: x.factory.id, code: "C", name: "C" });
  org().update(manager, "section", inX.id, { name: "Packing" });
  org().setActive(manager, "sectionShift", x.sectionShifts[0].id, false);
  org().reorder(manager, "section", [x.sections[1].id, x.sections[0].id, inX.id], {
    factoryId: x.factory.id,
  });

  expectCode(
    () => org().create(manager, "section", { factoryId: y.factory.id, code: "C", name: "C" }),
    "forbidden",
    "create in another factory"
  );
  expectCode(
    () =>
      org().create(manager, "sectionShift", {
        sectionId: x.sections[0].id,
        shiftId: y.shifts[0].id,
      }),
    "forbidden",
    "a pair reaching into a factory outside the scope"
  );
  expectCode(
    () => org().update(manager, "section", y.sections[0].id, { name: "Hack" }),
    "forbidden"
  );
  expectCode(
    () => org().setActive(manager, "sectionShift", y.sectionShifts[0].id, false),
    "forbidden"
  );
  expectCode(() => org().remove(manager, "sectionShift", y.sectionShifts[0].id), "forbidden");
  expectCode(() => org().get(manager, "section", y.sections[0].id), "forbidden");
  expectCode(
    () =>
      org().reorder(manager, "section", [y.sections[1].id, y.sections[0].id], {
        factoryId: y.factory.id,
      }),
    "forbidden"
  );
  expectCode(
    () => org().create(manager, "factory", { code: "Z", name: "Z" }),
    "forbidden",
    "a factory is tenant-wide, so it needs every factory"
  );
  expectCode(() => org().reorder(manager, "factory", [x.factory.id, y.factory.id]), "forbidden");

  assert.deepEqual(
    org()
      .list(manager, "factory")
      .map((row) => row.id),
    [x.factory.id],
    "only the factory in scope is visible"
  );
  assert.deepEqual(
    org()
      .list(manager, "section")
      .map((row) => row.factoryId),
    [x.factory.id, x.factory.id, x.factory.id]
  );
  assert.equal(
    org().get(adminA, "section", y.sections[0].id).name,
    `Section A`,
    "nothing in the denied factory changed"
  );
});

test("AC-1.4 an assignment-scoped member cannot manage structure (fail closed)", () => {
  const { world, a, adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "08:00", "17:00"]]);
  world.addMember(a.tenant.id, {
    email: "sup@felix.example",
    permissions: ["structure.manage", "factory.manage", "employee.manage"],
    all: true,
    assignmentScoped: true,
  });
  const supervisor = world.signInTenant("sup@felix.example", "felix");
  expectCode(
    () => org().create(supervisor, "section", { factoryId: x.factory.id, code: "B", name: "B" }),
    "forbidden"
  );
  expectCode(
    () => org().create(supervisor, "factory", { code: "Z", name: "Z" }),
    "forbidden",
    "tenant-wide data needs an unrestricted scope"
  );
  expectCode(
    () => org().create(supervisor, "designation", { name: "Operator" }),
    "forbidden",
    "tenant-wide data needs an unrestricted scope"
  );
  assert.equal(
    org().list(supervisor, "section", { factoryId: x.factory.id }).length,
    1,
    "the structure stays readable"
  );
});

// ---- Tenant isolation and context ----------------------------------------------------------

test("AC-1.4 another tenant's rows are invisible and untouchable", () => {
  const { world, a, b, adminA, adminB, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "08:00", "17:00"]]);
  const theirs = layout(org(), adminB, "X", ["A"], [["P", "08:00", "17:00"]]);
  const before = JSON.stringify(world.tenantRows(b.tenant.id, "sections"));
  for (const [kind, id] of [
    ["factory", x.factory.id],
    ["section", x.sections[0].id],
    ["shift", x.shifts[0].id],
    ["sectionShift", x.sectionShifts[0].id],
  ]) {
    expectCode(() => org().get(adminB, kind, id), "not_found", `get ${kind}`);
    expectCode(
      () => org().update(adminB, kind, id, { name: "Hack" }),
      "not_found",
      `update ${kind}`
    );
    expectCode(() => org().setActive(adminB, kind, id, false), "not_found", `setActive ${kind}`);
    expectCode(() => org().remove(adminB, kind, id), "not_found", `remove ${kind}`);
  }
  expectCode(
    () =>
      org().create(adminB, "sectionShift", {
        sectionId: x.sections[0].id,
        shiftId: theirs.shifts[0].id,
      }),
    "not_found",
    "a pair spanning tenants"
  );
  assert.equal(JSON.stringify(world.tenantRows(b.tenant.id, "sections")), before);
  assert.ok(
    org()
      .list(adminA, "section")
      .every((row) => row.tenantId === a.tenant.id)
  );
  assert.ok(
    org()
      .list(adminB, "section")
      .every((row) => row.tenantId === b.tenant.id)
  );
  assert.notDeepEqual(
    org()
      .list(adminA, "section")
      .map((row) => row.id),
    org()
      .list(adminB, "section")
      .map((row) => row.id)
  );
});

test("AC-1.4 every mutation writes one audit event for the actor in the tenant's log", () => {
  const { world, a, b, adminA, org } = setup();
  const factory = org().create(adminA, "factory", { code: "X", name: "X" });
  const section = org().create(adminA, "section", { factoryId: factory.id, code: "A", name: "A" });
  org().update(adminA, "section", section.id, { name: "Cutting" });
  org().setActive(adminA, "section", section.id, false);
  org().remove(adminA, "section", section.id);

  const events = world.tenantAudit(a.tenant.id, { entityType: "sections", entityId: section.id });
  assert.deepEqual(
    events.map((event) => event.action),
    ["create", "update", "update", "delete"]
  );
  assert.ok(
    events.every((event) => event.actorId === adminA.userId && event.tenantId === a.tenant.id)
  );
  assert.deepEqual(events[1].changes.name, { before: "A", after: "Cutting" });
  assert.deepEqual(events[2].changes.active, { before: true, after: false });
  assert.equal(world.tenantAudit(b.tenant.id, { entityType: "sections" }).length, 0);
});

test("AC-1.4 each kind records its creation under its own collection", () => {
  const { world, a, adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "22:00", "06:00"]]);
  org().create(adminA, "line", { sectionId: x.sections[0].id, name: "Line 1" });
  org().create(adminA, "designation", { name: "Supervisor", supervisorEligible: true });
  const calendar = org().create(adminA, "calendar", { factoryId: x.factory.id, name: "Std" });
  org().create(adminA, "calendarException", {
    calendarId: calendar.id,
    date: "2026-12-25",
    working: false,
  });
  const created = (entityType) =>
    world.tenantAudit(a.tenant.id, { entityType }).filter((event) => event.action === "create")
      .length;
  for (const entityType of [
    "factories",
    "sections",
    "shifts",
    "sectionShifts",
    "lines",
    "designations",
    "calendars",
    "calendarExceptions",
  ])
    assert.equal(created(entityType), 1, entityType);
});

test("AC-1.4 a refused change leaves neither a row nor an audit event", () => {
  const { world, a, adminA, org } = setup();
  const x = layout(org(), adminA, "X", ["A"], [["P", "08:00", "17:00"]]);
  const before = world.storage.raw();
  expectCode(
    () => org().create(adminA, "section", { factoryId: x.factory.id, code: "A", name: "Z" }),
    "duplicate"
  );
  expectCode(
    () => org().update(adminA, "shift", x.shifts[0].id, { endTime: "08:00" }),
    "invalid_shift_times"
  );
  expectCode(() => org().remove(adminA, "section", x.sections[0].id), "referenced");
  expectCode(() => org().reorder(adminA, "factory", []), "invalid_order");
  assert.equal(world.storage.raw(), before);
  assert.ok(world.tenantAudit(a.tenant.id).length > 0);
});

test("AC-1.4 a suspended tenant, an ended session and a revoked member stop at once", () => {
  const { world, platform, a, adminA, org } = setup();
  const factory = org().create(adminA, "factory", { code: "X", name: "X" });
  world.app.tenancy.transition(platform, a.tenant.id, { to: "suspended", reason: "unpaid" });
  expectCode(
    () => org().create(adminA, "section", { factoryId: factory.id, code: "A", name: "A" }),
    "tenant_inactive"
  );
  expectCode(() => org().list(adminA, "factory"), "tenant_inactive");
  world.app.tenancy.transition(platform, a.tenant.id, { to: "active" });
  assert.equal(org().list(adminA, "factory").length, 1, "a resumed tenant works again");

  const member = world.addMember(a.tenant.id, {
    email: "gone@felix.example",
    permissions: ["structure.manage"],
    all: true,
  });
  const gone = world.signInTenant("gone@felix.example", "felix");
  org().create(gone, "section", { factoryId: factory.id, code: "B", name: "B" });
  const tenant = world.store.session({ tenantId: a.tenant.id, actorId: "arrange" });
  const membership = tenant.list("memberships", (row) => row.userId === member.userId)[0];
  tenant.update("memberships", membership.id, { status: "revoked" });
  expectCode(() => org().list(gone, "section"), "access_revoked");
  expectCode(
    () => org().create(gone, "section", { factoryId: factory.id, code: "C", name: "C" }),
    "access_revoked"
  );

  world.app.identity.signOut(adminA);
  expectCode(() => org().list(adminA, "factory"), "session_ended");
  expectCode(() => org().list({ ...adminA }, "factory"), "invalid_context", "a copy is refused");
});

test("AC-1.4 platform and user contexts cannot reach the tenant's structure", () => {
  const { world, platform, org } = setup();
  const userContext = world.signIn(ADMIN_A);
  expectCode(() => org().list(platform, "factory"), "forbidden", "platform context");
  expectCode(() => org().list(userContext, "factory"), "forbidden", "user context");
  expectCode(() => org().create(platform, "factory", { code: "X", name: "X" }), "forbidden");
});
