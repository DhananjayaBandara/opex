// Scorecards (UC-SUP-10, UC-MGT-02..04, FR-PROD-012, FR-SCR-001..004; decisions D43 to D52).
//
// My Scorecard, the Management Scorecard, a supervisor's detail page, exceptions, the versioned score
// configuration and snapshots. Every figure is computed here from the approved production days
// (S3), the supervisor assignments and the attendance (S2), the KPI targets (S1) and the score
// configuration, and never accepted from the caller.
//
// A caller needs the permission (WHAT, which also needs the performance module) and a factory scope
// that covers the supervisor's factory (WHERE), failing closed with the generic refusal. Someone
// limited to their own assignments can read only their own scorecard. Browser-safe: no Node imports.
import { calculateSupervisorScore, resolveTargets } from "../domain/calculations.js";
import { SYSTEM_TARGETS } from "../domain/configuration.js";
import { addDays, versionAt } from "../domain/effective-dating.js";
import { computeDay, downtimeMinutes, pickPlan } from "../domain/production.js";
import {
  COMPONENT_LABELS,
  DEFAULT_SCORE_CONFIG,
  EXCEPTION_KINDS,
  SCORE_COMPONENTS,
  aggregateFacts,
  attribute,
  dayExceptions,
  dayFacts,
  resolvePeriod,
  scoreReadings,
  scoreTargets,
  snapshotKey,
  validDate,
  validateScoreConfig,
} from "../domain/scoring.js";
import { scheduledDatesBetween, summarizeAttendance } from "../domain/workforce.js";
import { fail } from "./errors.js";
import { writeVersion } from "./settings.js";

const VIEW_SELF = "scorecard.view_self";
const VIEW_ALL = "scorecard.view_all";
const MANAGE = "score_config.manage";

const CONFIGS = "scoreConfigVersions";
const SNAPSHOTS = "scoreSnapshots";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = () => fail("forbidden", "you do not have access to that");
const byId = (rows) => new Map(rows.map((row) => [row.id, row]));

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = key(item);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return groups;
}

export function createScorecards({ store, gate, clock }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  function nameOf(resolved) {
    const reader = store.platformSession({ actorId: resolved.user.id });
    const names = new Map();
    return (id) => {
      if (id === null || id === undefined) return null;
      if (!names.has(id)) names.set(id, reader.get("users", id)?.name ?? null);
      return names.get(id);
    };
  }

  // Management reads: the permission, and not limited to own assignments (D50).
  function requireManagement(context) {
    const resolved = gate.requireTenant(context, VIEW_ALL);
    if (resolved.access.assignmentScoped) throw refuse();
    return resolved;
  }

  // ---- Configuration and targets ------------------------------------------------------------

  const configView = (row) =>
    Object.freeze({
      version: row.version,
      isDefault: row.version === 0,
      label: row.version === 0 ? "Felix defaults" : `Version ${row.version}`,
      effectiveFrom: row.effectiveFrom ?? null,
      effectiveTo: row.effectiveTo ?? null,
      weights: Object.freeze({ ...row.weights }),
      windowDays: row.windowDays,
      reason: row.reason ?? null,
    });

  // The configuration in force on a date, or the Felix defaults before any version is saved.
  function configAt(tx, date) {
    const row = versionAt(tx.list(CONFIGS), date);
    return row ?? { version: 0, ...DEFAULT_SCORE_CONFIG, effectiveFrom: null, effectiveTo: null };
  }

  function targetsAt(versions, factoryId, asOf) {
    return resolveTargets(
      {
        system: SYSTEM_TARGETS,
        tenant: versions.filter((row) => row.subject === "tenant"),
        factory: versions.filter((row) => row.subject === factoryId),
      },
      asOf
    );
  }

  // ---- The data a period is scored from -----------------------------------------------------

  function lookups(tx) {
    return {
      factories: byId(tx.list("factories")),
      sections: byId(tx.list("sections")),
      lines: byId(tx.list("lines")),
      shifts: byId(tx.list("shifts")),
      sectionShifts: byId(tx.list("sectionShifts")),
      employees: byId(tx.list("employees")),
      designations: byId(tx.list("designations")),
    };
  }

  // Validates and resolves the optional factory, section and shift filters (AC-5.7).
  function filtersOf(tx, resolved, lookup, input) {
    const request = isObject(input) ? input : {};
    const pick = (value, map, label) => {
      if (value === undefined || value === null || value === "") return null;
      const row = typeof value === "string" ? map.get(value) : undefined;
      if (row === undefined) throw fail("not_found", `that ${label} was not found`);
      return row;
    };
    const factory = pick(request.factoryId, lookup.factories, "factory");
    if (factory !== null && !gate.inFactoryScope(resolved, factory.id)) throw refuse();
    const section = pick(request.sectionId, lookup.sections, "section");
    const shift = pick(request.shiftId, lookup.shifts, "shift");
    return Object.freeze({
      factoryId: factory?.id ?? null,
      sectionId: section?.id ?? null,
      shiftId: shift?.id ?? null,
    });
  }

  const dayPasses = (day, lookup, filters) =>
    (filters.factoryId === null || day.factoryId === filters.factoryId) &&
    (filters.sectionId === null || lookup.lines.get(day.lineId)?.sectionId === filters.sectionId) &&
    (filters.shiftId === null || day.shiftId === filters.shiftId);

  // Approved days in the period inside the caller's factory scope, each with its facts and who it is
  // attributed to (D43, D44).
  function loadDays(tx, resolved, lookup, assignments, period, filters) {
    const days = tx
      .list(
        "productionDays",
        (row) =>
          row.status === "approved" &&
          row.date >= period.from &&
          row.date <= period.to &&
          gate.inFactoryScope(resolved, row.factoryId) &&
          dayPasses(row, lookup, filters)
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const ids = new Set(days.map((row) => row.id));
    const hours = groupBy(
      tx.list("hourlyOutputs", (row) => ids.has(row.productionDayId)),
      (row) => row.productionDayId
    );
    const events = groupBy(
      tx.list("productionEvents", (row) => ids.has(row.productionDayId)),
      (row) => row.productionDayId
    );
    return days.map((day) => {
      const metrics = computeDay({
        day,
        plan: pickPlan(day),
        style: { smv: day.smv },
        hours: hours.get(day.id) ?? [],
      }).metrics;
      return Object.freeze({
        day,
        line: lookup.lines.get(day.lineId),
        sectionId: lookup.lines.get(day.lineId)?.sectionId ?? null,
        attribution: attribute(assignments, day.sectionShiftId, day.date),
        facts: dayFacts({
          day,
          metrics,
          downtimeMinutes: downtimeMinutes(events.get(day.id) ?? []),
        }),
      });
    });
  }

  // Working days of the employee's factory calendar in the period, with the attendance recorded on
  // them (D46).
  function attendanceOf(tx, employee, records, period, today) {
    const calendar = tx.list(
      "calendars",
      (row) => row.factoryId === employee.factoryId && row.active !== false
    )[0];
    const exceptions =
      calendar === undefined
        ? []
        : tx.list("calendarExceptions", (r) => r.calendarId === calendar.id);
    const scheduled = scheduledDatesBetween({
      calendar: calendar ?? null,
      exceptions,
      from: period.from,
      to: period.to,
      joinDate: employee.joinDate,
      today,
    });
    return summarizeAttendance({ records, scheduled });
  }

  const overlaps = (row, period) =>
    row.effectiveFrom <= period.to && (row.effectiveTo ?? "9999-12-31") >= period.from;

  // The score of one supervisor over a period (D45, D47).
  function scoreOf({ employee, facts, attendance, versions, config, period }) {
    const figures = aggregateFacts(facts);
    const targets = targetsAt(versions, employee.factoryId, period.to);
    const periodDays =
      Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000) + 1;
    const readings = scoreReadings(figures, attendance);
    const result = calculateSupervisorScore({
      readings,
      targets: scoreTargets(targets.values),
      config: { weights: config.weights, version: config.version, windowDays: periodDays },
    });
    // A supervisor with no approved day in the period has nothing to be scored on: attendance alone
    // would otherwise read as a near-perfect score (D45).
    const scored = figures.days === 0 ? { ...result, totalScore: null } : result;
    return { figures, targets, readings, result: scored };
  }

  function componentRows({ readings, targets, result, config, attendance }) {
    const reading = {
      efficiency: readings.efficiency,
      defect: readings.defectRate,
      firstHour: readings.firstHourHitRate,
      qco: readings.qcoHitRate,
      attendance: attendance.attendanceScore,
    };
    const target = {
      efficiency: targets.values.efficiency ?? null,
      defect: targets.values.defectRate ?? null,
      firstHour: targets.values.firstHour ?? null,
      qco: targets.values.qco ?? null,
      attendance: null,
    };
    const source = {
      efficiency: targets.sources.efficiency ?? null,
      defect: targets.sources.defectRate ?? null,
      firstHour: targets.sources.firstHour ?? null,
      qco: targets.sources.qco ?? null,
      attendance: null,
    };
    return SCORE_COMPONENTS.map((key) =>
      Object.freeze({
        key,
        label: COMPONENT_LABELS[key],
        reading: reading[key] ?? null,
        target: target[key],
        targetSource: source[key],
        score: result.componentScores[key],
        weight: config.weights[key],
        effectiveWeight: result.effectiveWeights[key] ?? null,
      })
    );
  }

  function rowOf({ employee, lookup, figures, attendance, result, config, days }) {
    return Object.freeze({
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      name: employee.name,
      factoryId: employee.factoryId,
      factoryName: lookup.factories.get(employee.factoryId)?.name ?? null,
      days,
      plannedPieces: figures.plannedPieces,
      actualPieces: figures.actualPieces,
      piecesVariance: figures.piecesVariance,
      piecesHitRate: figures.piecesHitRate,
      plannedEfficiency: figures.plannedEfficiency,
      actualEfficiency: figures.actualEfficiency,
      efficiencyVariance: figures.efficiencyVariance,
      efficiencyHitRate: figures.efficiencyHitRate,
      defectRate: figures.defectRate,
      firstHourHitRate: figures.firstHourHitRate,
      qcoHitRate: figures.qcoHitRate,
      attendanceScore: attendance.attendanceScore,
      scheduledDays: attendance.scheduledDays,
      unrecordedDays: attendance.unrecordedDays,
      score: result.totalScore,
      configVersion: config.version,
    });
  }

  // Everything the board, the detail page and the snapshots need, for the supervisors with days or
  // assignments in the period and inside the caller's scope.
  function analyze(tx, resolved, { period, filters, only = null }) {
    const lookup = lookups(tx);
    const assignments = tx.list("supervisorAssignments");
    const config = configAt(tx, period.to);
    const versions = tx.list("targetVersions");
    const days = loadDays(tx, resolved, lookup, assignments, period, filters);

    const attributed = groupBy(
      days.filter((entry) => entry.attribution.kind === "attributed"),
      (entry) => entry.attribution.employeeIds[0]
    );
    const candidates = new Set(attributed.keys());
    for (const row of assignments) {
      const sectionShift = lookup.sectionShifts.get(row.sectionShiftId);
      if (
        overlaps(row, period) &&
        sectionShift !== undefined &&
        (filters.factoryId === null || sectionShift.factoryId === filters.factoryId) &&
        (filters.sectionId === null || sectionShift.sectionId === filters.sectionId) &&
        (filters.shiftId === null || sectionShift.shiftId === filters.shiftId)
      ) {
        candidates.add(row.employeeId);
      }
    }

    const employees = [...candidates]
      .map((id) => lookup.employees.get(id))
      .filter(
        (employee) =>
          employee !== undefined &&
          gate.inFactoryScope(resolved, employee.factoryId) &&
          (only === null || employee.id === only)
      )
      .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
    const wanted = new Set(employees.map((employee) => employee.id));
    const records = groupBy(
      tx.list(
        "attendanceRecords",
        (row) => wanted.has(row.employeeId) && row.date >= period.from && row.date <= period.to
      ),
      (row) => row.employeeId
    );

    const scored = employees.map((employee) => {
      const mine = attributed.get(employee.id) ?? [];
      const attendance = attendanceOf(
        tx,
        employee,
        records.get(employee.id) ?? [],
        period,
        resolved.today
      );
      const outcome = scoreOf({
        employee,
        facts: mine.map((entry) => entry.facts),
        attendance,
        versions,
        config,
        period,
      });
      return { employee, entries: mine, attendance, config, ...outcome };
    });

    const kinds = days.map((entry) => entry.attribution.kind);
    return {
      lookup,
      assignments,
      config,
      versions,
      days,
      scored,
      excluded: {
        shared: kinds.filter((kind) => kind === "shared").length,
        unattributed: kinds.filter((kind) => kind === "unattributed").length,
      },
    };
  }

  // ---- Views --------------------------------------------------------------------------------

  function assignmentRows(assignments, employeeId, lookup, today) {
    return assignments
      .filter((row) => row.employeeId === employeeId)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
      .map((row) => {
        const sectionShift = lookup.sectionShifts.get(row.sectionShiftId);
        return Object.freeze({
          id: row.id,
          factoryName: lookup.factories.get(row.factoryId)?.name ?? null,
          sectionName: lookup.sections.get(sectionShift?.sectionId)?.name ?? null,
          shiftName: lookup.shifts.get(sectionShift?.shiftId)?.name ?? null,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo ?? null,
          note: row.note ?? null,
          state:
            row.effectiveFrom > today
              ? "scheduled"
              : row.effectiveTo === null ||
                  row.effectiveTo === undefined ||
                  row.effectiveTo >= today
                ? "current"
                : "ended",
        });
      });
  }

  function snapshotView(row, nameFor) {
    return Object.freeze({
      id: row.id,
      employeeId: row.employeeId,
      asOf: row.asOf,
      from: row.from,
      to: row.to,
      configVersion: row.configVersion,
      windowDays: row.windowDays,
      days: row.days,
      score: row.totalScore,
      componentScores: Object.freeze({ ...row.componentScores }),
      effectiveWeights: Object.freeze({ ...row.effectiveWeights }),
      targets: Object.freeze({ ...row.targets }),
      targetSources: Object.freeze({ ...row.targetSources }),
      readings: row.readings,
      takenBy: row.takenBy,
      takenByName: nameFor(row.takenBy),
      takenAt: row.takenAt,
    });
  }

  function detailOf(tx, resolved, scoredRow, ctx) {
    const { employee, entries, attendance, config, figures, targets, readings, result } = scoredRow;
    const { lookup, assignments, period, excludedShared } = ctx;
    const nameFor = nameOf(resolved);
    const groupFigures = (map, describe) =>
      [...map.entries()]
        .map(([key, group]) => ({
          ...describe(key, group),
          ...aggregateFacts(group.map((entry) => entry.facts)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const byLine = groupFigures(
      groupBy(entries, (entry) => entry.day.lineId),
      (key) => {
        const line = lookup.lines.get(key);
        return {
          id: key,
          name: line?.name ?? "—",
          context: `${lookup.factories.get(line?.factoryId)?.name ?? "—"} · ${lookup.sections.get(line?.sectionId)?.name ?? "—"}`,
        };
      }
    );
    const bySection = groupFigures(
      groupBy(entries, (entry) => entry.sectionId),
      (key) => {
        const section = lookup.sections.get(key);
        return {
          id: key,
          name: section?.name ?? "—",
          context: lookup.factories.get(section?.factoryId)?.name ?? "—",
        };
      }
    );
    const trend = entries.map((entry) =>
      Object.freeze({
        dayId: entry.day.id,
        date: entry.day.date,
        lineName: entry.line?.name ?? "—",
        shiftName: lookup.shifts.get(entry.day.shiftId)?.name ?? "—",
        ...entry.facts,
      })
    );
    const snapshots = tx
      .list(SNAPSHOTS, (row) => row.employeeId === employee.id)
      .sort((a, b) => b.asOf.localeCompare(a.asOf) || b.configVersion - a.configVersion)
      .map((row) => snapshotView(row, nameFor));

    return Object.freeze({
      employee: Object.freeze({
        id: employee.id,
        employeeCode: employee.employeeCode,
        name: employee.name,
        factoryId: employee.factoryId,
        factoryName: lookup.factories.get(employee.factoryId)?.name ?? null,
        designationName: lookup.designations.get(employee.designationId)?.name ?? null,
        joinDate: employee.joinDate,
        status: employee.status ?? "active",
      }),
      period,
      config: configView(config),
      figures,
      attendance: Object.freeze({ ...attendance }),
      targets: Object.freeze({ values: targets.values, sources: targets.sources }),
      score: result.totalScore,
      components: Object.freeze(componentRows({ readings, targets, result, config, attendance })),
      assignments: Object.freeze(assignmentRows(assignments, employee.id, lookup, resolved.today)),
      byLine: Object.freeze(byLine),
      bySection: Object.freeze(bySection),
      trend: Object.freeze(trend),
      snapshots: Object.freeze(snapshots),
      sharedDays: excludedShared,
    });
  }

  function sharedDaysOf(days, employeeId) {
    return days.filter(
      (entry) =>
        entry.attribution.kind === "shared" && entry.attribution.employeeIds.includes(employeeId)
    ).length;
  }

  function optionsOf(resolved, lookup) {
    const inScope = (factoryId) => gate.inFactoryScope(resolved, factoryId);
    const sorted = (rows) => rows.sort((a, b) => a.name.localeCompare(b.name));
    return Object.freeze({
      factories: Object.freeze(
        sorted(
          [...lookup.factories.values()]
            .filter((row) => inScope(row.id))
            .map((row) => ({ id: row.id, name: row.name }))
        )
      ),
      sections: Object.freeze(
        sorted(
          [...lookup.sections.values()]
            .filter((row) => inScope(row.factoryId))
            .map((row) => ({ id: row.id, factoryId: row.factoryId, name: row.name }))
        )
      ),
      shifts: Object.freeze(
        sorted(
          [...lookup.shifts.values()]
            .filter((row) => inScope(row.factoryId))
            .map((row) => ({ id: row.id, factoryId: row.factoryId, name: row.name }))
        )
      ),
    });
  }

  const periodOf = (tx, today, request) => {
    const end =
      request.to === undefined || request.to === null || request.to === ""
        ? today
        : validDate(request.to, "the end date");
    const config = configAt(tx, end <= today ? end : today);
    return resolvePeriod({
      from: request.from,
      to: request.to,
      today,
      windowDays: config.windowDays,
    });
  };

  return Object.freeze({
    // ---- My Scorecard (UC-SUP-10) -----------------------------------------------------------
    // The caller's own rolling score through the employee linked to their user (D50).
    mine(context, input) {
      const resolved = gate.requireTenant(context, VIEW_SELF);
      const request = isObject(input) ? input : {};
      const session = sessionFor(resolved);
      const employee = session.list("employees", (row) => row.userId === resolved.user.id)[0];
      if (employee === undefined) {
        return Object.freeze({ linked: false, reason: "no_employee", scorecard: null });
      }
      const hasAssignment =
        session.list("supervisorAssignments", (row) => row.employeeId === employee.id).length > 0;
      if (!hasAssignment) {
        return Object.freeze({ linked: true, reason: "no_assignment", scorecard: null });
      }
      const period = periodOf(session, resolved.today, { to: request.to });
      const ctx = analyze(session, resolved, {
        period,
        filters: { factoryId: null, sectionId: null, shiftId: null },
        only: employee.id,
      });
      const row = ctx.scored[0];
      if (row === undefined)
        return Object.freeze({ linked: true, reason: "no_data", scorecard: null });
      return Object.freeze({
        linked: true,
        reason: null,
        scorecard: detailOf(session, resolved, row, {
          lookup: ctx.lookup,
          assignments: ctx.assignments,
          period,
          excludedShared: sharedDaysOf(ctx.days, employee.id),
        }),
      });
    },

    // ---- Management Scorecard (UC-MGT-02, FR-PROD-012) --------------------------------------
    board(context, input) {
      const resolved = requireManagement(context);
      const request = isObject(input) ? input : {};
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const filters = filtersOf(session, resolved, lookup, request);
      const period = periodOf(session, resolved.today, request);
      const ctx = analyze(session, resolved, { period, filters });
      const rows = ctx.scored.map((row) =>
        rowOf({
          employee: row.employee,
          lookup,
          figures: row.figures,
          attendance: row.attendance,
          result: row.result,
          config: row.config,
          days: row.entries.length,
        })
      );
      return Object.freeze({
        period,
        filters,
        config: configView(ctx.config),
        options: optionsOf(resolved, lookup),
        rows: Object.freeze(rows),
        all: aggregateFacts(
          ctx.days.filter((e) => e.attribution.kind === "attributed").map((e) => e.facts)
        ),
        excluded: Object.freeze(ctx.excluded),
      });
    },

    // ---- Supervisor detail (UC-MGT-03) ------------------------------------------------------
    detail(context, employeeId, input) {
      const resolved = requireManagement(context);
      const request = isObject(input) ? input : {};
      const session = sessionFor(resolved);
      const employee = typeof employeeId === "string" ? session.get("employees", employeeId) : null;
      if (employee === null) throw fail("not_found", "that supervisor was not found");
      if (!gate.inFactoryScope(resolved, employee.factoryId)) throw refuse();
      const period = periodOf(session, resolved.today, request);
      const ctx = analyze(session, resolved, {
        period,
        filters: { factoryId: null, sectionId: null, shiftId: null },
        only: employee.id,
      });
      const row = ctx.scored[0];
      if (row === undefined) {
        throw fail("not_found", "that employee has no supervisor assignment in the period");
      }
      return detailOf(session, resolved, row, {
        lookup: ctx.lookup,
        assignments: ctx.assignments,
        period,
        excludedShared: sharedDaysOf(ctx.days, employee.id),
      });
    },

    // ---- Exceptions (UC-MGT-04) -------------------------------------------------------------
    exceptions(context, input) {
      const resolved = requireManagement(context);
      const request = isObject(input) ? input : {};
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const filters = filtersOf(session, resolved, lookup, request);
      const period = periodOf(session, resolved.today, request);
      const assignments = session.list("supervisorAssignments");
      const versions = session.list("targetVersions");
      const days = loadDays(session, resolved, lookup, assignments, period, filters);
      const rows = [];
      for (const entry of days) {
        const { day, line, attribution } = entry;
        const where = {
          dayId: day.id,
          date: day.date,
          factoryName: lookup.factories.get(day.factoryId)?.name ?? null,
          sectionName: lookup.sections.get(entry.sectionId)?.name ?? null,
          lineName: line?.name ?? null,
          shiftName: lookup.shifts.get(day.shiftId)?.name ?? null,
        };
        const supervisors = attribution.employeeIds.map(
          (id) => lookup.employees.get(id)?.name ?? "—"
        );
        if (attribution.kind === "attributed") {
          const targets = scoreTargets(targetsAt(versions, day.factoryId, period.to).values);
          for (const found of dayExceptions(entry.facts, targets)) {
            rows.push({ ...where, ...found, supervisorNames: supervisors });
          }
        } else {
          rows.push({
            ...where,
            kind: attribution.kind,
            detail:
              attribution.kind === "shared"
                ? `${supervisors.join(" and ")} were both assigned, so the day is counted for nobody`
                : "No supervisor was assigned on that date, so the day is counted for nobody",
            supervisorNames: supervisors,
          });
        }
      }
      const wanted = request.kind === undefined || request.kind === "" ? null : request.kind;
      if (wanted !== null && !(wanted in EXCEPTION_KINDS)) {
        throw fail("invalid_kind", "that kind of exception does not exist");
      }
      const counts = Object.fromEntries(
        Object.keys(EXCEPTION_KINDS).map((kind) => [
          kind,
          rows.filter((r) => r.kind === kind).length,
        ])
      );
      return Object.freeze({
        period,
        filters,
        options: optionsOf(resolved, lookup),
        counts: Object.freeze(counts),
        rows: Object.freeze(
          rows
            .filter((row) => wanted === null || row.kind === wanted)
            .sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind))
            .map((row, index) =>
              Object.freeze({
                key: `${row.dayId}:${row.kind}:${index}`,
                label: EXCEPTION_KINDS[row.kind],
                ...row,
              })
            )
        ),
      });
    },

    // ---- Score configuration (FR-SCR-002, D51) ----------------------------------------------
    config(context) {
      const resolved = gate.requireTenant(context);
      const mayManage =
        resolved.permissions.includes(MANAGE) &&
        resolved.access.factoryScope.all &&
        !resolved.access.assignmentScoped;
      if (
        resolved.access.assignmentScoped ||
        (!resolved.permissions.includes(VIEW_ALL) && !resolved.permissions.includes(MANAGE))
      ) {
        throw refuse();
      }
      const session = sessionFor(resolved);
      const lookup = lookups(session);
      const nameFor = nameOf(resolved);
      const versions = session
        .list(CONFIGS)
        .sort((a, b) => b.version - a.version)
        .map((row) => ({ ...configView(row), savedByName: nameFor(row.savedBy) }));
      return Object.freeze({
        current: configView(configAt(session, resolved.today)),
        versions: Object.freeze(versions.map((v) => Object.freeze(v))),
        defaults: configView({ version: 0, ...DEFAULT_SCORE_CONFIG }),
        factories: optionsOf(resolved, lookup).factories,
        mayManage,
      });
    },

    saveConfig(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      gate.authorizeTenantWide(resolved, MANAGE);
      const request = isObject(input) ? input : {};
      const clean = validateScoreConfig(request);
      return sessionFor(resolved).transaction((tx) => {
        const start =
          request.effectiveFrom === undefined || request.effectiveFrom === ""
            ? resolved.today
            : validDate(request.effectiveFrom, "the start date");
        const chain = tx.list(CONFIGS);
        const before = configAt(tx, start);
        const row = writeVersion(tx, {
          collection: CONFIGS,
          chain,
          today: resolved.today,
          start,
          fields: {
            version: Math.max(0, ...chain.map((r) => r.version)) + 1,
            weights: clean.weights,
            windowDays: clean.windowDays,
            reason: clean.reason,
            savedBy: resolved.user.id,
          },
          revise: {
            weights: clean.weights,
            windowDays: clean.windowDays,
            reason: clean.reason,
            savedBy: resolved.user.id,
          },
        });
        tx.record({
          action: "score_config_changed",
          entityType: CONFIGS,
          entityId: row.id,
          changes: {
            reason: clean.reason,
            before: {
              version: before.version,
              weights: before.weights,
              windowDays: before.windowDays,
            },
            after: { version: row.version, weights: row.weights, windowDays: row.windowDays },
          },
        });
        return { ...configView(row), savedByName: nameOf(resolved)(row.savedBy) };
      });
    },

    // ---- Snapshots (D52) --------------------------------------------------------------------
    // Takes a snapshot of every supervisor with a score as of a date. Idempotent: a supervisor,
    // date and configuration version that already have one keep it.
    takeSnapshots(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      gate.authorizeTenantWide(resolved, MANAGE);
      const request = isObject(input) ? input : {};
      const asOf =
        request.asOf === undefined || request.asOf === ""
          ? resolved.today
          : validDate(request.asOf, "the date");
      if (asOf > resolved.today)
        throw fail("invalid_period", "a snapshot cannot be taken for a future date");
      return sessionFor(resolved).transaction((tx) => {
        const period = periodOf(tx, resolved.today, { to: asOf });
        const ctx = analyze(tx, resolved, {
          period,
          filters: { factoryId: null, sectionId: null, shiftId: null },
        });
        const taken = [];
        const existing = [];
        let skipped = 0;
        for (const row of ctx.scored) {
          if (row.result.totalScore === null) {
            skipped += 1;
            continue;
          }
          const key = snapshotKey({
            employeeId: row.employee.id,
            asOf,
            configVersion: row.config.version,
          });
          const found = tx.list(SNAPSHOTS, (r) => r.key === key)[0];
          if (found !== undefined) {
            existing.push(found);
            continue;
          }
          taken.push(
            tx.insert(SNAPSHOTS, {
              key,
              employeeId: row.employee.id,
              asOf,
              from: period.from,
              to: period.to,
              configVersion: row.config.version,
              windowDays: row.result.windowDays,
              days: row.entries.length,
              readings: row.result.componentInputs.readings,
              targets: scoreTargets(row.targets.values),
              targetSources: row.targets.sources,
              componentScores: row.result.componentScores,
              effectiveWeights: row.result.effectiveWeights,
              totalScore: row.result.totalScore,
              takenBy: resolved.user.id,
              takenAt: clock(),
            })
          );
        }
        const nameFor = nameOf(resolved);
        return Object.freeze({
          asOf,
          created: taken.length,
          existing: existing.length,
          skipped,
          snapshots: Object.freeze(
            [...taken, ...existing].map((row) => snapshotView(row, nameFor))
          ),
        });
      });
    },
  });
}

// Used by the seed to describe a window without calling the service.
export const windowStart = (asOf, days) => addDays(asOf, -(days - 1));
