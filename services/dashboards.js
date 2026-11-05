// Dashboards (FR-PROD-011, SRS 16.1; decisions D53 to D60).
//
// The tenant overview, the production and line performance dashboard and the workforce dashboard.
// Every figure is computed here from the approved production days (S3), the attendance and the
// supervisor assignments (S2) and never accepted from the caller. A dashboard is a management view:
// the dashboard permission, not limited to own assignments. Each card then needs the permission of
// the data it shows, and a caller without it does not receive the card at all (D53, D54).
// Browser-safe: no Node imports.
import {
  CARDS,
  addTallies,
  bestStatus,
  breakdown,
  byDate,
  byHour,
  coverageOf,
  defaultPeriod,
  downtimeByReason,
  headline,
  invoiceSummary,
  layoutFor,
  stockSummary,
  tallyAttendance,
  unapprovedSummary,
} from "../domain/dashboards.js";
import { ordersSummary } from "../domain/orders.js";
import { computeDay, downtimeMinutes, pickPlan } from "../domain/production.js";
import { dayFacts, supervisorsOn } from "../domain/scoring.js";
import { scheduledDatesBetween } from "../domain/workforce.js";
import { fail } from "./errors.js";
import { MOVEMENTS, acceptedByPoLine } from "./supply-common.js";

const DASHBOARD = "dashboard.view";
const VIEW_PRODUCTION = "production.view";
const MANAGE_ATTENDANCE = "attendance.manage";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = () => fail("forbidden", "you do not have access to that");
const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
const byName = (a, b) => a.name.localeCompare(b.name);
const LATEST = 5;

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = key(item);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return groups;
}

export function createDashboards({ store, gate, scorecards }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  // The caller, once the dashboard permission and the management scope are checked (D54). A card or
  // dashboard that needs more is checked by `permission`.
  function open(context, permission = null) {
    const resolved = gate.requireTenant(context, DASHBOARD);
    if (resolved.access.assignmentScoped) throw refuse();
    if (permission !== null && !resolved.permissions.includes(permission)) throw refuse();
    return resolved;
  }

  function lookups(tx) {
    return {
      factories: byId(tx.list("factories")),
      sections: byId(tx.list("sections")),
      lines: byId(tx.list("lines")),
      shifts: byId(tx.list("shifts")),
      sectionShifts: byId(tx.list("sectionShifts")),
      employees: byId(tx.list("employees")),
      styles: byId(tx.list("styles")),
    };
  }

  // The factories, sections, shifts and lines the caller may filter by (inside the factory scope).
  function optionsOf(resolved, lookup) {
    const visible = (rows) =>
      [...rows.values()].filter((row) => gate.inFactoryScope(resolved, row.factoryId));
    const named = (rows, extra = () => ({})) =>
      Object.freeze(
        rows
          .map((row) => ({ id: row.id, factoryId: row.factoryId, name: row.name, ...extra(row) }))
          .sort(byName)
      );
    return Object.freeze({
      factories: Object.freeze(
        [...lookup.factories.values()]
          .filter((row) => gate.inFactoryScope(resolved, row.id))
          .map((row) => ({ id: row.id, name: row.name }))
          .sort(byName)
      ),
      sections: named(visible(lookup.sections)),
      shifts: named(visible(lookup.shifts)),
      lines: named(visible(lookup.lines), (row) => ({
        sectionId: row.sectionId,
        sectionName: lookup.sections.get(row.sectionId)?.name ?? "",
      })),
    });
  }

  // Validates the optional filters (AC-6.2): an unknown id is not found, a factory outside the scope
  // is refused, and a section, shift or line of another factory is a mismatch, never an empty result.
  function filtersOf(resolved, lookup, request, { withLine = false } = {}) {
    const pick = (value, map, label) => {
      if (value === undefined || value === null || value === "") return null;
      const row = typeof value === "string" ? map.get(value) : undefined;
      if (row === undefined) throw fail("not_found", `that ${label} was not found`);
      return row;
    };
    const factory = pick(request.factoryId, lookup.factories, "factory");
    const section = pick(request.sectionId, lookup.sections, "section");
    const shift = pick(request.shiftId, lookup.shifts, "shift");
    const line = withLine ? pick(request.lineId, lookup.lines, "line") : null;
    const picked = [factory, section, shift, line].filter((row) => row !== null);
    for (const row of picked) {
      if (!gate.inFactoryScope(resolved, row === factory ? row.id : row.factoryId)) throw refuse();
    }
    const factoryIds = new Set(picked.map((row) => (row === factory ? row.id : row.factoryId)));
    if (factoryIds.size > 1) {
      throw fail("filter_mismatch", "those filters belong to different factories");
    }
    if (line !== null && section !== null && line.sectionId !== section.id) {
      throw fail("filter_mismatch", "that line is not in that section");
    }
    return Object.freeze({
      factoryId: factory?.id ?? null,
      sectionId: section?.id ?? null,
      shiftId: shift?.id ?? null,
      lineId: line?.id ?? null,
    });
  }

  const periodOf = (resolved, request) =>
    defaultPeriod({ from: request.from, to: request.to, today: resolved.today });

  const dayPasses = (day, filters) =>
    (filters.factoryId === null || day.factoryId === filters.factoryId) &&
    (filters.sectionId === null || day.sectionId === filters.sectionId) &&
    (filters.shiftId === null || day.shiftId === filters.shiftId) &&
    (filters.lineId === null || day.lineId === filters.lineId);

  // The days of a period inside the caller's factory scope and filters: the approved ones with their
  // figures, and the ones not approved yet with the pieces entered so far (D56).
  function gather(tx, resolved, period, filters) {
    const days = tx
      .list(
        "productionDays",
        (row) =>
          row.date >= period.from &&
          row.date <= period.to &&
          gate.inFactoryScope(resolved, row.factoryId) &&
          dayPasses(row, filters)
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const ids = new Set(days.map((row) => row.id));
    const hours = groupBy(
      tx.list("hourlyOutputs", (row) => ids.has(row.productionDayId)),
      (row) => row.productionDayId
    );
    const events = groupBy(
      tx.list("productionEvents", (row) => ids.has(row.productionDayId)),
      (row) => row.productionDayId
    );
    const entries = [];
    const unapproved = [];
    for (const day of days) {
      const computed = computeDay({
        day,
        plan: pickPlan(day),
        style: { smv: day.smv },
        hours: hours.get(day.id) ?? [],
      });
      if (day.status === "approved") {
        const own = events.get(day.id) ?? [];
        entries.push(
          Object.freeze({
            day,
            hours: computed.hours,
            events: own,
            facts: dayFacts({
              day,
              metrics: computed.metrics,
              downtimeMinutes: downtimeMinutes(own),
            }),
          })
        );
      } else {
        unapproved.push({
          factoryId: day.factoryId,
          status: day.status,
          totalProduction: computed.metrics.totalProduction,
        });
      }
    }
    return { entries, unapproved };
  }

  // ---- Today's production (a card of the overview) -------------------------------------------

  // Every active line of every active section-shift in scope, against today's plan and day.
  function dayStatusCard(tx, resolved, lookup, filters) {
    const date = resolved.today;
    const plans = tx.list("productionPlans", (row) => row.date === date);
    const days = tx.list("productionDays", (row) => row.date === date);
    const totals = {
      lines: 0,
      noPlan: 0,
      notOpened: 0,
      draft: 0,
      pending_approval: 0,
      approved: 0,
    };
    const pending = [];
    for (const sectionShift of lookup.sectionShifts.values()) {
      if (
        sectionShift.active === false ||
        !gate.inFactoryScope(resolved, sectionShift.factoryId) ||
        (filters.factoryId !== null && sectionShift.factoryId !== filters.factoryId) ||
        (filters.sectionId !== null && sectionShift.sectionId !== filters.sectionId) ||
        (filters.shiftId !== null && sectionShift.shiftId !== filters.shiftId)
      ) {
        continue;
      }
      for (const line of lookup.lines.values()) {
        if (line.sectionId !== sectionShift.sectionId || line.active === false) continue;
        const same = (row) => row.lineId === line.id && row.shiftId === sectionShift.shiftId;
        const day = days.find(same) ?? null;
        totals.lines += 1;
        if (day !== null && Object.hasOwn(totals, day.status)) {
          totals[day.status] += 1;
          if (day.status === "pending_approval") {
            pending.push({
              dayId: day.id,
              factoryName: lookup.factories.get(day.factoryId)?.name ?? null,
              sectionName: lookup.sections.get(line.sectionId)?.name ?? null,
              lineName: line.name,
              shiftName: lookup.shifts.get(sectionShift.shiftId)?.name ?? null,
            });
          }
        } else if (plans.some(same)) {
          totals.notOpened += 1;
        } else {
          totals.noPlan += 1;
        }
      }
    }
    pending.sort((a, b) =>
      `${a.factoryName}/${a.sectionName}/${a.lineName}`.localeCompare(
        `${b.factoryName}/${b.sectionName}/${b.lineName}`
      )
    );
    return Object.freeze({
      date,
      ...totals,
      pending: Object.freeze(pending.slice(0, LATEST)),
    });
  }

  // ---- Workforce (D60) ------------------------------------------------------------------------

  // Today, and when a period is given the attendance of each working day in it, for the employees a
  // working day expects: not inactive, joined, in the factory scope and the filters.
  function workforceFigures(tx, resolved, lookup, filters, period) {
    const today = resolved.today;
    const start = period === null ? today : period.from;
    const factories = [...lookup.factories.values()]
      .filter(
        (row) =>
          gate.inFactoryScope(resolved, row.id) &&
          (filters.factoryId === null || row.id === filters.factoryId)
      )
      .sort(byName);
    const factoryIds = new Set(factories.map((row) => row.id));
    const runs = (sectionId) =>
      filters.shiftId === null ||
      [...lookup.sectionShifts.values()].some(
        (row) =>
          row.sectionId === sectionId && row.shiftId === filters.shiftId && row.active !== false
      );
    const employees = [...lookup.employees.values()].filter(
      (row) =>
        factoryIds.has(row.factoryId) &&
        row.status !== "inactive" &&
        (filters.sectionId === null || row.sectionId === filters.sectionId) &&
        runs(row.sectionId)
    );
    const statuses = groupBy(
      tx.list(
        "attendanceRecords",
        (row) =>
          row.date >= start &&
          row.date <= today &&
          (filters.shiftId === null || row.shiftId === filters.shiftId)
      ),
      (row) => `${row.employeeId}|${row.date}`
    );
    const statusOf = (date) => (employee) =>
      bestStatus((statuses.get(`${employee.id}|${date}`) ?? []).map((row) => row.status));
    const tallyOf = (list, date) =>
      tallyAttendance(
        list.filter((employee) => employee.joinDate <= date),
        statusOf(date)
      );

    const rows = [];
    const dates = new Map();
    const closed = [];
    for (const factory of factories) {
      const calendar = tx.list(
        "calendars",
        (row) => row.factoryId === factory.id && row.active !== false
      )[0];
      const exceptions =
        calendar === undefined
          ? []
          : tx.list("calendarExceptions", (row) => row.calendarId === calendar.id);
      const working = scheduledDatesBetween({
        calendar: calendar ?? null,
        exceptions,
        from: start,
        to: today,
        joinDate: start,
        today,
      });
      const own = employees.filter((employee) => employee.factoryId === factory.id);
      for (const date of working) {
        if (period !== null && date >= period.from && date <= period.to) {
          if (!dates.has(date)) dates.set(date, []);
          dates.get(date).push(tallyOf(own, date));
        }
      }
      if (!working.includes(today)) {
        closed.push(factory.name);
        continue;
      }
      const sections = [...groupBy(own, (employee) => employee.sectionId)]
        .map(([sectionId, list]) =>
          Object.freeze({
            sectionId,
            sectionName: lookup.sections.get(sectionId)?.name ?? "Unknown section",
            ...tallyOf(list, today),
          })
        )
        .sort((a, b) => a.sectionName.localeCompare(b.sectionName));
      rows.push(
        Object.freeze({
          factoryId: factory.id,
          factoryName: factory.name,
          ...addTallies(sections),
          sections: Object.freeze(sections),
        })
      );
    }
    return Object.freeze({
      date: today,
      total: addTallies(rows),
      factories: Object.freeze(rows),
      closed: Object.freeze(closed),
      byDate: Object.freeze(
        [...dates]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, tallies]) =>
            Object.freeze({ key: date, label: date, ...addTallies(tallies) })
          )
      ),
    });
  }

  // The section-shifts that run today and how many supervisors cover each (UC-MGT-01).
  function coverageFigures(tx, resolved, lookup, filters, workforce) {
    const working = new Set(workforce.factories.map((row) => row.factoryId));
    const assignments = tx.list("supervisorAssignments");
    const rows = [];
    for (const sectionShift of lookup.sectionShifts.values()) {
      if (
        sectionShift.active === false ||
        !working.has(sectionShift.factoryId) ||
        (filters.sectionId !== null && sectionShift.sectionId !== filters.sectionId) ||
        (filters.shiftId !== null && sectionShift.shiftId !== filters.shiftId)
      ) {
        continue;
      }
      const ids = supervisorsOn(assignments, sectionShift.id, resolved.today);
      rows.push(
        Object.freeze({
          sectionShiftId: sectionShift.id,
          factoryName: lookup.factories.get(sectionShift.factoryId)?.name ?? null,
          sectionName: lookup.sections.get(sectionShift.sectionId)?.name ?? null,
          shiftName: lookup.shifts.get(sectionShift.shiftId)?.name ?? null,
          supervisors: Object.freeze(ids.map((id) => lookup.employees.get(id)?.name ?? "—")),
          coverage: coverageOf(ids.length),
        })
      );
    }
    rows.sort((a, b) =>
      `${a.factoryName}/${a.sectionName}/${a.shiftName}`.localeCompare(
        `${b.factoryName}/${b.sectionName}/${b.shiftName}`
      )
    );
    const counts = { covered: 0, none: 0, conflict: 0 };
    for (const row of rows) counts[row.coverage] += 1;
    return Object.freeze({ counts: Object.freeze(counts), rows: Object.freeze(rows) });
  }

  // ---- The exceptions card --------------------------------------------------------------------

  function exceptionsCard(context, period, filters) {
    const view = scorecards.exceptions(context, {
      from: period.from,
      to: period.to,
      ...(filters.factoryId ? { factoryId: filters.factoryId } : {}),
      ...(filters.sectionId ? { sectionId: filters.sectionId } : {}),
      ...(filters.shiftId ? { shiftId: filters.shiftId } : {}),
    });
    return Object.freeze({
      counts: view.counts,
      total: view.rows.length,
      latest: Object.freeze(view.rows.slice(0, LATEST)),
    });
  }

  // ---- The orders card (D81) ------------------------------------------------------------------

  // Orders in the caller's factory scope (and the chosen factory), their open milestones, pending
  // approvals and active bookings, counted as of today.
  function ordersCard(session, resolved, filters) {
    const inView = (row) =>
      gate.inFactoryScope(resolved, row.factoryId) &&
      (filters.factoryId === null || row.factoryId === filters.factoryId);
    return ordersSummary({
      orders: session.list("buyerOrders", inView),
      milestones: session.list("orderMilestones", inView),
      approvals: session.list("buyerApprovals", inView),
      bookings: session.list("capacityBookings", inView),
      today: resolved.today,
    });
  }

  // ---- The stock and invoice cards (D95) ------------------------------------------------------

  // The same visibility rule as the pages these cards summarize: the permission for the factory of a
  // row, or a tenant-wide scope for a row that belongs to no factory (an invoice without a link).
  const mayRead = (resolved, permission, factoryId) => {
    try {
      if (factoryId === null || factoryId === undefined) {
        gate.authorizeTenantWide(resolved, permission);
      } else {
        gate.authorize(resolved, permission, { factoryId });
      }
      return true;
    } catch {
      return false;
    }
  };

  function stockCard(session, resolved, filters) {
    const inView = (row) =>
      mayRead(resolved, CARDS.stock.permission, row.factoryId) &&
      (filters.factoryId === null || row.factoryId === filters.factoryId);
    return stockSummary({
      materials: byId(session.list("materials")),
      movements: session.list(MOVEMENTS, inView),
      purchaseOrders: session.list("purchaseOrders", inView),
      poLines: session.list("purchaseOrderLines", inView),
      accepted: acceptedByPoLine(session),
      receipts: session.list("goodsReceipts", inView),
      requisitions: session.list("requisitions", inView),
      today: resolved.today,
    });
  }

  function invoicesCard(session, resolved, filters) {
    const visible = new Set(
      session
        .list(
          "invoices",
          (row) =>
            mayRead(resolved, CARDS.invoices.permission, row.factoryId) &&
            (filters.factoryId === null || row.factoryId === filters.factoryId)
        )
        .map((row) => row.id)
    );
    return invoiceSummary({
      invoices: session.list("invoices", (row) => visible.has(row.id)),
      lines: session.list("invoiceLines", (row) => visible.has(row.invoiceId)),
      payments: session.list("invoicePayments", (row) => visible.has(row.invoiceId)),
      today: resolved.today,
    });
  }

  return Object.freeze({
    // ---- Tenant overview (UC-MGT-05) ----------------------------------------------------------
    // The cards the caller may use, with the factory, section and shift filters and a period.
    tenant(context, input) {
      const resolved = open(context);
      const request = isObject(input) ? input : {};
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const filters = filtersOf(resolved, lookup, request);
      const period = periodOf(resolved, request);
      const may = (id) => resolved.permissions.includes(CARDS[id].permission);

      const cards = {};
      if (may("headline") || may("factoryHealth") || may("outputVsPlan")) {
        const { entries, unapproved } = gather(session, resolved, period, filters);
        if (may("headline")) {
          cards.headline = Object.freeze({
            ...headline(entries),
            notApproved: unapprovedSummary(unapproved),
          });
        }
        if (may("factoryHealth")) {
          const inScope = [...lookup.factories.values()]
            .filter(
              (row) =>
                gate.inFactoryScope(resolved, row.id) &&
                (filters.factoryId === null || row.id === filters.factoryId)
            )
            .map((row) => row.id);
          cards.factoryHealth = Object.freeze(
            breakdown(entries, {
              keyOf: (entry) => entry.day.factoryId,
              labelOf: (id) => lookup.factories.get(id)?.name ?? "Unknown factory",
              include: inScope,
              extra: (id) => ({
                factoryId: id,
                notApprovedDays: unapproved.filter((row) => row.factoryId === id).length,
              }),
            })
          );
        }
        if (may("outputVsPlan")) cards.outputVsPlan = Object.freeze(byDate(entries));
      }
      if (may("dayStatus")) cards.dayStatus = dayStatusCard(session, resolved, lookup, filters);
      if (may("exceptions")) cards.exceptions = exceptionsCard(context, period, filters);
      if (may("workforceToday")) {
        const workforce = workforceFigures(session, resolved, lookup, filters, null);
        cards.workforceToday = Object.freeze({
          date: workforce.date,
          total: workforce.total,
          factories: workforce.factories.map(({ sections: _sections, ...row }) => row),
          closed: workforce.closed,
        });
      }
      if (may("orders")) cards.orders = ordersCard(session, resolved, filters);
      if (may("stock")) cards.stock = stockCard(session, resolved, filters);
      if (may("invoices")) cards.invoices = invoicesCard(session, resolved, filters);

      return Object.freeze({
        period,
        filters,
        options: optionsOf(resolved, lookup),
        layout: layoutFor(resolved.permissions),
        today: resolved.today,
        cards: Object.freeze(cards),
      });
    },

    // ---- Production and line performance (UC-MGT-05, FR-PROD-011) -------------------------------
    production(context, input) {
      const resolved = open(context, VIEW_PRODUCTION);
      const request = isObject(input) ? input : {};
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const filters = filtersOf(resolved, lookup, request, { withLine: true });
      const period = periodOf(resolved, request);
      const { entries, unapproved } = gather(session, resolved, period, filters);

      const lineOf = (id) => lookup.lines.get(id);
      const factoryName = (id) => lookup.factories.get(id)?.name ?? null;
      const sectionName = (id) => lookup.sections.get(id)?.name ?? null;
      return Object.freeze({
        period,
        filters,
        options: optionsOf(resolved, lookup),
        today: resolved.today,
        ...headline(entries),
        notApproved: unapprovedSummary(unapproved),
        byDate: Object.freeze(byDate(entries)),
        byHour: Object.freeze(byHour(entries)),
        byLine: Object.freeze(
          breakdown(entries, {
            keyOf: (entry) => entry.day.lineId,
            labelOf: (id) => lineOf(id)?.name ?? "Unknown line",
            extra: (id) => ({
              lineId: id,
              sectionId: lineOf(id)?.sectionId ?? null,
              sectionName: sectionName(lineOf(id)?.sectionId),
              factoryId: lineOf(id)?.factoryId ?? null,
              factoryName: factoryName(lineOf(id)?.factoryId),
            }),
          })
        ),
        bySection: Object.freeze(
          breakdown(entries, {
            keyOf: (entry) => entry.day.sectionId,
            labelOf: (id) => sectionName(id) ?? "Unknown section",
            extra: (id) => ({
              sectionId: id,
              factoryId: lookup.sections.get(id)?.factoryId ?? null,
              factoryName: factoryName(lookup.sections.get(id)?.factoryId),
            }),
          })
        ),
        byStyle: Object.freeze(
          breakdown(entries, {
            keyOf: (entry) => entry.day.styleId,
            labelOf: (id) => lookup.styles.get(id)?.code ?? "Unknown style",
            extra: (id) => ({ styleId: id, styleName: lookup.styles.get(id)?.name ?? null }),
          })
        ),
        downtime: Object.freeze(downtimeByReason(entries)),
      });
    },

    // ---- Workforce (UC-MGT-05, FR-ATT-001) ------------------------------------------------------
    workforce(context, input) {
      const resolved = open(context, MANAGE_ATTENDANCE);
      const request = isObject(input) ? input : {};
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const filters = filtersOf(resolved, lookup, request);
      const period = periodOf(resolved, request);
      const figures = workforceFigures(session, resolved, lookup, filters, period);
      return Object.freeze({
        period,
        filters,
        options: optionsOf(resolved, lookup),
        today: resolved.today,
        figures,
        coverage: coverageFigures(session, resolved, lookup, filters, figures),
      });
    },
  });
}
