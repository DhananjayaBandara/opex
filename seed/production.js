// The production part of the demo world (D42): styles, ten days of earlier plans and production days
// in every status, and today's work in progress.
//
// Earlier days cannot be created through the services (a plan is for today or later and a day is not
// for the future), so the seed writes them straight to the store, one transaction per person who
// would have done the work, so the audit trail names the right people. Today and the days ahead go
// through the services, exactly as a planner and a supervisor would do them.
//
// Figures are repeatable: the same pseudo-random mix of line, day and hour on every run.
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";

export const HISTORY_DAYS = 10;

const STYLES = {
  felix: [
    { code: "ST-4501", name: "Men's polo shirt", buyer: "Harbor Brands", smv: 14.2 },
    { code: "ST-4502", name: "Ladies basic tee", buyer: "Meadow Retail", smv: 8.6 },
    { code: "ST-4510", name: "Boys cargo short", buyer: "Harbor Brands", smv: 17.5 },
    { code: "ST-4520", name: "Fleece hoodie", buyer: "Alpine Outfitters", smv: 24 },
  ],
  orbit: [
    { code: "KN-210", name: "Merino crew sweater", buyer: "Nordic Knits", smv: 32 },
    { code: "KN-225", name: "Cotton cardigan", buyer: "Nordic Knits", smv: 38 },
    { code: "KN-240", name: "Knit polo top", buyer: "Lakeside Co", smv: 21 },
  ],
};

// One entry per line that runs. `performance` is the line's typical output against its target;
// `today` says what has been keyed in so far; `then` changes the style from some days ahead.
const LINES = {
  felix: [
    {
      factory: "KAT",
      section: "SEW",
      shift: "DAY",
      line: "Line 1",
      style: "ST-4501",
      order: "PO-7781",
      efficiency: 78,
      operators: 28,
      helpers: 2,
      manual: 2,
      hours: 9,
      performance: 0.97,
      supervisor: "E-1001",
      reporter: "supervisor@felix.example",
      approver: "manager@felix.example",
      today: { hours: 4 },
      then: { afterDays: 2, style: "ST-4510", order: "PO-7830" },
    },
    {
      factory: "KAT",
      section: "SEW",
      shift: "DAY",
      line: "Line 2",
      style: "ST-4502",
      order: "PO-7790",
      efficiency: 80,
      operators: 30,
      helpers: 3,
      manual: 2,
      hours: 9,
      performance: 1.04,
      supervisor: "E-1001",
      reporter: "supervisor@felix.example",
      approver: "manager@felix.example",
      today: { hours: 9 },
    },
    {
      factory: "KAT",
      section: "SEW",
      shift: "DAY",
      line: "Line 3",
      style: "ST-4510",
      order: "PO-7802",
      efficiency: 74,
      operators: 26,
      helpers: 2,
      manual: 1,
      hours: 9,
      performance: 0.86,
      supervisor: "E-1001",
      reporter: "supervisor@felix.example",
      approver: "manager@felix.example",
      reviseToday: true,
    },
    {
      factory: "KAT",
      section: "FIN",
      shift: "DAY",
      line: "Finishing A",
      style: "ST-4501",
      order: "PO-7781",
      efficiency: 72,
      operators: 12,
      helpers: 1,
      manual: 3,
      hours: 9,
      performance: 0.93,
      supervisor: "E-1003",
      reporter: "engineer@felix.example",
      approver: "manager@felix.example",
    },
    {
      factory: "KAN",
      section: "SEW",
      shift: "DAY",
      line: "Line 1",
      style: "ST-4502",
      order: "PO-7815",
      efficiency: 76,
      operators: 22,
      helpers: 2,
      manual: 2,
      hours: 9,
      performance: 1.0,
      supervisor: "E-2001",
      reporter: "engineer@felix.example",
      approver: "admin@felix.example",
      today: { hours: 3 },
    },
    {
      factory: "KAN",
      section: "SEW",
      shift: "DAY",
      line: "Line 2",
      style: "ST-4520",
      order: "PO-7820",
      efficiency: 70,
      operators: 20,
      helpers: 2,
      manual: 2,
      hours: 9,
      performance: 0.9,
      supervisor: "E-2001",
      reporter: "engineer@felix.example",
      approver: "admin@felix.example",
    },
  ],
  orbit: [
    {
      factory: "GAZ",
      section: "KNT",
      shift: "A",
      line: "Knit Hall 1",
      style: "KN-210",
      order: "PO-B-410",
      efficiency: 70,
      operators: 40,
      helpers: 3,
      manual: 2,
      hours: 8,
      performance: 0.98,
      supervisor: "O-001",
      reporter: "manager@orbit.example",
      approver: "admin@orbit.example",
      today: { hours: 4 },
    },
    {
      factory: "GAZ",
      section: "KNT",
      shift: "A",
      line: "Knit Hall 2",
      style: "KN-225",
      order: "PO-B-415",
      efficiency: 68,
      operators: 36,
      helpers: 3,
      manual: 2,
      hours: 8,
      performance: 0.88,
      supervisor: "O-001",
      reporter: "manager@orbit.example",
      approver: "admin@orbit.example",
    },
    {
      factory: "GAZ",
      section: "LNK",
      shift: "A",
      line: "Linking Floor",
      style: "KN-240",
      order: "PO-B-422",
      efficiency: 72,
      operators: 24,
      helpers: 2,
      manual: 2,
      hours: 8,
      performance: 1.05,
      supervisor: "O-003",
      reporter: "manager@orbit.example",
      approver: "admin@orbit.example",
    },
  ],
};

const EVENT_CODES = [
  "power_cut",
  "machine_breakdown",
  "material_shortage",
  "style_changeover",
  "absenteeism",
  "quality_hold",
  "waiting_instruction",
];

// What the approver wrote when a day came back.
const RETURN_REASON =
  "Hour 4 output looks too high against the cutting issue. Please recount and resubmit.";

// Yesterday's status for each line in turn: something waiting, something done, something returned.
const LATEST = [
  "pending_approval",
  "approved",
  "returned",
  "pending_approval",
  "approved",
  "pending_approval",
];

// A repeatable number from 0 up to (not including) 1 for a line, day and purpose.
function mix(...parts) {
  let hash = 2166136261;
  for (const part of parts) hash = Math.imul(hash ^ (part + 0x9e3779b9), 16777619) >>> 0;
  return (hash % 10000) / 10000;
}

const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const groupBy = (items, key) => {
  const groups = new Map();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
};

export function seedProduction({ app, admin, plan, structure, members, employees, today, signIn }) {
  const slug = plan.spec.slug;
  const lines = LINES[slug];
  if (lines === undefined) return;

  const me = app.identity.whoami(admin);
  const store = app.internals.store;
  const adminEmail = plan.spec.admin.email;
  const userOf = (email) => (email === adminEmail ? me.userId : members.get(email).userId);
  const contexts = new Map([[adminEmail, admin]]);
  const contextOf = (email) => {
    if (!contexts.has(email))
      contexts.set(email, app.identity.enterTenant(signIn(email), { slug }));
    return contexts.get(email);
  };
  const as = (email, work) =>
    store.session({ tenantId: me.tenantId, actorId: userOf(email) }).transaction(work);

  const calendars = Object.fromEntries(plan.factories.map((f) => [f.code, f.calendar]));
  const works = (factory, date) => {
    const calendar = calendars[factory];
    const exception = (calendar.exceptions ?? []).find((row) => row.date === date);
    if (exception !== undefined) return exception.working !== false;
    return !calendar.nonWorkingWeekdays.includes(weekday(date));
  };

  // Supervisors report from the first day of the history: the earlier days need someone of record
  // (D42). The services do not allow a start in the past, so the dates are moved here.
  as(adminEmail, (tx) => {
    for (const row of tx.list("supervisorAssignments", (r) => r.effectiveFrom === today)) {
      tx.update("supervisorAssignments", row.id, { effectiveFrom: addDays(today, -HISTORY_DAYS) });
    }
  });

  const styles = new Map(
    STYLES[slug].map((style) => [style.code, app.production.createStyle(admin, style)])
  );

  const specs = lines.map((line, index) => {
    const style = styles.get(line.style);
    const values = planValues(line, style, line.order);
    return {
      ...line,
      index,
      style,
      values,
      factoryRow: structure.factories.get(line.factory),
      sectionRow: structure.sections.get(`${line.factory}/${line.section}`),
      lineRow: structure.lines.get(`${line.factory}/${line.section}/${line.line}`),
      shiftRow: structure.shifts.get(`${line.factory}/${line.shift}`),
      sectionShift: structure.sectionShifts.get(`${line.factory}/${line.section}/${line.shift}`),
      supervisorRow: employees.get(line.supervisor),
    };
  });

  // ---- Earlier days, prepared ------------------------------------------------------------------
  const prepared = [];
  for (const spec of specs) {
    const back = [];
    for (let n = HISTORY_DAYS; n >= 1; n -= 1) {
      if (works(spec.factory, addDays(today, -n))) back.push(n);
    }
    for (const n of back) {
      const date = addDays(today, -n);
      const rnd = (purpose) => mix(spec.index + 1, n, purpose);
      const revisions = [{ revision: 1, ...spec.values, reason: null }];
      if (rnd(1) < 0.1) {
        revisions.push({
          revision: 2,
          ...spec.values,
          hourlyTarget: Math.round(spec.values.hourlyTarget * 0.9),
          reason: "Target lowered after a late fabric delivery",
        });
      }
      const effective = revisions[revisions.length - 1];
      const events = [];
      if (rnd(2) > 0.78) {
        events.push({
          code: EVENT_CODES[Math.floor(rnd(3) * EVENT_CODES.length)],
          minutes: 15 + Math.floor(rnd(4) * 46),
          ordinalHour: 2 + Math.floor(rnd(5) * (spec.hours - 2)),
          note: null,
        });
      }
      const hours = Array.from({ length: spec.hours }, (_, i) => {
        const ordinalHour = i + 1;
        const lost = events
          .filter((e) => e.ordinalHour === ordinalHour)
          .reduce((s, e) => s + e.minutes, 0);
        const rate =
          spec.performance * (ordinalHour === 1 ? 0.82 : 1) * (0.88 + 0.24 * rnd(10 + ordinalHour));
        const actualPieces = Math.max(
          0,
          Math.round(effective.hourlyTarget * rate * (1 - lost / 60))
        );
        const damagePieces = Math.round(actualPieces * 0.06 * rnd(30 + ordinalHour));
        return { ordinalHour, actualPieces, damagePieces };
      });
      const latest = n === back[back.length - 1];
      const status = latest ? LATEST[spec.index % LATEST.length] : "approved";
      prepared.push({
        spec,
        n,
        date,
        revisions,
        effective,
        events,
        hours,
        status,
        day: {
          presentMCOperators: Math.round(spec.operators * (0.9 + 0.14 * rnd(6))),
          presentHelpers: spec.helpers,
          presentManual: spec.manual,
          qcoHitRate: Math.round(72 + 26 * rnd(7)),
          notes: rnd(8) > 0.9 ? "Short of operators after the bus delay" : null,
        },
      });
    }
  }

  // Pass 1: the planners publish the plans of those days.
  for (const [email, group] of groupBy(prepared, (d) => d.spec.approver)) {
    as(email, (tx) => {
      for (const entry of group) {
        const { spec } = entry;
        entry.planIds = entry.revisions.map(
          (revision) =>
            tx.insert("productionPlans", {
              lineId: spec.lineRow.id,
              shiftId: spec.shiftRow.id,
              date: entry.date,
              revision: revision.revision,
              styleId: spec.style.id,
              orderRef: revision.orderRef,
              hourlyTarget: revision.hourlyTarget,
              workingHours: revision.workingHours,
              plannedEfficiency: revision.plannedEfficiency,
              plannedMCOperators: revision.plannedMCOperators,
              plannedManual: revision.plannedManual,
              factoryId: spec.factoryRow.id,
              sectionId: spec.sectionRow.id,
              sectionShiftId: spec.sectionShift.id,
              reason: revision.reason,
              publishedBy: userOf(email),
              publishedAt: `${addDays(entry.date, -1)}T09:00:00.000Z`,
            }).id
        );
      }
    });
  }

  // Pass 2: the reporters key in the output and submit it.
  for (const [email, group] of groupBy(prepared, (d) => d.spec.reporter)) {
    as(email, (tx) => {
      for (const entry of group) {
        const { spec, effective } = entry;
        const day = tx.insert("productionDays", {
          lineId: spec.lineRow.id,
          shiftId: spec.shiftRow.id,
          date: entry.date,
          factoryId: spec.factoryRow.id,
          sectionId: spec.sectionRow.id,
          sectionShiftId: spec.sectionShift.id,
          planId: entry.planIds[entry.planIds.length - 1],
          planRevision: effective.revision,
          styleId: spec.style.id,
          smv: spec.style.smv,
          orderRef: effective.orderRef,
          hourlyTarget: effective.hourlyTarget,
          workingHours: effective.workingHours,
          plannedEfficiency: effective.plannedEfficiency,
          plannedMCOperators: effective.plannedMCOperators,
          plannedManual: effective.plannedManual,
          ...entry.day,
          status: "pending_approval",
          supervisorEmployeeId: spec.supervisorRow.id,
          returnReason: null,
          submittedBy: userOf(email),
          submittedAt: `${entry.date}T12:00:00.000Z`,
        });
        entry.dayId = day.id;
        for (const hour of entry.hours) {
          tx.insert("hourlyOutputs", { productionDayId: day.id, ...hour });
        }
        for (const event of entry.events) {
          tx.insert("productionEvents", { productionDayId: day.id, ...event });
        }
        tx.record({
          action: "production_submitted",
          entityType: "productionDays",
          entityId: day.id,
          changes: { status: { before: "draft", after: "pending_approval" } },
        });
      }
    });
  }

  // Pass 3: the approvers approve most days and give one back.
  for (const [email, group] of groupBy(prepared, (d) => d.spec.approver)) {
    as(email, (tx) => {
      for (const entry of group) {
        if (entry.status === "pending_approval") continue;
        if (entry.status === "approved") {
          tx.update("productionDays", entry.dayId, {
            status: "approved",
            approvedBy: userOf(email),
            approvedAt: `${addDays(entry.date, 1)}T04:00:00.000Z`,
          });
          tx.record({
            action: "production_approved",
            entityType: "productionDays",
            entityId: entry.dayId,
            changes: { status: { before: "pending_approval", after: "approved" } },
          });
        } else {
          tx.update("productionDays", entry.dayId, {
            status: "draft",
            returnReason: RETURN_REASON,
          });
          tx.record({
            action: "production_returned",
            entityType: "productionDays",
            entityId: entry.dayId,
            changes: {
              status: { before: "pending_approval", after: "draft" },
              reason: { before: null, after: RETURN_REASON },
            },
          });
        }
      }
    });
  }

  // One approved day is corrected afterwards by the administrator (D40).
  const corrected = prepared.find((e) => e.status === "approved" && e.n >= 3 && e.spec.index === 1);
  if (corrected !== undefined) {
    const third = corrected.hours[2];
    app.production.correct(admin, corrected.dayId, {
      reason: "The tally sheet showed 6 more pieces in hour 3 than keyed in",
      hours: [{ ordinalHour: 3, actualPieces: third.actualPieces + 6 }],
    });
  }

  // ---- Today and the days ahead, through the services -------------------------------------------
  for (const spec of specs) {
    const planner = contextOf(spec.approver);
    for (let ahead = 0; ahead <= 3; ahead += 1) {
      const date = addDays(today, ahead);
      if (!works(spec.factory, date)) continue;
      const changed = spec.then !== undefined && ahead >= spec.then.afterDays;
      const style = changed ? styles.get(spec.then.style) : spec.style;
      const values = planValues(spec, style, changed ? spec.then.order : spec.order);
      const request = {
        lineId: spec.lineRow.id,
        shiftId: spec.shiftRow.id,
        date,
        styleId: style.id,
        ...values,
      };
      app.production.publishPlan(planner, request);
      if (ahead === 0 && spec.reviseToday === true) {
        app.production.publishPlan(planner, {
          ...request,
          hourlyTarget: Math.round(values.hourlyTarget * 0.92),
          reason: "Hourly target lowered after a late fabric delivery",
        });
      }
    }

    if (spec.today === undefined || !works(spec.factory, today)) continue;
    const reporter = contextOf(spec.reporter);
    const day = app.production.openDay(reporter, {
      lineId: spec.lineRow.id,
      shiftId: spec.shiftRow.id,
      date: today,
    });
    const rnd = (purpose) => mix(spec.index + 1, 0, purpose);
    app.production.saveDay(reporter, day.id, {
      presentMCOperators: Math.round(spec.operators * (0.92 + 0.1 * rnd(6))),
      presentHelpers: spec.helpers,
      presentManual: spec.manual,
      ...(spec.today.hours >= spec.hours ? { qcoHitRate: Math.round(80 + 15 * rnd(7)) } : {}),
      hours: Array.from({ length: spec.today.hours }, (_, i) => {
        const ordinalHour = i + 1;
        const rate =
          spec.performance * (ordinalHour === 1 ? 0.82 : 1) * (0.9 + 0.2 * rnd(10 + ordinalHour));
        const actualPieces = Math.round(day.hourlyTarget * rate);
        return {
          ordinalHour,
          actualPieces,
          damagePieces: Math.round(actualPieces * 0.04 * rnd(30 + ordinalHour)),
        };
      }),
    });
  }
}

// The target is what the planned manpower earns at the planned efficiency (SRS 10.1):
// pieces per hour = efficiency x manpower x 60 / SMV.
function planValues(line, style, orderRef) {
  return {
    orderRef,
    hourlyTarget: Math.round(
      ((line.efficiency / 100) * (line.operators + line.manual) * 60) / style.smv
    ),
    workingHours: line.hours,
    plannedEfficiency: line.efficiency,
    plannedMCOperators: line.operators,
    plannedManual: line.manual,
  };
}
