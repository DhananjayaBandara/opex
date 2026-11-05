// Helpers shared by the procurement, inventory and finance services (S7; D83 to D96): resolving the
// caller's session, the WHERE check for a factory, organization-wide writes, name lookups and the
// stock balance. Browser-safe: no Node imports.
import { balanceOf } from "../domain/inventory.js";
import { fail } from "./errors.js";

export const MOVEMENTS = "stockMovements";

export const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const byName = (a, b) => a.name.localeCompare(b.name);
export const idMap = (rows) => new Map(rows.map((row) => [row.id, row]));
export const freeze = (row) => Object.freeze(row);

// Accepted quantity per purchase-order line, from Posted receipts only: a reversed receipt no longer
// counts, so delivery is always derived and never stored (D87, D88).
export function acceptedByPoLine(reader) {
  const posted = new Set(
    reader.list("goodsReceipts", (row) => row.status === "posted").map((row) => row.id)
  );
  const totals = new Map();
  if (posted.size === 0) return totals;
  for (const line of reader.list("goodsReceiptLines", (row) => posted.has(row.receiptId))) {
    totals.set(line.poLineId, (totals.get(line.poLineId) ?? 0) + line.accepted);
  }
  return totals;
}

// Stock on hand per "factoryId|materialId", summed from the movements (C12).
export function balanceIndex(reader) {
  const totals = new Map();
  for (const movement of reader.list(MOVEMENTS)) {
    const key = `${movement.factoryId}|${movement.materialId}`;
    const quantity = movement.direction === "in" ? movement.quantity : -movement.quantity;
    totals.set(key, Math.round(((totals.get(key) ?? 0) + quantity) * 1000) / 1000);
  }
  return totals;
}

export function createSupplyHelpers({ store, gate }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  // Reads and writes of a factory's data: the permission and a scope that covers the factory.
  const allowed = (resolved, permission, factoryId) => {
    try {
      gate.authorize(resolved, permission, { factoryId });
      return true;
    } catch {
      return false;
    }
  };

  // Data of the whole organization: the permission and a scope of every factory, never assignment-only.
  const tenantWideAllowed = (resolved, permission) => {
    try {
      gate.authorizeTenantWide(resolved, permission);
      return true;
    } catch {
      return false;
    }
  };

  function masterWrite(context, permission) {
    const resolved = gate.requireTenant(context, permission);
    gate.authorizeTenantWide(resolved, permission);
    return resolved;
  }

  function nameOf(resolved) {
    const reader = store.platformSession({ actorId: resolved.user.id });
    const names = new Map();
    return (id) => {
      if (id === null || id === undefined) return null;
      if (!names.has(id)) names.set(id, reader.get("users", id)?.name ?? null);
      return names.get(id);
    };
  }

  function requireRow(tx, collection, id, noun) {
    const row = typeof id === "string" ? tx.get(collection, id) : null;
    if (row === null) throw fail("not_found", `that ${noun} was not found`);
    return row;
  }

  const companyCurrency = (reader) =>
    reader.list("settings", (row) => row.kind === "profile")[0]?.currency ?? "USD";

  const balanceAt = (reader, factoryId, materialId) =>
    balanceOf(
      reader.list(MOVEMENTS, (row) => row.factoryId === factoryId && row.materialId === materialId)
    );

  // A factory the caller may use: it exists, is in scope for the permission and is active.
  function factoryFor(tx, resolved, permission, factoryId) {
    const factory = requireRow(tx, "factories", factoryId, "factory");
    gate.authorize(resolved, permission, { factoryId: factory.id });
    if (factory.active === false) throw fail("inactive_parent", "that factory is inactive");
    return factory;
  }

  function activeMaterial(tx, materialId) {
    const material = requireRow(tx, "materials", materialId, "material");
    if (material.active === false) {
      throw fail("inactive_parent", `${material.name} is inactive and cannot be used`);
    }
    return material;
  }

  function activeSupplier(tx, supplierId) {
    const supplier = requireRow(tx, "suppliers", supplierId, "supplier");
    if (supplier.active === false) {
      throw fail("inactive_parent", `${supplier.name} is inactive and cannot be used`);
    }
    return supplier;
  }

  return Object.freeze({
    sessionFor,
    allowed,
    tenantWideAllowed,
    masterWrite,
    nameOf,
    requireRow,
    companyCurrency,
    balanceAt,
    factoryFor,
    activeMaterial,
    activeSupplier,
  });
}
