// The audit log reader (SRS 15.4; decision D97): who did what to which record, newest first.
//
// Nothing here writes. The log itself is appended by the store inside the transaction of each change,
// so a change and its event stand or fall together; this service only reads it, for one organization
// and only for someone who holds `audit.view` across every factory. Support access reads it too (a
// read-only permission). Sensitive fields are replaced before anything leaves the service.
// Browser-safe: no Node imports.
import {
  actionLabel,
  detailOf,
  entityLabel,
  matchesFilters,
  readFilters,
  readLimit,
  summarize,
} from "../domain/audit.js";
import { SYSTEM_ACTOR } from "./context.js";
import { fail } from "./errors.js";

const VIEW = "audit.view";
const SYSTEM_NAME = "System";

export function createAudit({ store, gate }) {
  const platformReader = () => store.platformSession({ actorId: SYSTEM_ACTOR });

  function reader(context) {
    const resolved = gate.requireTenant(context, VIEW);
    gate.authorizeTenantWide(resolved, VIEW);
    const session = store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });
    return { resolved, session };
  }

  // A name for the actor column. A user outside the platform registry (or a removed one) is shown by
  // id, never hidden; the system actor is named as such.
  function namer() {
    const platform = platformReader();
    const names = new Map();
    return (actorId) => {
      if (actorId === SYSTEM_ACTOR) return SYSTEM_NAME;
      if (!names.has(actorId)) {
        const user = platform.get("users", actorId);
        names.set(actorId, user === null ? actorId : user.name);
      }
      return names.get(actorId);
    };
  }

  const row = (event, nameOf) =>
    Object.freeze({
      id: event.id,
      timestamp: event.timestamp,
      actorId: event.actorId,
      actorName: nameOf(event.actorId),
      action: event.action,
      actionLabel: actionLabel(event.action),
      entityType: event.entityType,
      entityLabel: entityLabel(event.entityType),
      entityId: event.entityId,
      summary: summarize(event),
    });

  return Object.freeze({
    // A page of events, newest first. `before` is the id of the last event of the previous page; the
    // log only grows at its end, so a page never repeats or skips an event while someone else works.
    list(context, input = {}) {
      const { resolved, session } = reader(context);
      const filters = readFilters(input, resolved.tenant.timeZone);
      const limit = readLimit(input?.limit);
      const events = session.auditLog();
      let upTo = events.length;
      if (filters.before !== null) {
        const at = events.findIndex((event) => event.id === filters.before);
        if (at === -1) throw fail("invalid_filter", "that page position is not in this log");
        upTo = at;
      }
      const nameOf = namer();
      const items = [];
      let more = false;
      let total = 0;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (!matchesFilters(events[index], filters)) continue;
        total += 1;
        if (index >= upTo) continue;
        if (items.length === limit) {
          more = true;
          continue;
        }
        items.push(row(events[index], nameOf));
      }
      return Object.freeze({
        items: Object.freeze(items),
        next: more ? items[items.length - 1].id : null,
        total,
      });
    },

    // One event with every changed field, before and after, sensitive fields redacted.
    get(context, eventId) {
      const { session } = reader(context);
      const event = session.auditLog().find((candidate) => candidate.id === eventId);
      if (event === undefined) throw fail("not_found", "that audit event was not found");
      const nameOf = namer();
      return Object.freeze({
        ...row(event, nameOf),
        correlationId: event.correlationId ?? null,
        changes: Object.freeze(detailOf(event.changes)),
      });
    },

    // What the filter controls offer: the actors, actions and kinds of record that appear in the log.
    facets(context) {
      const { session } = reader(context);
      const nameOf = namer();
      const actors = new Map();
      const actions = new Set();
      const entityTypes = new Set();
      for (const event of session.auditLog()) {
        actors.set(event.actorId, nameOf(event.actorId));
        actions.add(event.action);
        entityTypes.add(event.entityType);
      }
      return Object.freeze({
        actors: Object.freeze(
          [...actors]
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        ),
        actions: Object.freeze(
          [...actions].sort().map((value) => ({ value, label: actionLabel(value) }))
        ),
        entityTypes: Object.freeze(
          [...entityTypes].sort().map((value) => ({ value, label: entityLabel(value) }))
        ),
      });
    },
  });
}
