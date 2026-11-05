// The communication part of the demo world (D61 to D70): a few production days sent for approval, the
// notifications that follow, operational comments with tags, one export and one scheduled report.
//
// Everything goes through the services, exactly as the people would do it, so the notifications, the
// delivery records and the audit trail come from the real rules (the notifier writes them inside the
// transaction of the event). Kept small: LocalStorage holds about 5 MB.
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";

const FELIX = {
  manager: "manager@felix.example",
  supervisor: "supervisor@felix.example",
  engineer: "engineer@felix.example",
  viewer: "viewer@felix.example",
  // Line 2 is complete for today, so it can be closed; Line 1 has four hours keyed in.
  closed: { factory: "KAT", section: "SEW", line: "Line 2", shift: "DAY" },
  early: { factory: "KAT", section: "SEW", line: "Line 1", shift: "DAY" },
};

const ORBIT = { manager: "manager@orbit.example" };

export function seedCommunication({ app, plan, structure, members, employees, today, signIn }) {
  const slug = plan.spec.slug;
  const contexts = new Map();
  const contextOf = (email) => {
    if (!contexts.has(email)) {
      contexts.set(email, app.identity.enterTenant(signIn(email), { slug }));
    }
    return contexts.get(email);
  };
  const factoryOf = (code) => structure.factories.get(code).id;
  const lineOf = (factory, section, name) =>
    structure.lines.get(`${factory}/${section}/${name}`).id;
  const shiftOf = (factory, code) => structure.shifts.get(`${factory}/${code}`).id;
  const staff = (code) => employees.get(code).id;
  const dayOf = (context, where) =>
    app.production.days(context, {
      date: today,
      lineId: lineOf(where.factory, where.section, where.line),
    })[0];

  if (slug === "felix") {
    const manager = contextOf(FELIX.manager);
    const supervisor = contextOf(FELIX.supervisor);
    const engineer = contextOf(FELIX.engineer);

    // Sunil closes Line 2 (complete) and, too early, Line 1; Farah returns that one with a reason.
    const closed = dayOf(supervisor, FELIX.closed);
    if (closed !== undefined && closed.status === "draft") {
      app.production.submit(supervisor, closed.id, { confirmGaps: true });
    }
    const early = dayOf(supervisor, FELIX.early);
    if (early !== undefined && early.status === "draft") {
      app.production.submit(supervisor, early.id, { confirmGaps: true });
      app.production.returnDay(manager, early.id, {
        reason: "Only four of nine hours are keyed in. Complete the tally before closing the day.",
      });
    }

    // Comments: a line note from the manager, a stoppage from the supervisor, a factory note from the
    // engineer that is later corrected (the earlier text stays as a revision).
    app.comments.create(manager, {
      factoryId: factoryOf("KAT"),
      lineId: lineOf("KAT", "SEW", "Line 1"),
      shiftId: shiftOf("KAT", "DAY"),
      body: "Fabric for ST-4501 arrived at 10:30, so Line 1 started the first hour late.",
      mentionIds: [staff("E-1001")],
    });
    app.comments.create(supervisor, {
      factoryId: factoryOf("KAT"),
      lineId: lineOf("KAT", "SEW", "Line 1"),
      shiftId: shiftOf("KAT", "DAY"),
      body: "Needle breakage on machine 4 in hour 3. The mechanic fixed it in about 20 minutes.",
      mentionIds: [staff("E-1002")],
    });
    const note = app.comments.create(engineer, {
      factoryId: factoryOf("KAN"),
      body: "Line 2 changeover trial is planned for tomorrow morning.",
      mentionIds: [staff("E-2001")],
    });
    app.comments.edit(engineer, note.id, {
      body: "Line 2 changeover trial is planned for tomorrow at 08:00. Operators to be briefed first.",
      reason: "Added the start time and the briefing",
    });

    // One export for the manager, and a weekly report to the viewer that has already run once.
    const katunayake = { factoryId: factoryOf("KAT") };
    app.reports.request(manager, {
      report: "production_by_line",
      from: addDays(today, -7),
      to: addDays(today, -1),
      filters: katunayake,
      idempotencyKey: "seed-line-performance",
    });
    const schedule = app.reports.createSchedule(manager, {
      name: "Weekly line performance (Katunayake)",
      report: "production_by_line",
      filters: katunayake,
      periodKind: "last_7_days",
      recurrence: { cadence: "weekly", time: "07:00", weekday: 1 },
      recipientIds: [members.get(FELIX.viewer).userId],
    });
    app.reports.transitionSchedule(manager, schedule.id, {
      action: "run_now",
      reason: "First delivery for the demonstration",
      expectedVersion: schedule.version,
    });
  }

  if (slug === "orbit") {
    app.comments.create(contextOf(ORBIT.manager), {
      factoryId: factoryOf("GAZ"),
      body: "The yarn lot changed this morning. Watch the first-hour output on both halls.",
      mentionIds: [staff("O-001")],
    });
  }
}
