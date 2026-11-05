// Production (UC-SUP-01..09, FR-PROD-001..010; decisions D34 to D42).
//
// Styles (a minimal master), published plans with revisions, the production day with its hourly
// output and events, the Daily Close, submit / approve / return, the privileged correction of an
// approved day, and the supervisor dashboard.
//
// Every call resolves the tenant and the caller's access from the context, never from the payload.
// Each call needs its permission (WHAT, which also needs the production module) and a scope that
// covers the line's factory and, for a member limited to their own assignments, the SectionShift of
// the line and shift (WHERE), failing closed. Each write runs in one transaction with its audit
// event. All metrics are computed here on every read and never accepted from the caller.
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";
import { validateDate } from "../domain/organization.js";
import {
  EVENT_CODES,
  PLAN_FIELDS,
  buildDayInputs,
  buildEvent,
  buildHour,
  buildPlan,
  buildStyle,
  changeStyle,
  closeCheck,
  computeDay,
  dayFigures,
  downtimeMinutes,
  pickPlan,
  requireEditable,
  requireReason,
  requireTransition,
} from "../domain/production.js";
import { fail } from "./errors.js";

const VIEW = "production.view";
const ENTER = "production.enter";
const SUBMIT = "production.submit";
const APPROVE = "production.approve";
const EDIT_APPROVED = "production.edit_approved";
const DASHBOARD = "dashboard.view";

const STYLES = "styles";
const PLANS = "productionPlans";
const DAYS = "productionDays";
const HOURS = "hourlyOutputs";
const EVENTS = "productionEvents";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = () => fail("forbidden", "you do not have access to that");

// The audit actions that tell the story of a day (D39); the store's own updates are not repeated.
const STORY = Object.freeze({
  create: "Opened",
  production_plan_adopted: "Adopted a later plan revision",
  production_submitted: "Submitted for approval",
  production_approved: "Approved",
  production_returned: "Returned",
  production_corrected: "Corrected after approval",
});

export function createProduction({ store, gate, clock, notifier }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  const allowed = (resolved, permission, resource) => {
    try {
      gate.authorize(resolved, permission, resource);
      return true;
    } catch {
      return false;
    }
  };

  // Planning is for people who are not limited to their own assignments (D35).
  const mayPlan = (resolved, resource) =>
    !resolved.access.assignmentScoped && allowed(resolved, ENTER, resource);
  // Approving is for people who are not limited to their own assignments (D39).
  const mayApprove = (resolved, resource) =>
    !resolved.access.assignmentScoped && allowed(resolved, APPROVE, resource);

  function nameOf(resolved) {
    const reader = store.platformSession({ actorId: resolved.user.id });
    const names = new Map();
    return (id) => {
      if (id === null || id === undefined) return null;
      if (!names.has(id)) names.set(id, reader.get("users", id)?.name ?? null);
      return names.get(id);
    };
  }

  // The line, shift and section-shift behind a call, authorized for one permission. A caller outside
  // the scope is refused before anything about the shift is revealed.
  function area(tx, resolved, permission, ids, { planning = false } = {}) {
    const line = typeof ids.lineId === "string" ? tx.get("lines", ids.lineId) : null;
    if (line === null) throw fail("not_found", "that line was not found");
    const shift = typeof ids.shiftId === "string" ? tx.get("shifts", ids.shiftId) : null;
    if (shift === null) throw fail("not_found", "that shift was not found");
    if (shift.factoryId !== line.factoryId) {
      throw fail("cross_factory", "that shift belongs to another factory");
    }
    const sectionShift = tx.list(
      "sectionShifts",
      (row) => row.sectionId === line.sectionId && row.shiftId === shift.id
    )[0];
    const resource = { factoryId: line.factoryId, sectionShiftId: sectionShift?.id };
    if (!allowed(resolved, permission, resource)) throw refuse();
    if (planning && resolved.access.assignmentScoped) throw refuse();
    if (sectionShift === undefined || sectionShift.active === false) {
      throw fail("shift_not_run", "that line's section does not run that shift");
    }
    return {
      line,
      shift,
      sectionShift,
      section: tx.get("sections", line.sectionId),
      factory: tx.get("factories", line.factoryId),
    };
  }

  function requireDay(tx, resolved, permission, id) {
    const day = typeof id === "string" ? tx.get(DAYS, id) : null;
    if (day === null) throw fail("not_found", "that production day was not found");
    if (
      !allowed(resolved, permission, {
        factoryId: day.factoryId,
        sectionShiftId: day.sectionShiftId,
      })
    ) {
      throw refuse();
    }
    return day;
  }

  const planKey = (row) => (candidate) =>
    candidate.lineId === row.lineId &&
    candidate.shiftId === row.shiftId &&
    candidate.date === row.date;

  // The latest revision of a plan for one line, shift and date.
  function currentPlan(tx, key) {
    const revisions = tx.list(PLANS, planKey(key));
    return revisions.reduce(
      (best, row) => (best === null || row.revision > best.revision ? row : best),
      null
    );
  }

  // Employees whose supervisor assignment covers the date (SRS 6.8).
  function supervisorsOn(tx, sectionShiftId, date) {
    const employees = new Map(tx.list("employees").map((row) => [row.id, row]));
    return tx
      .list(
        "supervisorAssignments",
        (row) =>
          row.sectionShiftId === sectionShiftId &&
          row.effectiveFrom <= date &&
          (row.effectiveTo === null || row.effectiveTo === undefined || row.effectiveTo >= date)
      )
      .map((row) => employees.get(row.employeeId))
      .filter((employee) => employee !== undefined)
      .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
  }

  function lookups(tx) {
    const by = (collection) => new Map(tx.list(collection).map((row) => [row.id, row]));
    return {
      factories: by("factories"),
      sections: by("sections"),
      lines: by("lines"),
      shifts: by("shifts"),
      styles: by(STYLES),
      employees: by("employees"),
    };
  }

  const hoursOf = (tx, dayId) =>
    tx
      .list(HOURS, (row) => row.productionDayId === dayId)
      .sort((a, b) => a.ordinalHour - b.ordinalHour);

  function compute(day, hours) {
    return computeDay({ day, plan: pickPlan(day), style: { smv: day.smv }, hours });
  }

  const planView = (row, lookup, byName) =>
    Object.freeze({
      id: row.id,
      lineId: row.lineId,
      lineName: lookup.lines.get(row.lineId)?.name ?? null,
      sectionName: lookup.sections.get(row.sectionId)?.name ?? null,
      shiftId: row.shiftId,
      shiftName: lookup.shifts.get(row.shiftId)?.name ?? null,
      factoryId: row.factoryId,
      factoryName: lookup.factories.get(row.factoryId)?.name ?? null,
      sectionShiftId: row.sectionShiftId,
      date: row.date,
      revision: row.revision,
      styleId: row.styleId,
      styleCode: lookup.styles.get(row.styleId)?.code ?? null,
      styleName: lookup.styles.get(row.styleId)?.name ?? null,
      smv: lookup.styles.get(row.styleId)?.smv ?? null,
      ...pickPlan(row),
      plannedPieces: row.hourlyTarget * row.workingHours,
      reason: row.reason ?? null,
      publishedBy: row.publishedBy,
      publishedByName: byName(row.publishedBy),
      publishedAt: row.publishedAt,
    });

  // The figures the lists and the dashboard show for one day.
  function brief(day, hours, events) {
    const { metrics } = compute(day, hours);
    return {
      hoursEntered: metrics.hoursRun,
      totalProduction: metrics.totalProduction,
      plannedPieces: metrics.plannedPieces,
      hourlyHitRate: metrics.hourlyHitRate,
      piecesHitRate: metrics.piecesHitRate,
      achievedEfficiency: metrics.achievedEfficiency,
      downtimeMinutes: downtimeMinutes(events),
    };
  }

  function capabilities(resolved, day) {
    const resource = { factoryId: day.factoryId, sectionShiftId: day.sectionShiftId };
    const draft = day.status === "draft";
    const pending = day.status === "pending_approval";
    return Object.freeze({
      edit: draft && allowed(resolved, ENTER, resource),
      submit: draft && allowed(resolved, SUBMIT, resource),
      approve: pending && mayApprove(resolved, resource) && day.submittedBy !== resolved.user.id,
      return: pending && mayApprove(resolved, resource),
      correct: day.status === "approved" && allowed(resolved, EDIT_APPROVED, resource),
    });
  }

  function dayView(tx, resolved, day, lookup, byName) {
    const hours = hoursOf(tx, day.id);
    const events = tx
      .list(EVENTS, (row) => row.productionDayId === day.id)
      .sort((a, b) => (a.ordinalHour ?? 0) - (b.ordinalHour ?? 0) || a.id.localeCompare(b.id));
    const { metrics, hours: rows } = compute(day, hours);
    const latest = currentPlan(tx, day);
    const supervisors = supervisorsOn(tx, day.sectionShiftId, day.date);
    const can = capabilities(resolved, day);
    return Object.freeze({
      id: day.id,
      date: day.date,
      status: day.status,
      lineId: day.lineId,
      lineName: lookup.lines.get(day.lineId)?.name ?? null,
      sectionName: lookup.sections.get(day.sectionId)?.name ?? null,
      shiftId: day.shiftId,
      shiftName: lookup.shifts.get(day.shiftId)?.name ?? null,
      factoryId: day.factoryId,
      factoryName: lookup.factories.get(day.factoryId)?.name ?? null,
      sectionShiftId: day.sectionShiftId,
      supervisorEmployeeId: day.supervisorEmployeeId ?? null,
      supervisorName: lookup.employees.get(day.supervisorEmployeeId)?.name ?? null,
      currentSupervisors: Object.freeze(supervisors.map((employee) => employee.name)),
      planRevision: day.planRevision,
      newerRevision:
        latest !== null && latest.revision > day.planRevision && day.status === "draft"
          ? latest.revision
          : null,
      styleId: day.styleId,
      styleCode: lookup.styles.get(day.styleId)?.code ?? null,
      styleName: lookup.styles.get(day.styleId)?.name ?? null,
      smv: day.smv,
      ...pickPlan(day),
      presentMCOperators: day.presentMCOperators ?? null,
      presentHelpers: day.presentHelpers ?? null,
      presentManual: day.presentManual ?? null,
      qcoHitRate: day.qcoHitRate ?? null,
      notes: day.notes ?? null,
      returnReason: day.returnReason ?? null,
      submittedByName: byName(day.submittedBy),
      submittedAt: day.submittedAt ?? null,
      approvedByName: byName(day.approvedBy),
      approvedAt: day.approvedAt ?? null,
      hours: Object.freeze(rows.map(Object.freeze)),
      events: Object.freeze(
        events.map((event) =>
          Object.freeze({
            id: event.id,
            code: event.code,
            label: EVENT_CODES[event.code] ?? event.code,
            minutes: event.minutes,
            ordinalHour: event.ordinalHour ?? null,
            note: event.note ?? null,
          })
        )
      ),
      downtimeMinutes: downtimeMinutes(events),
      metrics: Object.freeze(metrics),
      close: closeCheck(day, hours, day),
      history: Object.freeze(
        tx
          .auditLog({ entityType: DAYS, entityId: day.id })
          .filter((event) => Object.hasOwn(STORY, event.action))
          .map((event) =>
            Object.freeze({
              action: event.action,
              label: STORY[event.action],
              at: event.timestamp,
              byName: byName(event.actorId),
              reason: event.changes?.reason?.after ?? null,
            })
          )
      ),
      can,
    });
  }

  // The day behind a call, as a view.
  const viewOf = (tx, resolved, id) =>
    dayView(tx, resolved, tx.get(DAYS, id), lookups(tx), nameOf(resolved));

  function patchHours(tx, day, input) {
    if (input.hours === undefined) return;
    if (!Array.isArray(input.hours)) throw fail("invalid_hours", "hours must be a list");
    const rows = hoursOf(tx, day.id);
    for (const patch of input.hours) {
      if (!isObject(patch)) throw fail("invalid_hours", "each hour must be an object");
      const row = rows.find((candidate) => candidate.ordinalHour === Number(patch.ordinalHour));
      if (row === undefined)
        throw fail("invalid_hour", `hour ${String(patch.ordinalHour)} does not exist`);
      tx.update(HOURS, row.id, buildHour(row, patch, day.workingHours));
    }
  }

  const todayCheck = (resolved, date) => {
    if (date > resolved.today) {
      throw fail(
        "future_date",
        `output cannot be reported for a future day (today is ${resolved.today})`
      );
    }
  };

  return Object.freeze({
    // ---- Styles (D34) -------------------------------------------------------------------------

    styles(context) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      return Object.freeze(
        session
          .list(STYLES)
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((row) =>
            Object.freeze({
              id: row.id,
              code: row.code,
              name: row.name,
              buyer: row.buyer ?? null,
              smv: row.smv,
              plans: session.list(PLANS, (plan) => plan.styleId === row.id).length,
            })
          )
      );
    },

    createStyle(context, input) {
      const resolved = gate.requireTenant(context, ENTER);
      gate.authorizeTenantWide(resolved, ENTER);
      const values = buildStyle(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => Object.freeze(tx.insert(STYLES, values)));
    },

    updateStyle(context, id, patch) {
      const resolved = gate.requireTenant(context, ENTER);
      gate.authorizeTenantWide(resolved, ENTER);
      const values = changeStyle(isObject(patch) ? patch : {});
      return sessionFor(resolved).transaction((tx) => {
        const row = typeof id === "string" ? tx.get(STYLES, id) : null;
        if (row === null) throw fail("not_found", "that style was not found");
        // A style linked to a buyer shows that buyer's name; change it from the orders screens (D73).
        if (row.buyerId && values.buyer !== undefined && values.buyer !== row.buyer) {
          throw fail(
            "buyer_linked",
            "this style is linked to a buyer; change the buyer under Orders"
          );
        }
        return Object.freeze(tx.update(STYLES, id, values));
      });
    },

    // ---- Where the caller can work -------------------------------------------------------------

    // Section-shifts with their lines that the caller may use for one permission (`view` or `enter`):
    // the choosers of the plan and day screens.
    workAreas(context, input) {
      const permission = input?.for === "enter" ? ENTER : VIEW;
      const resolved = gate.requireTenant(context, permission);
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const areas = [];
      for (const sectionShift of session.list("sectionShifts", (row) => row.active !== false)) {
        const resource = { factoryId: sectionShift.factoryId, sectionShiftId: sectionShift.id };
        if (!allowed(resolved, permission, resource)) continue;
        const lines = session
          .list("lines", (row) => row.sectionId === sectionShift.sectionId && row.active !== false)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (lines.length === 0) continue;
        areas.push(
          Object.freeze({
            sectionShiftId: sectionShift.id,
            factoryId: sectionShift.factoryId,
            factoryName: lookup.factories.get(sectionShift.factoryId)?.name ?? null,
            sectionName: lookup.sections.get(sectionShift.sectionId)?.name ?? null,
            shiftId: sectionShift.shiftId,
            shiftName: lookup.shifts.get(sectionShift.shiftId)?.name ?? null,
            lines: Object.freeze(
              lines.map((line) => Object.freeze({ id: line.id, name: line.name }))
            ),
          })
        );
      }
      areas.sort((a, b) =>
        `${a.factoryName}/${a.sectionName}/${a.shiftName}`.localeCompare(
          `${b.factoryName}/${b.sectionName}/${b.shiftName}`
        )
      );
      return Object.freeze(areas);
    },

    // ---- Plans (D35) --------------------------------------------------------------------------

    // Adds revision 1, or the next revision with a reason, for a line, shift and date.
    publishPlan(context, input) {
      const resolved = gate.requireTenant(context, ENTER);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const where = area(tx, resolved, ENTER, request, { planning: true });
        const date = validateDate(request.date);
        if (date < resolved.today) {
          throw fail("past_date", `a plan is for today (${resolved.today}) or a later day`);
        }
        const style = typeof request.styleId === "string" ? tx.get(STYLES, request.styleId) : null;
        if (style === null) throw fail("not_found", "choose a style from the style master");
        const values = buildPlan(request);
        const key = { lineId: where.line.id, shiftId: where.shift.id, date };
        const latest = currentPlan(tx, key);
        const revision = latest === null ? 1 : latest.revision + 1;
        let reason = null;
        if (latest !== null) {
          reason = requireReason(request.reason, "a reason for the new revision");
          const same =
            latest.styleId === style.id && PLAN_FIELDS.every((f) => latest[f] === values[f]);
          if (same) throw fail("no_change", "nothing differs from the current revision");
        }
        const row = tx.insert(PLANS, {
          ...key,
          revision,
          styleId: style.id,
          ...values,
          factoryId: where.line.factoryId,
          sectionId: where.line.sectionId,
          sectionShiftId: where.sectionShift.id,
          reason,
          publishedBy: resolved.user.id,
          publishedAt: clock(),
        });
        tx.record({
          action: "production_plan_published",
          entityType: PLANS,
          entityId: row.id,
          changes: { revision: { before: latest?.revision ?? null, after: revision } },
        });
        return planView(row, lookups(tx), nameOf(resolved));
      });
    },

    // The latest revision of each plan in scope, newest date first. `revisions` counts the history.
    plans(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const { factoryId, lineId, from, to } = isObject(filter) ? filter : {};
      const first = from === undefined ? undefined : validateDate(from);
      const last = to === undefined ? undefined : validateDate(to);
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const byName = nameOf(resolved);
      const days = new Map(
        session.list(DAYS).map((day) => [`${day.lineId}/${day.shiftId}/${day.date}`, day])
      );
      const all = session.list(PLANS, (row) => {
        if (factoryId !== undefined && row.factoryId !== factoryId) return false;
        if (lineId !== undefined && row.lineId !== lineId) return false;
        if (first !== undefined && row.date < first) return false;
        if (last !== undefined && row.date > last) return false;
        return allowed(resolved, VIEW, {
          factoryId: row.factoryId,
          sectionShiftId: row.sectionShiftId,
        });
      });
      const latest = new Map();
      for (const row of all) {
        const key = `${row.lineId}/${row.shiftId}/${row.date}`;
        const seen = latest.get(key);
        if (seen === undefined || row.revision > seen.row.revision) {
          latest.set(key, { row, revisions: (seen?.revisions ?? 0) + 1 });
        } else seen.revisions += 1;
      }
      return Object.freeze(
        [...latest.entries()]
          .map(([key, { row, revisions }]) => {
            const day = days.get(key);
            return Object.freeze({
              ...planView(row, lookup, byName),
              revisions,
              dayId: day?.id ?? null,
              dayStatus: day?.status ?? null,
            });
          })
          .sort(
            (a, b) =>
              b.date.localeCompare(a.date) ||
              a.factoryName.localeCompare(b.factoryName) ||
              a.lineName.localeCompare(b.lineName)
          )
      );
    },

    // Every revision of one plan, oldest first.
    planHistory(context, input) {
      const resolved = gate.requireTenant(context, VIEW);
      const request = isObject(input) ? input : {};
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const byName = nameOf(resolved);
      const rows = session
        .list(PLANS, planKey(request))
        .filter((row) =>
          allowed(resolved, VIEW, { factoryId: row.factoryId, sectionShiftId: row.sectionShiftId })
        )
        .sort((a, b) => a.revision - b.revision);
      if (rows.length === 0) throw fail("not_found", "that plan was not found");
      return Object.freeze(rows.map((row) => planView(row, lookup, byName)));
    },

    // ---- The production day (D36 to D40) ------------------------------------------------------

    // Opens the day of a line and shift from the plan published for it.
    openDay(context, input) {
      const resolved = gate.requireTenant(context, ENTER);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const where = area(tx, resolved, ENTER, request);
        const date = validateDate(request.date);
        todayCheck(resolved, date);
        if (where.line.active === false) throw fail("inactive_line", "that line is not active");
        const key = { lineId: where.line.id, shiftId: where.shift.id, date };
        const plan = currentPlan(tx, key);
        if (plan === null) {
          throw fail("no_plan", "no plan is published for that line, shift and date");
        }
        if (tx.list(DAYS, planKey(key)).length > 0) {
          throw fail("already_open", "that day is already open");
        }
        const style = tx.get(STYLES, plan.styleId);
        const supervisors = supervisorsOn(tx, where.sectionShift.id, date);
        const day = tx.insert(DAYS, {
          ...key,
          factoryId: where.line.factoryId,
          sectionId: where.line.sectionId,
          sectionShiftId: where.sectionShift.id,
          planId: plan.id,
          planRevision: plan.revision,
          styleId: style.id,
          smv: style.smv,
          ...pickPlan(plan),
          presentMCOperators: null,
          presentHelpers: null,
          presentManual: null,
          qcoHitRate: null,
          notes: null,
          status: "draft",
          supervisorEmployeeId: supervisors[0]?.id ?? null,
          returnReason: null,
        });
        for (let ordinalHour = 1; ordinalHour <= plan.workingHours; ordinalHour += 1) {
          tx.insert(HOURS, {
            productionDayId: day.id,
            ordinalHour,
            actualPieces: null,
            damagePieces: null,
          });
        }
        return viewOf(tx, resolved, day.id);
      });
    },

    day(context, id) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const day = typeof id === "string" ? session.get(DAYS, id) : null;
      if (day === null) throw fail("not_found", "that production day was not found");
      if (
        !allowed(resolved, VIEW, { factoryId: day.factoryId, sectionShiftId: day.sectionShiftId })
      ) {
        throw refuse();
      }
      return dayView(session, resolved, day, lookups(session), nameOf(resolved));
    },

    // Days in scope, newest first. Filters: factoryId, lineId, shiftId, status, date, from, to.
    days(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const request = isObject(filter) ? filter : {};
      const dates = ["date", "from", "to"].map((name) =>
        request[name] === undefined ? undefined : validateDate(request[name])
      );
      const [date, from, to] = dates;
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const byName = nameOf(resolved);
      const rows = session
        .list(DAYS, (day) => {
          if (request.factoryId !== undefined && day.factoryId !== request.factoryId) return false;
          if (request.lineId !== undefined && day.lineId !== request.lineId) return false;
          if (request.shiftId !== undefined && day.shiftId !== request.shiftId) return false;
          if (request.status !== undefined && day.status !== request.status) return false;
          if (date !== undefined && day.date !== date) return false;
          if (from !== undefined && day.date < from) return false;
          if (to !== undefined && day.date > to) return false;
          return allowed(resolved, VIEW, {
            factoryId: day.factoryId,
            sectionShiftId: day.sectionShiftId,
          });
        })
        .map((day) => {
          const hours = hoursOf(session, day.id);
          const events = session.list(EVENTS, (row) => row.productionDayId === day.id);
          return Object.freeze({
            id: day.id,
            date: day.date,
            status: day.status,
            factoryId: day.factoryId,
            factoryName: lookup.factories.get(day.factoryId)?.name ?? null,
            sectionName: lookup.sections.get(day.sectionId)?.name ?? null,
            lineId: day.lineId,
            lineName: lookup.lines.get(day.lineId)?.name ?? null,
            shiftName: lookup.shifts.get(day.shiftId)?.name ?? null,
            supervisorName: lookup.employees.get(day.supervisorEmployeeId)?.name ?? null,
            styleCode: lookup.styles.get(day.styleId)?.code ?? null,
            workingHours: day.workingHours,
            submittedByName: byName(day.submittedBy),
            submittedAt: day.submittedAt ?? null,
            returnReason: day.returnReason ?? null,
            ...brief(day, hours, events),
          });
        });
      rows.sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          a.factoryName.localeCompare(b.factoryName) ||
          a.lineName.localeCompare(b.lineName)
      );
      return Object.freeze(rows);
    },

    // Output, present manpower, QCO and notes of a draft day, in one atomic save.
    saveDay(context, id, input) {
      const resolved = gate.requireTenant(context, ENTER);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const day = requireDay(tx, resolved, ENTER, id);
        requireEditable(day.status);
        const values = buildDayInputs(request);
        patchHours(tx, day, request);
        if (Object.keys(values).length > 0) tx.update(DAYS, day.id, values);
        return viewOf(tx, resolved, day.id);
      });
    },

    addEvent(context, id, input) {
      const resolved = gate.requireTenant(context, ENTER);
      return sessionFor(resolved).transaction((tx) => {
        const day = requireDay(tx, resolved, ENTER, id);
        requireEditable(day.status);
        const values = buildEvent(isObject(input) ? input : {}, day);
        const used = downtimeMinutes(tx.list(EVENTS, (row) => row.productionDayId === day.id));
        if (used + values.minutes > day.workingHours * 60) {
          throw fail(
            "downtime_exceeds_day",
            `events cannot add up to more than the ${day.workingHours * 60} working minutes (${used} used)`
          );
        }
        tx.insert(EVENTS, { productionDayId: day.id, ...values });
        return viewOf(tx, resolved, day.id);
      });
    },

    removeEvent(context, id, eventId) {
      const resolved = gate.requireTenant(context, ENTER);
      return sessionFor(resolved).transaction((tx) => {
        const day = requireDay(tx, resolved, ENTER, id);
        requireEditable(day.status);
        const event = typeof eventId === "string" ? tx.get(EVENTS, eventId) : null;
        if (event === null || event.productionDayId !== day.id) {
          throw fail("not_found", "that event was not found");
        }
        tx.remove(EVENTS, event.id);
        return viewOf(tx, resolved, day.id);
      });
    },

    // A draft day takes over the latest plan revision (D36). Hours that already hold output stay.
    adoptPlan(context, id) {
      const resolved = gate.requireTenant(context, ENTER);
      return sessionFor(resolved).transaction((tx) => {
        const day = requireDay(tx, resolved, ENTER, id);
        requireEditable(day.status);
        const plan = currentPlan(tx, day);
        if (plan === null || plan.revision <= day.planRevision) {
          throw fail("no_change", "this day already uses the latest plan revision");
        }
        const style = tx.get(STYLES, plan.styleId);
        const hours = hoursOf(tx, day.id);
        const events = tx.list(EVENTS, (row) => row.productionDayId === day.id);
        for (const hour of hours.filter((row) => row.ordinalHour > plan.workingHours)) {
          if (hour.actualPieces !== null) {
            throw fail("hours_in_use", `hour ${hour.ordinalHour} already has output`);
          }
        }
        if (events.some((event) => (event.ordinalHour ?? 0) > plan.workingHours)) {
          throw fail("hours_in_use", "an event is tied to an hour the new revision does not have");
        }
        for (const hour of hours.filter((row) => row.ordinalHour > plan.workingHours)) {
          tx.remove(HOURS, hour.id);
        }
        for (let hour = hours.length + 1; hour <= plan.workingHours; hour += 1) {
          tx.insert(HOURS, {
            productionDayId: day.id,
            ordinalHour: hour,
            actualPieces: null,
            damagePieces: null,
          });
        }
        if (downtimeMinutes(events) > plan.workingHours * 60) {
          throw fail("hours_in_use", "the events add up to more than the new working minutes");
        }
        tx.update(DAYS, day.id, {
          planId: plan.id,
          planRevision: plan.revision,
          styleId: style.id,
          smv: style.smv,
          ...pickPlan(plan),
        });
        tx.record({
          action: "production_plan_adopted",
          entityType: DAYS,
          entityId: day.id,
          changes: { planRevision: { before: day.planRevision, after: plan.revision } },
        });
        return viewOf(tx, resolved, day.id);
      });
    },

    // Daily Close (D39): the check, then the submit.
    submit(context, id, input) {
      const resolved = gate.requireTenant(context, SUBMIT);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const day = requireDay(tx, resolved, SUBMIT, id);
        const to = requireTransition("submit", day.status);
        const check = closeCheck(day, hoursOf(tx, day.id), day);
        if (!check.ready) throw fail("close_blocked", check.blockers.join(" "));
        if (check.warnings.length > 0 && request.confirmGaps !== true) {
          throw fail(
            "confirmation_required",
            `${check.warnings.join(" ")} Confirm to submit anyway.`
          );
        }
        tx.update(DAYS, day.id, {
          status: to,
          submittedBy: resolved.user.id,
          submittedAt: clock(),
          returnReason: null,
        });
        tx.record({
          action: "production_submitted",
          entityType: DAYS,
          entityId: day.id,
          changes: { status: { before: day.status, after: to } },
        });
        notifier.productionDay(tx, {
          tenantId: resolved.tenant.id,
          actorId: resolved.user.id,
          event: "submitted",
          day,
        });
        return viewOf(tx, resolved, day.id);
      });
    },

    approve(context, id) {
      const resolved = gate.requireTenant(context, APPROVE);
      return sessionFor(resolved).transaction((tx) => {
        const day = requireDay(tx, resolved, APPROVE, id);
        if (resolved.access.assignmentScoped) throw refuse();
        const to = requireTransition("approve", day.status);
        if (day.submittedBy === resolved.user.id) {
          throw fail("self_approval", "someone other than the submitter must approve this day");
        }
        tx.update(DAYS, day.id, { status: to, approvedBy: resolved.user.id, approvedAt: clock() });
        tx.record({
          action: "production_approved",
          entityType: DAYS,
          entityId: day.id,
          changes: { status: { before: day.status, after: to } },
        });
        notifier.productionDay(tx, {
          tenantId: resolved.tenant.id,
          actorId: resolved.user.id,
          event: "approved",
          day,
        });
        return viewOf(tx, resolved, day.id);
      });
    },

    // Gives a pending day back to the supervisor as a draft, with the reason.
    returnDay(context, id, input) {
      const resolved = gate.requireTenant(context, APPROVE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const day = requireDay(tx, resolved, APPROVE, id);
        if (resolved.access.assignmentScoped) throw refuse();
        const to = requireTransition("return", day.status);
        const reason = requireReason(request.reason, "a reason for returning the day");
        tx.update(DAYS, day.id, { status: to, returnReason: reason, approvedBy: null });
        tx.record({
          action: "production_returned",
          entityType: DAYS,
          entityId: day.id,
          changes: {
            status: { before: day.status, after: to },
            reason: { before: null, after: reason },
          },
        });
        notifier.productionDay(tx, {
          tenantId: resolved.tenant.id,
          actorId: resolved.user.id,
          event: "returned",
          day,
          reason,
        });
        return viewOf(tx, resolved, day.id);
      });
    },

    // The privileged correction of an approved day (D40); the day stays approved.
    correct(context, id, input) {
      const resolved = gate.requireTenant(context, EDIT_APPROVED);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const day = requireDay(tx, resolved, EDIT_APPROVED, id);
        if (day.status !== "approved") {
          throw fail("not_approved", "only an approved day is corrected; edit other days directly");
        }
        const reason = requireReason(request.reason, "a reason for the correction");
        const before = dayFigures(day, hoursOf(tx, day.id));
        const { notes: ignored, ...values } = buildDayInputs(request);
        void ignored;
        patchHours(tx, day, request);
        if (Object.keys(values).length > 0) tx.update(DAYS, day.id, values);
        const after = dayFigures(tx.get(DAYS, day.id), hoursOf(tx, day.id));
        if (JSON.stringify(before) === JSON.stringify(after)) {
          throw fail("no_change", "nothing was changed");
        }
        tx.record({
          action: "production_corrected",
          entityType: DAYS,
          entityId: day.id,
          changes: { reason: { before: null, after: reason }, figures: { before, after } },
        });
        return viewOf(tx, resolved, day.id);
      });
    },

    // ---- Supervisor dashboard (D41) -----------------------------------------------------------

    // Per section-shift in scope, its lines for one date with the plan, the day and what to do next.
    dashboard(context, input) {
      const resolved = gate.requireTenant(context, DASHBOARD);
      if (!resolved.permissions.includes(VIEW)) throw refuse();
      const date = input?.date === undefined ? resolved.today : validateDate(input.date);
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const days = session.list(DAYS, (row) => row.date === date);
      const plans = session.list(PLANS, (row) => row.date === date);
      const cards = [];
      const totals = { lines: 0, planned: 0, open: 0, draft: 0, pending_approval: 0, approved: 0 };
      const sectionShifts = session
        .list("sectionShifts", (row) => row.active !== false)
        .filter((row) =>
          allowed(resolved, VIEW, { factoryId: row.factoryId, sectionShiftId: row.id })
        );
      for (const sectionShift of sectionShifts) {
        const lines = session
          .list("lines", (row) => row.sectionId === sectionShift.sectionId && row.active !== false)
          .sort((a, b) => a.name.localeCompare(b.name));
        const resource = { factoryId: sectionShift.factoryId, sectionShiftId: sectionShift.id };
        const mayOpen = allowed(resolved, ENTER, resource);
        const entries = lines.map((line) => {
          const key = { lineId: line.id, shiftId: sectionShift.shiftId, date };
          const plan = plans
            .filter(planKey(key))
            .reduce(
              (best, row) => (best === null || row.revision > best.revision ? row : best),
              null
            );
          const day = days.find(planKey(key)) ?? null;
          totals.lines += 1;
          if (plan !== null) totals.planned += 1;
          if (day !== null) {
            totals.open += 1;
            totals[day.status] += 1;
          }
          const figures =
            day === null
              ? null
              : brief(
                  day,
                  hoursOf(session, day.id),
                  session.list(EVENTS, (e) => e.productionDayId === day.id)
                );
          return Object.freeze({
            lineId: line.id,
            lineName: line.name,
            plan:
              plan === null
                ? null
                : Object.freeze({
                    revision: plan.revision,
                    styleCode: lookup.styles.get(plan.styleId)?.code ?? null,
                    orderRef: plan.orderRef ?? null,
                    hourlyTarget: plan.hourlyTarget,
                    workingHours: plan.workingHours,
                    plannedPieces: plan.hourlyTarget * plan.workingHours,
                  }),
            day:
              day === null
                ? null
                : Object.freeze({
                    id: day.id,
                    status: day.status,
                    returnReason: day.returnReason ?? null,
                    ...figures,
                  }),
            next: nextStep({ plan, day, figures, date, today: resolved.today, mayOpen }),
          });
        });
        cards.push(
          Object.freeze({
            sectionShiftId: sectionShift.id,
            factoryId: sectionShift.factoryId,
            factoryName: lookup.factories.get(sectionShift.factoryId)?.name ?? null,
            sectionName: lookup.sections.get(sectionShift.sectionId)?.name ?? null,
            shiftId: sectionShift.shiftId,
            shiftName: lookup.shifts.get(sectionShift.shiftId)?.name ?? null,
            supervisors: Object.freeze(
              supervisorsOn(session, sectionShift.id, date).map((employee) => employee.name)
            ),
            lines: Object.freeze(entries),
          })
        );
      }
      cards.sort((a, b) =>
        `${a.factoryName}/${a.sectionName}/${a.shiftName}`.localeCompare(
          `${b.factoryName}/${b.sectionName}/${b.shiftName}`
        )
      );
      return Object.freeze({
        date,
        today: resolved.today,
        previous: addDays(date, -1),
        next: addDays(date, 1),
        scope: resolved.access.assignmentScoped ? "assignments" : "factories",
        totals: Object.freeze(totals),
        cards: Object.freeze(cards),
      });
    },
  });
}

// What the person at this line should do next (D41): a word, never only a colour.
function nextStep({ plan, day, figures, date, today, mayOpen }) {
  if (day === null) {
    if (plan === null) return Object.freeze({ kind: "none", label: "No plan published" });
    if (date > today) return Object.freeze({ kind: "wait", label: `Starts on ${date}` });
    return Object.freeze({
      kind: mayOpen ? "open" : "none",
      label: mayOpen ? "Open the day" : "Day not opened yet",
    });
  }
  if (day.status === "approved") return Object.freeze({ kind: "done", label: "Approved" });
  if (day.status === "pending_approval") {
    return Object.freeze({ kind: "wait", label: "Waiting for approval" });
  }
  if (day.returnReason) return Object.freeze({ kind: "fix", label: "Returned: fix and resubmit" });
  if (figures.hoursEntered >= day.workingHours) {
    return Object.freeze({ kind: "submit", label: "Ready to submit" });
  }
  return Object.freeze({
    kind: "enter",
    label: `Enter hour ${figures.hoursEntered + 1} of ${day.workingHours}`,
  });
}
