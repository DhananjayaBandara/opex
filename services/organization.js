// Factories, sections, shifts, SectionShifts, lines, designations and working calendars
// (SRS 6, FR-ORG-001..007, UC-ORG-01..05; decisions D21, D22). One generic set of calls serves every
// kind, driven by the descriptions in domain/organization.js.
//
// Every call resolves the tenant and the caller's effective access from the context (never from the
// payload). Writes need the kind's permission (WHAT) and a factory scope that covers the factory the
// row belongs to (WHERE), failing closed. Reads need only an active membership, limited to the
// caller's factories. Each write runs in one transaction with its audit event, so a refused call
// leaves neither a row nor an event. Master data that is referenced is deactivated, never deleted.
// Browser-safe: no Node imports.
import { KINDS, kindOf } from "../domain/organization.js";
import { fail } from "./errors.js";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// The stored `nameKey` only exists to make names unique regardless of case.
const view = (row) =>
  Object.freeze(Object.fromEntries(Object.entries(row).filter(([field]) => field !== "nameKey")));

// The factory a row belongs to; a factory belongs to itself; tenant-wide data to none.
const factoryOf = (kindName, row) => (kindName === "factory" ? row.id : (row.factoryId ?? null));

export function createOrganization({ store, gate }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  function authorizeRow(resolved, kindName, row) {
    const kind = KINDS[kindName];
    if (kind.tenantWide) gate.authorizeTenantWide(resolved, kind.permission);
    else gate.authorize(resolved, kind.permission, { factoryId: factoryOf(kindName, row) });
  }

  function requireRow(tx, kind, id) {
    const row = typeof id === "string" ? tx.get(kind.collection, id) : null;
    if (row === null) throw fail("not_found", "that record was not found");
    return row;
  }

  return Object.freeze({
    create(context, kindName, input) {
      const kind = kindOf(kindName);
      const resolved = gate.requireTenant(context, kind.permission);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const parents = kind.parents.map(({ field, kind: parentKind }) => ({
          field,
          kind: parentKind,
          row: requireRow(tx, KINDS[parentKind], fields[field]),
        }));
        if (parents.length === 0) gate.authorizeTenantWide(resolved, kind.permission);
        for (const parent of parents) {
          gate.authorize(resolved, kind.permission, {
            factoryId: factoryOf(parent.kind, parent.row),
          });
        }
        const factoryIds = new Set(parents.map((parent) => factoryOf(parent.kind, parent.row)));
        const factoryId = parents.length > 0 ? [...factoryIds][0] : null;
        const statesFactory = parents[0]?.field !== "factoryId" && fields.factoryId !== undefined;
        if (factoryIds.size > 1 || (statesFactory && fields.factoryId !== factoryId)) {
          throw fail("cross_factory", "those records belong to different factories");
        }
        if (parents.some((parent) => parent.row.active === false)) {
          throw fail("inactive_parent", "that parent is inactive");
        }

        const own = kind.build(fields);
        const siblings = tx.list(kind.collection, (row) => row.factoryId === factoryId);
        const row = {
          ...own,
          ...Object.fromEntries(parents.map((parent) => [parent.field, parent.row.id])),
          ...(parents.length > 0 && { factoryId }),
          ...(kind.hasActive && { active: true }),
          ...(kind.ordered && {
            sortOrder:
              Math.max(
                0,
                ...(parents.length > 0 ? siblings : tx.list(kind.collection)).map(
                  (r) => r.sortOrder
                )
              ) + 1,
          }),
        };
        return view(tx.insert(kind.collection, row));
      });
    },

    update(context, kindName, id, patch) {
      const kind = kindOf(kindName);
      const resolved = gate.requireTenant(context, kind.permission);
      const input = isObject(patch) ? patch : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, kind, id);
        authorizeRow(resolved, kindName, row);
        for (const field of kind.controlled) {
          if (input[field] !== undefined) {
            throw fail("immutable_field", `${field} cannot be edited here`);
          }
        }
        return view(tx.update(kind.collection, row.id, kind.change(input, row)));
      });
    },

    // Deactivate (or reactivate) instead of deleting (FR-ORG-007). A parent cannot be switched off
    // while something under it is still active, and nothing is revived under an inactive parent.
    setActive(context, kindName, id, active) {
      const kind = kindOf(kindName);
      const resolved = gate.requireTenant(context, kind.permission);
      if (!kind.hasActive) throw fail("not_supported", `${kindName} has no active flag`);
      if (typeof active !== "boolean") throw fail("invalid_field", "active must be true or false");
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, kind, id);
        authorizeRow(resolved, kindName, row);
        if (row.active === active) return view(row);
        if (active) {
          for (const { field, kind: parentKind } of kind.parents) {
            const parent = tx.get(KINDS[parentKind].collection, row[field]);
            if (parent?.active === false) throw fail("inactive_parent", "that parent is inactive");
          }
        } else {
          for (const [collection, field] of kind.activeChildren) {
            if (
              tx.list(collection, (child) => child[field] === row.id && child.active !== false)
                .length > 0
            ) {
              throw fail("active_children", "deactivate what is under it first");
            }
          }
        }
        return view(tx.update(kind.collection, row.id, { active }));
      });
    },

    remove(context, kindName, id) {
      const kind = kindOf(kindName);
      const resolved = gate.requireTenant(context, kind.permission);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, kind, id);
        authorizeRow(resolved, kindName, row);
        for (const [collection, field] of kind.referencedBy) {
          if (tx.list(collection, (other) => other[field] === row.id).length > 0) {
            throw fail("referenced", "it is in use; deactivate it instead of deleting it");
          }
        }
        return view(tx.remove(kind.collection, row.id));
      });
    },

    // The complete list of a group, in the new order. A factory's sections (or shifts) are ordered
    // within that factory; factories are ordered across the organization.
    reorder(context, kindName, ids, options) {
      const kind = kindOf(kindName);
      if (!kind.ordered) throw fail("not_supported", `${kindName} has no sort order`);
      const resolved = gate.requireTenant(context, kind.permission);
      return sessionFor(resolved).transaction((tx) => {
        let factoryId = null;
        if (kind.parents.length === 0) {
          gate.authorizeTenantWide(resolved, kind.permission);
        } else {
          factoryId = options?.factoryId;
          requireRow(tx, KINDS.factory, factoryId);
          gate.authorize(resolved, kind.permission, { factoryId });
        }
        const group = tx.list(
          kind.collection,
          (row) => factoryId === null || row.factoryId === factoryId
        );
        const known = new Set(group.map((row) => row.id));
        const listed = Array.isArray(ids) ? new Set(ids) : new Set();
        if (
          !Array.isArray(ids) ||
          listed.size !== ids.length ||
          ids.length !== known.size ||
          !ids.every((id) => known.has(id))
        ) {
          throw fail("invalid_order", "list every record of the group exactly once");
        }
        ids.forEach((id, index) => tx.update(kind.collection, id, { sortOrder: index + 1 }));
        return Object.freeze(ids.map((id) => view(tx.get(kind.collection, id))));
      });
    },

    get(context, kindName, id) {
      const kind = kindOf(kindName);
      const resolved = gate.requireTenant(context);
      const row = requireRow(sessionFor(resolved), kind, id);
      if (!kind.tenantWide && !gate.inFactoryScope(resolved, factoryOf(kindName, row))) {
        throw fail("forbidden", "you do not have access to that");
      }
      return view(row);
    },

    // Inactive rows are hidden unless asked for. Only rows in the caller's factory scope are listed.
    list(context, kindName, filter) {
      const kind = kindOf(kindName);
      const resolved = gate.requireTenant(context);
      const { factoryId, sectionId, includeInactive = false } = isObject(filter) ? filter : {};
      const rows = sessionFor(resolved).list(
        kind.collection,
        (row) =>
          (kind.tenantWide || gate.inFactoryScope(resolved, factoryOf(kindName, row))) &&
          (includeInactive || row.active !== false) &&
          (factoryId === undefined || factoryOf(kindName, row) === factoryId) &&
          (sectionId === undefined || row.sectionId === sectionId)
      );
      if (kind.ordered) rows.sort((a, b) => a.sortOrder - b.sortOrder);
      return Object.freeze(rows.map(view));
    },
  });
}
