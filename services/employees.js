// The employee register (UC-PEO-01, FR-SUPA-005; decisions D5, D27, D28, D29).
//
// Every call resolves the tenant and the caller's access from the context, never from the payload.
// Employee data is personal, so reading and writing both need `employee.manage` (WHAT) and a factory
// scope that covers the employee's factory (WHERE), failing closed; a member limited to their own
// assignments has no access. An employee is never deleted once an assignment or attendance record
// refers to them: they are made inactive, with a reason. Each write runs in one transaction with
// its audit event, so a refused call leaves neither a row nor an event.
// Browser-safe: no Node imports.
import {
  buildEmployee,
  blank,
  changeEmployee,
  isLive,
  validateEmployeeStatus,
} from "../domain/workforce.js";
import { fail } from "./errors.js";

const MANAGE = "employee.manage";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function createEmployees({ store, gate }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  const allowed = (resolved, factoryId) => {
    try {
      gate.authorize(resolved, MANAGE, { factoryId });
      return true;
    } catch {
      return false;
    }
  };

  function requireEmployee(tx, resolved, id) {
    const row = typeof id === "string" ? tx.get("employees", id) : null;
    if (row === null) throw fail("not_found", "that employee was not found");
    gate.authorize(resolved, MANAGE, { factoryId: row.factoryId });
    return row;
  }

  // A user the employee is linked to must be a member of this organization (D29).
  function requireMember(tx, userId) {
    if (
      typeof userId !== "string" ||
      tx.list("memberships", (row) => row.userId === userId).length === 0
    ) {
      throw fail("unknown_user", "that person is not a member of this organization");
    }
    return userId;
  }

  function requireDesignation(tx, designationId) {
    const row = typeof designationId === "string" ? tx.get("designations", designationId) : null;
    if (row === null) throw fail("not_found", "that designation was not found");
    if (row.active === false) throw fail("inactive_parent", "that designation is inactive");
    return row;
  }

  const liveAssignments = (tx, employeeId, today) =>
    tx.list("supervisorAssignments", (row) => row.employeeId === employeeId && isLive(row, today));

  return Object.freeze({
    list(context, filter) {
      const resolved = gate.requireTenant(context, MANAGE);
      const { factoryId, sectionId, status } = isObject(filter) ? filter : {};
      return Object.freeze(
        sessionFor(resolved)
          .list(
            "employees",
            (row) =>
              allowed(resolved, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (sectionId === undefined || row.sectionId === sectionId) &&
              (status === undefined || row.status === status)
          )
          .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
          .map((row) => Object.freeze(row))
      );
    },

    get(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      return Object.freeze(requireEmployee(sessionFor(resolved), resolved, id));
    },

    create(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const section =
          typeof fields.sectionId === "string" ? tx.get("sections", fields.sectionId) : null;
        if (section === null) throw fail("not_found", "that section was not found");
        gate.authorize(resolved, MANAGE, { factoryId: section.factoryId });
        const factory = tx.get("factories", section.factoryId);
        if (section.active === false || factory?.active === false) {
          throw fail("inactive_parent", "that section is inactive");
        }
        const designation = requireDesignation(tx, fields.designationId);
        const own = buildEmployee(fields);
        if (own.joinDate > resolved.today) {
          throw fail("invalid_date", `the join date cannot be after today (${resolved.today})`);
        }
        const userId = blank(fields.userId) ? null : requireMember(tx, fields.userId);
        return Object.freeze(
          tx.insert("employees", {
            ...own,
            factoryId: section.factoryId,
            sectionId: section.id,
            designationId: designation.id,
            userId,
            status: "active",
            statusReason: null,
          })
        );
      });
    },

    update(context, id, patch) {
      const resolved = gate.requireTenant(context, MANAGE);
      const input = isObject(patch) ? patch : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = requireEmployee(tx, resolved, id);
        for (const field of ["factoryId", "sectionId", "status", "statusReason"]) {
          if (input[field] !== undefined) {
            throw fail("immutable_field", `${field} cannot be edited here`);
          }
        }
        const changes = changeEmployee(input);
        if (changes.joinDate !== undefined) {
          if (changes.joinDate > resolved.today) {
            throw fail("invalid_date", `the join date cannot be after today (${resolved.today})`);
          }
          const first = tx
            .list("attendanceRecords", (record) => record.employeeId === row.id)
            .map((record) => record.date)
            .sort()[0];
          if (first !== undefined && changes.joinDate > first) {
            throw fail(
              "join_date_after_attendance",
              `attendance is already recorded from ${first}`
            );
          }
        }
        if (input.designationId !== undefined) {
          const designation = requireDesignation(tx, input.designationId);
          if (
            designation.supervisorEligible !== true &&
            liveAssignments(tx, row.id, resolved.today).length > 0
          ) {
            throw fail(
              "designation_in_use",
              "this employee supervises a section-shift; end the assignment first"
            );
          }
          changes.designationId = designation.id;
        }
        if (input.userId !== undefined) {
          changes.userId = blank(input.userId) ? null : requireMember(tx, input.userId);
        }
        return Object.freeze(tx.update("employees", row.id, changes));
      });
    },

    // Active, on leave or inactive. Going inactive needs a reason and is refused while the employee
    // still supervises a section-shift (their access would silently end).
    setStatus(context, id, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = requireEmployee(tx, resolved, id);
        const next = validateEmployeeStatus(request.status, request.reason);
        if (next.status === "inactive" && liveAssignments(tx, row.id, resolved.today).length > 0) {
          throw fail("has_assignments", "end or move their supervisor assignments first");
        }
        return Object.freeze(tx.update("employees", row.id, next));
      });
    },

    // Only an employee nothing refers to can be deleted; everyone else is made inactive.
    remove(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireEmployee(tx, resolved, id);
        const used =
          tx.list("supervisorAssignments", (other) => other.employeeId === row.id).length > 0 ||
          tx.list("attendanceRecords", (other) => other.employeeId === row.id).length > 0;
        if (used) throw fail("referenced", "they have history; make them inactive instead");
        return Object.freeze(tx.remove("employees", row.id));
      });
    },
  });
}
