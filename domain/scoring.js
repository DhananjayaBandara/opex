// Scorecard rules (SRS 8.4, 10.3, 10.4; FR-PROD-012, FR-SCR-001..004; decisions D43 to D52).
// Pure functions: which supervisor a production day belongs to, how the days of a period add up,
// the score configuration, the exceptions of a day and the snapshot key. The arithmetic of the
// score itself is `calculateSupervisorScore` in calculations.js. Orchestration (authorization,
// lookups, transactions, audit) lives in services/scorecards.js. Browser-safe: no Node imports.
import { addDays } from "./effective-dating.js";
import { requireReason } from "./workforce.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

export const SCORE_COMPONENTS = Object.freeze([
  "efficiency",
  "defect",
  "firstHour",
  "qco",
  "attendance",
]);

export const COMPONENT_LABELS = Object.freeze({
  efficiency: "Efficiency",
  defect: "Defect rate",
  firstHour: "First-hour hit rate",
  qco: "QCO hit rate",
  attendance: "Attendance",
});

// FR-SCR-003: the Felix defaults, used until a tenant saves a version of its own.
export const DEFAULT_SCORE_CONFIG = Object.freeze({
  weights: Object.freeze({ efficiency: 40, defect: 20, firstHour: 20, qco: 10, attendance: 10 }),
  windowDays: 90,
});

// ---- Attribution (D44) --------------------------------------------------------------------------

const covers = (row, date) =>
  row.effectiveFrom <= date &&
  (row.effectiveTo === null || row.effectiveTo === undefined || row.effectiveTo >= date);

// The supervisors whose assignment covered a section-shift on a date, read from the history.
export function supervisorsOn(assignments, sectionShiftId, date) {
  const ids = new Set(
    assignments
      .filter((row) => row.sectionShiftId === sectionShiftId && covers(row, date))
      .map((row) => row.employeeId)
  );
  return [...ids].sort();
}

// One supervisor: attributed. Two or more: shared. None: unattributed.
export function attribute(assignments, sectionShiftId, date) {
  const employeeIds = supervisorsOn(assignments, sectionShiftId, date);
  const kind =
    employeeIds.length === 1 ? "attributed" : employeeIds.length === 0 ? "unattributed" : "shared";
  return Object.freeze({ kind, employeeIds: Object.freeze(employeeIds) });
}

// ---- The figures of one day (D45) ---------------------------------------------------------------

// What a day adds to a period. `metrics` is `calculateProductionDay` over the stored plan snapshot.
export function dayFacts({ day, metrics, downtimeMinutes }) {
  const hours = day.workingHours;
  const capacity =
    isNumber(hours) && metrics.presentManpower > 0 ? metrics.presentManpower * hours : null;
  return Object.freeze({
    plannedPieces: metrics.plannedPieces,
    totalProduction: metrics.totalProduction,
    piecesHitRate: metrics.piecesHitRate,
    efficiency: metrics.achievedEfficiency,
    plannedEfficiency: isNumber(day.plannedEfficiency) ? day.plannedEfficiency : null,
    earnedSAH: metrics.earnedSAH,
    capacity,
    defectRate: metrics.damagePercent,
    firstHourHitRate: metrics.firstHourHitRate,
    qcoHitRate: isNumber(day.qcoHitRate) ? day.qcoHitRate : null,
    downtimeMinutes: isNumber(downtimeMinutes) ? downtimeMinutes : 0,
  });
}

const ratioOf = (numerator, denominator) =>
  isNumber(numerator) && isNumber(denominator) && denominator > 0
    ? (numerator / denominator) * 100
    : null;

function mean(values) {
  const readings = values.filter(isNumber);
  return readings.length === 0 ? null : readings.reduce((sum, v) => sum + v, 0) / readings.length;
}

// How the days of a period add up. Pieces are summed; efficiency is weighted by the available SAH of
// each day; the three rates are the plain mean of the days that have a reading (D45).
export function aggregateFacts(facts) {
  const withPlan = facts.filter((fact) => isNumber(fact.plannedPieces));
  const plannedPieces = withPlan.length === 0 ? null : sum(withPlan.map((f) => f.plannedPieces));
  const actualPieces = withPlan.length === 0 ? null : sum(withPlan.map((f) => f.totalProduction));

  const efficient = facts.filter((f) => isNumber(f.efficiency) && isNumber(f.capacity));
  const capacity = sum(efficient.map((f) => f.capacity));
  const actualEfficiency = ratioOf(sum(efficient.map((f) => f.earnedSAH ?? 0)), capacity);
  const planned = efficient.filter((f) => isNumber(f.plannedEfficiency));
  const plannedCapacity = sum(planned.map((f) => f.capacity));
  const plannedEfficiency =
    plannedCapacity > 0
      ? sum(planned.map((f) => f.plannedEfficiency * f.capacity)) / plannedCapacity
      : null;

  return Object.freeze({
    days: facts.length,
    plannedPieces,
    actualPieces,
    piecesVariance: plannedPieces === null ? null : actualPieces - plannedPieces,
    piecesHitRate: ratioOf(actualPieces, plannedPieces),
    plannedEfficiency,
    actualEfficiency,
    efficiencyVariance:
      actualEfficiency === null || plannedEfficiency === null
        ? null
        : actualEfficiency - plannedEfficiency,
    efficiencyHitRate: ratioOf(actualEfficiency, plannedEfficiency),
    defectRate: mean(facts.map((f) => f.defectRate)),
    firstHourHitRate: mean(facts.map((f) => f.firstHourHitRate)),
    qcoHitRate: mean(facts.map((f) => f.qcoHitRate)),
    downtimeMinutes: sum(facts.map((f) => f.downtimeMinutes)),
  });
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

// The readings `calculateSupervisorScore` takes (SRS 10.3).
export function scoreReadings(figures, attendance) {
  return {
    efficiency: figures.actualEfficiency,
    defectRate: figures.defectRate,
    firstHourHitRate: figures.firstHourHitRate,
    qcoHitRate: figures.qcoHitRate,
    attendance: {
      scheduledDays: attendance.scheduledDays,
      absentDays: attendance.absentDays,
      leaveDays: attendance.leaveDays,
    },
  };
}

// The KPI targets as the score names them.
export function scoreTargets(values) {
  return {
    efficiency: values.efficiency ?? null,
    firstHour: values.firstHour ?? null,
    defectRate: values.defectRate ?? null,
    qco: values.qco ?? null,
  };
}

// ---- Period (D47) -------------------------------------------------------------------------------

export function validDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fail("invalid_date", `${label} must be a date written YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw fail("invalid_date", `${label} is not a real date`);
  }
  return value;
}

// The period asked for, or the rolling window ending today (FR-SCR-001). A period never ends after
// today and never runs longer than a year.
export function resolvePeriod({ from, to, today, windowDays }) {
  const end = to === undefined || to === null || to === "" ? today : validDate(to, "the end date");
  if (end > today) throw fail("invalid_period", "the period cannot end after today");
  const start =
    from === undefined || from === null || from === ""
      ? addDays(end, -(windowDays - 1))
      : validDate(from, "the start date");
  if (start > end) throw fail("invalid_period", "the start date is after the end date");
  if (start < addDays(end, -365)) {
    throw fail("invalid_period", "a period is at most 366 days");
  }
  return Object.freeze({ from: start, to: end });
}

// ---- Exceptions (D49) ---------------------------------------------------------------------------

export const SHORTFALL_BELOW = 90;
export const DOWNTIME_AT_LEAST = 60;

export const EXCEPTION_KINDS = Object.freeze({
  shortfall: "Shortfall against plan",
  downtime: "Downtime",
  defects: "Defects above target",
  low_first_hour: "Low first-hour hit rate",
  shared: "Assignment conflict",
  unattributed: "No supervisor assigned",
});

export function dayExceptions(fact, targets) {
  const kinds = [];
  if (isNumber(fact.piecesHitRate) && fact.piecesHitRate < SHORTFALL_BELOW) {
    kinds.push({
      kind: "shortfall",
      detail: `${fact.totalProduction} of ${fact.plannedPieces} pieces (${fact.piecesHitRate.toFixed(1)}%)`,
    });
  }
  if (fact.downtimeMinutes >= DOWNTIME_AT_LEAST) {
    kinds.push({ kind: "downtime", detail: `${fact.downtimeMinutes} minutes of downtime` });
  }
  if (
    isNumber(fact.defectRate) &&
    isNumber(targets.defectRate) &&
    fact.defectRate > targets.defectRate
  ) {
    kinds.push({
      kind: "defects",
      detail: `${fact.defectRate.toFixed(1)}% damaged against a target of ${targets.defectRate}%`,
    });
  }
  if (
    isNumber(fact.firstHourHitRate) &&
    isNumber(targets.firstHour) &&
    fact.firstHourHitRate < targets.firstHour
  ) {
    kinds.push({
      kind: "low_first_hour",
      detail: `${fact.firstHourHitRate.toFixed(1)}% in the first hour against a target of ${targets.firstHour}%`,
    });
  }
  return kinds;
}

// ---- Score configuration (D51) ------------------------------------------------------------------

function weightOf(value, label) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!isNumber(number) || number < 0 || number > 100) {
    throw fail("invalid_weights", `${label} must be a number from 0 to 100`);
  }
  return number;
}

export function validateScoreConfig(input) {
  const weights = input?.weights;
  if (typeof weights !== "object" || weights === null || Array.isArray(weights)) {
    throw fail("invalid_weights", "the weights are required");
  }
  const clean = {};
  for (const name of SCORE_COMPONENTS) {
    clean[name] = weightOf(weights[name], `the ${COMPONENT_LABELS[name].toLowerCase()} weight`);
  }
  const total = sum(Object.values(clean));
  if (Math.abs(total - 100) > 1e-9) {
    throw fail("invalid_weights", `the weights must add up to 100, they add up to ${total}`);
  }
  const days =
    typeof input.windowDays === "string" && input.windowDays.trim() !== ""
      ? Number(input.windowDays)
      : input.windowDays;
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw fail("invalid_window", "the window must be a whole number of days from 1 to 366");
  }
  return { weights: clean, windowDays: days, reason: requireReason(input.reason) };
}

// ---- Snapshots (D52) ----------------------------------------------------------------------------

export const snapshotKey = ({ employeeId, asOf, configVersion }) =>
  `${employeeId}|${asOf}|${configVersion}`;
