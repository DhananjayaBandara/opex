// Organization rules (SRS 6, FR-ORG-001..007; decisions D21, D22). Pure validation and the
// description of each kind of master data: what it is called in storage, which permission manages
// it, what it hangs from and which fields a caller may set or change. Orchestration (authorization,
// parents, transactions, audit) lives in services/organization.js.
// Browser-safe: no Node imports.
import { validateName } from "./tenancy.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MINUTES = 24 * 60;

// Codes are short upper-case identifiers, so "x" and "X" are one factory (FR-ORG-006).
export function normalizeCode(value) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!CODE.test(code)) {
    throw fail("invalid_code", "a code is 1 to 20 letters, digits, hyphens or underscores");
  }
  return code;
}

function minutesOf(value, label) {
  const match = typeof value === "string" ? CLOCK_TIME.exec(value) : null;
  if (!match) throw fail("invalid_time", `${label} must be a time such as 08:00`);
  return Number(match[1]) * 60 + Number(match[2]);
}

// A shift that ends earlier than it starts crosses midnight (FR-ORG-003); equal times are not a shift.
export function shiftSpan(startTime, endTime) {
  const start = minutesOf(startTime, "the start time");
  const end = minutesOf(endTime, "the end time");
  if (start === end) {
    throw fail("invalid_shift_times", "a shift cannot start and end at the same time");
  }
  const overnight = end < start;
  return Object.freeze({
    durationMinutes: overnight ? DAY_MINUTES - start + end : end - start,
    overnight,
  });
}

export function validateDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw fail("invalid_date", "a date is written YYYY-MM-DD");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real) throw fail("invalid_date", `${value} is not a real calendar date`);
  return value;
}

// Weekdays are 0 (Sunday) to 6 (Saturday), stored sorted and without repeats.
export function validateWeekdays(value) {
  if (
    !Array.isArray(value) ||
    !value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  ) {
    throw fail("invalid_weekdays", "weekdays are whole numbers from 0 (Sunday) to 6 (Saturday)");
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

// A dated exception always wins over the weekly pattern (decision C11, D22).
export function isWorkingDay(calendar, exceptions, date) {
  validateDate(date);
  const exception = exceptions.find((candidate) => candidate.date === date);
  if (exception) return exception.working === true;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return !(calendar.nonWorkingWeekdays ?? []).includes(weekday);
}

const optionalText = (value, label) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 120) {
    throw fail("invalid_field", `${label} must be text of at most 120 characters`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const flag = (value, label) => {
  if (typeof value !== "boolean") throw fail("invalid_field", `${label} must be true or false`);
  return value;
};

const nameFields = (value) => {
  const name = validateName(value);
  return { name, nameKey: name.toLowerCase() };
};

function machineCount(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw fail("invalid_machine_count", "the machine count is a whole number, zero or more");
  }
  return value;
}

// ---- Kinds ----------------------------------------------------------------------------------
// `parents` are the links a row is created under (the first decides the factory). `controlled` are
// fields the service sets itself, so a caller cannot edit them: changing them is `immutable_field`.
// `build` validates a new row's own fields; `change` validates the editable fields of an update.
// `referencedBy` lists [collection, field] pairs whose rows block a delete (FR-ORG-007); later
// slices append here when orders or production reference this data.
// `activeChildren` lists the pairs that must already be inactive before this row can be deactivated.
const present = (patch, field) => patch[field] !== undefined;

export const KINDS = Object.freeze({
  factory: Object.freeze({
    collection: "factories",
    permission: "factory.manage",
    ordered: true,
    hasActive: true,
    parents: [],
    controlled: ["active", "sortOrder"],
    referencedBy: [
      ["sections", "factoryId"],
      ["shifts", "factoryId"],
      ["calendars", "factoryId"],
      ["employees", "factoryId"],
      ["buyerOrders", "factoryId"],
      ["capacityBookings", "factoryId"],
      ["rfqs", "factoryId"],
      ["purchaseOrders", "factoryId"],
      ["goodsReceipts", "factoryId"],
      ["stockMovements", "factoryId"],
      ["requisitions", "factoryId"],
      ["invoices", "factoryId"],
    ],
    activeChildren: [
      ["sections", "factoryId"],
      ["shifts", "factoryId"],
      ["calendars", "factoryId"],
    ],
    build: (input) => ({
      code: normalizeCode(input.code),
      name: validateName(input.name),
      location: optionalText(input.location, "the location"),
    }),
    change: (patch) => ({
      ...(present(patch, "code") && { code: normalizeCode(patch.code) }),
      ...(present(patch, "name") && { name: validateName(patch.name) }),
      ...(present(patch, "location") && { location: optionalText(patch.location, "the location") }),
    }),
  }),
  section: Object.freeze({
    collection: "sections",
    permission: "structure.manage",
    ordered: true,
    hasActive: true,
    parents: [{ field: "factoryId", kind: "factory" }],
    controlled: ["factoryId", "active", "sortOrder"],
    referencedBy: [
      ["lines", "sectionId"],
      ["sectionShifts", "sectionId"],
      ["employees", "sectionId"],
    ],
    activeChildren: [
      ["lines", "sectionId"],
      ["sectionShifts", "sectionId"],
    ],
    build: (input) => ({ code: normalizeCode(input.code), ...nameFields(input.name) }),
    change: (patch) => ({
      ...(present(patch, "code") && { code: normalizeCode(patch.code) }),
      ...(present(patch, "name") && nameFields(patch.name)),
    }),
  }),
  shift: Object.freeze({
    collection: "shifts",
    permission: "structure.manage",
    ordered: true,
    hasActive: true,
    parents: [{ field: "factoryId", kind: "factory" }],
    controlled: ["factoryId", "active", "sortOrder", "durationMinutes", "overnight"],
    referencedBy: [
      ["sectionShifts", "shiftId"],
      ["attendanceRecords", "shiftId"],
      ["capacityBookings", "shiftId"],
    ],
    activeChildren: [["sectionShifts", "shiftId"]],
    build: (input) => ({
      code: normalizeCode(input.code),
      ...nameFields(input.name),
      startTime: input.startTime,
      endTime: input.endTime,
      ...shiftSpan(input.startTime, input.endTime),
    }),
    change: (patch, existing) => {
      const timesChanged = present(patch, "startTime") || present(patch, "endTime");
      const startTime = patch.startTime ?? existing.startTime;
      const endTime = patch.endTime ?? existing.endTime;
      return {
        ...(present(patch, "code") && { code: normalizeCode(patch.code) }),
        ...(present(patch, "name") && nameFields(patch.name)),
        ...(timesChanged && { startTime, endTime, ...shiftSpan(startTime, endTime) }),
      };
    },
  }),
  sectionShift: Object.freeze({
    collection: "sectionShifts",
    permission: "section_shift.manage",
    ordered: false,
    hasActive: true,
    parents: [
      { field: "sectionId", kind: "section" },
      { field: "shiftId", kind: "shift" },
    ],
    controlled: ["sectionId", "shiftId", "factoryId", "active"],
    referencedBy: [
      ["supervisorAssignments", "sectionShiftId"],
      ["attendanceRecords", "sectionShiftId"],
    ],
    activeChildren: [],
    build: () => ({}),
    change: () => ({}),
  }),
  line: Object.freeze({
    collection: "lines",
    permission: "structure.manage",
    ordered: false,
    hasActive: true,
    parents: [{ field: "sectionId", kind: "section" }],
    controlled: ["sectionId", "factoryId", "active"],
    referencedBy: [["capacityBookings", "productionLineId"]],
    activeChildren: [],
    build: (input) => ({
      ...nameFields(input.name),
      machineCount: input.machineCount === undefined ? 0 : machineCount(input.machineCount),
    }),
    change: (patch) => ({
      ...(present(patch, "name") && nameFields(patch.name)),
      ...(present(patch, "machineCount") && { machineCount: machineCount(patch.machineCount) }),
    }),
  }),
  designation: Object.freeze({
    collection: "designations",
    permission: "employee.manage",
    ordered: false,
    hasActive: true,
    tenantWide: true,
    parents: [],
    controlled: ["active"],
    referencedBy: [["employees", "designationId"]],
    activeChildren: [],
    build: (input) => ({
      ...nameFields(input.name),
      supervisorEligible:
        input.supervisorEligible === undefined
          ? false
          : flag(input.supervisorEligible, "supervisor eligibility"),
    }),
    change: (patch) => ({
      ...(present(patch, "name") && nameFields(patch.name)),
      ...(present(patch, "supervisorEligible") && {
        supervisorEligible: flag(patch.supervisorEligible, "supervisor eligibility"),
      }),
    }),
  }),
  calendar: Object.freeze({
    collection: "calendars",
    permission: "structure.manage",
    ordered: false,
    hasActive: true,
    parents: [{ field: "factoryId", kind: "factory" }],
    controlled: ["factoryId", "active"],
    referencedBy: [
      ["calendarExceptions", "calendarId"],
      ["capacityBookings", "calendarId"],
    ],
    activeChildren: [],
    build: (input) => ({
      ...nameFields(input.name),
      nonWorkingWeekdays: validateWeekdays(input.nonWorkingWeekdays ?? []),
    }),
    change: (patch) => ({
      ...(present(patch, "name") && nameFields(patch.name)),
      ...(present(patch, "nonWorkingWeekdays") && {
        nonWorkingWeekdays: validateWeekdays(patch.nonWorkingWeekdays),
      }),
    }),
  }),
  calendarException: Object.freeze({
    collection: "calendarExceptions",
    permission: "structure.manage",
    ordered: false,
    hasActive: false,
    parents: [{ field: "calendarId", kind: "calendar" }],
    controlled: ["calendarId", "factoryId", "date"],
    referencedBy: [],
    activeChildren: [],
    build: (input) => ({
      date: validateDate(input.date),
      working: flag(input.working, "working"),
      reason: optionalText(input.reason, "the reason"),
    }),
    change: (patch) => ({
      ...(present(patch, "working") && { working: flag(patch.working, "working") }),
      ...(present(patch, "reason") && { reason: optionalText(patch.reason, "the reason") }),
    }),
  }),
});

export function kindOf(name) {
  if (typeof name !== "string" || !Object.hasOwn(KINDS, name)) {
    throw fail("unknown_kind", `${String(name)} is not a kind of organization data`);
  }
  return KINDS[name];
}
