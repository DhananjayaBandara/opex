// The deterministic demo world (AC-1.8; SRS 3, 5.2): the platform team, two organizations with
// different structures, and one sign-in identity for each persona. Everything goes through the
// services, exactly as a person would do it, so the demo shows the real rules rather than a
// hand-built database. It runs once on an empty store and refuses a second run.
//
// Everything dated is relative to each organization's own business date, so the world looks the same
// whenever it is created: employees joined some days ago, two weeks of attendance have been recorded,
// supervisor assignments started ten days ago (so earlier production days have a supervisor of
// record, D42), one reassignment is scheduled ahead, and the production screens hold ten days of
// plans and production days in every status plus today's work in progress.
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";
import { fail } from "../services/errors.js";
import { seedCommunication } from "./communication.js";
import { ORDER_ROLES, seedOrders } from "./orders.js";
import { PLATFORM_ROLES, seedPlatform } from "./platform.js";
import { seedProduction } from "./production.js";
import { seedScorecards } from "./scorecards.js";
import { SUPPLY_ROLES, seedSupply } from "./supply.js";

// Standard roles carry no workforce rights, so the demo adds two custom ones: one that runs the
// register and the assignments, and a narrow one that only records attendance.
const WORKFORCE_ROLES = [
  {
    name: "Workforce coordinator",
    permissions: ["employee.manage", "supervisor_assignment.manage", "attendance.manage"],
  },
  { name: "Team attendance", permissions: ["attendance.manage"] },
];

const ATTENDANCE_DAYS = 14;

const PLATFORM_ADMIN = { email: "platform.admin@opex.example", name: "Priya Platform" };
const SUPPORT = { email: "support@opex.example", name: "Sam Support" };

// A plain employee row of the demo workforce.
function emp(code, name, factory, section, designation, joined, shifts) {
  return { code, name, factory, section, designation, joined, shifts };
}

// Felix Fashions: two factories, a three-section line-based plant and a smaller second site.
const FELIX = {
  spec: {
    name: "Felix Fashions",
    slug: "felix",
    timeZone: "Asia/Colombo",
    admin: { email: "admin@felix.example", name: "Felix Admin" },
    features: ["attendance", "finance", "orders", "performance", "procurement", "production"],
  },
  profile: {
    legalName: "Felix Fashions (Pvt) Ltd",
    currency: "LKR",
    locale: "en-LK",
    primaryColor: "#1f4e79",
  },
  targets: { efficiency: 78, firstHour: 85 },
  designations: [
    { name: "Machine Operator" },
    { name: "Line Supervisor", supervisorEligible: true },
    { name: "Quality Checker" },
  ],
  factories: [
    {
      code: "KAT",
      name: "Katunayake Plant",
      location: "Katunayake",
      targets: { efficiency: 82 },
      shifts: [
        { code: "DAY", name: "Day", startTime: "07:30", endTime: "16:30" },
        { code: "OT", name: "Overtime", startTime: "16:30", endTime: "19:30" },
      ],
      sections: [
        {
          code: "CUT",
          name: "Cutting",
          shifts: [0],
          lines: [{ name: "Cutting A", machineCount: 6 }],
        },
        {
          code: "SEW",
          name: "Sewing",
          shifts: [0, 1],
          lines: [
            { name: "Line 1", machineCount: 28 },
            { name: "Line 2", machineCount: 30 },
            { name: "Line 3", machineCount: 26 },
          ],
        },
        {
          code: "FIN",
          name: "Finishing",
          shifts: [0],
          lines: [{ name: "Finishing A", machineCount: 12 }],
        },
      ],
      calendar: {
        name: "Standard week",
        nonWorkingWeekdays: [0],
        exceptions: [{ date: "2026-12-25", working: false, reason: "Christmas Day" }],
      },
    },
    {
      code: "KAN",
      name: "Kandy Plant",
      location: "Kandy",
      shifts: [{ code: "DAY", name: "Day", startTime: "08:00", endTime: "17:00" }],
      sections: [
        {
          code: "SEW",
          name: "Sewing",
          shifts: [0],
          lines: [
            { name: "Line 1", machineCount: 22 },
            { name: "Line 2", machineCount: 20 },
          ],
        },
      ],
      calendar: { name: "Standard week", nonWorkingWeekdays: [0] },
    },
  ],
  // Persona -> role template, scope (factory codes) and whether limited to own assignments.
  people: [
    {
      persona: "factory_manager",
      email: "manager@felix.example",
      name: "Farah Manager",
      factories: ["KAT"],
      extraRoles: ["Workforce coordinator", "Order planner", "Supply chain officer"],
    },
    {
      persona: "supervisor",
      email: "supervisor@felix.example",
      name: "Sunil Supervisor",
      factories: ["KAT"],
      assignmentScoped: true,
      extraRoles: ["Team attendance"],
    },
    {
      persona: "industrial_engineer",
      email: "engineer@felix.example",
      name: "Ishara Engineer",
      extraRoles: ["Requisition approver"],
    },
    {
      persona: "viewer",
      email: "viewer@felix.example",
      name: "Vihan Viewer",
      extraRoles: ["Order viewer", "Supply viewer"],
    },
    {
      persona: "viewer",
      email: "finance@felix.example",
      name: "Fiona Finance",
      extraRoles: ["Finance officer"],
    },
    {
      persona: "viewer",
      email: "steward@felix.example",
      name: "Dina Steward",
      extraRoles: ["Data steward"],
    },
  ],
  // `joined` is days before today; `shifts` the shift codes they work (the first shift by default);
  // `leftAfter` the days since their last working day; `leaveDays` recent days on medical leave;
  // `status` is set once their history exists.
  workforce: {
    employees: [
      {
        code: "E-1001",
        name: "Sunil Supervisor",
        factory: "KAT",
        section: "SEW",
        designation: "Line Supervisor",
        joined: 900,
        phone: "+94 77 100 1001",
        linkedTo: "supervisor@felix.example",
      },
      {
        code: "E-1002",
        name: "Nimal Fernando",
        factory: "KAT",
        section: "CUT",
        designation: "Line Supervisor",
        joined: 1200,
        phone: "+94 77 100 1002",
      },
      {
        code: "E-1003",
        name: "Chamari Wijesinghe",
        factory: "KAT",
        section: "FIN",
        designation: "Line Supervisor",
        joined: 700,
        phone: "+94 77 100 1003",
      },
      emp("E-1101", "Kamala Perera", "KAT", "SEW", "Machine Operator", 640, ["DAY", "OT"]),
      emp("E-1102", "Anura Silva", "KAT", "SEW", "Machine Operator", 510, ["DAY", "OT"]),
      emp("E-1103", "Dilshan Rathnayake", "KAT", "SEW", "Machine Operator", 330),
      emp("E-1104", "Sanduni Jayawardena", "KAT", "SEW", "Machine Operator", 280, ["DAY", "OT"]),
      emp("E-1105", "Pradeep Kumara", "KAT", "SEW", "Machine Operator", 150),
      emp("E-1106", "Nadeesha Gunasekara", "KAT", "SEW", "Machine Operator", 90),
      {
        ...emp("E-1107", "Tharindu Bandara", "KAT", "SEW", "Machine Operator", 6),
        note: "Joined this week",
      },
      {
        ...emp("E-1108", "Lakmali Dissanayake", "KAT", "SEW", "Machine Operator", 800),
        leaveDays: 3,
        status: "on_leave",
        reason: "Medical leave",
      },
      emp("E-1401", "Hasini Amarasinghe", "KAT", "SEW", "Quality Checker", 420),
      emp("E-1201", "Roshan Fonseka", "KAT", "CUT", "Machine Operator", 560),
      emp("E-1202", "Menaka Herath", "KAT", "CUT", "Machine Operator", 200),
      emp("E-1301", "Ishani Weerasinghe", "KAT", "FIN", "Machine Operator", 380),
      {
        ...emp("E-1302", "Ravi Jayasinghe", "KAT", "FIN", "Machine Operator", 760),
        leftAfter: 6,
        status: "inactive",
        reason: "Resigned",
      },
      {
        code: "E-2001",
        name: "Dilani Silva",
        factory: "KAN",
        section: "SEW",
        designation: "Line Supervisor",
        joined: 610,
        phone: "+94 77 200 2001",
      },
      emp("E-2101", "Chathura Mendis", "KAN", "SEW", "Machine Operator", 300),
      emp("E-2102", "Piumi Karunaratne", "KAN", "SEW", "Machine Operator", 120),
    ],
    assignments: [
      { employee: "E-1001", factory: "KAT", section: "SEW", shift: "DAY", note: "Lines 1 to 3" },
      { employee: "E-1002", factory: "KAT", section: "CUT", shift: "DAY" },
      { employee: "E-1003", factory: "KAT", section: "FIN", shift: "DAY" },
      { employee: "E-2001", factory: "KAN", section: "SEW", shift: "DAY" },
    ],
    // From `after` days ahead the employee moves to another section-shift (SRS 8.3).
    reassignments: [
      {
        employee: "E-1002",
        section: "SEW",
        shift: "OT",
        after: 14,
        note: "Takes over the sewing overtime shift",
      },
    ],
  },
};

// Orbit Apparel: one knitwear factory on three shifts including a night shift, a different week.
const ORBIT = {
  spec: {
    name: "Orbit Apparel",
    slug: "orbit",
    timeZone: "Asia/Dhaka",
    admin: { email: "admin@orbit.example", name: "Orbit Admin" },
    features: ["attendance", "finance", "orders", "performance", "procurement", "production"],
  },
  profile: {
    legalName: "Orbit Apparel Ltd",
    currency: "BDT",
    locale: "en",
    primaryColor: "#7a2e8a",
  },
  targets: { efficiency: 70, defectRate: 4 },
  designations: [
    { name: "Knitting Operator" },
    { name: "Shift Incharge", supervisorEligible: true },
  ],
  factories: [
    {
      code: "GAZ",
      name: "Gazipur Knit Mill",
      location: "Gazipur",
      shifts: [
        { code: "A", name: "Morning", startTime: "06:00", endTime: "14:00" },
        { code: "B", name: "Evening", startTime: "14:00", endTime: "22:00" },
        { code: "C", name: "Night", startTime: "22:00", endTime: "06:00" },
      ],
      sections: [
        {
          code: "KNT",
          name: "Knitting",
          shifts: [0, 1, 2],
          lines: [
            { name: "Knit Hall 1", machineCount: 40 },
            { name: "Knit Hall 2", machineCount: 36 },
          ],
        },
        {
          code: "LNK",
          name: "Linking",
          shifts: [0, 1],
          lines: [{ name: "Linking Floor", machineCount: 24 }],
        },
        {
          code: "PAK",
          name: "Packing",
          shifts: [0],
          lines: [{ name: "Pack Line", machineCount: 8 }],
        },
      ],
      calendar: {
        name: "Friday off",
        nonWorkingWeekdays: [5],
        exceptions: [{ date: "2026-12-16", working: false, reason: "Victory Day" }],
      },
    },
  ],
  people: [
    {
      persona: "factory_manager",
      email: "manager@orbit.example",
      name: "Omar Manager",
      extraRoles: ["Workforce coordinator", "Order planner", "Supply chain officer"],
    },
    {
      persona: "viewer",
      email: "viewer@orbit.example",
      name: "Olivia Viewer",
      extraRoles: ["Order viewer", "Supply viewer"],
    },
  ],
  workforce: {
    // Orbit refuses overlapping assignments outright; Felix leaves them to a warning.
    assignmentPolicy: "block",
    employees: [
      emp("O-001", "Rashed Karim", "GAZ", "KNT", "Shift Incharge", 800, ["A"]),
      emp("O-002", "Nasrin Akter", "GAZ", "KNT", "Shift Incharge", 650, ["C"]),
      emp("O-003", "Tanvir Hasan", "GAZ", "LNK", "Shift Incharge", 500, ["A"]),
      emp("O-101", "Farhana Islam", "GAZ", "KNT", "Knitting Operator", 420, ["A"]),
      emp("O-102", "Mahbub Alam", "GAZ", "KNT", "Knitting Operator", 360, ["B"]),
      emp("O-103", "Sumaiya Khatun", "GAZ", "KNT", "Knitting Operator", 300, ["C"]),
      emp("O-104", "Imran Sheikh", "GAZ", "KNT", "Knitting Operator", 240, ["C"]),
      emp("O-105", "Jahid Hossain", "GAZ", "LNK", "Knitting Operator", 180, ["A"]),
      emp("O-106", "Rupa Begum", "GAZ", "PAK", "Knitting Operator", 120, ["A"]),
    ],
    assignments: [
      { employee: "O-001", factory: "GAZ", section: "KNT", shift: "A" },
      { employee: "O-002", factory: "GAZ", section: "KNT", shift: "C", note: "Night incharge" },
      { employee: "O-003", factory: "GAZ", section: "LNK", shift: "A" },
    ],
    reassignments: [
      {
        employee: "O-001",
        section: "KNT",
        shift: "B",
        after: 7,
        note: "Rotates to the evening shift",
      },
    ],
  },
};

export const DEMO_ACCOUNTS = Object.freeze({
  platform: Object.freeze([
    { persona: "platform_admin", ...PLATFORM_ADMIN },
    { persona: "support_engineer", ...SUPPORT },
  ]),
  tenants: Object.freeze(
    [FELIX, ORBIT].map((plan) =>
      Object.freeze({
        slug: plan.spec.slug,
        name: plan.spec.name,
        people: Object.freeze([
          { persona: "tenant_admin", ...plan.spec.admin },
          ...plan.people.map(({ persona, email, name }) => ({ persona, email, name })),
        ]),
      })
    )
  ),
});

export function seedDemo(app) {
  const store = app.internals.store;
  const reader = store.platformSession({ actorId: "demo-seed" });
  if (reader.list("users").length > 0 || reader.list("tenants").length > 0) {
    throw fail("already_seeded", "the demo world can only be created on an empty store");
  }

  const signIn = (email) => {
    try {
      return app.identity.authenticate({ email });
    } catch (error) {
      if (error.code !== "mfa_required") throw error;
      return app.identity.authenticate({ email, mfaCode: app.prototypeTools.mfaCode(email) });
    }
  };

  app.tenancy.bootstrapPlatform(PLATFORM_ADMIN);
  const platform = app.identity.enterPlatform(signIn(PLATFORM_ADMIN.email));
  app.tenancy.addPlatformUser(platform, { ...SUPPORT, roleKeys: ["support_engineer"] });

  for (const plan of [FELIX, ORBIT]) {
    const { tenant } = app.tenancy.provision(platform, plan.spec);
    app.tenancy.transition(platform, tenant.id, { to: "active" });
    const admin = app.identity.enterTenant(signIn(plan.spec.admin.email), { slug: plan.spec.slug });
    shape(app, admin, plan, signIn);
  }
  return DEMO_ACCOUNTS;
}

// The organization's profile, structure, targets and people, in the order a new customer would set
// them up.
function shape(app, admin, plan, signIn) {
  const org = app.organization;
  app.settings.updateProfile(admin, plan.profile);
  app.settings.setTargets(admin, { values: plan.targets });
  // What the workforce step needs to find again, by the codes the plan uses.
  const structure = {
    designations: new Map(),
    factories: new Map(),
    sections: new Map(),
    shifts: new Map(),
    sectionShifts: new Map(),
    lines: new Map(),
  };
  for (const designation of plan.designations) {
    structure.designations.set(designation.name, org.create(admin, "designation", designation));
  }

  const factoryByCode = structure.factories;
  for (const spec of plan.factories) {
    const factory = org.create(admin, "factory", {
      code: spec.code,
      name: spec.name,
      location: spec.location,
    });
    factoryByCode.set(spec.code, factory);
    if (spec.targets)
      app.settings.setTargets(admin, { factoryId: factory.id, values: spec.targets });
    const shifts = spec.shifts.map((shift) => {
      const created = org.create(admin, "shift", { factoryId: factory.id, ...shift });
      structure.shifts.set(`${spec.code}/${shift.code}`, created);
      return created;
    });
    for (const section of spec.sections) {
      const created = org.create(admin, "section", {
        factoryId: factory.id,
        code: section.code,
        name: section.name,
      });
      for (const line of section.lines) {
        structure.lines.set(
          `${spec.code}/${section.code}/${line.name}`,
          org.create(admin, "line", { sectionId: created.id, ...line })
        );
      }
      structure.sections.set(`${spec.code}/${section.code}`, created);
      for (const index of section.shifts) {
        structure.sectionShifts.set(
          `${spec.code}/${section.code}/${spec.shifts[index].code}`,
          org.create(admin, "sectionShift", { sectionId: created.id, shiftId: shifts[index].id })
        );
      }
    }
    const calendar = org.create(admin, "calendar", {
      factoryId: factory.id,
      name: spec.calendar.name,
      nonWorkingWeekdays: spec.calendar.nonWorkingWeekdays,
    });
    for (const exception of spec.calendar.exceptions ?? []) {
      org.create(admin, "calendarException", { calendarId: calendar.id, ...exception });
    }
  }

  for (const role of [...WORKFORCE_ROLES, ...ORDER_ROLES, ...SUPPLY_ROLES, ...PLATFORM_ROLES])
    app.administration.createRole(admin, role);
  const roles = app.administration.roles(admin);
  const members = new Map();
  for (const person of plan.people) {
    const role = roles.find((candidate) => candidate.templateKey === person.persona);
    const extra = (person.extraRoles ?? []).map(
      (name) => roles.find((candidate) => candidate.name === name).id
    );
    members.set(
      person.email,
      app.administration.addMember(admin, {
        email: person.email,
        name: person.name,
        roleIds: [role.id, ...extra],
        factoryScope:
          person.factories === undefined
            ? { all: true }
            : { factoryIds: person.factories.map((code) => factoryByCode.get(code).id) },
        assignmentScoped: person.assignmentScoped === true,
      })
    );
  }

  const employees = staff(app, admin, plan, structure, members);
  const today = app.identity.whoami(admin).today;
  seedProduction({ app, admin, plan, structure, members, employees, today, signIn });
  seedScorecards({ app, admin, slug: plan.spec.slug, structure, today });
  seedOrders({ app, admin, plan, structure, today, signIn });
  seedSupply({ app, admin, plan, structure, today, signIn });
  seedPlatform({ app, admin, plan, today, signIn });
  seedCommunication({ app, plan, structure, members, employees, today, signIn });
}

// ---- Workforce: the register, who supervises what, and two weeks of attendance -------------------

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const clockOf = (total) => {
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};

// A repeatable mix of present, late, overtime, absent and leave days, different for each person and
// day but the same on every run.
function attendanceFor(entry, back, shift) {
  const { spec, index } = entry;
  if (spec.leaveDays !== undefined && back < spec.leaveDays) {
    return { status: "LV", leaveType: "medical", note: "Medical certificate on file" };
  }
  const n = (index * 5 + back * 3) % 23;
  if (n === 0) return { status: "AB" };
  if (n === 1) return { status: "LV", leaveType: "casual" };
  const late = n % 7 === 2 ? 8 + (n % 4) * 4 : 0;
  const overtime = n % 5 === 3 ? 45 : 0;
  return {
    status: "P",
    clockIn: clockOf(minutesOf(shift.startTime) - 5 + late),
    clockOut: clockOf(minutesOf(shift.endTime) + 2 + overtime),
  };
}

function staff(app, admin, plan, structure, members) {
  const work = plan.workforce;
  const today = app.identity.whoami(admin).today;
  const sectionShiftOf = (factory, spec) =>
    structure.sectionShifts.get(`${factory}/${spec.section}/${spec.shift}`);

  if (work.assignmentPolicy !== undefined) {
    app.assignments.setPolicy(admin, { policy: work.assignmentPolicy });
  }

  const employees = new Map();
  for (const spec of work.employees) {
    const row = app.employees.create(admin, {
      employeeCode: spec.code,
      name: spec.name,
      phone: spec.phone,
      joinDate: addDays(today, -spec.joined),
      sectionId: structure.sections.get(`${spec.factory}/${spec.section}`).id,
      designationId: structure.designations.get(spec.designation).id,
      userId: spec.linkedTo === undefined ? undefined : members.get(spec.linkedTo).userId,
    });
    employees.set(spec.code, row);
  }

  const assigned = new Map();
  for (const spec of work.assignments) {
    assigned.set(
      spec.employee,
      app.assignments.assign(admin, {
        employeeId: employees.get(spec.employee).id,
        sectionShiftId: sectionShiftOf(spec.factory, spec).id,
        effectiveFrom: today,
        note: spec.note,
      })
    );
  }
  for (const spec of work.reassignments ?? []) {
    const factory = work.employees.find((candidate) => candidate.code === spec.employee).factory;
    app.assignments.reassign(admin, assigned.get(spec.employee).id, {
      sectionShiftId: sectionShiftOf(factory, spec).id,
      effectiveFrom: addDays(today, spec.after),
      note: spec.note,
    });
  }

  const roster = new Map(work.employees.map((spec, index) => [spec.code, { spec, index }]));
  const absences = [];
  for (let back = ATTENDANCE_DAYS; back >= 0; back -= 1) {
    const date = addDays(today, -back);
    for (const factory of plan.factories) {
      for (const shiftSpec of factory.shifts) {
        const day = app.attendance.daily(admin, {
          factoryId: structure.factories.get(factory.code).id,
          shiftId: structure.shifts.get(`${factory.code}/${shiftSpec.code}`).id,
          date,
        });
        if (!day.workingDay) continue;
        let seen = 0;
        for (const row of day.rows) {
          const entry = roster.get(row.employeeCode);
          const worksIt = (entry?.spec.shifts ?? [factory.shifts[0].code]).includes(shiftSpec.code);
          if (entry === undefined || row.record !== null || !worksIt) continue;
          if (back < (entry.spec.leftAfter ?? 0)) continue;
          seen += 1;
          if (back === 0 && seen % 2 === 0) continue; // today is only half recorded
          const record = app.attendance.record(admin, {
            employeeId: row.employeeId,
            shiftId: day.shiftId,
            date,
            ...attendanceFor(entry, back, shiftSpec),
          });
          if (record.status === "AB" && back > 0) absences.push(record);
        }
      }
    }
  }
  // The latest absence turns out to have been a medical day: the correction keeps the first entry (D33).
  if (absences.length > 0) {
    app.attendance.correct(admin, absences[absences.length - 1].id, {
      status: "LV",
      leaveType: "medical",
      reason: "Medical certificate handed in the next day",
    });
  }

  for (const spec of work.employees) {
    if (spec.status !== undefined) {
      app.employees.setStatus(admin, employees.get(spec.code).id, {
        status: spec.status,
        reason: spec.reason,
      });
    }
  }
  return employees;
}
