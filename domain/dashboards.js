// Dashboard rules (FR-PROD-011, SRS 16.1; decisions D53 to D60).
// Pure functions: the card catalogue with what each card needs, the default period, how approved
// days break down by date, hour, line, section, style and downtime reason, the factory health band
// and the default layout. Orchestration (authorization, lookups, scope) lives in
// services/dashboards.js. Browser-safe: no Node imports.
import { invoiceTotals, paidOf, settlementOf } from "./finance.js";
import { INDICATOR_LABELS, coverDays, stockIndicator } from "./inventory.js";
import { deliveryOf, round3 } from "./procurement.js";
import { EVENT_CODES } from "./production.js";
import { aggregateFacts, resolvePeriod } from "./scoring.js";

// ---- Cards (D53, D57) ---------------------------------------------------------------------------

// What a card needs to be shown. The service leaves out a card the caller may not use; the module
// is implied by the permission (a tenant without the module never holds it).
export const CARDS = Object.freeze({
  headline: { dashboard: "tenant", permission: "production.view", label: "Headline figures" },
  factoryHealth: { dashboard: "tenant", permission: "production.view", label: "Factory health" },
  outputVsPlan: {
    dashboard: "tenant",
    permission: "production.view",
    label: "Output against plan",
  },
  dayStatus: { dashboard: "tenant", permission: "production.view", label: "Today's production" },
  exceptions: { dashboard: "tenant", permission: "scorecard.view_all", label: "Exceptions" },
  workforceToday: {
    dashboard: "tenant",
    permission: "attendance.manage",
    label: "Workforce today",
  },
  orders: { dashboard: "tenant", permission: "order.view", label: "Orders and approvals" },
  stock: { dashboard: "tenant", permission: "procurement.view", label: "Stock and purchasing" },
  invoices: { dashboard: "tenant", permission: "finance.view", label: "Invoices and payments" },
});

// The order of the tenant cards for a permission profile (D59). Presentation only: it never changes
// which cards or figures are returned.
export function layoutFor(permissions) {
  const has = (permission) => permissions.includes(permission);
  const base = ["headline", "factoryHealth", "outputVsPlan", "dayStatus", "exceptions"];
  const order = has("production.approve")
    ? ["dayStatus", "headline", "exceptions", "factoryHealth", "outputVsPlan"]
    : base;
  return Object.freeze({
    profile: has("production.approve") ? "approver" : "management",
    order: Object.freeze([...order, "workforceToday", "orders", "stock", "invoices"]),
  });
}

// ---- Period (D55) -------------------------------------------------------------------------------

export const DEFAULT_DAYS = 7;

export const defaultPeriod = ({ from, to, today }) =>
  resolvePeriod({ from, to, today, windowDays: DEFAULT_DAYS });

// ---- Health (D56) -------------------------------------------------------------------------------

// A reading aid for pieces against plan; it carries no rule (the same bands as the scorecard).
export function healthBand(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "none";
  if (rate >= 90) return "strong";
  if (rate >= 75) return "fair";
  return "low";
}

// ---- Breakdowns of approved days (D45, D56) -----------------------------------------------------

function groupEntries(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

const figuresOf = (entries) => aggregateFacts(entries.map((entry) => entry.facts));

// The figures of all the entries together and their health band: the headline of a dashboard.
export function headline(entries) {
  const figures = figuresOf(entries);
  return Object.freeze({ figures, band: healthBand(figures.piecesHitRate) });
}

// One row per group, the same figures as the headline, so additive columns add up to it. Keys in
// `include` appear even when they have no approved day (a factory with nothing yet).
export function breakdown(entries, { keyOf, labelOf, extra = () => ({}), include = [] }) {
  const groups = groupEntries(entries, keyOf);
  for (const key of include) if (!groups.has(key)) groups.set(key, []);
  return [...groups]
    .map(([key, group]) => {
      const figures = figuresOf(group);
      return Object.freeze({
        key,
        label: labelOf(key, group),
        ...extra(key, group),
        ...figures,
        band: healthBand(figures.piecesHitRate),
      });
    })
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

// The days that have an approved day, in date order.
export function byDate(entries) {
  return breakdown(entries, {
    keyOf: (entry) => entry.day.date,
    labelOf: (date) => date,
  }).sort((a, b) => a.key.localeCompare(b.key));
}

// The shift hour by hour: pieces against the hourly target over every approved day that entered it.
export function byHour(entries) {
  const hours = new Map();
  for (const entry of entries) {
    for (const row of entry.hours) {
      if (row.actualPieces === null || row.target === null) continue;
      const slot = hours.get(row.ordinalHour) ?? { actual: 0, target: 0, days: 0 };
      slot.actual += row.actualPieces;
      slot.target += row.target;
      slot.days += 1;
      hours.set(row.ordinalHour, slot);
    }
  }
  return [...hours]
    .sort((a, b) => a[0] - b[0])
    .map(([ordinalHour, slot]) =>
      Object.freeze({
        ordinalHour,
        label: `Hour ${ordinalHour}`,
        days: slot.days,
        actualPieces: slot.actual,
        targetPieces: slot.target,
        hitRate: slot.target > 0 ? (slot.actual / slot.target) * 100 : null,
      })
    );
}

// Minutes lost by reason over the approved days (the events of those days only).
export function downtimeByReason(entries) {
  const reasons = new Map();
  for (const entry of entries) {
    for (const event of entry.events) {
      const slot = reasons.get(event.code) ?? { minutes: 0, events: 0 };
      slot.minutes += event.minutes;
      slot.events += 1;
      reasons.set(event.code, slot);
    }
  }
  return [...reasons]
    .map(([code, slot]) =>
      Object.freeze({
        code,
        label: EVENT_CODES[code] ?? code,
        minutes: slot.minutes,
        events: slot.events,
      })
    )
    .sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));
}

// ---- Days not yet approved (D56) ----------------------------------------------------------------

export function unapprovedSummary(days) {
  const summary = {
    draft: { days: 0, provisionalPieces: 0 },
    pending_approval: { days: 0, provisionalPieces: 0 },
  };
  for (const { status, totalProduction } of days) {
    if (!Object.hasOwn(summary, status)) continue;
    summary[status].days += 1;
    summary[status].provisionalPieces += totalProduction ?? 0;
  }
  return Object.freeze({
    draft: Object.freeze(summary.draft),
    pending_approval: Object.freeze(summary.pending_approval),
  });
}

// ---- Workforce (D60) ----------------------------------------------------------------------------

const DAY_RANK = Object.freeze({ P: 0, LV: 1, AB: 2 });

// A day counts once per employee: present if any shift was attended, else leave, else absent.
export function bestStatus(statuses) {
  let best = null;
  for (const status of statuses) {
    if (!Object.hasOwn(DAY_RANK, status)) continue;
    if (best === null || DAY_RANK[status] < DAY_RANK[best]) best = status;
  }
  return best;
}

function finishTally(tally) {
  const recorded = tally.present + tally.absent + tally.leave;
  return Object.freeze({
    ...tally,
    attendanceRate: recorded > 0 ? (tally.present / recorded) * 100 : null,
  });
}

// The employees expected on one working day and what was recorded for each. An expected employee with
// no record is shown as unrecorded, and the rate counts recorded days only.
export function tallyAttendance(expected, statusOf) {
  const tally = { expected: 0, present: 0, absent: 0, leave: 0, unrecorded: 0 };
  for (const employee of expected) {
    tally.expected += 1;
    const status = statusOf(employee);
    if (status === "P") tally.present += 1;
    else if (status === "AB") tally.absent += 1;
    else if (status === "LV") tally.leave += 1;
    else tally.unrecorded += 1;
  }
  return finishTally(tally);
}

// Several tallies (factories, sections) as one; the rate is recomputed, never averaged.
export function addTallies(tallies) {
  const total = { expected: 0, present: 0, absent: 0, leave: 0, unrecorded: 0 };
  for (const tally of tallies) for (const key of Object.keys(total)) total[key] += tally[key];
  return finishTally(total);
}

// Whether the section-shifts that run have no supervisor, one, or two or more on a date.
export function coverageOf(count) {
  return count === 1 ? "covered" : count === 0 ? "none" : "conflict";
}

// ---- Stock and purchasing (D95) -------------------------------------------------------------------

const LOWEST = 5;

// The supply picture of the rows the caller may see, counted as of today. A "tracked" pair is a
// factory and material with a movement or an open order, exactly the rows of the Stock page, so the
// card and the page always agree. Every count is a number with a word beside it in the view; none
// is a colour alone.
export function stockSummary({
  materials,
  movements,
  purchaseOrders,
  poLines,
  accepted,
  receipts,
  requisitions,
  today,
}) {
  const balances = new Map();
  for (const movement of movements) {
    const key = `${movement.factoryId}|${movement.materialId}`;
    const quantity = movement.direction === "in" ? movement.quantity : -movement.quantity;
    balances.set(key, round3((balances.get(key) ?? 0) + quantity));
  }

  const issued = purchaseOrders.filter((order) => order.status === "issued");
  const orderById = new Map(issued.map((order) => [order.id, order]));
  const onOrder = new Map();
  const linesByOrder = new Map();
  for (const line of poLines) {
    const order = orderById.get(line.poId);
    if (order === undefined) continue;
    const key = `${order.factoryId}|${line.materialId}`;
    const pending = Math.max(0, round3(line.quantity - (accepted.get(line.id) ?? 0)));
    onOrder.set(key, round3((onOrder.get(key) ?? 0) + pending));
    if (!linesByOrder.has(order.id)) linesByOrder.set(order.id, []);
    linesByOrder.get(order.id).push(line);
  }

  const counts = { tracked: 0, outOfStock: 0, belowReorder: 0 };
  const attention = [];
  for (const key of new Set([...balances.keys(), ...onOrder.keys()])) {
    const [factoryId, materialId] = key.split("|");
    const master = materials.get(materialId);
    if (master === undefined) continue;
    const balance = balances.get(key) ?? 0;
    const reorderLevel = master.reorderLevel ?? 0;
    const indicator = stockIndicator(balance, reorderLevel, master.dailyUse);
    counts.tracked += 1;
    if (indicator === "out_of_stock") counts.outOfStock += 1;
    else if (indicator === "below_reorder") counts.belowReorder += 1;
    if (indicator === "out_of_stock" || indicator === "below_reorder") {
      attention.push({
        factoryId,
        materialId,
        materialCode: master.code,
        materialName: master.name,
        unit: master.unit,
        balance,
        reorderLevel,
        coverDays: coverDays(balance, master.dailyUse),
        onOrder: onOrder.get(key) ?? 0,
        indicator,
        indicatorLabel: INDICATOR_LABELS[indicator],
      });
    }
  }
  // Out of stock first, then the furthest below its reorder level.
  attention.sort(
    (a, b) =>
      (a.indicator === "out_of_stock" ? 0 : 1) - (b.indicator === "out_of_stock" ? 0 : 1) ||
      (a.reorderLevel > 0 ? a.balance / a.reorderLevel : 0) -
        (b.reorderLevel > 0 ? b.balance / b.reorderLevel : 0) ||
      a.materialName.localeCompare(b.materialName)
  );

  const orders = { open: 0, late: 0 };
  for (const order of issued) {
    const delivery = deliveryOf(
      linesByOrder.get(order.id) ?? [],
      accepted,
      order.expectedDate,
      today,
      order.status
    );
    if (delivery.pending > 0) orders.open += 1;
    if (delivery.late) orders.late += 1;
  }

  return Object.freeze({
    counts: Object.freeze(counts),
    lowest: Object.freeze(attention.slice(0, LOWEST).map((row) => Object.freeze(row))),
    orders: Object.freeze(orders),
    receiptsToPost: receipts.filter((receipt) => receipt.status === "received").length,
    requisitions: Object.freeze({
      waiting: requisitions.filter((row) => row.status === "submitted").length,
      toIssue: requisitions.filter((row) => row.status === "approved").length,
    }),
  });
}

// ---- Invoices and payments (D95) ------------------------------------------------------------------

const money = () => ({ open: 0, balance: 0, overdueCount: 0, overdue: 0 });

// What is owed to the company (customer invoices) and by it (supplier invoices), per currency; two
// currencies are never added together. Drafts and cancelled invoices carry no balance. Overdue is a
// separate figure, not a settlement status (AC-9.12).
export function invoiceSummary({ invoices, lines, payments, today }) {
  const linesBy = new Map();
  for (const line of lines) {
    if (!linesBy.has(line.invoiceId)) linesBy.set(line.invoiceId, []);
    linesBy.get(line.invoiceId).push(line);
  }
  const paymentsBy = new Map();
  for (const payment of payments) {
    if (!paymentsBy.has(payment.invoiceId)) paymentsBy.set(payment.invoiceId, []);
    paymentsBy.get(payment.invoiceId).push(payment);
  }

  const byCurrency = new Map();
  let drafts = 0;
  for (const invoice of invoices) {
    if (invoice.status === "draft") {
      drafts += 1;
      continue;
    }
    if (invoice.status !== "issued") continue;
    const { total } = invoiceTotals(linesBy.get(invoice.id) ?? [], invoice.taxAmount);
    const paid = paidOf(paymentsBy.get(invoice.id) ?? []);
    const state = settlementOf(
      { status: invoice.status, total, paid, dueDate: invoice.dueDate },
      today
    );
    if (state.balance <= 0) continue;
    if (!byCurrency.has(invoice.currency)) {
      byCurrency.set(invoice.currency, { receivable: money(), payable: money() });
    }
    const side = byCurrency.get(invoice.currency)[
      invoice.kind === "customer" ? "receivable" : "payable"
    ];
    side.open += 1;
    side.balance = Math.round((side.balance + state.balance) * 100) / 100;
    if (state.overdue) {
      side.overdueCount += 1;
      side.overdue = Math.round((side.overdue + state.balance) * 100) / 100;
    }
  }

  return Object.freeze({
    drafts,
    currencies: Object.freeze(
      [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, sides]) =>
          Object.freeze({
            currency,
            receivable: Object.freeze(sides.receivable),
            payable: Object.freeze(sides.payable),
          })
        )
    ),
  });
}
