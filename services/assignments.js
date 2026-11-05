// Supervisor assignments (UC-PEO-02, FR-SUPA-001..005, SRS 8.3; decisions D3, D29, D31, D32).
//
// An assignment ties an employee with a supervisor-eligible designation to a SectionShift for a
// range of dates. Assignments are history: they are ended, never overwritten. A reassignment
// end-dates the current assignment the day before the new one starts, in one transaction with its
// audit events. The assignments in effect today decide the section-shifts of an assignment-scoped
// member (the gate reads them through the employee linked to the member's user).
//
// Every call resolves the tenant and the caller's access from the context, never from the payload.
// Everything but `mine` needs `supervisor_assignment.manage` (WHAT) and a factory scope that covers
// the SectionShift's factory (WHERE), failing closed. Browser-safe: no Node imports.
import { addDays, replaceAssignment, validateRange } from "../domain/effective-dating.js";
import {
  assessAssignment,
  assignmentStatus,
  blank,
  isLive,
  optionalText,
  validateAssignmentDates,
  validatePolicy,
} from "../domain/workforce.js";
import { fail } from "./errors.js";

const MANAGE = "supervisor_assignment.manage";
const COLLECTION = "supervisorAssignments";
const POLICY_KIND = "assignment_policy";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const withConflicts = (error, conflicts) => Object.assign(error, { conflicts });

export function createAssignments({ store, gate }) {
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

  const policyOf = (tx) =>
    tx.list("settings", (row) => row.kind === POLICY_KIND)[0]?.policy ?? "warn";

  // Names for the screens: the supervisor, section and shift behind an assignment.
  function lookups(tx) {
    const by = (collection) => new Map(tx.list(collection).map((row) => [row.id, row]));
    return {
      employees: by("employees"),
      sectionShifts: by("sectionShifts"),
      sections: by("sections"),
      shifts: by("shifts"),
    };
  }

  function view(row, today, lookup) {
    const employee = lookup.employees.get(row.employeeId);
    const sectionShift = lookup.sectionShifts.get(row.sectionShiftId);
    const section = lookup.sections.get(sectionShift?.sectionId);
    const shift = lookup.shifts.get(sectionShift?.shiftId);
    return Object.freeze({
      id: row.id,
      employeeId: row.employeeId,
      employeeCode: employee?.employeeCode ?? null,
      employeeName: employee?.name ?? null,
      employeeStatus: employee?.status ?? null,
      factoryId: row.factoryId,
      sectionShiftId: row.sectionShiftId,
      sectionId: section?.id ?? null,
      sectionName: section?.name ?? null,
      shiftId: shift?.id ?? null,
      shiftName: shift?.name ?? null,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      status: assignmentStatus(row, today),
      note: row.note ?? null,
      endReason: row.endReason ?? null,
      replacesId: row.replacesId ?? null,
    });
  }

  function requireRow(tx, resolved, id) {
    const row = typeof id === "string" ? tx.get(COLLECTION, id) : null;
    if (row === null) throw fail("not_found", "that assignment was not found");
    gate.authorize(resolved, MANAGE, { factoryId: row.factoryId });
    return row;
  }

  // The employee and SectionShift an assignment would join, checked against everything FR-SUPA-001
  // and FR-SUPA-002 require. Returns the rows.
  function requireParties(tx, resolved, input) {
    const employee =
      typeof input.employeeId === "string" ? tx.get("employees", input.employeeId) : null;
    if (employee === null) throw fail("not_found", "that employee was not found");
    const sectionShift =
      typeof input.sectionShiftId === "string"
        ? tx.get("sectionShifts", input.sectionShiftId)
        : null;
    if (sectionShift === null) throw fail("not_found", "that section-shift was not found");
    gate.authorize(resolved, MANAGE, { factoryId: sectionShift.factoryId });
    if (employee.factoryId !== sectionShift.factoryId) {
      throw fail(
        "cross_factory",
        "the employee and the section-shift belong to different factories"
      );
    }
    if (employee.status !== "active") {
      throw fail("employee_not_active", "only an active employee can supervise");
    }
    if (tx.get("designations", employee.designationId)?.supervisorEligible !== true) {
      throw fail("not_supervisor_eligible", "their designation cannot supervise a section-shift");
    }
    if (sectionShift.active === false) {
      throw fail("inactive_parent", "that section-shift is inactive");
    }
    return { employee, sectionShift };
  }

  // Applies the tenant policy (D31) to `incoming` against `rows`. A duplicate and a `block` policy
  // refuse; `warn` refuses until the caller acknowledges.
  function enforce(rows, incoming, policy, acknowledge) {
    const result = assessAssignment(rows, incoming, policy);
    if (result.duplicate) {
      throw fail(
        "duplicate_assignment",
        "that employee already supervises that section-shift then"
      );
    }
    if (result.status === "blocked") {
      throw withConflicts(
        fail("overlap_blocked", "the overlap policy does not allow that assignment"),
        result.conflicts
      );
    }
    if (result.status === "warning" && acknowledge !== true) {
      throw withConflicts(
        fail("overlap_warning", "this overlaps another assignment; confirm to assign anyway"),
        result.conflicts
      );
    }
    return result;
  }

  function describe(result, lookup, today) {
    return Object.freeze({
      status: result.status,
      duplicate: result.duplicate,
      conflicts: Object.freeze(
        result.conflicts.map(({ kind, row }) =>
          Object.freeze({ kind, assignment: view(row, today, lookup) })
        )
      ),
    });
  }

  return Object.freeze({
    // ---- Policy (FR-SUPA-003) ---------------------------------------------------------------

    policy(context) {
      const resolved = gate.requireTenant(context, MANAGE);
      return Object.freeze({ policy: policyOf(sessionFor(resolved)) });
    },

    setPolicy(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      gate.authorizeTenantWide(resolved, MANAGE);
      const policy = validatePolicy(isObject(input) ? input.policy : undefined);
      return sessionFor(resolved).transaction((tx) => {
        const row = tx.list("settings", (candidate) => candidate.kind === POLICY_KIND)[0];
        if (row === undefined) tx.insert("settings", { kind: POLICY_KIND, policy });
        else tx.update("settings", row.id, { policy });
        return Object.freeze({ policy });
      });
    },

    // ---- Reading ------------------------------------------------------------------------------

    // Newest first. `status` is scheduled, current or ended.
    list(context, filter) {
      const resolved = gate.requireTenant(context, MANAGE);
      const { factoryId, employeeId, sectionShiftId, status } = isObject(filter) ? filter : {};
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      return Object.freeze(
        session
          .list(
            COLLECTION,
            (row) =>
              allowed(resolved, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (employeeId === undefined || row.employeeId === employeeId) &&
              (sectionShiftId === undefined || row.sectionShiftId === sectionShiftId) &&
              (status === undefined || assignmentStatus(row, resolved.today) === status)
          )
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
          .map((row) => view(row, resolved.today, lookup))
      );
    },

    // The audit trail of one assignment, oldest first: who changed what and when (FR-SUPA-004).
    history(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      const session = sessionFor(resolved);
      const row = typeof id === "string" ? session.get(COLLECTION, id) : null;
      if (row === null) throw fail("not_found", "that assignment was not found");
      gate.authorize(resolved, MANAGE, { factoryId: row.factoryId });
      const names = store.platformSession({ actorId: resolved.user.id });
      return Object.freeze(
        session.auditLog({ entityType: COLLECTION, entityId: row.id }).map((event) =>
          Object.freeze({
            at: event.timestamp,
            action: event.action,
            actorId: event.actorId,
            actorName: names.get("users", event.actorId)?.name ?? null,
            changes: event.changes,
          })
        )
      );
    },

    // Employees who could supervise in a factory: active and holding a supervisor-eligible designation.
    supervisors(context, filter) {
      const resolved = gate.requireTenant(context, MANAGE);
      const { factoryId } = isObject(filter) ? filter : {};
      const session = sessionFor(resolved);
      const eligible = new Set(
        session.list("designations", (row) => row.supervisorEligible === true).map((row) => row.id)
      );
      return Object.freeze(
        session
          .list(
            "employees",
            (row) =>
              row.status === "active" &&
              eligible.has(row.designationId) &&
              allowed(resolved, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId)
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) =>
            Object.freeze({
              id: row.id,
              employeeCode: row.employeeCode,
              name: row.name,
              factoryId: row.factoryId,
            })
          )
      );
    },

    // The caller's own assignments, through the employee linked to their user (FR-SUPA-005).
    mine(context) {
      const resolved = gate.requireTenant(context);
      const session = sessionFor(resolved);
      const employee = session.list("employees", (row) => row.userId === resolved.user.id)[0];
      if (employee === undefined) return Object.freeze({ employee: null, assignments: [] });
      const lookup = lookups(session);
      return Object.freeze({
        employee: Object.freeze({
          id: employee.id,
          employeeCode: employee.employeeCode,
          name: employee.name,
          status: employee.status,
        }),
        assignments: Object.freeze(
          session
            .list(COLLECTION, (row) => row.employeeId === employee.id)
            .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
            .map((row) => view(row, resolved.today, lookup))
        ),
      });
    },

    // ---- Writing ------------------------------------------------------------------------------

    // What `assign` (or `reassign`, with `replaces`) would find, without writing anything.
    preview(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        requireParties(tx, resolved, request);
        const dates = validateAssignmentDates(request, resolved.today);
        const incoming = {
          employeeId: request.employeeId,
          sectionShiftId: request.sectionShiftId,
          ...dates,
        };
        let rows = tx.list(COLLECTION);
        if (!blank(request.replaces)) {
          const old = requireRow(tx, resolved, request.replaces);
          rows = rows.map((row) =>
            row.id === old.id && old.effectiveFrom < dates.effectiveFrom
              ? { ...row, effectiveTo: addDays(dates.effectiveFrom, -1) }
              : row
          );
        }
        return describe(
          assessAssignment(rows, incoming, policyOf(tx)),
          lookups(tx),
          resolved.today
        );
      });
    },

    assign(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const { employee, sectionShift } = requireParties(tx, resolved, request);
        const dates = validateAssignmentDates(request, resolved.today);
        const incoming = { employeeId: employee.id, sectionShiftId: sectionShift.id, ...dates };
        enforce(tx.list(COLLECTION), incoming, policyOf(tx), request.acknowledge);
        const row = tx.insert(COLLECTION, {
          ...incoming,
          factoryId: sectionShift.factoryId,
          note: optionalText(request.note, "the note"),
        });
        return view(row, resolved.today, lookups(tx));
      });
    },

    // SRS 8.3: the supervisor and/or the section-shift changes from a date. The current assignment is
    // end-dated the day before, the new one starts on the date and the history keeps both.
    reassign(context, id, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const old = requireRow(tx, resolved, id);
        const employeeId = blank(request.employeeId) ? old.employeeId : request.employeeId;
        const sectionShiftId = blank(request.sectionShiftId)
          ? old.sectionShiftId
          : request.sectionShiftId;
        if (employeeId === old.employeeId && sectionShiftId === old.sectionShiftId) {
          throw fail("no_change", "choose another supervisor or another section-shift");
        }
        const { employee, sectionShift } = requireParties(tx, resolved, {
          employeeId,
          sectionShiftId,
        });
        const dates = validateAssignmentDates(request, resolved.today);
        if (old.effectiveTo !== null && old.effectiveTo < dates.effectiveFrom) {
          throw fail("assignment_ended", "that assignment has already ended before that date");
        }
        if (old.effectiveFrom >= dates.effectiveFrom) {
          throw fail(
            "invalid_replacement",
            "the new assignment must start after the one it replaces starts"
          );
        }
        const incoming = { employeeId: employee.id, sectionShiftId: sectionShift.id, ...dates };
        const { ended } = replaceAssignment([old], incoming, { sameSubject: () => true });
        const rows = tx
          .list(COLLECTION)
          .map((row) => (row.id === old.id ? { ...row, effectiveTo: ended[0].effectiveTo } : row));
        enforce(rows, incoming, policyOf(tx), request.acknowledge);

        tx.update(COLLECTION, old.id, { effectiveTo: ended[0].effectiveTo });
        const row = tx.insert(COLLECTION, {
          ...incoming,
          factoryId: sectionShift.factoryId,
          note: optionalText(request.note, "the note"),
          replacesId: old.id,
          replacedEffectiveTo: old.effectiveTo,
        });
        tx.record({
          action: "supervisor_reassigned",
          entityType: COLLECTION,
          entityId: row.id,
          changes: {
            replacesId: { before: old.id, after: row.id },
            employeeId: { before: old.employeeId, after: row.employeeId },
            sectionShiftId: { before: old.sectionShiftId, after: row.sectionShiftId },
            effectiveFrom: { before: old.effectiveFrom, after: row.effectiveFrom },
          },
        });
        const lookup = lookups(tx);
        return Object.freeze({
          ended: view(tx.get(COLLECTION, old.id), resolved.today, lookup),
          started: view(row, resolved.today, lookup),
        });
      });
    },

    // Ends an assignment that has started, from the given last day (yesterday at the earliest), with
    // no replacement. A scheduled assignment is cancelled instead.
    end(context, id, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, resolved, id);
        if (row.effectiveFrom > resolved.today) {
          throw fail("not_started", "it has not started; cancel it instead");
        }
        const last = blank(request.effectiveTo) ? resolved.today : request.effectiveTo;
        const range = validateEnd(row, last, resolved.today);
        if (row.effectiveTo !== null && range.effectiveTo >= row.effectiveTo) {
          throw fail("no_change", `it already ends on ${row.effectiveTo}`);
        }
        const updated = tx.update(COLLECTION, row.id, {
          effectiveTo: range.effectiveTo,
          endReason: optionalText(request.reason, "the reason"),
        });
        return view(updated, resolved.today, lookups(tx));
      });
    },

    // Removes an assignment that has not started. If it replaced another one, that one is restored.
    cancel(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, resolved, id);
        if (row.effectiveFrom <= resolved.today) {
          throw fail("already_started", "it has started; end it instead");
        }
        if (!blank(row.replacesId)) {
          const previous = tx.get(COLLECTION, row.replacesId);
          if (previous !== null && previous.effectiveTo === addDays(row.effectiveFrom, -1)) {
            tx.update(COLLECTION, previous.id, {
              effectiveTo: row.replacedEffectiveTo ?? null,
              endReason: null,
            });
          }
        }
        const lookup = lookups(tx);
        tx.remove(COLLECTION, row.id);
        return view(row, resolved.today, lookup);
      });
    },
  });
}

// The last day of an ending assignment: not before it started and not before yesterday.
function validateEnd(row, last, today) {
  const range = validateRange({ effectiveFrom: row.effectiveFrom, effectiveTo: last });
  if (range.effectiveTo < addDays(today, -1)) {
    throw fail("past_effective_date", `an assignment cannot end before ${addDays(today, -1)}`);
  }
  return range;
}
