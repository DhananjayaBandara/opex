// The scorecard part of the demo world (D43 to D52): a score configuration, an assignment conflict, a
// long stop, and two sets of snapshots.
//
// The configuration, the conflict and the stop belong to days that have already happened, which the
// services do not allow to be created, so they are written straight to the store as the
// administrator. The snapshots are taken through the service, as a manager would do it. Kept small:
// LocalStorage holds about 5 MB and the production seed already uses a third of it.
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";

// Felix tightens the weights once; Orbit keeps the Felix defaults, so both states can be shown.
const CONFIGS = {
  felix: {
    startedDaysAgo: 60,
    weights: { efficiency: 45, defect: 20, firstHour: 15, qco: 10, attendance: 10 },
    windowDays: 90,
    reason: "Efficiency weighted higher after the third-quarter review",
  },
};

// One supervisor covers another's section for a few days, so those days belong to nobody (D44).
const CONFLICTS = {
  felix: {
    employee: "E-1002",
    factory: "KAT",
    section: "FIN",
    shift: "DAY",
    fromDaysAgo: 5,
    toDaysAgo: 3,
    note: "Covered finishing while the regular supervisor attended a training day",
  },
};

// Two long stops, so the exceptions page has downtime to show.
const STOPS = { felix: { count: 2, minutes: 75, ordinalHour: 3, code: "power_cut" } };

export function seedScorecards({ app, admin, slug, structure, today }) {
  const me = app.identity.whoami(admin);
  const store = app.internals.store;
  const session = store.session({ tenantId: me.tenantId, actorId: me.userId });

  const config = CONFIGS[slug];
  const conflict = CONFLICTS[slug];
  const stops = STOPS[slug];

  session.transaction((tx) => {
    if (config !== undefined) {
      tx.insert("scoreConfigVersions", {
        version: 1,
        weights: config.weights,
        windowDays: config.windowDays,
        reason: config.reason,
        savedBy: me.userId,
        effectiveFrom: addDays(today, -config.startedDaysAgo),
        effectiveTo: null,
      });
    }

    if (conflict !== undefined) {
      const sectionShift = structure.sectionShifts.get(
        `${conflict.factory}/${conflict.section}/${conflict.shift}`
      );
      const employee = tx.list("employees", (row) => row.employeeCode === conflict.employee)[0];
      if (sectionShift !== undefined && employee !== undefined) {
        tx.insert("supervisorAssignments", {
          employeeId: employee.id,
          sectionShiftId: sectionShift.id,
          factoryId: sectionShift.factoryId,
          effectiveFrom: addDays(today, -conflict.fromDaysAgo),
          effectiveTo: addDays(today, -conflict.toDaysAgo),
          note: conflict.note,
        });
      }
    }

    if (stops !== undefined) {
      const sewing = structure.sections.get("KAT/SEW");
      const days = tx
        .list(
          "productionDays",
          (row) => row.status === "approved" && row.sectionId === sewing?.id && row.date < today
        )
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      const step = Math.max(1, Math.floor(days.length / (stops.count + 1)));
      for (let i = 1; i <= stops.count && i * step < days.length; i += 1) {
        tx.insert("productionEvents", {
          productionDayId: days[i * step].id,
          code: stops.code,
          minutes: stops.minutes,
          ordinalHour: stops.ordinalHour,
          note: "Grid outage",
        });
      }
    }
  });

  // Two sets of snapshots, a week apart, taken the way a manager would (D52).
  app.scorecards.takeSnapshots(admin, { asOf: addDays(today, -7) });
  app.scorecards.takeSnapshots(admin, { asOf: addDays(today, -1) });
}
