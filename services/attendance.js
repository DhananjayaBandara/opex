// Attendance (UC-PEO-03, FR-ATT-001/002, SRS 10.3, 13.4; decisions D4, D9, D30, D33).
//
// One AttendanceRecord per employee, date and shift. A recorded day is corrected, never silently
// overwritten: a correction needs a reason and keeps the earlier values, who changed them and when.
// Worked, late and overtime minutes are derived from the clock times and the shift.
//
// Every call resolves the tenant and the caller's access from the context, never from the payload.
// Everything needs `attendance.manage` (WHAT, which also needs the attendance module) and a scope
// that covers the employee's factory and, for a member limited to their own assignments, the
// SectionShift of the employee and shift (WHERE), failing closed. Each write runs in one
// transaction with its audit event. Browser-safe: no Node imports.
import {
  ATTENDANCE_FIELDS,
  blank,
  buildAttendance,
  monthBounds,
  pickAttendance,
  requireReason,
  scheduledDates,
  summarizeAttendance,
  validateMonth,
} from "../domain/workforce.js";
import { validateDate } from "../domain/organization.js";
import { fail } from "./errors.js";

const MANAGE = "attendance.manage";
const RECORDS = "attendanceRecords";
const CORRECTIONS = "attendanceCorrections";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function createAttendance({ store, gate, clock }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  const allowed = (resolved, resource) => {
    try {
      gate.authorize(resolved, MANAGE, resource);
      return true;
    } catch {
      return false;
    }
  };

  // The SectionShift that runs a shift in an employee's section; absent when the section does not.
  const sectionShiftFor = (tx, sectionId, shiftId) =>
    tx.list("sectionShifts", (row) => row.sectionId === sectionId && row.shiftId === shiftId)[0] ??
    null;

  // The factory's working calendar (D30): the first active one, with its exceptions.
  function calendarOf(tx, factoryId) {
    const calendar = tx.list(
      "calendars",
      (row) => row.factoryId === factoryId && row.active !== false
    )[0];
    if (calendar === undefined) return { calendar: null, exceptions: [] };
    return {
      calendar,
      exceptions: tx.list("calendarExceptions", (row) => row.calendarId === calendar.id),
    };
  }

  function requireEmployee(tx, id) {
    const employee = typeof id === "string" ? tx.get("employees", id) : null;
    if (employee === null) throw fail("not_found", "that employee was not found");
    return employee;
  }

  function requireShift(tx, employee, id) {
    const shift = typeof id === "string" ? tx.get("shifts", id) : null;
    if (shift === null) throw fail("not_found", "that shift was not found");
    if (shift.factoryId !== employee.factoryId) {
      throw fail("cross_factory", "that shift belongs to another factory");
    }
    return shift;
  }

  function view(row, lookup) {
    const employee = lookup.employees.get(row.employeeId);
    const shift = lookup.shifts.get(row.shiftId);
    return Object.freeze({
      id: row.id,
      employeeId: row.employeeId,
      employeeCode: employee?.employeeCode ?? null,
      employeeName: employee?.name ?? null,
      factoryId: row.factoryId,
      sectionId: row.sectionId,
      sectionShiftId: row.sectionShiftId,
      shiftId: row.shiftId,
      shiftName: shift?.name ?? null,
      date: row.date,
      ...pickAttendance(row),
    });
  }

  function lookups(tx) {
    const by = (collection) => new Map(tx.list(collection).map((row) => [row.id, row]));
    return { employees: by("employees"), shifts: by("shifts"), sections: by("sections") };
  }

  return Object.freeze({
    // One employee, one date, one shift (FR-ATT-001). The date is a business date: not in the future
    // and not before they joined.
    record(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const employee = requireEmployee(tx, request.employeeId);
        const shift = requireShift(tx, employee, request.shiftId);
        const sectionShift = sectionShiftFor(tx, employee.sectionId, shift.id);
        gate.authorize(resolved, MANAGE, {
          factoryId: employee.factoryId,
          sectionShiftId: sectionShift?.id,
        });
        if (sectionShift === null || sectionShift.active === false) {
          throw fail("shift_not_run", "their section does not run that shift");
        }
        if (employee.status === "inactive") {
          throw fail("employee_not_active", "an inactive employee has no attendance to record");
        }
        const date = validateDate(request.date);
        if (date > resolved.today) {
          throw fail(
            "future_date",
            `attendance cannot be recorded after today (${resolved.today})`
          );
        }
        if (date < employee.joinDate) {
          throw fail("before_join_date", `they joined on ${employee.joinDate}`);
        }
        const existing = tx.list(
          RECORDS,
          (row) => row.employeeId === employee.id && row.date === date && row.shiftId === shift.id
        );
        if (existing.length > 0) {
          throw fail("already_recorded", "that day is already recorded; correct it instead");
        }
        const values = buildAttendance(request, shift);
        const row = tx.insert(RECORDS, {
          employeeId: employee.id,
          factoryId: employee.factoryId,
          sectionId: employee.sectionId,
          sectionShiftId: sectionShift.id,
          shiftId: shift.id,
          date,
          ...values,
        });
        return view(row, lookups(tx));
      });
    },

    // Rewrites a recorded day with a reason (D33). The earlier values stay in the correction row.
    correct(context, id, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = typeof id === "string" ? tx.get(RECORDS, id) : null;
        if (row === null) throw fail("not_found", "that attendance record was not found");
        gate.authorize(resolved, MANAGE, {
          factoryId: row.factoryId,
          sectionShiftId: row.sectionShiftId,
        });
        for (const [field, current] of [
          ["employeeId", row.employeeId],
          ["date", row.date],
          ["shiftId", row.shiftId],
        ]) {
          if (request[field] !== undefined && request[field] !== current) {
            throw fail("immutable_field", `${field} cannot be corrected`);
          }
        }
        const reason = requireReason(request.reason, "a reason for the correction");
        const shift = tx.get("shifts", row.shiftId);
        const merged = { ...pickAttendance(row) };
        for (const field of ["status", "leaveType", "clockIn", "clockOut", "note"]) {
          if (request[field] !== undefined)
            merged[field] = blank(request[field]) ? null : request[field];
        }
        // A day that stops being present, or stops being leave, drops what no longer applies.
        if (merged.status !== "P" && request.clockIn === undefined) merged.clockIn = null;
        if (merged.status !== "P" && request.clockOut === undefined) merged.clockOut = null;
        if (merged.status !== "LV" && request.leaveType === undefined) merged.leaveType = null;
        const after = buildAttendance(merged, shift);
        const before = pickAttendance(row);
        if (ATTENDANCE_FIELDS.every((field) => (after[field] ?? null) === before[field])) {
          throw fail("no_change", "nothing was changed");
        }
        tx.update(RECORDS, row.id, after);
        tx.insert(CORRECTIONS, {
          recordId: row.id,
          employeeId: row.employeeId,
          factoryId: row.factoryId,
          sectionShiftId: row.sectionShiftId,
          date: row.date,
          shiftId: row.shiftId,
          reason,
          before,
          after: pickAttendance(after),
          correctedBy: resolved.user.id,
          correctedAt: clock(),
        });
        tx.record({
          action: "attendance_corrected",
          entityType: RECORDS,
          entityId: row.id,
          changes: { reason: { before: null, after: reason } },
        });
        return view(tx.get(RECORDS, row.id), lookups(tx));
      });
    },

    // The corrections of one record, oldest first.
    history(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      const session = sessionFor(resolved);
      const row = typeof id === "string" ? session.get(RECORDS, id) : null;
      if (row === null) throw fail("not_found", "that attendance record was not found");
      gate.authorize(resolved, MANAGE, {
        factoryId: row.factoryId,
        sectionShiftId: row.sectionShiftId,
      });
      const names = store.platformSession({ actorId: resolved.user.id });
      return Object.freeze(
        session
          .list(CORRECTIONS, (correction) => correction.recordId === row.id)
          .map((correction) =>
            Object.freeze({
              id: correction.id,
              reason: correction.reason,
              before: Object.freeze(correction.before),
              after: Object.freeze(correction.after),
              correctedAt: correction.correctedAt,
              correctedBy: correction.correctedBy,
              correctedByName: names.get("users", correction.correctedBy)?.name ?? null,
            })
          )
      );
    },

    // The daily register (FR-ATT-001): everyone the shift expects in a factory, with their record or
    // none. Employees who have not joined yet, or are inactive without a record, are left out.
    daily(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      const date = validateDate(request.date);
      const session = sessionFor(resolved);
      const factory =
        typeof request.factoryId === "string" ? session.get("factories", request.factoryId) : null;
      if (factory === null) throw fail("not_found", "that factory was not found");
      if (!gate.inFactoryScope(resolved, factory.id)) {
        throw fail("forbidden", "you do not have access to that");
      }
      const shift =
        typeof request.shiftId === "string" ? session.get("shifts", request.shiftId) : null;
      if (shift === null || shift.factoryId !== factory.id) {
        throw fail("not_found", "that shift was not found");
      }
      const lookup = lookups(session);
      const sectionShifts = session.list(
        "sectionShifts",
        (row) => row.shiftId === shift.id && row.active !== false
      );
      const records = new Map(
        session
          .list(RECORDS, (row) => row.date === date && row.shiftId === shift.id)
          .map((row) => [row.employeeId, row])
      );
      const rows = [];
      for (const sectionShift of sectionShifts) {
        if (!allowed(resolved, { factoryId: factory.id, sectionShiftId: sectionShift.id }))
          continue;
        for (const employee of session.list(
          "employees",
          (row) => row.sectionId === sectionShift.sectionId
        )) {
          const record = records.get(employee.id) ?? null;
          const expected = employee.status !== "inactive" && employee.joinDate <= date;
          if (!expected && record === null) continue;
          rows.push(
            Object.freeze({
              employeeId: employee.id,
              employeeCode: employee.employeeCode,
              employeeName: employee.name,
              employeeStatus: employee.status,
              sectionId: employee.sectionId,
              sectionName: lookup.sections.get(employee.sectionId)?.name ?? null,
              sectionShiftId: sectionShift.id,
              record: record === null ? null : view(record, lookup),
            })
          );
        }
      }
      rows.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
      const { calendar, exceptions } = calendarOf(session, factory.id);
      const working = scheduledDates({
        calendar,
        exceptions,
        month: date.slice(0, 7),
        joinDate: date,
        today: date,
      });
      return Object.freeze({
        date,
        factoryId: factory.id,
        shiftId: shift.id,
        workingDay: working.length === 1,
        rows: Object.freeze(rows),
      });
    },

    // The monthly timesheet (FR-ATT-002, SRS 10.3): per employee the days present, absent and on
    // leave, the scheduled days, and the attendance score.
    timesheet(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      const month = validateMonth(request.month);
      const { first, last } = monthBounds(month);
      const session = sessionFor(resolved);
      const factory =
        typeof request.factoryId === "string" ? session.get("factories", request.factoryId) : null;
      if (factory === null) throw fail("not_found", "that factory was not found");
      if (!gate.inFactoryScope(resolved, factory.id)) {
        throw fail("forbidden", "you do not have access to that");
      }
      const { calendar, exceptions } = calendarOf(session, factory.id);
      const lookup = lookups(session);
      const sectionShiftsOf = (sectionId) =>
        session.list("sectionShifts", (row) => row.sectionId === sectionId && row.active !== false);
      const inScope = (sectionShiftId) =>
        allowed(resolved, { factoryId: factory.id, sectionShiftId });
      const records = session.list(
        RECORDS,
        (row) => row.factoryId === factory.id && row.date >= first && row.date <= last
      );
      const rows = [];
      for (const employee of session.list("employees", (row) => row.factoryId === factory.id)) {
        const visible = sectionShiftsOf(employee.sectionId).some((row) => inScope(row.id));
        if (!visible) continue;
        const own = records.filter(
          (row) => row.employeeId === employee.id && inScope(row.sectionShiftId)
        );
        if (employee.status === "inactive" && own.length === 0) continue;
        const scheduled = scheduledDates({
          calendar,
          exceptions,
          month,
          joinDate: employee.joinDate,
          today: resolved.today,
        });
        rows.push(
          Object.freeze({
            employeeId: employee.id,
            employeeCode: employee.employeeCode,
            employeeName: employee.name,
            employeeStatus: employee.status,
            sectionName: lookup.sections.get(employee.sectionId)?.name ?? null,
            ...summarizeAttendance({ records: own, scheduled }),
          })
        );
      }
      rows.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
      return Object.freeze({
        month,
        factoryId: factory.id,
        from: first,
        to: last < resolved.today ? last : resolved.today,
        rows: Object.freeze(rows),
      });
    },
  });
}
