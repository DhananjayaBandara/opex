// Operational comments and mentions (C070, C071; decisions D66, D67): a short note on a factory,
// optionally a line and shift, with employees tagged.
//
// A comment is append-only. Only its author edits it, with a reason, and every earlier text is kept
// as a revision. Nothing is deleted, and a comment never touches a production day's notes or events.
// A tag is a reference, not a recipient: no notification is written for a comment or a mention.
// Browser-safe: no Node imports.
import {
  requireAreaPair,
  validateBody,
  validateMentionIds,
  validateOnDate,
  validateReason,
} from "../domain/comments.js";
import { fail } from "./errors.js";

const READ = "comment.read";
const WRITE = "comment.write";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const blank = (value) => value === undefined || value === null || value === "";
const missing = () => fail("not_found", "that comment was not found");

export function createComments({ store, gate, clock }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  // Names come from the global registry; they are looked up once per call.
  function names(resolved) {
    const reader = store.platformSession({ actorId: resolved.user.id });
    const cache = new Map();
    return (userId) => {
      if (!cache.has(userId)) cache.set(userId, reader.get("users", userId)?.name ?? null);
      return cache.get(userId);
    };
  }

  // The WHERE of a stored comment: its factory, and for a member limited to their assignments the
  // section-shift of its line and shift. A factory-level comment has none, so it is hidden from them.
  const resourceOf = (comment) => ({
    factoryId: comment.factoryId,
    sectionShiftId: comment.sectionShiftId ?? undefined,
  });
  const readable = (resolved, comment) => gate.permits(resolved.access, READ, resourceOf(comment));

  function view(tx, resolved, comment, nameOf, { revisions = false } = {}) {
    const lookups = {
      factory: tx.get("factories", comment.factoryId),
      line: comment.lineId === null ? null : tx.get("lines", comment.lineId),
      shift: comment.shiftId === null ? null : tx.get("shifts", comment.shiftId),
    };
    const earlier = tx.list("commentRevisions", (row) => row.commentId === comment.id);
    return Object.freeze({
      id: comment.id,
      factoryId: comment.factoryId,
      factoryName: lookups.factory?.name ?? null,
      lineId: comment.lineId,
      lineName: lookups.line?.name ?? null,
      shiftId: comment.shiftId,
      shiftName: lookups.shift?.name ?? null,
      onDate: comment.onDate,
      body: comment.body,
      author: Object.freeze({ id: comment.authorId, name: nameOf(comment.authorId) }),
      mine: comment.authorId === resolved.user.id,
      // Code and name only: no user, no email (D67).
      mentions: Object.freeze(
        comment.mentionIds.map((id) => {
          const employee = tx.get("employees", id);
          return Object.freeze({
            id,
            employeeCode: employee?.employeeCode ?? null,
            name: employee?.name ?? null,
          });
        })
      ),
      revision: comment.revision,
      createdAt: comment.createdAt,
      editedAt: comment.editedAt,
      revisionCount: earlier.length,
      ...(revisions && {
        revisions: Object.freeze(
          earlier
            .sort((a, b) => b.revision - a.revision)
            .map((row) =>
              Object.freeze({
                revision: row.revision,
                body: row.body,
                mentions: Object.freeze(
                  row.mentionIds.map((id) => {
                    const employee = tx.get("employees", id);
                    return Object.freeze({
                      id,
                      employeeCode: employee?.employeeCode ?? null,
                      name: employee?.name ?? null,
                    });
                  })
                ),
                writtenAt: row.writtenAt,
                supersededAt: row.supersededAt,
                reason: row.reason,
              })
            )
        ),
      }),
    });
  }

  function requireComment(tx, resolved, commentId) {
    const comment = typeof commentId === "string" ? tx.get("comments", commentId) : null;
    if (comment === null || !readable(resolved, comment)) throw missing();
    return comment;
  }

  // The line and shift a comment is about, as ids that belong together in this factory.
  function areaOf(tx, factoryId, input) {
    if (!requireAreaPair(input.lineId, input.shiftId)) {
      return { lineId: null, shiftId: null, sectionShiftId: null };
    }
    const line = typeof input.lineId === "string" ? tx.get("lines", input.lineId) : null;
    const shift = typeof input.shiftId === "string" ? tx.get("shifts", input.shiftId) : null;
    if (line === null || line.factoryId !== factoryId) {
      throw fail("not_found", "that line was not found");
    }
    if (shift === null || shift.factoryId !== factoryId) {
      throw fail("not_found", "that shift was not found");
    }
    const sectionShift = tx.list(
      "sectionShifts",
      (row) => row.sectionId === line.sectionId && row.shiftId === shift.id
    )[0];
    if (sectionShift === undefined) {
      throw fail("shift_not_run", "that line's section does not run that shift");
    }
    return { lineId: line.id, shiftId: shift.id, sectionShiftId: sectionShift.id };
  }

  // Tagged employees: of this factory, not inactive. Anything else fails like an unknown employee.
  function mentionsOf(tx, factoryId, value) {
    const ids = validateMentionIds(value);
    for (const id of ids) {
      const employee = tx.get("employees", id);
      if (employee === null || employee.factoryId !== factoryId || employee.status === "inactive") {
        throw fail("not_found", "an employee you tagged was not found");
      }
    }
    return ids;
  }

  function readLimit(value) {
    if (value === undefined || value === null) return DEFAULT_LIMIT;
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
      throw fail("invalid_limit", `a page is 1 to ${MAX_LIMIT} items`);
    }
    return value;
  }

  return Object.freeze({
    // What the comment screen offers: the factories the caller may read, and for one of them its
    // lines, shifts and the employees that can be tagged (code and name only, D67). The caller needs
    // only the read permission; `canWrite` says whether the composer is shown.
    options(context, input = {}) {
      const resolved = gate.requireTenant(context, READ);
      const request = isObject(input) ? input : {};
      const reader = sessionFor(resolved);
      const byName = (a, b) => a.name.localeCompare(b.name);
      const factories = reader
        .list("factories", (row) => row.active !== false && gate.inFactoryScope(resolved, row.id))
        .map(({ id, name }) => Object.freeze({ id, name }))
        .sort(byName);
      const chosen = factories.find((row) => row.id === request.factoryId) ?? factories[0] ?? null;
      const sections = new Map(
        reader.list("sections", (row) => row.factoryId === chosen?.id).map((row) => [row.id, row])
      );
      return Object.freeze({
        today: resolved.today,
        canWrite: resolved.permissions.includes(WRITE),
        factories: Object.freeze(factories),
        factoryId: chosen?.id ?? null,
        lines: Object.freeze(
          chosen === null
            ? []
            : reader
                .list("lines", (row) => row.factoryId === chosen.id && row.active !== false)
                .map((row) =>
                  Object.freeze({
                    id: row.id,
                    name: row.name,
                    sectionName: sections.get(row.sectionId)?.name ?? null,
                  })
                )
                .sort(byName)
        ),
        shifts: Object.freeze(
          chosen === null
            ? []
            : reader
                .list("shifts", (row) => row.factoryId === chosen.id && row.active !== false)
                .map(({ id, name }) => Object.freeze({ id, name }))
                .sort(byName)
        ),
        employees: Object.freeze(
          chosen === null || !resolved.permissions.includes(WRITE)
            ? []
            : reader
                .list(
                  "employees",
                  (row) => row.factoryId === chosen.id && row.status !== "inactive"
                )
                .map((row) =>
                  Object.freeze({ id: row.id, employeeCode: row.employeeCode, name: row.name })
                )
                .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
        ),
      });
    },

    create(context, input) {
      const resolved = gate.requireTenant(context, WRITE);
      const request = isObject(input) ? input : {};
      const body = validateBody(request.body);
      const onDate = validateOnDate(
        blank(request.onDate) ? resolved.today : request.onDate,
        resolved.today
      );
      return sessionFor(resolved).transaction((tx) => {
        const factory =
          typeof request.factoryId === "string" ? tx.get("factories", request.factoryId) : null;
        if (factory === null || !gate.inFactoryScope(resolved, factory.id)) {
          throw fail("not_found", "that factory was not found");
        }
        const area = areaOf(tx, factory.id, request);
        gate.authorize(resolved, WRITE, {
          factoryId: factory.id,
          sectionShiftId: area.sectionShiftId ?? undefined,
        });
        const mentionIds = mentionsOf(tx, factory.id, request.mentionIds);
        const comment = tx.insert("comments", {
          factoryId: factory.id,
          ...area,
          onDate,
          body,
          authorId: resolved.user.id,
          mentionIds,
          revision: 1,
          createdAt: clock(),
          editedAt: null,
        });
        return view(tx, resolved, comment, names(resolved));
      });
    },

    // Newest day first, then newest note. Filters narrow what the caller may already read.
    list(context, filters = {}) {
      const resolved = gate.requireTenant(context, READ);
      const query = isObject(filters) ? filters : {};
      const limit = readLimit(query.limit);
      const reader = sessionFor(resolved);
      const nameOf = names(resolved);
      const rows = reader
        .list(
          "comments",
          (row) =>
            readable(resolved, row) &&
            (blank(query.factoryId) || row.factoryId === query.factoryId) &&
            (blank(query.lineId) || row.lineId === query.lineId) &&
            (blank(query.shiftId) || row.shiftId === query.shiftId) &&
            (blank(query.from) || row.onDate >= query.from) &&
            (blank(query.to) || row.onDate <= query.to) &&
            (query.mine !== true || row.authorId === resolved.user.id)
        )
        .map((row, index) => ({ row, index }))
        .sort(
          (a, b) =>
            b.row.onDate.localeCompare(a.row.onDate) ||
            b.row.createdAt.localeCompare(a.row.createdAt) ||
            b.index - a.index
        )
        .map(({ row }) => row);
      return Object.freeze({
        asOf: clock(),
        total: rows.length,
        items: Object.freeze(
          rows.slice(0, limit).map((row) => view(reader, resolved, row, nameOf))
        ),
      });
    },

    get(context, commentId) {
      const resolved = gate.requireTenant(context, READ);
      const reader = sessionFor(resolved);
      return view(reader, resolved, requireComment(reader, resolved, commentId), names(resolved), {
        revisions: true,
      });
    },

    // Only the author, with a reason; the text it replaces is kept as a revision (D66).
    edit(context, commentId, input) {
      const resolved = gate.requireTenant(context, WRITE);
      const request = isObject(input) ? input : {};
      const body = validateBody(request.body);
      const reason = validateReason(request.reason);
      return sessionFor(resolved).transaction((tx) => {
        const comment = requireComment(tx, resolved, commentId);
        if (comment.authorId !== resolved.user.id) {
          throw fail("forbidden", "only the author can edit a comment");
        }
        gate.authorize(resolved, WRITE, resourceOf(comment));
        if (
          request.expectedRevision !== undefined &&
          request.expectedRevision !== comment.revision
        ) {
          throw fail("conflict", "this comment was changed; reload it and try again");
        }
        const mentionIds =
          request.mentionIds === undefined
            ? comment.mentionIds
            : mentionsOf(tx, comment.factoryId, request.mentionIds);
        const sameMentions =
          mentionIds.length === comment.mentionIds.length &&
          mentionIds.every((id) => comment.mentionIds.includes(id));
        if (body === comment.body && sameMentions) {
          throw fail("no_change", "nothing was changed");
        }
        const at = clock();
        tx.insert("commentRevisions", {
          commentId: comment.id,
          revision: comment.revision,
          body: comment.body,
          mentionIds: comment.mentionIds,
          writtenAt: comment.editedAt ?? comment.createdAt,
          supersededAt: at,
          reason,
        });
        const updated = tx.update("comments", comment.id, {
          body,
          mentionIds,
          revision: comment.revision + 1,
          editedAt: at,
        });
        return view(tx, resolved, updated, names(resolved), { revisions: true });
      });
    },
  });
}
