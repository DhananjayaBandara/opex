// Workforce rules (SRS 6, 8.3, 10.3, 13.4; FR-SUPA-001..005, FR-ATT-001/002; decisions D27 to D33).
// Pure validation and arithmetic: employees, supervisor assignments and attendance. Orchestration
// (authorization, lookups, transactions, audit) lives in services/employees.js, assignments.js and
// attendance.js.
// Browser-safe: no Node imports.
import { attendanceScore } from "./calculations.js";
import { addDays, evaluateOverlap, validateRange } from "./effective-dating.js";
import { isWorkingDay, normalizeCode, validateDate } from "./organization.js";
import { normalizeEmail, validateName } from "./tenancy.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const blank = (value) => value === undefined || value === null || value === "";

// ---- Employees (D27) ----------------------------------------------------------------------------

export const EMPLOYEE_STATUSES = Object.freeze(["active", "on_leave", "inactive"]);

const PHONE = /^[0-9+()\- ]{5,30}$/;

function optionalEmail(value) {
  return blank(value) ? null : normalizeEmail(value);
}

function optionalPhone(value) {
  if (blank(value)) return null;
  const phone = typeof value === "string" ? value.trim() : "";
  if (!PHONE.test(phone)) throw fail("invalid_phone", "a phone number is 5 to 30 digits and +()- ");
  return phone;
}

export function optionalText(value, label, max = 200) {
  if (blank(value)) return null;
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw fail("invalid_field", `${label} must be at most ${max} characters`);
  return text === "" ? null : text;
}

// A reason is required for the actions that end or rewrite something (D27, D33).
export function requireReason(value, label = "a reason") {
  const text = optionalText(value, label);
  if (text === null) throw fail("reason_required", `${label} is required`);
  return text;
}

// The fields of a new employee that need no lookup. Ids (section, designation, user) are checked
// by the service, because they need the rows.
export function buildEmployee(input) {
  return {
    employeeCode: normalizeCode(input.employeeCode),
    name: validateName(input.name, "the name"),
    email: optionalEmail(input.email),
    phone: optionalPhone(input.phone),
    joinDate: validateDate(input.joinDate),
  };
}

export function changeEmployee(patch) {
  const present = (field) => patch[field] !== undefined;
  return {
    ...(present("employeeCode") && { employeeCode: normalizeCode(patch.employeeCode) }),
    ...(present("name") && { name: validateName(patch.name, "the name") }),
    ...(present("email") && { email: optionalEmail(patch.email) }),
    ...(present("phone") && { phone: optionalPhone(patch.phone) }),
    ...(present("joinDate") && { joinDate: validateDate(patch.joinDate) }),
  };
}

export function validateEmployeeStatus(status, reason) {
  if (!EMPLOYEE_STATUSES.includes(status)) {
    throw fail("invalid_status", `status must be one of ${EMPLOYEE_STATUSES.join(", ")}`);
  }
  return {
    status,
    statusReason:
      status === "inactive" ? requireReason(reason) : optionalText(reason, "the reason"),
  };
}

// ---- Supervisor assignments (D31, D32) ----------------------------------------------------------

export const OVERLAP_POLICIES = Object.freeze(["warn", "block", "allow"]);

export function validatePolicy(policy) {
  if (!OVERLAP_POLICIES.includes(policy)) {
    throw fail(
      "invalid_policy",
      `the overlap policy must be one of ${OVERLAP_POLICIES.join(", ")}`
    );
  }
  return policy;
}

// An assignment is `scheduled` before it starts, `current` while it is in effect and `ended` after.
export function assignmentStatus(row, today) {
  if (row.effectiveFrom > today) return "scheduled";
  if (row.effectiveTo !== null && row.effectiveTo < today) return "ended";
  return "current";
}

// Not yet ended: the assignment is in effect or will be.
export const isLive = (row, today) => assignmentStatus(row, today) !== "ended";

export function validateAssignmentDates(input, today) {
  const range = validateRange({
    effectiveFrom: input.effectiveFrom,
    effectiveTo: blank(input.effectiveTo) ? null : input.effectiveTo,
  });
  if (range.effectiveFrom < today) {
    throw fail("past_effective_date", `an assignment cannot start before today (${today})`);
  }
  return { effectiveFrom: range.effectiveFrom, effectiveTo: range.effectiveTo ?? null };
}

// FR-SUPA-003. The same person twice on one SectionShift is never allowed. Another SectionShift for
// the same person, or another person on the same SectionShift, is a conflict that the tenant's
// policy rules on: `warn` asks for an acknowledgement, `block` refuses, `allow` accepts.
// `rows` are the assignments that exist (the one being replaced already end-dated).
export function assessAssignment(rows, incoming, policy = "warn") {
  validatePolicy(policy);
  const duplicates = rows.filter(
    (row) =>
      row.employeeId === incoming.employeeId &&
      row.sectionShiftId === incoming.sectionShiftId &&
      overlapsRange(row, incoming)
  );
  const elsewhere = evaluateOverlap(rows, incoming, {
    policy,
    sameSubject: (row, next) =>
      row.employeeId === next.employeeId && row.sectionShiftId !== next.sectionShiftId,
  });
  const shared = evaluateOverlap(rows, incoming, {
    policy,
    sameSubject: (row, next) =>
      row.sectionShiftId === next.sectionShiftId && row.employeeId !== next.employeeId,
  });
  const conflicts = [
    ...elsewhere.conflicts.map((row) => ({ kind: "employee_elsewhere", row })),
    ...shared.conflicts.map((row) => ({ kind: "section_shift_shared", row })),
  ];
  const status =
    duplicates.length > 0 || elsewhere.status === "blocked" || shared.status === "blocked"
      ? "blocked"
      : elsewhere.status === "warning" || shared.status === "warning"
        ? "warning"
        : "ok";
  return Object.freeze({ status, duplicate: duplicates.length > 0, conflicts });
}

function overlapsRange(a, b) {
  const aEndsBefore = a.effectiveTo !== null && a.effectiveTo < b.effectiveFrom;
  const bEndsBefore = b.effectiveTo !== null && b.effectiveTo < a.effectiveFrom;
  return !aEndsBefore && !bEndsBefore;
}

// ---- Attendance (D4, D9, D30, D33) --------------------------------------------------------------

export const ATTENDANCE_STATUSES = Object.freeze(["P", "AB", "LV"]);
export const LEAVE_TYPES = Object.freeze(["annual", "casual", "medical", "other"]);

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = 24 * 60;

function clockMinutes(value, label) {
  const match = typeof value === "string" ? CLOCK.exec(value) : null;
  if (!match) throw fail("invalid_time", `${label} must be a time such as 08:00`);
  return Number(match[1]) * 60 + Number(match[2]);
}

// Minutes worked, late and overtime for one present day. A shift that crosses midnight is handled
// by moving the clock readings onto one timeline that starts at the shift start.
export function deriveMinutes(shift, clockIn, clockOut) {
  const start = clockMinutes(shift.startTime, "the shift start");
  const end = clockMinutes(shift.endTime, "the shift end");
  const overnight = end < start;
  const arrived = clockMinutes(clockIn, "the clock-in time");
  const left = clockMinutes(clockOut, "the clock-out time");
  const inTime = overnight && arrived <= end ? arrived + DAY : arrived;
  let outTime = left + (inTime - arrived);
  if (outTime < inTime) outTime += DAY;
  if (outTime === inTime) {
    throw fail("invalid_clock", "clock-in and clock-out cannot be the same time");
  }
  if (!overnight && left < arrived) {
    throw fail("invalid_clock", "clock-out must be after clock-in for a shift within one day");
  }
  const shiftEnd = overnight ? end + DAY : end;
  return {
    workedMinutes: outTime - inTime,
    lateMinutes: Math.max(0, inTime - start),
    overtimeMinutes: Math.max(0, outTime - shiftEnd),
  };
}

// The values of one attendance record (without who and where). `P` needs both clock times or
// neither; `LV` needs a leave type; the other statuses carry neither.
export function buildAttendance(input, shift) {
  const status = input.status;
  if (!ATTENDANCE_STATUSES.includes(status)) {
    throw fail("invalid_status", `status must be one of ${ATTENDANCE_STATUSES.join(", ")}`);
  }
  const note = optionalText(input.note, "the note");
  if (status === "LV") {
    if (!LEAVE_TYPES.includes(input.leaveType)) {
      throw fail("leave_type_required", `choose the leave type (${LEAVE_TYPES.join(", ")})`);
    }
  } else if (!blank(input.leaveType)) {
    throw fail("invalid_field", "only a leave day has a leave type");
  }
  const timed = !blank(input.clockIn) || !blank(input.clockOut);
  if (status !== "P" && timed) {
    throw fail("invalid_field", "only a present day has clock times");
  }
  const none = {
    clockIn: null,
    clockOut: null,
    workedMinutes: 0,
    lateMinutes: 0,
    overtimeMinutes: 0,
  };
  if (status !== "P" || !timed) {
    return { status, leaveType: status === "LV" ? input.leaveType : null, note, ...none };
  }
  if (blank(input.clockIn) || blank(input.clockOut)) {
    throw fail("clock_times_incomplete", "give both the clock-in and the clock-out time");
  }
  return {
    status,
    leaveType: null,
    note,
    clockIn: input.clockIn,
    clockOut: input.clockOut,
    ...deriveMinutes(shift, input.clockIn, input.clockOut),
  };
}

// The fields a correction compares and keeps in its history.
export const ATTENDANCE_FIELDS = Object.freeze([
  "status",
  "leaveType",
  "clockIn",
  "clockOut",
  "workedMinutes",
  "lateMinutes",
  "overtimeMinutes",
  "note",
]);

export const pickAttendance = (row) =>
  Object.fromEntries(ATTENDANCE_FIELDS.map((field) => [field, row[field] ?? null]));

export function validateMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw fail("invalid_month", "a month is written YYYY-MM");
  }
  return value;
}

export function monthBounds(month) {
  validateMonth(month);
  const first = `${month}-01`;
  const [year, number] = month.split("-").map(Number);
  const last = addDays(
    `${number === 12 ? year + 1 : year}-${String(number === 12 ? 1 : number + 1).padStart(2, "0")}-01`,
    -1
  );
  return { first, last };
}

// D30: the days an employee is scheduled in a month are the working days of the factory's calendar,
// from the later of the month start and the join date to the earlier of the month end and today. A
// factory without a calendar works Monday to Saturday.
export function scheduledDates({ calendar, exceptions, month, joinDate, today }) {
  const { first, last } = monthBounds(month);
  return scheduledDatesBetween({ calendar, exceptions, from: first, to: last, joinDate, today });
}

// The same rule over any range (a score window, D46): from the later of the range start and the
// join date to the earlier of the range end and today.
export function scheduledDatesBetween({ calendar, exceptions, from, to, joinDate, today }) {
  const start = joinDate > from ? joinDate : from;
  const end = today < to ? today : to;
  const pattern = calendar ?? { nonWorkingWeekdays: [0] };
  const dates = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (isWorkingDay(pattern, exceptions ?? [], date)) dates.push(date);
  }
  return dates;
}

// A day counts once: present if any shift was attended, else leave, else absent.
const DAY_RANK = { P: 0, LV: 1, AB: 2 };

export function summarizeAttendance({ records, scheduled }) {
  const byDate = new Map();
  for (const record of records) {
    const known = byDate.get(record.date);
    if (known === undefined || DAY_RANK[record.status] < DAY_RANK[known]) {
      byDate.set(record.date, record.status);
    }
  }
  let presentDays = 0;
  let absentDays = 0;
  let leaveDays = 0;
  let unrecordedDays = 0;
  for (const date of scheduled) {
    const status = byDate.get(date);
    if (status === "P") presentDays += 1;
    else if (status === "AB") absentDays += 1;
    else if (status === "LV") leaveDays += 1;
    else unrecordedDays += 1;
  }
  const sum = (field) => records.reduce((total, record) => total + (record[field] ?? 0), 0);
  return Object.freeze({
    scheduledDays: scheduled.length,
    presentDays,
    absentDays,
    leaveDays,
    unrecordedDays,
    workedMinutes: sum("workedMinutes"),
    lateMinutes: sum("lateMinutes"),
    overtimeMinutes: sum("overtimeMinutes"),
    attendanceScore: attendanceScore({
      scheduledDays: scheduled.length,
      absentDays,
      leaveDays,
    }),
  });
}
