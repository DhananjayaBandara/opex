// CSV imports (SRS 14.3; architecture 16; decisions D104, D105). Staging registers the file's
// metadata, reads it and checks every row with the SAME rules as the Add form: the real create call
// runs for each row inside a rolled-back trial, so a row that passes would have been created and one
// that fails says why. Nothing is created until the person commits, which is a separate step and
// creates the valid rows in batches of 50, each one audited as an ordinary create.
//
// The source text is not kept: a staged row holds its values, and a failed-row report is built from
// them. Browser-safe: no Node imports.
import { validateFile } from "../domain/files.js";
import { fingerprint } from "../domain/fingerprint.js";
import {
  BATCH,
  KINDS,
  KIND_KEYS,
  STATUSES,
  errorReportCsv,
  readCsv,
  requireKind,
  templateOf,
  validateImportName,
} from "../domain/imports.js";
import { fail } from "./errors.js";
import { insertFile } from "./files.js";

const MANAGE = "import.manage";
const JOBS = "importJobs";
const ROWS = "importRows";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const notFound = () => fail("not_found", "that import was not found");
const byteLength = (text) => new TextEncoder().encode(text).length;

export function createImports({ store, gate, clock, newId, orders, procurement, employees }) {
  function reader(context, kind = null) {
    const resolved = gate.requireTenant(context, MANAGE);
    gate.authorizeTenantWide(resolved, MANAGE);
    if (kind !== null) gate.authorizeTenantWide(resolved, KINDS[kind].permission);
    const session = store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });
    return { resolved, session };
  }

  const names = () => {
    const platform = store.platformSession({ actorId: "system" });
    const cache = new Map();
    return (userId) => {
      if (!cache.has(userId)) {
        const user = platform.get("users", userId);
        cache.set(userId, user === null ? userId : user.name);
      }
      return cache.get(userId);
    };
  };

  const view = (row, nameOf) =>
    Object.freeze({
      id: row.id,
      kind: row.kind,
      kindLabel: KINDS[row.kind].label,
      fileId: row.fileId,
      fileName: row.fileName,
      fingerprint: row.fingerprint,
      size: row.size,
      status: row.status,
      statusLabel: STATUSES[row.status],
      total: row.total,
      valid: row.valid,
      failed: row.failed,
      created: row.created,
      failedAtCommit: row.failedAtCommit,
      ignoredColumns: Object.freeze([...row.ignoredColumns]),
      refusedColumns: Object.freeze([...row.refusedColumns]),
      stagedBy: row.stagedBy,
      stagedByName: nameOf(row.stagedBy),
      stagedAt: row.stagedAt,
      decidedAt: row.decidedAt,
    });

  const rowView = (row) =>
    Object.freeze({
      id: row.id,
      number: row.number,
      values: Object.freeze({ ...row.values }),
      status: row.status,
      problem: row.problem,
      code: row.code,
      createdId: row.createdId,
    });

  function requireJob(session, id) {
    const row = typeof id === "string" ? session.get(JOBS, id) : null;
    if (row === null) throw notFound();
    return row;
  }

  // The values of one CSV row as the input of the matching create call. Employees are named by
  // factory code, section code and designation name, which are looked up here.
  function inputOf(kind, values, lookups) {
    if (kind !== "employees") return values;
    const factoryCode = values.factoryCode.trim().toUpperCase();
    const factory = lookups.factories.find((row) => row.code === factoryCode);
    if (factory === undefined)
      throw fail("unknown_factory", `no factory has the code ${values.factoryCode || "(blank)"}`);
    const sectionCode = values.sectionCode.trim().toUpperCase();
    const section = lookups.sections.find(
      (row) => row.factoryId === factory.id && row.code === sectionCode
    );
    if (section === undefined) {
      throw fail(
        "unknown_section",
        `factory ${factory.code} has no section with the code ${values.sectionCode || "(blank)"}`
      );
    }
    const designation = lookups.designations.find(
      (row) => row.nameKey === values.designation.trim().toLowerCase()
    );
    if (designation === undefined) {
      throw fail(
        "unknown_designation",
        `there is no designation named ${values.designation || "(blank)"}`
      );
    }
    return {
      employeeCode: values.employeeCode,
      name: values.name,
      email: values.email,
      phone: values.phone,
      joinDate: values.joinDate,
      sectionId: section.id,
      designationId: designation.id,
    };
  }

  // Calls the same create method as the Add form.
  function createOne(context, kind, input) {
    if (kind === "buyers") return orders.createBuyer(context, input);
    if (kind === "suppliers") return procurement.createSupplier(context, input);
    if (kind === "materials") return procurement.createMaterial(context, input);
    return employees.create(context, input);
  }

  const lookupsOf = (session) => ({
    factories: session.list("factories"),
    sections: session.list("sections"),
    designations: session.list("designations"),
  });

  // The problem of a row as readable text with a stable code; anything without a code is a defect.
  function problemOf(error) {
    if (typeof error?.code !== "string") throw error;
    return { code: error.code, problem: error.message };
  }

  return Object.freeze({
    kinds() {
      return KIND_KEYS.map((key) =>
        Object.freeze({ key, label: KINDS[key].label, columns: KINDS[key].columns })
      );
    },

    template(context, kind) {
      reader(context);
      return templateOf(kind);
    },

    stage(context, input) {
      const source = isObject(input) ? input : {};
      requireKind(source.kind);
      const kind = source.kind;
      const { resolved, session } = reader(context, kind);
      const fileName = validateImportName(source.fileName);
      const text = typeof source.content === "string" ? source.content : "";
      const parsed = readCsv(kind, text);
      const print = fingerprint(text);
      const size = byteLength(text);
      validateFile({
        name: fileName,
        contentType: "text/csv",
        category: "import",
        size: Math.max(size, 1),
        fingerprint: print,
      });
      const same = session.list(
        JOBS,
        (row) => row.kind === kind && row.fingerprint === print && row.status !== "cancelled"
      )[0];
      if (same !== undefined) {
        throw fail(
          "duplicate_import",
          `This exact file was already ${same.status === "staged" ? "staged" : "imported"} as ${same.fileName}; cancel that import or change the file`
        );
      }

      // Every row runs through the real create call, one after another so that a row sees the rows
      // before it (a code repeated inside the file is caught), and all of it is rolled back.
      const lookups = lookupsOf(session);
      const checked = store.trialRun(() =>
        parsed.rows.map((row) => {
          try {
            createOne(context, kind, inputOf(kind, row.values, lookups));
            return { ...row, status: "valid", problem: null, code: null };
          } catch (error) {
            return { ...row, status: "failed", ...problemOf(error) };
          }
        })
      );
      const valid = checked.filter((row) => row.status === "valid").length;

      return session.transaction((tx) => {
        const file = insertFile(
          tx,
          { tenantId: resolved.tenant.id, userId: resolved.user.id, clock, newId },
          { name: fileName, contentType: "text/csv", category: "import", size, fingerprint: print }
        );
        const job = tx.insert(JOBS, {
          kind,
          fileId: file.fileId,
          fileName,
          fingerprint: print,
          size,
          status: "staged",
          total: checked.length,
          valid,
          failed: checked.length - valid,
          created: 0,
          failedAtCommit: 0,
          ignoredColumns: [...parsed.ignoredColumns],
          refusedColumns: [...parsed.refusedColumns],
          stagedBy: resolved.user.id,
          stagedAt: clock(),
          decidedAt: null,
        });
        for (const row of checked) {
          tx.insert(ROWS, {
            jobId: job.id,
            number: row.number,
            values: row.values,
            status: row.status,
            problem: row.problem,
            code: row.code,
            createdId: null,
          });
        }
        tx.record({
          action: "import_staged",
          entityType: JOBS,
          entityId: job.id,
          changes: {
            kind,
            file: fileName,
            rows: checked.length,
            valid,
            failed: checked.length - valid,
          },
        });
        return view(job, names());
      });
    },

    list(context) {
      const { session } = reader(context);
      const nameOf = names();
      return Object.freeze(
        session
          .list(JOBS)
          .reverse()
          .map((row) => view(row, nameOf))
      );
    },

    get(context, id) {
      const { session } = reader(context);
      const job = requireJob(session, id);
      const rows = session
        .list(ROWS, (row) => row.jobId === job.id)
        .sort((a, b) => a.number - b.number)
        .map(rowView);
      return Object.freeze({ ...view(job, names()), rows: Object.freeze(rows) });
    },

    // Creates the valid rows, in batches of 50, each as the real create call. A row that has become
    // invalid since staging (someone else added the same code) is recorded as not created and the
    // rest go on. A second commit of the same import is refused.
    commit(context, id) {
      const { resolved, session } = reader(context);
      const job = requireJob(session, id);
      gate.authorizeTenantWide(resolved, KINDS[job.kind].permission);
      if (job.status !== "staged") {
        throw fail(
          "import_not_staged",
          `This import is ${STATUSES[job.status].toLowerCase()}, not staged`
        );
      }
      const pending = session
        .list(ROWS, (row) => row.jobId === job.id && row.status === "valid")
        .sort((a, b) => a.number - b.number);
      if (pending.length === 0)
        throw fail(
          "nothing_to_import",
          "No row is ready to import; correct the file and stage it again"
        );

      let created = job.created;
      let missed = job.failedAtCommit;
      for (let start = 0; start < pending.length; start += BATCH) {
        const lookups = lookupsOf(session);
        store.batch(() => {
          for (const row of pending.slice(start, start + BATCH)) {
            try {
              const made = createOne(context, job.kind, inputOf(job.kind, row.values, lookups));
              session.transaction((tx) =>
                tx.update(ROWS, row.id, { status: "created", createdId: made.id })
              );
              created += 1;
            } catch (error) {
              const { code, problem } = problemOf(error);
              session.transaction((tx) =>
                tx.update(ROWS, row.id, { status: "not_created", code, problem })
              );
              missed += 1;
            }
          }
          session.transaction((tx) => tx.update(JOBS, job.id, { created, failedAtCommit: missed }));
        });
      }
      return session.transaction((tx) => {
        const done = tx.update(JOBS, job.id, { status: "committed", decidedAt: clock() });
        tx.record({
          action: "import_committed",
          entityType: JOBS,
          entityId: job.id,
          changes: {
            kind: job.kind,
            file: job.fileName,
            created,
            notCreated: missed,
            rejected: job.failed,
          },
        });
        return view(done, names());
      });
    },

    cancel(context, id) {
      const { resolved, session } = reader(context);
      const job = requireJob(session, id);
      gate.authorizeTenantWide(resolved, KINDS[job.kind].permission);
      if (job.status !== "staged") {
        throw fail(
          "import_not_staged",
          `This import is ${STATUSES[job.status].toLowerCase()}, not staged`
        );
      }
      return session.transaction((tx) => {
        const done = tx.update(JOBS, job.id, { status: "cancelled", decidedAt: clock() });
        tx.record({
          action: "import_cancelled",
          entityType: JOBS,
          entityId: job.id,
          changes: { kind: job.kind, file: job.fileName, rows: job.total },
        });
        return view(done, names());
      });
    },

    // The rows that were rejected (or not created), with the reason, as a CSV to correct and load again.
    errorReport(context, id) {
      const { session } = reader(context);
      const job = requireJob(session, id);
      const rows = session
        .list(
          ROWS,
          (row) => row.jobId === job.id && (row.status === "failed" || row.status === "not_created")
        )
        .sort((a, b) => a.number - b.number);
      if (rows.length === 0) throw fail("no_failed_rows", "Every row of this import was accepted");
      return Object.freeze({
        fileName: `${job.fileName.replace(/\.csv$/i, "")}-errors.csv`,
        count: rows.length,
        csv: errorReportCsv(job.kind, rows),
      });
    },
  });
}
