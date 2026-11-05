// Report and export rules (C128 to C130; decisions D68, D69): the catalogue of reports with their
// columns, CSV with formula escaping, relative periods and a bounded recurrence in the schedule's
// own timezone. Pure functions; the data comes from the dashboard and scorecard services and the
// orchestration lives in services/reports.js. Browser-safe: no Node imports.
import { addDays } from "./effective-dating.js";
import { businessDate, isValidTimeZone } from "./time.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const MAX_ROWS = 1000;
export const REQUESTS_PER_HOUR = 10;
export const KEY_MAX = 80;
export const NAME_MAX = 80;
export const MAX_RECIPIENTS = 20;

// ---- Catalogue (D68) ----------------------------------------------------------------------------

const text = (key, label, of = (row) => row[key]) => ({ key, label, type: "text", of });
const num = (key, label, of = (row) => row[key]) => ({ key, label, type: "number", of });
const yesNo = (key, label) => text(key, label, (row) => (row[key] ? "Yes" : "No"));
const within = (period, date) => date !== null && date >= period.from && date <= period.to;

// `source` names the service call that produces the rows, `needs` the permissions the caller must
// hold now besides export.create, and `filters` the optional keys the source accepts.
export const REPORTS = Object.freeze({
  production_by_line: {
    label: "Production by line",
    description: "Pieces, efficiency, defects and downtime for each line on approved days.",
    source: { service: "dashboards", call: "production" },
    needs: ["dashboard.view", "production.view"],
    filters: ["factoryId", "sectionId", "shiftId", "lineId"],
    rowsOf: (view) => view.byLine,
    columns: [
      text("label", "Line"),
      text("sectionName", "Section"),
      text("factoryName", "Factory"),
      num("days", "Approved days"),
      num("plannedPieces", "Planned pieces"),
      num("actualPieces", "Pieces made"),
      num("piecesVariance", "Variance (pieces)"),
      num("piecesHitRate", "Against plan (%)"),
      num("plannedEfficiency", "Planned efficiency (%)"),
      num("actualEfficiency", "Efficiency (%)"),
      num("defectRate", "Defect rate (%)"),
      num("firstHourHitRate", "First-hour hit rate (%)"),
      num("qcoHitRate", "QCO hit rate (%)"),
      num("downtimeMinutes", "Downtime (minutes)"),
    ],
  },
  production_by_date: {
    label: "Production by date",
    description: "Pieces against plan for each date with an approved day.",
    source: { service: "dashboards", call: "production" },
    needs: ["dashboard.view", "production.view"],
    filters: ["factoryId", "sectionId", "shiftId", "lineId"],
    rowsOf: (view) => view.byDate,
    columns: [
      text("key", "Date"),
      num("days", "Approved days"),
      num("plannedPieces", "Planned pieces"),
      num("actualPieces", "Pieces made"),
      num("piecesVariance", "Variance (pieces)"),
      num("piecesHitRate", "Against plan (%)"),
      num("actualEfficiency", "Efficiency (%)"),
      num("defectRate", "Defect rate (%)"),
      num("downtimeMinutes", "Downtime (minutes)"),
    ],
  },
  downtime_by_reason: {
    label: "Downtime by reason",
    description: "Minutes lost on approved days, by reason.",
    source: { service: "dashboards", call: "production" },
    needs: ["dashboard.view", "production.view"],
    filters: ["factoryId", "sectionId", "shiftId", "lineId"],
    rowsOf: (view) => view.downtime,
    columns: [text("label", "Reason"), num("events", "Events"), num("minutes", "Minutes lost")],
  },
  scorecard_board: {
    label: "Management scorecard",
    description: "Each supervisor's figures and score for the period.",
    source: { service: "scorecards", call: "board" },
    needs: ["scorecard.view_all"],
    filters: ["factoryId", "sectionId", "shiftId"],
    rowsOf: (view) => view.rows,
    columns: [
      text("employeeCode", "Code"),
      text("name", "Supervisor"),
      text("factoryName", "Factory"),
      num("days", "Days"),
      num("plannedPieces", "Planned pieces"),
      num("actualPieces", "Pieces made"),
      num("piecesHitRate", "Against plan (%)"),
      num("actualEfficiency", "Efficiency (%)"),
      num("defectRate", "Defect rate (%)"),
      num("firstHourHitRate", "First-hour hit rate (%)"),
      num("qcoHitRate", "QCO hit rate (%)"),
      num("attendanceScore", "Attendance score (%)"),
      num("score", "Score"),
      num("configVersion", "Score configuration version"),
    ],
  },
  score_exceptions: {
    label: "Score exceptions",
    description: "Days that need attention: shortfalls, downtime, defects and assignment gaps.",
    source: { service: "scorecards", call: "exceptions" },
    needs: ["scorecard.view_all"],
    filters: ["factoryId", "sectionId", "shiftId"],
    rowsOf: (view) => view.rows,
    columns: [
      text("date", "Date"),
      text("label", "Exception"),
      text("factoryName", "Factory"),
      text("sectionName", "Section"),
      text("lineName", "Line"),
      text("shiftName", "Shift"),
      text("detail", "Detail"),
      text("supervisors", "Supervisors", (row) => (row.supervisorNames ?? []).join("; ")),
    ],
  },
  // ---- Business data (S8; D106) -------------------------------------------------------------------
  // Lists a person with the matching view permission could already read on screen. The period narrows
  // the documents by their own date (an invoice by invoice date, an order by order date, a payment by
  // payment date); master data and stock are as at the day the file is made.
  buyer_orders: {
    label: "Buyer orders",
    description: "Buyer orders dated in the period, with what has been produced and the value.",
    source: { service: "orders", call: "orders" },
    needs: ["order.view"],
    filters: ["factoryId"],
    rowsOf: (rows, period) => rows.filter((row) => within(period, row.orderDate)),
    columns: [
      text("reference", "Order"),
      text("buyerPo", "Buyer PO"),
      text("buyerName", "Buyer"),
      text("factoryName", "Factory"),
      text("status", "Status"),
      text("orderDate", "Order date"),
      text("shipDate", "Ship date"),
      text("currency", "Currency"),
      num("lines", "Lines"),
      num("quantity", "Pieces ordered"),
      num("produced", "Pieces produced"),
      num("percent", "Percent produced"),
      num("value", "Value"),
    ],
  },
  buyers: {
    label: "Buyers",
    description: "Every buyer with its contact and the styles and orders linked to it.",
    source: { service: "orders", call: "buyers" },
    needs: ["order.view"],
    asAt: true,
    filters: [],
    rowsOf: (rows) => rows,
    columns: [
      text("code", "Code"),
      text("name", "Buyer"),
      text("country", "Country"),
      text("contactName", "Contact"),
      text("contactEmail", "Contact email"),
      yesNo("active", "Active"),
      num("styles", "Styles"),
      num("orders", "Orders"),
    ],
  },
  materials: {
    label: "Materials",
    description: "The material master with the quantity on hand across your factories.",
    source: { service: "procurement", call: "materials" },
    needs: ["procurement.view"],
    asAt: true,
    filters: [],
    rowsOf: (rows) => rows,
    columns: [
      text("code", "Code"),
      text("name", "Material"),
      text("category", "Category"),
      text("unit", "Unit"),
      num("reorderLevel", "Reorder level"),
      num("dailyUse", "Daily use"),
      num("standardCost", "Standard cost"),
      num("onHand", "On hand"),
      yesNo("active", "Active"),
    ],
  },
  suppliers: {
    label: "Suppliers",
    description: "Every supplier with its contact, payment terms and purchase order count.",
    source: { service: "procurement", call: "suppliers" },
    needs: ["procurement.view"],
    asAt: true,
    filters: [],
    rowsOf: (rows) => rows,
    columns: [
      text("code", "Code"),
      text("name", "Supplier"),
      text("contactName", "Contact"),
      text("email", "Email"),
      text("phone", "Phone"),
      text("paymentTerms", "Payment terms"),
      yesNo("active", "Active"),
      num("purchaseOrders", "Purchase orders"),
    ],
  },
  stock_by_material: {
    label: "Stock by material",
    description: "Balance, cover and quantity on order for each material and factory.",
    source: { service: "inventory", call: "stock" },
    needs: ["procurement.view"],
    asAt: true,
    filters: ["factoryId"],
    rowsOf: (rows) => rows,
    columns: [
      text("factoryName", "Factory"),
      text("materialCode", "Code"),
      text("materialName", "Material"),
      text("unit", "Unit"),
      num("balance", "Balance"),
      num("reorderLevel", "Reorder level"),
      num("coverDays", "Cover (days)"),
      text("indicatorLabel", "Status"),
      num("onOrder", "On order"),
      text("lastMovementDate", "Last movement"),
    ],
  },
  purchase_orders: {
    label: "Purchase orders",
    description: "Purchase orders dated in the period, with value and delivery state.",
    source: { service: "procurement", call: "purchaseOrders" },
    needs: ["procurement.view"],
    filters: ["factoryId"],
    rowsOf: (rows, period) => rows.filter((row) => within(period, row.orderDate)),
    columns: [
      text("number", "Number"),
      text("factoryName", "Factory"),
      text("supplierName", "Supplier"),
      text("status", "Status"),
      text("orderDate", "Order date"),
      text("expectedDate", "Expected"),
      text("currency", "Currency"),
      num("lines", "Lines"),
      num("subtotal", "Subtotal"),
      num("tax", "Tax"),
      num("value", "Value"),
      text("delivery", "Delivery"),
      text("late", "Late", (row) => (row.late ? "Yes" : "No")),
    ],
  },
  invoices: {
    label: "Invoices",
    description: "Customer and supplier invoices dated in the period, with what is paid and owed.",
    source: { service: "finance", call: "invoices" },
    needs: ["finance.view"],
    filters: ["kind", "status"],
    rowsOf: (rows, period) => rows.filter((row) => within(period, row.invoiceDate)),
    columns: [
      text("displayNumber", "Number"),
      text("kind", "Kind"),
      text("partyName", "Buyer or supplier"),
      text("status", "Status"),
      text("invoiceDate", "Invoice date"),
      text("dueDate", "Due date"),
      text("currency", "Currency"),
      num("subtotal", "Subtotal"),
      num("tax", "Tax"),
      num("total", "Total"),
      num("paid", "Paid"),
      num("balance", "Balance"),
      text("settlement", "Settlement"),
      text("overdue", "Overdue", (row) => (row.overdue ? "Yes" : "No")),
    ],
  },
  payments: {
    label: "Payments",
    description: "Payments recorded against invoices in the period.",
    source: { service: "finance", call: "payments" },
    needs: ["finance.view"],
    filters: ["kind", "method"],
    rowsOf: (rows, period) => rows.filter((row) => within(period, row.date)),
    columns: [
      text("date", "Date"),
      text("invoiceNumber", "Invoice"),
      text("kind", "Kind"),
      text("partyName", "Buyer or supplier"),
      text("currency", "Currency"),
      num("amount", "Amount"),
      text("methodLabel", "Method"),
      text("reference", "Reference"),
      text("recordedBy", "Recorded by"),
    ],
  },
});

export const REPORT_KEYS = Object.freeze(Object.keys(REPORTS));

export function requireReport(report) {
  if (typeof report !== "string" || !Object.hasOwn(REPORTS, report)) {
    throw fail("unknown_report", `${String(report)} is not a report`);
  }
  return REPORTS[report];
}

// The values a fixed-choice filter accepts (S8; D106). Filters that name a record (a factory, a line)
// are checked by the source service instead, because they depend on the caller's scope.
export const FILTER_CHOICES = Object.freeze({
  kind: Object.freeze([
    Object.freeze({ value: "customer", label: "Customer invoices" }),
    Object.freeze({ value: "supplier", label: "Supplier invoices" }),
  ]),
  status: Object.freeze([
    Object.freeze({ value: "draft", label: "Draft" }),
    Object.freeze({ value: "issued", label: "Issued" }),
    Object.freeze({ value: "cancelled", label: "Cancelled" }),
  ]),
  method: Object.freeze([
    Object.freeze({ value: "bank_transfer", label: "Bank transfer" }),
    Object.freeze({ value: "cheque", label: "Cheque" }),
    Object.freeze({ value: "cash", label: "Cash" }),
    Object.freeze({ value: "card", label: "Card" }),
  ]),
});

// Only the filters a report accepts, as non-empty strings; the source service checks that they exist
// and are inside the caller's scope.
export function validateFilters(report, input) {
  const spec = requireReport(report);
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw fail("invalid_filters", "filters are an object");
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (!spec.filters.includes(key)) {
      throw fail("invalid_filters", `${key} is not a filter of ${spec.label}`);
    }
    if (typeof value !== "string" || value.length > 64) {
      throw fail("invalid_filters", `${key} must be an id`);
    }
    const choices = FILTER_CHOICES[key];
    if (choices !== undefined && !choices.some((choice) => choice.value === value)) {
      throw fail(
        "invalid_filters",
        `${key} must be one of ${choices.map((choice) => choice.value).join(", ")}`
      );
    }
    result[key] = value;
  }
  return result;
}

// ---- CSV (D68) ----------------------------------------------------------------------------------

// A text cell that a spreadsheet would run as a formula gets a leading apostrophe. Numbers are
// written as numbers and never get one, so a negative variance stays negative.
const FORMULA_START = /^[=+\-@\t\r]/;
export const neutralize = (value) => (FORMULA_START.test(value) ? `'${value}` : value);

function cell(column, row) {
  const value = column.of(row);
  if (value === null || value === undefined || value === "") return "";
  if (column.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    return String(Math.round(value * 100) / 100);
  }
  return String(value);
}

const quote = (value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export function toCsv(columns, rows) {
  if (rows.length > MAX_ROWS) {
    throw fail(
      "too_many_rows",
      `that report has ${rows.length} rows; narrow the period or the filters (limit ${MAX_ROWS})`
    );
  }
  const lines = [columns.map((column) => quote(column.label)).join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((column) => {
          const value = cell(column, row);
          return quote(column.type === "number" ? value : neutralize(value));
        })
        .join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export const fileNameOf = (report, period) =>
  `${report.replaceAll("_", "-")}_${period.from}_${period.to}.csv`;

export const storageKeyOf = (tenantId, jobId) => `tenants/${tenantId}/exports/${jobId}.csv`;

// An Idempotency-Key is a short printable token.
export function validateKey(value) {
  if (typeof value !== "string" || !/^[\w.:-]{1,80}$/.test(value)) {
    throw fail("invalid_key", `an Idempotency-Key is 1 to ${KEY_MAX} letters, digits or . : _ -`);
  }
  return value;
}

// ---- Periods ------------------------------------------------------------------------------------

export const RELATIVE_PERIODS = Object.freeze({
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  month_to_date: "Month to date",
});

export function requireRelativePeriod(value) {
  if (typeof value !== "string" || !Object.hasOwn(RELATIVE_PERIODS, value)) {
    throw fail("invalid_period", `a period is one of ${Object.keys(RELATIVE_PERIODS).join(", ")}`);
  }
  return value;
}

// The dates a relative period covers on a business date. A day that is not over is never included
// except by month-to-date, which ends today.
export function relativePeriod(kind, today) {
  switch (requireRelativePeriod(kind)) {
    case "yesterday": {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case "last_7_days":
      return { from: addDays(today, -7), to: addDays(today, -1) };
    case "last_30_days":
      return { from: addDays(today, -30), to: addDays(today, -1) };
    default:
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

// ---- Recurrence (D69) ---------------------------------------------------------------------------

export const CADENCES = Object.freeze({ daily: "Daily", weekly: "Weekly", monthly: "Monthly" });
export const WEEKDAYS = Object.freeze({
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
});

// { cadence, weekday (1 Monday to 7 Sunday, weekly), dayOfMonth (1 to 28, monthly), time "HH:MM" }
export function validateRecurrence(input) {
  const cadence = input?.cadence;
  if (typeof cadence !== "string" || !Object.hasOwn(CADENCES, cadence)) {
    throw fail("invalid_recurrence", "the cadence is daily, weekly or monthly");
  }
  const time = input.time;
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw fail("invalid_recurrence", "the time is HH:MM, 24 hours");
  }
  const result = { cadence, weekday: null, dayOfMonth: null, time };
  if (cadence === "weekly") {
    const weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw fail("invalid_recurrence", "a weekly report names a weekday, 1 (Monday) to 7 (Sunday)");
    }
    result.weekday = weekday;
  }
  if (cadence === "monthly") {
    const dayOfMonth = Number(input.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
      throw fail("invalid_recurrence", "a monthly report runs on day 1 to 28");
    }
    result.dayOfMonth = dayOfMonth;
  }
  return result;
}

export function validateScheduleTimeZone(value) {
  if (!isValidTimeZone(value)) {
    throw fail("invalid_timezone", "an IANA timezone such as Asia/Colombo is required");
  }
  return value;
}

export function describeRecurrence(recurrence) {
  const at = `at ${recurrence.time}`;
  if (recurrence.cadence === "daily") return `Every day ${at}`;
  if (recurrence.cadence === "weekly") return `Every ${WEEKDAYS[recurrence.weekday]} ${at}`;
  return `Day ${recurrence.dayOfMonth} of each month ${at}`;
}

// The offset of a zone from UTC at an instant, in milliseconds.
function offsetOf(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  );
  return local - Math.floor(instant.getTime() / 1000) * 1000;
}

// The instant at which a zone's clock reads `date` `time`. A time the zone skips resolves to just
// after the gap.
export function zonedInstant(date, time, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - offsetOf(new Date(naive), timeZone);
  guess = naive - offsetOf(new Date(guess), timeZone);
  return new Date(guess);
}

const isoWeekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

function matches(recurrence, date) {
  if (recurrence.cadence === "daily") return true;
  if (recurrence.cadence === "weekly") return isoWeekday(date) === recurrence.weekday;
  return Number(date.slice(8, 10)) === recurrence.dayOfMonth;
}

// The first run strictly after an instant, as an ISO string in UTC. A recurrence matches within 31
// days, so the search is bounded.
export function nextRun(recurrence, timeZone, after) {
  const first = businessDate(after, timeZone);
  for (let offset = 0; offset <= 32; offset += 1) {
    const date = addDays(first, offset);
    if (!matches(recurrence, date)) continue;
    const instant = zonedInstant(date, recurrence.time, timeZone);
    if (instant.getTime() > after.getTime()) return instant.toISOString();
  }
  throw fail("invalid_recurrence", "that recurrence never runs");
}

export function validateName(value) {
  const name =
    typeof value === "string"
      ? // eslint-disable-next-line no-control-regex
        value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
      : "";
  if (name.length === 0 || name.length > NAME_MAX) {
    throw fail("invalid_name", `a name is 1 to ${NAME_MAX} characters`);
  }
  return name;
}

export function validateRecipientIds(value) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id === "")) {
    throw fail("invalid_recipients", "recipients are a list of member ids");
  }
  const ids = [...new Set(value)];
  if (ids.length === 0 || ids.length > MAX_RECIPIENTS) {
    throw fail("invalid_recipients", `a schedule has 1 to ${MAX_RECIPIENTS} recipients`);
  }
  return ids;
}
