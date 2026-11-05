// Reports, exports and scheduled reports (C128 to C130; decisions D68, D69).
//
// A report is produced by calling the dashboard or scorecard service with the requester's own
// context, so scope is applied once, in one place, and no row can fall outside it. The prototype has
// no background worker, so an export job runs at once (queued, running, then completed or failed) and
// "Run due schedules" does what a scheduler would. A schedule runs with its owner's authority at the
// moment it runs, through a context only this service is given (services/index.js).
// Browser-safe: no Node imports.
import { validateReason } from "../domain/comments.js";
import {
  CADENCES,
  FILTER_CHOICES,
  MAX_ROWS,
  RELATIVE_PERIODS,
  REPORTS,
  REPORT_KEYS,
  REQUESTS_PER_HOUR,
  WEEKDAYS,
  describeRecurrence,
  fileNameOf,
  nextRun,
  relativePeriod,
  requireRelativePeriod,
  requireReport,
  storageKeyOf,
  toCsv,
  validateFilters,
  validateKey,
  validateName,
  validateRecipientIds,
  validateRecurrence,
  validateScheduleTimeZone,
} from "../domain/reports.js";
import { resolvePeriod } from "../domain/scoring.js";
import { fail } from "./errors.js";

const EXPORT = "export.create";
const SCHEDULE = "report_schedule.manage";
const HOUR_MS = 60 * 60 * 1000;
const LIST_LIMIT = 50;

const FAILURE_TEXT = Object.freeze({
  too_many_rows: `The report has more than ${MAX_ROWS.toLocaleString("en-US")} rows. Narrow the period or the filters.`,
  owner_access_revoked: "The schedule's owner can no longer produce this report.",
  forbidden: "Access to this report was withdrawn.",
  not_found: "Something the report needs was not found.",
  export_failed: "The report could not be produced.",
});

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const blank = (value) => value === undefined || value === null || value === "";
const forbidden = () => fail("forbidden", "you do not have access to that");
const periodText = (period) =>
  period.from === period.to ? period.from : `${period.from} to ${period.to}`;

// The permissions to produce a report: export.create and the source's own, for someone whose reach is
// not narrowed to their own assignments (the sources refuse those members, too).
const canProduce = (access, spec) =>
  access.active &&
  !access.assignmentScoped &&
  [EXPORT, ...spec.needs].every((permission) => access.permissions.includes(permission));

// Whether an access reaches every factory a job covers.
const covers = (access, scope) =>
  access.factoryScope.all ||
  (!scope.all && scope.factoryIds.every((id) => access.factoryScope.factoryIds.includes(id)));

const eligibleRecipient = (access, spec, scope) =>
  access !== null && canProduce(access, spec) && covers(access, scope);

export function createReports({ store, gate, clock, notifier, sources }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  function names(resolved) {
    const reader = store.platformSession({ actorId: resolved.user.id });
    const cache = new Map();
    return (userId) => {
      if (!cache.has(userId)) cache.set(userId, reader.get("users", userId)?.name ?? null);
      return cache.get(userId);
    };
  }

  // Export and schedule pages are for people, never for support access (it holds no write kind, so
  // the permission checks below already refuse it).
  function holding(context, permission) {
    return gate.requireTenant(context, permission);
  }

  // ---- Scope of a job ------------------------------------------------------------------------------

  // The factories a job reaches: those its filters name, else everything the producer can reach.
  function scopeOf(tx, access, filters) {
    const factoryIds = new Set();
    const named = (collection, id) => {
      const row = tx.get(collection, id);
      if (row === null) throw fail("not_found", "a filter you chose was not found");
      return row.factoryId ?? row.id;
    };
    if (filters.factoryId) factoryIds.add(named("factories", filters.factoryId));
    if (filters.sectionId) factoryIds.add(named("sections", filters.sectionId));
    if (filters.shiftId) factoryIds.add(named("shifts", filters.shiftId));
    if (filters.lineId) factoryIds.add(named("lines", filters.lineId));
    if (factoryIds.size > 0) return { all: false, factoryIds: [...factoryIds].sort() };
    return access.factoryScope.all
      ? { all: true, factoryIds: [] }
      : { all: false, factoryIds: [...access.factoryScope.factoryIds] };
  }

  const singleFactory = (scope) =>
    !scope.all && scope.factoryIds.length === 1 ? scope.factoryIds[0] : null;

  // ---- Jobs ----------------------------------------------------------------------------------------

  function jobView(resolved, job, nameOf) {
    const spec = REPORTS[job.report];
    return Object.freeze({
      id: job.id,
      report: job.report,
      reportLabel: spec?.label ?? job.report,
      filters: Object.freeze({ ...job.filters }),
      period: Object.freeze({ ...job.period }),
      status: job.status,
      fileName: job.fileName,
      storageKey: job.fileKey,
      rowCount: job.rowCount,
      bytes: job.bytes,
      failureCode: job.failureCode,
      failureText:
        job.failureCode === null
          ? null
          : (FAILURE_TEXT[job.failureCode] ?? FAILURE_TEXT.export_failed),
      requester: Object.freeze({ id: job.requesterId, name: nameOf(job.requesterId) }),
      mine: job.requesterId === resolved.user.id,
      scheduleName: job.scheduleName,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      canDownload: job.status === "completed" && mayDownload(resolved, job),
    });
  }

  // Reauthorized at every download: involved in the job, the permissions held now, a scope that still
  // covers what the file contains.
  function mayDownload(resolved, job) {
    const spec = REPORTS[job.report];
    const involved =
      job.requesterId === resolved.user.id || job.recipientIds.includes(resolved.user.id);
    return (
      involved &&
      spec !== undefined &&
      canProduce(resolved.access, spec) &&
      covers(resolved.access, job.scope)
    );
  }

  const involvedIn = (resolved, job) =>
    job.requesterId === resolved.user.id || job.recipientIds.includes(resolved.user.id);

  // Calls the source service as the requester and turns its rows into CSV.
  function produce(context, spec, job) {
    const view = sources[spec.source.service][spec.source.call](context, {
      from: job.period.from,
      to: job.period.to,
      ...job.filters,
    });
    const rows = spec.rowsOf(view, job.period);
    const csv = toCsv(spec.columns, rows);
    return { csv, rowCount: rows.length, bytes: new TextEncoder().encode(csv).length };
  }

  // Runs a queued job to its end. `complete(tx, job)` writes what the finished job causes (the
  // notifications) in the same transaction as the file, so they stand or fall together.
  function execute(context, resolved, spec, queued, complete) {
    const writer = sessionFor(resolved);
    writer.transaction((tx) =>
      tx.update("exportJobs", queued.id, { status: "running", startedAt: clock() })
    );
    let produced;
    try {
      produced = produce(context, spec, queued);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "export_failed";
      const failed = writer.transaction((tx) =>
        tx.update("exportJobs", queued.id, {
          status: "failed",
          failureCode: Object.hasOwn(FAILURE_TEXT, code) ? code : "export_failed",
          finishedAt: clock(),
        })
      );
      if (typeof error?.code !== "string") throw error;
      return failed;
    }
    return writer.transaction((tx) => {
      const key = storageKeyOf(resolved.tenant.id, queued.id);
      const fileName = fileNameOf(queued.report, queued.period);
      tx.insert("exportFiles", {
        key,
        jobId: queued.id,
        content: produced.csv,
        bytes: produced.bytes,
      });
      const done = tx.update("exportJobs", queued.id, {
        status: "completed",
        fileName,
        fileKey: key,
        rowCount: produced.rowCount,
        bytes: produced.bytes,
        finishedAt: clock(),
      });
      complete(tx, done);
      return done;
    });
  }

  const newJob = (tx, owner, fields) =>
    tx.insert("exportJobs", {
      requesterId: owner.user.id,
      scheduleId: null,
      scheduleName: null,
      idempotencyKey: null,
      fingerprint: null,
      recipientIds: [],
      fileName: null,
      fileKey: null,
      rowCount: null,
      bytes: null,
      failureCode: null,
      status: "queued",
      createdAt: clock(),
      startedAt: null,
      finishedAt: null,
      ...fields,
    });

  // ---- Schedules -----------------------------------------------------------------------------------

  // Someone's own schedule, or any when they reach every factory (the administrator).
  const manageable = (resolved, schedule) =>
    schedule.ownerId === resolved.user.id ||
    (resolved.access.factoryScope.all && !resolved.access.assignmentScoped);

  function requireSchedule(reader, resolved, scheduleId) {
    const schedule =
      typeof scheduleId === "string" ? reader.get("reportSchedules", scheduleId) : null;
    if (schedule === null || !manageable(resolved, schedule)) {
      throw fail("not_found", "that schedule was not found");
    }
    return schedule;
  }

  function scheduleView(resolved, schedule, nameOf) {
    const spec = REPORTS[schedule.report];
    return Object.freeze({
      id: schedule.id,
      name: schedule.name,
      report: schedule.report,
      reportLabel: spec?.label ?? schedule.report,
      filters: Object.freeze({ ...schedule.filters }),
      periodKind: schedule.periodKind,
      periodLabel: RELATIVE_PERIODS[schedule.periodKind] ?? schedule.periodKind,
      recurrence: Object.freeze({ ...schedule.recurrence }),
      recurrenceText: describeRecurrence(schedule.recurrence),
      timeZone: schedule.timeZone,
      owner: Object.freeze({ id: schedule.ownerId, name: nameOf(schedule.ownerId) }),
      mine: schedule.ownerId === resolved.user.id,
      recipients: Object.freeze(
        schedule.recipientIds.map((id) => Object.freeze({ id, name: nameOf(id) }))
      ),
      status: schedule.status,
      version: schedule.version,
      nextRunAt: schedule.nextRunAt,
      due:
        schedule.status === "enabled" &&
        schedule.nextRunAt !== null &&
        Date.parse(schedule.nextRunAt) <= Date.parse(clock()),
      lastRunAt: schedule.lastRunAt,
      lastRunStatus: schedule.lastRunStatus,
      lastRunNote: schedule.lastRunNote,
      lastJobId: schedule.lastJobId,
      disabledReason: schedule.disabledReason,
    });
  }

  const nextAfterNow = (recurrence, timeZone) =>
    nextRun(recurrence, timeZone, new Date(clock())).toString();

  // The recipients of a schedule: active members who can produce that report now and whose reach
  // covers the schedule's (D69).
  function checkedRecipients(tx, resolved, spec, filters, ids) {
    const scope = scopeOf(tx, resolved.access, filters);
    for (const id of ids) {
      if (!eligibleRecipient(gate.accessOf(resolved.tenant.id, id), spec, scope)) {
        throw fail(
          "invalid_recipient",
          "a recipient must be an active member who can use that report"
        );
      }
    }
    return ids;
  }

  function requireVersion(schedule, expected) {
    if (!Number.isInteger(expected)) {
      throw fail("version_required", "send the version of the schedule you are changing");
    }
    if (expected !== schedule.version) {
      throw fail("conflict", "this schedule was changed; reload it and try again");
    }
  }

  function readFilters(report, input) {
    return validateFilters(report, input);
  }

  // Runs one schedule as its owner. Returns what happened; writes the job, the notifications and the
  // schedule's last-run fields (and audit) as the owner's job and the pressing person's update.
  function runSchedule(presser, schedule, trigger, reason) {
    const tenantId = presser.tenant.id;
    const spec = REPORTS[schedule.report];
    const ownerContext = gate.runAs(tenantId, schedule.ownerId);
    let owner = null;
    try {
      owner = gate.requireTenant(ownerContext);
    } catch (error) {
      if (typeof error?.code !== "string") throw error;
    }
    const at = clock();
    const settle = (outcome) =>
      sessionFor(presser).transaction((tx) => {
        const fresh = tx.get("reportSchedules", schedule.id);
        const lost = outcome.code === "owner_access_revoked";
        const stillOn = fresh.status === "enabled" && !lost;
        tx.update("reportSchedules", schedule.id, {
          lastRunAt: at,
          lastRunStatus: outcome.status,
          lastRunNote: outcome.note,
          lastJobId: outcome.jobId,
          status: lost ? "disabled" : fresh.status,
          disabledReason: lost ? "owner_access_revoked" : fresh.disabledReason,
          nextRunAt: stillOn
            ? nextAfterNow(fresh.recurrence, fresh.timeZone)
            : lost
              ? null
              : fresh.nextRunAt,
          version: fresh.version + 1,
        });
        tx.record({
          action: "report_schedule_run",
          entityType: "reportSchedules",
          entityId: schedule.id,
          changes: {
            trigger,
            reason: reason ?? null,
            status: outcome.status,
            jobId: outcome.jobId,
            delivered: outcome.delivered,
            skipped: outcome.skipped,
            code: outcome.code ?? null,
          },
        });
        return outcome;
      });

    if (owner === null || owner.support !== undefined || !canProduce(owner.access, spec)) {
      return settle({
        status: "failed",
        code: "owner_access_revoked",
        note: FAILURE_TEXT.owner_access_revoked,
        jobId: null,
        delivered: 0,
        skipped: 0,
      });
    }

    const period = relativePeriod(schedule.periodKind, owner.today);
    const reader = sessionFor(owner);
    let scope;
    try {
      scope = scopeOf(reader, owner.access, schedule.filters);
    } catch (error) {
      if (typeof error?.code !== "string") throw error;
      return settle({
        status: "failed",
        code: error.code,
        note: FAILURE_TEXT[error.code] ?? FAILURE_TEXT.export_failed,
        jobId: null,
        delivered: 0,
        skipped: 0,
      });
    }
    const delivered = [];
    let skipped = 0;
    for (const id of schedule.recipientIds) {
      if (eligibleRecipient(gate.accessOf(tenantId, id), spec, scope)) delivered.push(id);
      else skipped += 1;
    }
    const queued = sessionFor(owner).transaction((tx) =>
      newJob(tx, owner, {
        report: schedule.report,
        filters: schedule.filters,
        period,
        scope,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        recipientIds: delivered,
      })
    );
    const job = execute(ownerContext, owner, spec, queued, (tx, done) =>
      notifier.reportDelivered(tx, {
        recipients: delivered,
        job: done,
        schedule,
        label: spec.label,
        period: periodText(period),
        factoryId: singleFactory(scope),
      })
    );
    const note =
      job.status === "completed"
        ? `Delivered to ${delivered.length} (${job.rowCount} rows)${
            skipped > 0 ? `; skipped ${skipped} who can no longer use this report` : ""
          }`
        : (FAILURE_TEXT[job.failureCode] ?? FAILURE_TEXT.export_failed);
    return settle({
      status: job.status,
      code: job.failureCode,
      note,
      jobId: job.id,
      delivered: job.status === "completed" ? delivered.length : 0,
      skipped,
    });
  }

  return Object.freeze({
    // What the caller can produce and choose from. Used by the exports and schedules pages.
    catalogue(context) {
      const resolved = gate.requireTenant(context);
      if (resolved.support !== undefined) throw forbidden();
      const permissions = resolved.permissions;
      if (!permissions.includes(EXPORT) && !permissions.includes(SCHEDULE)) throw forbidden();
      const reader = sessionFor(resolved);
      return Object.freeze({
        today: resolved.today,
        timeZone: resolved.tenant.timeZone,
        maxRows: MAX_ROWS,
        perHour: REQUESTS_PER_HOUR,
        reports: Object.freeze(
          REPORT_KEYS.filter((key) => canProduce(resolved.access, REPORTS[key])).map((key) =>
            Object.freeze({
              key,
              label: REPORTS[key].label,
              description: REPORTS[key].description,
              filters: Object.freeze([...REPORTS[key].filters]),
              // Master data and stock are as at the day the file is made; the period is ignored.
              asAt: REPORTS[key].asAt === true,
            })
          )
        ),
        filterChoices: FILTER_CHOICES,
        periods: Object.freeze({ ...RELATIVE_PERIODS }),
        cadences: Object.freeze({ ...CADENCES }),
        weekdays: Object.freeze({ ...WEEKDAYS }),
        factories: Object.freeze(
          reader
            .list("factories", (row) => gate.inFactoryScope(resolved, row.id))
            .map(({ id, name }) => Object.freeze({ id, name }))
        ),
      });
    },

    // ---- Exports (C128) ----------------------------------------------------------------------------

    // Asks for a CSV. The same Idempotency-Key returns the same job (a different request under it is a
    // conflict) and a requester gets ten requests an hour.
    request(context, input) {
      const resolved = holding(context, EXPORT);
      const request = isObject(input) ? input : {};
      const spec = requireReport(request.report);
      if (!canProduce(resolved.access, spec)) throw forbidden();
      const filters = readFilters(request.report, request.filters);
      if (blank(request.from) || blank(request.to)) {
        throw fail("invalid_period", "a start and an end date are required");
      }
      const period = resolvePeriod({
        from: request.from,
        to: request.to,
        today: resolved.today,
        windowDays: 30,
      });
      const key = validateKey(request.idempotencyKey);
      const fingerprint = JSON.stringify([
        request.report,
        period.from,
        period.to,
        Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      const nameOf = names(resolved);
      const writer = sessionFor(resolved);
      const start = writer.transaction((tx) => {
        const scope = scopeOf(tx, resolved.access, filters);
        if (!covers(resolved.access, scope)) throw forbidden();
        const earlier = tx.list(
          "exportJobs",
          (row) => row.requesterId === resolved.user.id && row.idempotencyKey === key
        )[0];
        if (earlier !== undefined) {
          if (earlier.fingerprint !== fingerprint) {
            throw fail("conflict", "that Idempotency-Key was already used for a different request");
          }
          return { job: earlier, replayed: true };
        }
        const since = new Date(Date.parse(clock()) - HOUR_MS).toISOString();
        const recent = tx.list(
          "exportJobs",
          (row) =>
            row.requesterId === resolved.user.id && row.scheduleId === null && row.createdAt > since
        ).length;
        if (recent >= REQUESTS_PER_HOUR) {
          throw fail(
            "rate_limited",
            `at most ${REQUESTS_PER_HOUR} exports an hour; try again later`
          );
        }
        return {
          job: newJob(tx, resolved, {
            report: request.report,
            filters,
            period,
            scope,
            idempotencyKey: key,
            fingerprint,
          }),
          replayed: false,
        };
      });
      if (start.replayed) return jobView(resolved, start.job, nameOf);
      const done = execute(context, resolved, spec, start.job, (tx, finished) =>
        notifier.exportReady(tx, {
          userId: resolved.user.id,
          job: finished,
          label: spec.label,
          period: periodText(period),
          factoryId: singleFactory(start.job.scope),
        })
      );
      return jobView(resolved, done, nameOf);
    },

    // The jobs the caller asked for or receives, newest first.
    jobs(context) {
      const resolved = holding(context, EXPORT);
      const nameOf = names(resolved);
      const rows = sessionFor(resolved)
        .list("exportJobs", (row) => involvedIn(resolved, row))
        .map((row, index) => ({ row, index }))
        .sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt) || b.index - a.index)
        .map(({ row }) => row);
      return Object.freeze(rows.slice(0, LIST_LIMIT).map((row) => jobView(resolved, row, nameOf)));
    },

    job(context, jobId) {
      const resolved = holding(context, EXPORT);
      const row = typeof jobId === "string" ? sessionFor(resolved).get("exportJobs", jobId) : null;
      if (row === null || !involvedIn(resolved, row))
        throw fail("not_found", "that export was not found");
      return jobView(resolved, row, names(resolved));
    },

    // The file, after the permissions and scope are checked again. Each download is audited.
    download(context, jobId) {
      const resolved = holding(context, EXPORT);
      return sessionFor(resolved).transaction((tx) => {
        const job = typeof jobId === "string" ? tx.get("exportJobs", jobId) : null;
        if (job === null || !involvedIn(resolved, job)) {
          throw fail("not_found", "that export was not found");
        }
        if (job.status !== "completed") throw fail("not_ready", "that export has no file");
        if (!mayDownload(resolved, job)) throw forbidden();
        const file = tx.list("exportFiles", (row) => row.key === job.fileKey)[0];
        if (file === undefined) throw fail("not_found", "that export has no file");
        tx.record({
          action: "export_downloaded",
          entityType: "exportJobs",
          entityId: job.id,
          changes: {},
        });
        return Object.freeze({
          fileName: job.fileName,
          contentType: "text/csv;charset=utf-8",
          content: file.content,
          rowCount: job.rowCount,
          bytes: file.bytes,
        });
      });
    },

    // ---- Schedules (C129, C130) --------------------------------------------------------------------

    // Members who could receive a report: active, able to produce it, with a reach that covers it.
    recipientOptions(context, input) {
      const resolved = holding(context, SCHEDULE);
      const request = isObject(input) ? input : {};
      const spec = requireReport(request.report);
      if (!canProduce(resolved.access, spec)) throw forbidden();
      const filters = readFilters(request.report, request.filters);
      const nameOf = names(resolved);
      const reader = sessionFor(resolved);
      const scope = scopeOf(reader, resolved.access, filters);
      return Object.freeze(
        gate
          .holders(resolved.tenant.id, EXPORT)
          .filter(({ access }) => eligibleRecipient(access, spec, scope))
          .map(({ userId }) => Object.freeze({ id: userId, name: nameOf(userId) }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      );
    },

    schedules(context) {
      const resolved = holding(context, SCHEDULE);
      const nameOf = names(resolved);
      return Object.freeze(
        sessionFor(resolved)
          .list("reportSchedules", (row) => manageable(resolved, row))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => scheduleView(resolved, row, nameOf))
      );
    },

    schedule(context, scheduleId) {
      const resolved = holding(context, SCHEDULE);
      return scheduleView(
        resolved,
        requireSchedule(sessionFor(resolved), resolved, scheduleId),
        names(resolved)
      );
    },

    createSchedule(context, input) {
      const resolved = holding(context, SCHEDULE);
      const request = isObject(input) ? input : {};
      const spec = requireReport(request.report);
      if (!canProduce(resolved.access, spec)) throw forbidden();
      const name = validateName(request.name);
      const filters = readFilters(request.report, request.filters);
      const periodKind = requireRelativePeriod(request.periodKind);
      const recurrence = validateRecurrence(request.recurrence);
      const timeZone = blank(request.timeZone)
        ? resolved.tenant.timeZone
        : validateScheduleTimeZone(request.timeZone);
      const recipientIds = validateRecipientIds(request.recipientIds);
      return sessionFor(resolved).transaction((tx) => {
        checkedRecipients(tx, resolved, spec, filters, recipientIds);
        const schedule = tx.insert("reportSchedules", {
          name,
          nameKey: name.toLowerCase(),
          report: request.report,
          filters,
          periodKind,
          recurrence,
          timeZone,
          recipientIds,
          ownerId: resolved.user.id,
          status: "enabled",
          version: 1,
          nextRunAt: nextAfterNow(recurrence, timeZone),
          lastRunAt: null,
          lastRunStatus: null,
          lastRunNote: null,
          lastJobId: null,
          disabledReason: null,
          createdAt: clock(),
        });
        return scheduleView(resolved, schedule, names(resolved));
      });
    },

    updateSchedule(context, scheduleId, input) {
      const resolved = holding(context, SCHEDULE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const schedule = requireSchedule(tx, resolved, scheduleId);
        requireVersion(schedule, request.expectedVersion);
        if (request.report !== undefined && request.report !== schedule.report) {
          throw fail("immutable_field", "the report cannot be changed; create another schedule");
        }
        const spec = REPORTS[schedule.report];
        // The owner decides what a schedule produces; someone else managing it cannot widen it.
        if (
          schedule.ownerId !== resolved.user.id &&
          (request.filters !== undefined || request.recipientIds !== undefined)
        ) {
          throw fail("forbidden", "only the owner changes what a schedule produces");
        }
        const patch = {};
        if (request.name !== undefined) {
          patch.name = validateName(request.name);
          patch.nameKey = patch.name.toLowerCase();
        }
        const filters =
          request.filters === undefined
            ? schedule.filters
            : readFilters(schedule.report, request.filters);
        if (request.filters !== undefined) patch.filters = filters;
        if (request.periodKind !== undefined)
          patch.periodKind = requireRelativePeriod(request.periodKind);
        const recurrence =
          request.recurrence === undefined
            ? schedule.recurrence
            : validateRecurrence(request.recurrence);
        if (request.recurrence !== undefined) patch.recurrence = recurrence;
        const timeZone =
          request.timeZone === undefined
            ? schedule.timeZone
            : validateScheduleTimeZone(request.timeZone);
        if (request.timeZone !== undefined) patch.timeZone = timeZone;
        if (request.recipientIds !== undefined || request.filters !== undefined) {
          const ids =
            request.recipientIds === undefined
              ? schedule.recipientIds
              : validateRecipientIds(request.recipientIds);
          patch.recipientIds = checkedRecipients(tx, resolved, spec, filters, ids);
        }
        if (
          schedule.status === "enabled" &&
          (request.recurrence !== undefined || request.timeZone !== undefined)
        ) {
          patch.nextRunAt = nextAfterNow(recurrence, timeZone);
        }
        const updated = tx.update("reportSchedules", schedule.id, {
          ...patch,
          version: schedule.version + 1,
        });
        return scheduleView(resolved, updated, names(resolved));
      });
    },

    // enable, disable or run_now, each with a reason and the version being changed.
    transitionSchedule(context, scheduleId, input) {
      const resolved = holding(context, SCHEDULE);
      const request = isObject(input) ? input : {};
      if (!["enable", "disable", "run_now"].includes(request.action)) {
        throw fail("invalid_action", "the action is enable, disable or run_now");
      }
      const reason = validateReason(request.reason);
      const reader = sessionFor(resolved);
      const schedule = requireSchedule(reader, resolved, scheduleId);
      requireVersion(schedule, request.expectedVersion);
      if (request.action === "run_now") {
        runSchedule(resolved, schedule, "manual", reason);
        return scheduleView(resolved, reader.get("reportSchedules", schedule.id), names(resolved));
      }
      return reader.transaction((tx) => {
        const fresh = tx.get("reportSchedules", schedule.id);
        if (request.action === "enable") {
          if (fresh.status === "enabled") throw fail("invalid_state", "the schedule is already on");
          // The owner must still be able to produce the report for it to be switched on.
          const ownerAccess = gate.accessOf(resolved.tenant.id, fresh.ownerId);
          if (ownerAccess === null || !canProduce(ownerAccess, REPORTS[fresh.report])) {
            throw fail("owner_access_revoked", FAILURE_TEXT.owner_access_revoked);
          }
        } else if (fresh.status !== "enabled") {
          throw fail("invalid_state", "the schedule is already off");
        }
        const on = request.action === "enable";
        const updated = tx.update("reportSchedules", fresh.id, {
          status: on ? "enabled" : "disabled",
          nextRunAt: on ? nextAfterNow(fresh.recurrence, fresh.timeZone) : null,
          disabledReason: on ? null : "disabled",
          version: fresh.version + 1,
        });
        tx.record({
          action: on ? "report_schedule_enabled" : "report_schedule_disabled",
          entityType: "reportSchedules",
          entityId: fresh.id,
          changes: { reason },
        });
        return scheduleView(resolved, updated, names(resolved));
      });
    },

    // The prototype has no scheduler, so this does what one would: every due schedule runs once.
    // A run that was missed is not replayed; the next one is planned from now.
    runDue(context) {
      const resolved = holding(context, SCHEDULE);
      const now = Date.parse(clock());
      const due = sessionFor(resolved)
        .list(
          "reportSchedules",
          (row) =>
            row.status === "enabled" &&
            row.nextRunAt !== null &&
            Date.parse(row.nextRunAt) <= now &&
            manageable(resolved, row)
        )
        .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
      const outcomes = due.map((schedule) => {
        const outcome = runSchedule(resolved, schedule, "due", null);
        return Object.freeze({
          scheduleId: schedule.id,
          name: schedule.name,
          status: outcome.status,
          note: outcome.note,
          jobId: outcome.jobId,
        });
      });
      return Object.freeze({ ran: outcomes.length, outcomes: Object.freeze(outcomes) });
    },
  });
}
