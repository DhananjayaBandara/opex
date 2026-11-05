// The single calculation library for SRS 10.1-10.4 (architecture 8.3: full precision is kept and
// rounding is a presentation step). "No reading" is null, never zero; a zero or missing
// denominator gives null, never NaN or Infinity (decision D13).
// Browser-safe: no Node imports.
import { addDays, versionAt } from "./effective-dating.js";

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const orZero = (value) => (isNumber(value) ? value : 0);

// Ratio as a percentage; unavailable unless the denominator is a positive number.
function percentOf(numerator, denominator) {
  if (!isNumber(numerator) || !isNumber(denominator) || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

export function formatPercent(value, digits = 1) {
  return isNumber(value) ? `${value.toFixed(digits)}%` : "—";
}

// SRS 10.1 and 10.2 for one ProductionDay.
export function calculateProductionDay(plan, style, hours) {
  const populated = hours.filter((hour) => isNumber(hour.actualPieces));
  const totalProduction = populated.reduce((sum, hour) => sum + hour.actualPieces, 0);
  const hoursRun = populated.length;
  const averageHourly = hoursRun > 0 ? totalProduction / hoursRun : 0;
  const damagePieces = populated.reduce((sum, hour) => sum + orZero(hour.damagePieces), 0);

  const smv = style?.smv;
  const earnedSAH = hoursRun > 0 && isNumber(smv) && smv > 0 ? (totalProduction * smv) / 60 : null;

  const presentManpower =
    orZero(plan.presentMCOperators) + orZero(plan.presentHelpers) + orZero(plan.presentManual);
  const plannedManpower = orZero(plan.plannedMCOperators) + orZero(plan.plannedManual);

  const achievedEfficiency = percentOf(earnedSAH, presentManpower * orZero(plan.workingHours));

  const firstHour = populated.find((hour) => hour.ordinalHour === 1);
  const plannedPieces =
    isNumber(plan.hourlyTarget) && isNumber(plan.workingHours)
      ? plan.hourlyTarget * plan.workingHours
      : null;
  const hasPlannedEfficiency = achievedEfficiency !== null && isNumber(plan.plannedEfficiency);

  let cumulativeActual = 0;
  let cumulativeTarget = 0;
  const cumulative = [...hours]
    .sort((a, b) => a.ordinalHour - b.ordinalHour)
    .map((hour) => {
      if (!isNumber(hour.actualPieces)) {
        return { ordinalHour: hour.ordinalHour, cumulativeActual: null, cumulativeTarget: null };
      }
      cumulativeActual += hour.actualPieces;
      cumulativeTarget += orZero(plan.hourlyTarget);
      return {
        ordinalHour: hour.ordinalHour,
        cumulativeActual,
        cumulativeTarget: isNumber(plan.hourlyTarget) ? cumulativeTarget : null,
      };
    });

  return {
    totalProduction,
    hoursRun,
    averageHourly,
    earnedSAH,
    presentManpower,
    plannedManpower,
    manpowerVariance: presentManpower - plannedManpower,
    achievedEfficiency,
    hourlyHitRate: hoursRun > 0 ? percentOf(averageHourly, plan.hourlyTarget) : null,
    firstHourHitRate: firstHour ? percentOf(firstHour.actualPieces, plan.hourlyTarget) : null,
    damagePercent: percentOf(damagePieces, totalProduction),
    plannedPieces,
    piecesVariance: plannedPieces === null ? null : totalProduction - plannedPieces,
    piecesHitRate: hoursRun > 0 ? percentOf(totalProduction, plannedPieces) : null,
    efficiencyVariance: hasPlannedEfficiency ? achievedEfficiency - plan.plannedEfficiency : null,
    efficiencyHitRate:
      achievedEfficiency === null ? null : percentOf(achievedEfficiency, plan.plannedEfficiency),
    cumulative,
  };
}

const COMPONENTS = ["efficiency", "defect", "firstHour", "qco", "attendance"];

const capped = (value) => (value === null ? null : Math.min(100, value));
const validReading = (value) => isNumber(value) && value >= 0;

export function attendanceScore(attendance) {
  const scheduled = attendance?.scheduledDays;
  if (!isNumber(scheduled) || scheduled <= 0) return null;
  const present = scheduled - orZero(attendance.absentDays) - orZero(attendance.leaveDays);
  return Math.max(0, Math.min(100, (present / scheduled) * 100));
}

// SRS 10.3. A component without a reading or a usable target is unavailable (null); the
// remaining weights are re-normalized. The result carries everything needed to store a snapshot
// (architecture 8.4, 9.3): inputs, component scores and the configuration version.
export function calculateSupervisorScore({ readings, targets, config }) {
  const ratioScore = (reading, target) =>
    validReading(reading) ? capped(percentOf(reading, target)) : null;

  const componentScores = {
    efficiency: ratioScore(readings.efficiency, targets.efficiency),
    defect:
      validReading(readings.defectRate) && isNumber(targets.defectRate) && targets.defectRate > 0
        ? readings.defectRate === 0
          ? 100
          : capped(percentOf(targets.defectRate, readings.defectRate))
        : null,
    firstHour: ratioScore(readings.firstHourHitRate, targets.firstHour),
    qco: ratioScore(readings.qcoHitRate, targets.qco),
    attendance: attendanceScore(readings.attendance),
  };

  const available = COMPONENTS.filter(
    (name) => componentScores[name] !== null && orZero(config.weights[name]) > 0
  );
  const weightSum = available.reduce((sum, name) => sum + config.weights[name], 0);
  const effectiveWeights = Object.fromEntries(
    available.map((name) => [name, (config.weights[name] * 100) / weightSum])
  );
  const totalScore =
    available.length === 0
      ? null
      : available.reduce((sum, name) => sum + componentScores[name] * config.weights[name], 0) /
        weightSum;

  return {
    componentScores,
    effectiveWeights,
    totalScore,
    configVersion: config.version,
    windowDays: config.windowDays,
    componentInputs: { readings: structuredClone(readings), targets: structuredClone(targets) },
  };
}

// The rolling window ends on the as-of date and includes it.
export function scoreWindow(asOf, days) {
  if (!Number.isInteger(days) || days < 1) {
    const error = new Error(`window must be a whole number of days of at least 1, got ${days}`);
    error.code = "invalid_window";
    throw error;
  }
  return { from: addDays(asOf, -(days - 1)), to: asOf };
}

// SRS 10.4: System -> Tenant -> Factory, each level versioned and effective-dated.
export function resolveTargets(levels, asOf) {
  const values = {};
  const sources = {};
  for (const level of ["system", "tenant", "factory"]) {
    const version = versionAt(levels[level] ?? [], asOf);
    if (!version) continue;
    for (const [key, value] of Object.entries(version.values)) {
      if (value === undefined) continue;
      values[key] = value;
      sources[key] = { level, version: version.version };
    }
  }
  return { values, sources };
}
