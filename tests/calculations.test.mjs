// AC-0.6 One calculation library for SRS 10.1-10.4. Full precision is kept (architecture 8.3);
// "no reading" is null, never zero.
import test from "node:test";
import assert from "node:assert/strict";
import { optional, need, near } from "./harness.mjs";

const calc = await optional("../domain/calculations.js");
const SRC = "domain/calculations.js";

const plan = (overrides = {}) => ({
  hourlyTarget: 100,
  workingHours: 8,
  plannedMCOperators: 20,
  plannedManual: 2,
  presentMCOperators: 15,
  presentHelpers: 3,
  presentManual: 2,
  plannedEfficiency: 80,
  ...overrides,
});
const style = { smv: 12 };
const hours = [
  { ordinalHour: 1, actualPieces: 0, damagePieces: 0 },
  { ordinalHour: 2, actualPieces: null },
  { ordinalHour: 3, actualPieces: 400, damagePieces: 4 },
];

test("AC-0.6 SRS 10.1: a blank hour is excluded, a zero hour is counted", () => {
  const day = need(calc, "calculateProductionDay", SRC)(plan(), style, hours);
  assert.equal(day.totalProduction, 400);
  assert.equal(day.hoursRun, 2);
  assert.equal(day.averageHourly, 200);
  near(day.earnedSAH, 80, "Earned SAH = 400 x 12 / 60");
  assert.equal(day.presentManpower, 20);
  assert.equal(day.plannedManpower, 22);
  assert.equal(day.manpowerVariance, -2);
  near(day.achievedEfficiency, 50, "Efficiency = 80 / (20 x 8) x 100");
  near(day.hourlyHitRate, 200, "Hourly Hit Rate = 200 / 100 x 100");
  near(day.firstHourHitRate, 0, "First-Hour Hit Rate with a populated zero hour 1");
  near(day.damagePercent, 1, "Damage % = 4 / 400 x 100");
});

test("AC-0.6 SRS 10.2: plan variance and hit rates", () => {
  const day = need(calc, "calculateProductionDay", SRC)(plan(), style, hours);
  assert.equal(day.plannedPieces, 800);
  assert.equal(day.piecesVariance, -400);
  near(day.piecesHitRate, 50, "Pieces Hit Rate");
  near(day.efficiencyVariance, -30, "Efficiency Variance in percentage points");
  near(day.efficiencyHitRate, 62.5, "Efficiency Hit Rate = 50 / 80 x 100");
});

test("AC-0.6 present manpower drives efficiency; planned manpower drives only the variance", () => {
  const f = need(calc, "calculateProductionDay", SRC);
  const base = f(plan(), style, hours);
  const moreHelpers = f(plan({ presentHelpers: 8 }), style, hours);
  assert.equal(moreHelpers.presentManpower, 25);
  assert.equal(moreHelpers.manpowerVariance, 3);
  assert.ok(moreHelpers.achievedEfficiency < base.achievedEfficiency);
  const noHelpersField = f(plan({ presentHelpers: undefined }), style, hours);
  assert.equal(noHelpersField.presentManpower, 17, "a missing staffing component counts as 0");
});

test("AC-0.6 first-hour hit rate is unavailable when hour 1 is blank", () => {
  const f = need(calc, "calculateProductionDay", SRC);
  const day = f(plan(), style, [
    { ordinalHour: 1, actualPieces: null },
    { ordinalHour: 2, actualPieces: 120 },
  ]);
  assert.equal(day.firstHourHitRate, null);
  assert.equal(day.hoursRun, 1);
});

test("AC-0.6 cumulative output and target accrue only over populated hours", () => {
  const f = need(calc, "calculateProductionDay", SRC);
  const day = f(plan(), style, [
    { ordinalHour: 1, actualPieces: 100 },
    { ordinalHour: 2, actualPieces: null },
    { ordinalHour: 3, actualPieces: 150 },
    { ordinalHour: 4, actualPieces: 50 },
  ]);
  assert.deepEqual(
    day.cumulative.map((row) => [row.ordinalHour, row.cumulativeActual, row.cumulativeTarget]),
    [
      [1, 100, 100],
      [2, null, null],
      [3, 250, 200],
      [4, 300, 300],
    ]
  );
});

test("AC-0.6 no populated hour: totals are zero but performance ratios are unavailable, not zero", () => {
  const f = need(calc, "calculateProductionDay", SRC);
  const day = f(plan(), style, [{ ordinalHour: 1, actualPieces: null }]);
  assert.equal(day.totalProduction, 0);
  assert.equal(day.hoursRun, 0);
  assert.equal(day.averageHourly, 0, "SRS: Average Hourly is zero-safe");
  for (const key of [
    "earnedSAH",
    "achievedEfficiency",
    "hourlyHitRate",
    "firstHourHitRate",
    "damagePercent",
    "piecesHitRate",
    "efficiencyHitRate",
  ])
    assert.equal(day[key], null, `${key} must be null without a reading`);
});

test("AC-0.6 populated zero is a real reading: zero efficiency, but damage % has no denominator", () => {
  const f = need(calc, "calculateProductionDay", SRC);
  const day = f(plan(), style, [{ ordinalHour: 1, actualPieces: 0, damagePieces: 0 }]);
  assert.equal(day.hoursRun, 1);
  near(day.achievedEfficiency, 0, "efficiency of a populated zero hour");
  near(day.hourlyHitRate, 0, "hourly hit rate of a populated zero hour");
  assert.equal(day.damagePercent, null, "Damage % divides by Total Production = 0");
});

test("AC-0.6 zero or missing denominators yield null and never NaN or Infinity", () => {
  const f = need(calc, "calculateProductionDay", SRC);
  const cases = [
    [
      "hourly target 0",
      plan({ hourlyTarget: 0 }),
      style,
      ["hourlyHitRate", "firstHourHitRate", "piecesHitRate"],
    ],
    ["working hours 0", plan({ workingHours: 0 }), style, ["achievedEfficiency", "piecesHitRate"]],
    [
      "present manpower 0",
      plan({ presentMCOperators: 0, presentHelpers: 0, presentManual: 0 }),
      style,
      ["achievedEfficiency"],
    ],
    ["planned efficiency 0", plan({ plannedEfficiency: 0 }), style, ["efficiencyHitRate"]],
    [
      "no style / SMV",
      plan(),
      null,
      ["earnedSAH", "achievedEfficiency", "efficiencyVariance", "efficiencyHitRate"],
    ],
  ];
  for (const [label, p, s, nulls] of cases) {
    const day = f(p, s, hours);
    for (const key of nulls) assert.equal(day[key], null, `${label}: ${key} must be null`);
    for (const [key, value] of Object.entries(day))
      if (typeof value === "number")
        assert.ok(Number.isFinite(value), `${label}: ${key} must be finite, got ${value}`);
  }
});

test("AC-0.6 results keep full precision; rounding is a separate presentation step", () => {
  const f = need(calc, "calculateProductionDay", SRC);
  const day = f(plan(), { smv: 7 }, [{ ordinalHour: 1, actualPieces: 100 }]);
  near(day.earnedSAH, 700 / 60, "Earned SAH keeps every digit", 1e-12);
  assert.notEqual(day.earnedSAH, 11.67, "calculation must not pre-round");
  const formatPercent = need(calc, "formatPercent", SRC);
  assert.equal(formatPercent(62.5), "62.5%");
  assert.equal(formatPercent(100 / 3), "33.3%");
  assert.equal(formatPercent(100 / 3, 2), "33.33%");
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(0), "0.0%");
});

const targets = { efficiency: 80, defectRate: 2, firstHour: 80, qco: 90 };
const config = {
  version: "felix-default-v1",
  windowDays: 90,
  weights: { efficiency: 40, defect: 20, firstHour: 20, qco: 10, attendance: 10 },
};
const readings = (overrides = {}) => ({
  efficiency: 90,
  defectRate: 4,
  firstHourHitRate: 64,
  qcoHitRate: 54,
  attendance: { scheduledDays: 20, absentDays: 2, leaveDays: 3 },
  ...overrides,
});

test("AC-0.6 SRS 10.3: each component is capped at 100 and follows its formula", () => {
  const score = need(
    calc,
    "calculateSupervisorScore",
    SRC
  )({ readings: readings(), targets, config });
  near(score.componentScores.efficiency, 100, "efficiency 90/80 is capped");
  near(score.componentScores.defect, 50, "defect = 2 / 4 x 100");
  near(score.componentScores.firstHour, 80, "first hour = 64 / 80 x 100");
  near(score.componentScores.qco, 60, "qco = 54 / 90 x 100");
  near(score.componentScores.attendance, 75, "attendance = (20 - 2 - 3) / 20 x 100");
});

test("AC-0.6 SRS 10.3: zero actual defect rate is the best score (capped), not a division error", () => {
  const score = need(
    calc,
    "calculateSupervisorScore",
    SRC
  )({
    readings: readings({ defectRate: 0 }),
    targets,
    config,
  });
  near(score.componentScores.defect, 100, "zero defects");
});

test("AC-0.6 SRS 10.3: composite is the weighted average with default weights 40/20/20/10/10", () => {
  const score = need(
    calc,
    "calculateSupervisorScore",
    SRC
  )({ readings: readings(), targets, config });
  near(score.totalScore, 79.5, "40x100 + 20x50 + 20x80 + 10x60 + 10x75 over 100");
});

test("AC-0.6 SRS 10.3: unavailable components drop out and remaining weights are re-normalized", () => {
  const f = need(calc, "calculateSupervisorScore", SRC);
  const score = f({
    readings: readings({
      qcoHitRate: null,
      attendance: { scheduledDays: 0, absentDays: 0, leaveDays: 0 },
    }),
    targets,
    config,
  });
  assert.equal(score.componentScores.qco, null);
  assert.equal(score.componentScores.attendance, null);
  near(score.totalScore, 82.5, "(40x100 + 20x50 + 20x80) / 80");
  assert.deepEqual(score.effectiveWeights, { efficiency: 50, defect: 25, firstHour: 25 });
});

test("AC-0.6 SRS 10.3: no component reading gives a null total, not zero", () => {
  const f = need(calc, "calculateSupervisorScore", SRC);
  const score = f({
    readings: {
      efficiency: null,
      defectRate: null,
      firstHourHitRate: null,
      qcoHitRate: null,
      attendance: null,
    },
    targets,
    config,
  });
  assert.equal(score.totalScore, null);
});

test("AC-0.6 a target of zero or missing makes that component unavailable", () => {
  const f = need(calc, "calculateSupervisorScore", SRC);
  const score = f({
    readings: readings(),
    targets: { ...targets, efficiency: 0, qco: undefined },
    config,
  });
  assert.equal(score.componentScores.efficiency, null);
  assert.equal(score.componentScores.qco, null);
});

test("AC-0.6 architecture 8.4/9.3: the result carries inputs, scores and the config version, deterministically", () => {
  const f = need(calc, "calculateSupervisorScore", SRC);
  const first = f({ readings: readings(), targets, config });
  const again = f({ readings: readings(), targets, config });
  assert.deepEqual(first, again, "same inputs and config version give the same result");
  assert.equal(first.configVersion, "felix-default-v1");
  assert.equal(first.windowDays, 90);
  assert.deepEqual(first.componentInputs.targets, targets);
  assert.equal(first.componentInputs.readings.efficiency, 90);
  const v2 = f({
    readings: readings(),
    targets,
    config: { ...config, version: "felix-default-v2" },
  });
  assert.equal(v2.configVersion, "felix-default-v2");
});

test("AC-0.6 SRS 10.3: the rolling 90-day window ends on the as-of date, inclusive", () => {
  const scoreWindow = need(calc, "scoreWindow", SRC);
  assert.deepEqual(scoreWindow("2026-03-31", 90), { from: "2026-01-01", to: "2026-03-31" });
  assert.deepEqual(scoreWindow("2026-03-31", 1), { from: "2026-03-31", to: "2026-03-31" });
  assert.throws(() => scoreWindow("2026-03-31", 0));
});

const version = (number, effectiveFrom, effectiveTo, values) => ({
  version: number,
  effectiveFrom,
  effectiveTo,
  values,
});

test("AC-0.6 SRS 10.4: targets inherit System -> Tenant -> Factory and record the version applied", () => {
  const resolveTargets = need(calc, "resolveTargets", SRC);
  const resolved = resolveTargets(
    {
      system: [
        version(1, "2020-01-01", null, { efficiency: 70, defectRate: 3, firstHour: 70, qco: 80 }),
      ],
      tenant: [version(4, "2026-01-01", null, { efficiency: 80, defectRate: 2 })],
      factory: [version(2, "2026-02-01", null, { efficiency: 85 })],
    },
    "2026-03-15"
  );
  assert.deepEqual(resolved.values, { efficiency: 85, defectRate: 2, firstHour: 70, qco: 80 });
  assert.deepEqual(resolved.sources.efficiency, { level: "factory", version: 2 });
  assert.deepEqual(resolved.sources.defectRate, { level: "tenant", version: 4 });
  assert.deepEqual(resolved.sources.qco, { level: "system", version: 1 });
});

test("AC-0.6 SRS 10.4: a past date reconstructs the targets that applied then", () => {
  const resolveTargets = need(calc, "resolveTargets", SRC);
  const levels = {
    system: [version(1, "2020-01-01", null, { efficiency: 70 })],
    tenant: [
      version(1, "2026-01-01", "2026-02-28", { efficiency: 75 }),
      version(2, "2026-03-01", null, { efficiency: 80 }),
    ],
  };
  assert.equal(resolveTargets(levels, "2026-02-10").values.efficiency, 75);
  assert.equal(resolveTargets(levels, "2026-03-10").values.efficiency, 80);
  assert.deepEqual(resolveTargets(levels, "2026-02-10").sources.efficiency, {
    level: "tenant",
    version: 1,
  });
  assert.equal(
    resolveTargets(levels, "2025-06-01").values.efficiency,
    70,
    "before the tenant default: system default"
  );
});
