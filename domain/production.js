// Production rules (SRS 8.4, 10.1, 10.2; FR-PROD-001..010; decisions D34 to D41).
// Pure validation and arithmetic for styles, plans, production days, hourly output, events and the
// day's status. Orchestration (authorization, lookups, transactions, audit) lives in
// services/production.js. Browser-safe: no Node imports.
import { calculateProductionDay } from "./calculations.js";
import { normalizeCode } from "./organization.js";
import { validateName } from "./tenancy.js";
import { blank, optionalText, requireReason } from "./workforce.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

// A number the caller typed, which may arrive as text from a form.
function toNumber(value, label) {
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (isNumber(value)) return value;
  throw fail("invalid_number", `${label} must be a number`);
}

function wholeNumber(value, label, { min = 0, max = 1_000_000 } = {}) {
  const number = toNumber(value, label);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw fail("invalid_number", `${label} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

// A reading that may be left blank (null): blank is not zero (FR-PROD-003).
function optionalWhole(value, label, bounds) {
  return blank(value) ? null : wholeNumber(value, label, bounds);
}

// ---- Styles (D34) -------------------------------------------------------------------------------

function validSmv(value) {
  const smv = toNumber(value, "the SMV");
  if (!(smv > 0) || smv > 500) throw fail("invalid_smv", "the SMV must be above 0 and at most 500");
  return smv;
}

export function buildStyle(input) {
  return {
    code: normalizeCode(input.code),
    name: validateName(input.name, "the style name"),
    buyer: optionalText(input.buyer, "the buyer", 120),
    smv: validSmv(input.smv),
  };
}

export function changeStyle(patch) {
  const present = (field) => patch[field] !== undefined;
  return {
    ...(present("code") && { code: normalizeCode(patch.code) }),
    ...(present("name") && { name: validateName(patch.name, "the style name") }),
    ...(present("buyer") && { buyer: optionalText(patch.buyer, "the buyer", 120) }),
    ...(present("smv") && { smv: validSmv(patch.smv) }),
  };
}

// ---- Plans (D35) --------------------------------------------------------------------------------

export const MAX_WORKING_HOURS = 16;

// The values of one plan revision. Ids (line, shift, style) are checked by the service, which has
// the rows.
export function buildPlan(input) {
  const efficiency = toNumber(input.plannedEfficiency, "the planned efficiency");
  if (!(efficiency > 0) || efficiency > 100) {
    throw fail("invalid_efficiency", "the planned efficiency must be above 0 and at most 100");
  }
  return {
    orderRef: optionalText(input.orderRef, "the order reference", 40),
    hourlyTarget: wholeNumber(input.hourlyTarget, "the hourly target", { min: 1, max: 100_000 }),
    workingHours: wholeNumber(input.workingHours, "the working hours", {
      min: 1,
      max: MAX_WORKING_HOURS,
    }),
    plannedEfficiency: efficiency,
    plannedMCOperators: wholeNumber(input.plannedMCOperators ?? 0, "the planned operators", {
      max: 5000,
    }),
    plannedManual: wholeNumber(input.plannedManual ?? 0, "the planned manual workers", {
      max: 5000,
    }),
  };
}

// The fields a day copies from the plan (D36) and a revision comparison looks at.
export const PLAN_FIELDS = Object.freeze([
  "orderRef",
  "hourlyTarget",
  "workingHours",
  "plannedEfficiency",
  "plannedMCOperators",
  "plannedManual",
]);

export const pickPlan = (row) => Object.fromEntries(PLAN_FIELDS.map((f) => [f, row[f] ?? null]));

// The target of each working hour. The prototype's plan has one hourly target (D37), so every hour
// shares it; the shape allows a plan with a ramp-up later.
export function hourTargets(plan) {
  return Array.from({ length: plan.workingHours }, (_, index) => ({
    ordinalHour: index + 1,
    target: plan.hourlyTarget,
  }));
}

// ---- Production day and hours (D36, D37) --------------------------------------------------------

export const DAY_STATUSES = Object.freeze(["draft", "pending_approval", "approved"]);

// The present manpower and QCO of a day; each may stay blank.
const DAY_INPUTS = Object.freeze(["presentMCOperators", "presentHelpers", "presentManual"]);

export function buildDayInputs(patch) {
  const values = {};
  for (const field of DAY_INPUTS) {
    if (patch[field] !== undefined) {
      values[field] = optionalWhole(patch[field], `the ${field} count`, { max: 5000 });
    }
  }
  if (patch.qcoHitRate !== undefined) {
    if (blank(patch.qcoHitRate)) values.qcoHitRate = null;
    else {
      const qco = toNumber(patch.qcoHitRate, "the QCO percentage");
      if (qco < 0 || qco > 100) throw fail("invalid_qco", "the QCO percentage is from 0 to 100");
      values.qcoHitRate = qco;
    }
  }
  if (patch.notes !== undefined) values.notes = optionalText(patch.notes, "the notes", 500);
  return values;
}

// One hour row after a patch. Damage cannot exceed output and needs it (D37).
export function buildHour(current, patch, workingHours) {
  const ordinal = current.ordinalHour;
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > workingHours) {
    throw fail("invalid_hour", `hour ${String(ordinal)} is not one of the ${workingHours} hours`);
  }
  const next = {
    actualPieces: current.actualPieces ?? null,
    damagePieces: current.damagePieces ?? null,
  };
  if (patch.actualPieces !== undefined) {
    next.actualPieces = optionalWhole(patch.actualPieces, `the output of hour ${ordinal}`);
  }
  if (patch.damagePieces !== undefined) {
    next.damagePieces = optionalWhole(patch.damagePieces, `the damaged pieces of hour ${ordinal}`);
  }
  if (next.actualPieces === null && next.damagePieces !== null) {
    throw fail("damage_without_output", `enter the output of hour ${ordinal} before its damage`);
  }
  if (next.damagePieces !== null && next.damagePieces > next.actualPieces) {
    throw fail(
      "damage_exceeds_output",
      `hour ${ordinal}: damaged pieces cannot be more than the output`
    );
  }
  return next;
}

// ---- Events and downtime (D38) ------------------------------------------------------------------

export const EVENT_CODES = Object.freeze({
  power_cut: "Power cut",
  machine_breakdown: "Machine breakdown",
  material_shortage: "Material shortage",
  style_changeover: "Style changeover",
  absenteeism: "Absenteeism",
  quality_hold: "Quality hold",
  waiting_instruction: "Waiting for instruction",
  other: "Other",
});

export function buildEvent(input, { workingHours }) {
  if (!Object.hasOwn(EVENT_CODES, input.code)) {
    throw fail("invalid_event", `choose an event code (${Object.keys(EVENT_CODES).join(", ")})`);
  }
  const note = optionalText(input.note, "the note", 200);
  if (input.code === "other" && note === null) {
    throw fail("note_required", "describe the event in a note when the code is other");
  }
  return {
    code: input.code,
    minutes: wholeNumber(input.minutes, "the minutes", { min: 1, max: workingHours * 60 }),
    ordinalHour: optionalWhole(input.ordinalHour, "the hour", { min: 1, max: workingHours }),
    note,
  };
}

export const downtimeMinutes = (events) => events.reduce((sum, event) => sum + event.minutes, 0);

// ---- Status machine (D39, D40) ------------------------------------------------------------------

export const TRANSITIONS = Object.freeze({
  submit: { from: "draft", to: "pending_approval" },
  approve: { from: "pending_approval", to: "approved" },
  return: { from: "pending_approval", to: "draft" },
});

const PAST_TENSE = Object.freeze({ submit: "submitted", approve: "approved", return: "returned" });

export function requireTransition(action, status) {
  const rule = TRANSITIONS[action];
  if (status !== rule.from) {
    throw fail(
      "invalid_transition",
      `a day that is ${status.replaceAll("_", " ")} cannot be ${PAST_TENSE[action]}`
    );
  }
  return rule.to;
}

export const requireEditable = (status) => {
  if (status !== "draft") {
    throw fail(
      "not_editable",
      status === "approved"
        ? "an approved day cannot be edited; ask for a correction"
        : "a day waiting for approval cannot be edited; it must be returned first"
    );
  }
};

export { requireReason };

// ---- Daily Close (D39) --------------------------------------------------------------------------

// What stops a submit (blockers) and what needs a decision (warnings).
export function closeCheck(day, hours, plan) {
  const entered = hours.filter((hour) => isNumber(hour.actualPieces));
  const blockers = [];
  const warnings = [];
  if (entered.length === 0) blockers.push("Enter the output of at least one hour.");
  const manpower = ["presentMCOperators", "presentHelpers", "presentManual"].map((f) => day[f]);
  if (manpower.every((value) => value === null || value === undefined)) {
    blockers.push("Enter the present manpower (operators, helpers or manual).");
  }
  if (entered.length > 0) {
    const last = Math.max(...entered.map((hour) => hour.ordinalHour));
    const gaps = hours
      .filter((hour) => hour.ordinalHour < last && !isNumber(hour.actualPieces))
      .map((hour) => hour.ordinalHour);
    if (gaps.length > 0) {
      warnings.push(
        `Hour ${gaps.join(", ")} ${gaps.length > 1 ? "have" : "has"} no output but a later hour does.`
      );
    }
    if (last < plan.workingHours) {
      warnings.push(`Only ${last} of ${plan.workingHours} hours have been entered.`);
    }
  }
  return Object.freeze({ blockers, warnings, ready: blockers.length === 0 });
}

// ---- Metrics (D13, D37) -------------------------------------------------------------------------

// The server's computation of a day: SRS 10.1 and 10.2 over the plan snapshot, the day's present
// manpower and its hours, plus the per-hour target, cumulative figures and hit rate of each hour.
export function computeDay({ day, plan, style, hours }) {
  const planInput = {
    ...plan,
    presentMCOperators: day.presentMCOperators,
    presentHelpers: day.presentHelpers,
    presentManual: day.presentManual,
  };
  const metrics = calculateProductionDay(planInput, style, hours);
  const targets = new Map(hourTargets(plan).map((row) => [row.ordinalHour, row.target]));
  let cumulativeActual = 0;
  let cumulativeTarget = 0;
  const rows = [...hours]
    .sort((a, b) => a.ordinalHour - b.ordinalHour)
    .map((hour) => {
      const target = targets.get(hour.ordinalHour) ?? null;
      cumulativeTarget += target ?? 0;
      const entered = isNumber(hour.actualPieces);
      if (entered) cumulativeActual += hour.actualPieces;
      return {
        ordinalHour: hour.ordinalHour,
        actualPieces: hour.actualPieces ?? null,
        damagePieces: hour.damagePieces ?? null,
        target,
        hitRate: entered && target ? (hour.actualPieces / target) * 100 : null,
        cumulativeActual: entered ? cumulativeActual : null,
        cumulativeTarget,
      };
    });
  return { metrics, hours: rows };
}

// The values a correction compares and keeps (D40).
export function dayFigures(day, hours) {
  return {
    presentMCOperators: day.presentMCOperators ?? null,
    presentHelpers: day.presentHelpers ?? null,
    presentManual: day.presentManual ?? null,
    qcoHitRate: day.qcoHitRate ?? null,
    hours: [...hours]
      .sort((a, b) => a.ordinalHour - b.ordinalHour)
      .map(({ ordinalHour, actualPieces, damagePieces }) => ({
        ordinalHour,
        actualPieces: actualPieces ?? null,
        damagePieces: damagePieces ?? null,
      })),
  };
}
