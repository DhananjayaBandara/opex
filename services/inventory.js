// Stock and material requisitions (SRS 7.4; architecture 9.5; decisions D89 to D91).
//
// Stock on hand is never stored: it is the sum of the movements of a material at a factory, and a
// movement is only ever added. Manual movements (Opening, Issue, Return, Adjustment in or out) need
// the stock adjustment permission; receipts and their reversals come only from goods receipts
// (services/procurement.js). A requisition asks the store for materials and, once approved, issues
// them in one transaction.
//
// Every call resolves the tenant and the caller's access from the context. Each write runs in one
// transaction with its audit event, so a refused call leaves neither a row nor an event.
// Browser-safe: no Node imports.
import {
  CANCELLABLE_REQUISITION,
  addsStock,
  buildMovement,
  buildRequisition,
  buildRequisitionLine,
  changeRequisition,
  coverDays,
  directionOf,
  INDICATOR_LABELS,
  requireEnough,
  requireRequisitionStatus,
  stockIndicator,
} from "../domain/inventory.js";
import { PREFIXES, nextNumber, round3 } from "../domain/procurement.js";
import { optionalText, requireReason } from "../domain/workforce.js";
import { fail } from "./errors.js";
import {
  MOVEMENTS,
  acceptedByPoLine,
  balanceIndex,
  createSupplyHelpers,
  freeze,
  idMap,
  isObject,
} from "./supply-common.js";

const VIEW = "procurement.view";
const ADJUST = "stock.adjust";
const MANAGE = "requisition.manage";
const APPROVE = "requisition.approve";

const REQUISITIONS = "requisitions";
const LINES = "requisitionLines";

const IMMUTABLE = (fields, names) => {
  for (const field of names) {
    if (fields[field] !== undefined)
      throw fail("immutable_field", `${field} cannot be edited here`);
  }
};

export function createInventory({ store, gate, clock }) {
  const { sessionFor, allowed, requireRow, balanceAt, factoryFor, activeMaterial, nameOf } =
    createSupplyHelpers({ store, gate });

  function documentFor(tx, resolved, id, permission = VIEW) {
    const row = requireRow(tx, REQUISITIONS, id, "requisition");
    gate.authorize(resolved, permission, { factoryId: row.factoryId });
    return row;
  }

  const requireStatus = (row, expected, action) => requireRequisitionStatus(row, expected, action);

  function recordStatus(tx, row, status, action, changes = {}) {
    tx.record({
      action,
      entityType: REQUISITIONS,
      entityId: row.id,
      changes: { status: { before: row.status, after: status }, ...changes },
    });
  }

  // Pending quantity on issued purchase orders per "factoryId|materialId" (D89, "on order").
  function onOrderIndex(reader, resolved) {
    const accepted = acceptedByPoLine(reader);
    const orders = new Map(
      reader
        .list(
          "purchaseOrders",
          (row) => row.status === "issued" && allowed(resolved, VIEW, row.factoryId)
        )
        .map((row) => [row.id, row])
    );
    const totals = new Map();
    if (orders.size === 0) return totals;
    for (const line of reader.list("purchaseOrderLines", (row) => orders.has(row.poId))) {
      const key = `${orders.get(line.poId).factoryId}|${line.materialId}`;
      const pending = Math.max(0, round3(line.quantity - (accepted.get(line.id) ?? 0)));
      totals.set(key, round3((totals.get(key) ?? 0) + pending));
    }
    return totals;
  }

  function movementRow(row, look, userName) {
    const material = look.materials.get(row.materialId);
    return freeze({
      id: row.id,
      factoryId: row.factoryId,
      factoryName: look.factories.get(row.factoryId)?.name ?? null,
      materialId: row.materialId,
      materialCode: material?.code ?? null,
      materialName: material?.name ?? null,
      unit: material?.unit ?? null,
      type: row.type,
      direction: row.direction,
      quantity: row.quantity,
      date: row.date,
      reason: row.reason ?? null,
      receiptId: row.receiptId ?? null,
      receiptNumber: row.receiptId ? (look.receipts.get(row.receiptId)?.number ?? null) : null,
      requisitionId: row.requisitionId ?? null,
      requisitionNumber: row.requisitionId
        ? (look.requisitions.get(row.requisitionId)?.number ?? null)
        : null,
      reversesId: row.reversesId ?? null,
      recordedBy: userName(row.recordedBy),
      recordedAt: row.recordedAt,
    });
  }

  function requisitionRow(row, lines, look, userName) {
    return freeze({
      id: row.id,
      number: row.number,
      factoryId: row.factoryId,
      factoryName: look.factories.get(row.factoryId)?.name ?? null,
      status: row.status,
      neededBy: row.neededBy ?? null,
      note: row.note ?? null,
      lines: lines.length,
      requestedBy: userName(row.requestedBy),
      submittedAt: row.submittedAt ?? null,
      decidedBy: userName(row.decidedBy),
      decidedAt: row.decidedAt ?? null,
      decisionReason: row.decisionReason ?? null,
      issuedBy: userName(row.issuedBy),
      issuedAt: row.issuedAt ?? null,
      cancelReason: row.cancelReason ?? null,
    });
  }

  function lookups(reader) {
    return {
      factories: idMap(reader.list("factories")),
      materials: idMap(reader.list("materials")),
      receipts: idMap(reader.list("goodsReceipts")),
      requisitions: idMap(reader.list(REQUISITIONS)),
    };
  }

  function insertLine(tx, requisition, input) {
    const fields = isObject(input) ? input : {};
    const material = activeMaterial(tx, fields.materialId);
    const quantity = buildRequisitionLine(fields);
    return tx.insert(LINES, {
      requisitionId: requisition.id,
      factoryId: requisition.factoryId,
      materialId: material.id,
      ...quantity,
    });
  }

  return Object.freeze({
    // ---- Stock (D89) --------------------------------------------------------------------------

    // One row per factory and material that has a movement or an open order, with the derived
    // balance, cover, indicator (always a word) and the quantity on order.
    stock(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { factoryId, materialId, indicator } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const onOrder = onOrderIndex(session, resolved);
      const lastDate = new Map();
      const balances = new Map();
      for (const movement of session.list(MOVEMENTS, (row) =>
        allowed(resolved, VIEW, row.factoryId)
      )) {
        const key = `${movement.factoryId}|${movement.materialId}`;
        const quantity = movement.direction === "in" ? movement.quantity : -movement.quantity;
        balances.set(key, round3((balances.get(key) ?? 0) + quantity));
        if ((lastDate.get(key) ?? "") < movement.date) lastDate.set(key, movement.date);
      }
      const keys = new Set([...balances.keys(), ...onOrder.keys()]);
      const rows = [];
      for (const key of keys) {
        const [factory, material] = key.split("|");
        if (factoryId !== undefined && factory !== factoryId) continue;
        if (materialId !== undefined && material !== materialId) continue;
        const master = look.materials.get(material);
        if (master === undefined) continue;
        const balance = balances.get(key) ?? 0;
        const state = stockIndicator(balance, master.reorderLevel ?? 0, master.dailyUse);
        if (indicator !== undefined && state !== indicator) continue;
        rows.push(
          freeze({
            factoryId: factory,
            factoryName: look.factories.get(factory)?.name ?? null,
            materialId: material,
            materialCode: master.code,
            materialName: master.name,
            unit: master.unit,
            active: master.active !== false,
            balance,
            reorderLevel: master.reorderLevel ?? 0,
            dailyUse: master.dailyUse ?? null,
            coverDays: coverDays(balance, master.dailyUse),
            indicator: state,
            indicatorLabel: INDICATOR_LABELS[state],
            onOrder: onOrder.get(key) ?? 0,
            lastMovementDate: lastDate.get(key) ?? null,
          })
        );
      }
      return Object.freeze(
        rows.sort(
          (a, b) =>
            a.materialName.localeCompare(b.materialName) ||
            a.factoryName.localeCompare(b.factoryName)
        )
      );
    },

    // ---- Movements (D89, D90) -----------------------------------------------------------------

    movements(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { factoryId, materialId, type, from, to } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const userName = nameOf(resolved);
      return Object.freeze(
        session
          .list(
            MOVEMENTS,
            (row) =>
              allowed(resolved, VIEW, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (materialId === undefined || row.materialId === materialId) &&
              (type === undefined || row.type === type) &&
              (from === undefined || row.date >= from) &&
              (to === undefined || row.date <= to)
          )
          .sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt))
          .map((row) => movementRow(row, look, userName))
      );
    },

    // A manual movement. Stock never goes below zero (D90); an Opening is the first movement of a
    // material at a factory; an inactive material can be moved out but not in.
    recordMovement(context, input) {
      const resolved = gate.requireTenant(context, ADJUST);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const factory = factoryFor(tx, resolved, ADJUST, fields.factoryId);
        const values = buildMovement(fields, resolved.today);
        const material = addsStock(values.type)
          ? activeMaterial(tx, fields.materialId)
          : requireRow(tx, "materials", fields.materialId, "material");
        const existing = tx.list(
          MOVEMENTS,
          (row) => row.factoryId === factory.id && row.materialId === material.id
        );
        if (values.type === "opening" && existing.length > 0) {
          throw fail(
            "opening_not_first",
            `${material.name} already has stock movements at ${factory.name}; record an adjustment instead`
          );
        }
        if (!addsStock(values.type)) {
          requireEnough(balanceAt(tx, factory.id, material.id), values.quantity, material.name);
        }
        const row = tx.insert(MOVEMENTS, {
          factoryId: factory.id,
          materialId: material.id,
          ...values,
          receiptId: null,
          requisitionId: null,
          reversesId: null,
          recordedBy: resolved.user.id,
          recordedAt: clock(),
        });
        if (values.type === "adjustment_in" || values.type === "adjustment_out") {
          tx.record({
            action: "stock_adjusted",
            entityType: MOVEMENTS,
            entityId: row.id,
            changes: {
              quantity: {
                before: null,
                after: values.direction === "in" ? values.quantity : -values.quantity,
              },
            },
          });
        }
        return freeze(tx.get(MOVEMENTS, row.id));
      });
    },

    // ---- Requisitions (D91) -------------------------------------------------------------------

    requisitions(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { factoryId, status } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const userName = nameOf(resolved);
      const lines = session.list(LINES);
      return Object.freeze(
        session
          .list(
            REQUISITIONS,
            (row) =>
              allowed(resolved, VIEW, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (status === undefined || row.status === status)
          )
          .sort((a, b) => b.number.localeCompare(a.number))
          .map((row) =>
            requisitionRow(
              row,
              lines.filter((line) => line.requisitionId === row.id),
              look,
              userName
            )
          )
      );
    },

    // The requisition, its lines against what is on hand now, and what the caller may do to it.
    requisition(context, id) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const row = documentFor(session, resolved, id);
      const look = lookups(session);
      const userName = nameOf(resolved);
      const lines = session.list(LINES, (line) => line.requisitionId === row.id);
      const balances = balanceIndex(session);
      const open = row.status === "approved";
      const detail = lines
        .map((line) => {
          const material = look.materials.get(line.materialId);
          const onHand = balances.get(`${row.factoryId}|${line.materialId}`) ?? 0;
          return freeze({
            id: line.id,
            materialId: line.materialId,
            materialCode: material?.code ?? null,
            materialName: material?.name ?? null,
            unit: material?.unit ?? null,
            quantity: line.quantity,
            onHand,
            short: open || row.status === "submitted" ? onHand < line.quantity : false,
          });
        })
        .sort((a, b) => (a.materialCode ?? "").localeCompare(b.materialCode ?? ""));
      const mayManage = allowed(resolved, MANAGE, row.factoryId);
      const mayApprove = allowed(resolved, APPROVE, row.factoryId);
      return freeze({
        requisition: requisitionRow(row, lines, look, userName),
        lines: Object.freeze(detail),
        anyShort: detail.some((line) => line.short),
        editable: mayManage && row.status === "draft",
        canSubmit: mayManage && row.status === "draft" && lines.length > 0,
        canApprove: mayApprove && row.status === "submitted",
        canReject: mayApprove && row.status === "submitted",
        canIssue: mayApprove && row.status === "approved",
        canCancel: mayManage && CANCELLABLE_REQUISITION.includes(row.status),
      });
    },

    createRequisition(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const factory = factoryFor(tx, resolved, MANAGE, fields.factoryId);
        const values = buildRequisition(fields);
        const row = tx.insert(REQUISITIONS, {
          ...values,
          number: nextNumber(
            PREFIXES.requisition,
            tx.list(REQUISITIONS).map((entry) => entry.number)
          ),
          factoryId: factory.id,
          status: "draft",
          requestedBy: resolved.user.id,
          submittedAt: null,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          issuedBy: null,
          issuedAt: null,
          cancelReason: null,
        });
        const seen = new Set();
        for (const line of Array.isArray(fields.lines) ? fields.lines : []) {
          const materialId = isObject(line) ? line.materialId : undefined;
          if (seen.has(materialId))
            throw fail("duplicate_line", "each material can be on a requisition once");
          seen.add(materialId);
          insertLine(tx, row, line);
        }
        return freeze(tx.get(REQUISITIONS, row.id));
      });
    },

    updateRequisition(context, id, patch) {
      const resolved = gate.requireTenant(context, MANAGE);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["factoryId", "number", "status", "lines"]);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, id, MANAGE);
        requireStatus(row, ["draft"], "changed");
        return freeze(tx.update(REQUISITIONS, row.id, changeRequisition(fields)));
      });
    },

    addRequisitionLine(context, requisitionId, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, requisitionId, MANAGE);
        requireStatus(row, ["draft"], "changed");
        const materialId = isObject(input) ? input.materialId : undefined;
        if (
          tx.list(LINES, (line) => line.requisitionId === row.id && line.materialId === materialId)
            .length > 0
        ) {
          throw fail("duplicate_line", "that material is already on the requisition");
        }
        return freeze(insertLine(tx, row, input));
      });
    },

    updateRequisitionLine(context, id, patch) {
      const resolved = gate.requireTenant(context, MANAGE);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["requisitionId", "materialId", "factoryId"]);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, LINES, id, "requisition line");
        const row = documentFor(tx, resolved, line.requisitionId, MANAGE);
        requireStatus(row, ["draft"], "changed");
        return freeze(tx.update(LINES, line.id, buildRequisitionLine(fields)));
      });
    },

    removeRequisitionLine(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, LINES, id, "requisition line");
        const row = documentFor(tx, resolved, line.requisitionId, MANAGE);
        requireStatus(row, ["draft"], "changed");
        tx.remove(LINES, line.id);
        return freeze({ id: line.id });
      });
    },

    submitRequisition(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, id, MANAGE);
        requireStatus(row, ["draft"], "submitted");
        if (tx.list(LINES, (line) => line.requisitionId === row.id).length === 0) {
          throw fail("no_lines", "add at least one line before submitting");
        }
        tx.update(REQUISITIONS, row.id, { status: "submitted", submittedAt: clock() });
        recordStatus(tx, row, "submitted", "requisition_submitted");
        return freeze(tx.get(REQUISITIONS, row.id));
      });
    },

    approveRequisition(context, id) {
      const resolved = gate.requireTenant(context, APPROVE);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, id, APPROVE);
        requireStatus(row, ["submitted"], "approved");
        tx.update(REQUISITIONS, row.id, {
          status: "approved",
          decidedBy: resolved.user.id,
          decidedAt: clock(),
          decisionReason: null,
        });
        recordStatus(tx, row, "approved", "requisition_approved");
        return freeze(tx.get(REQUISITIONS, row.id));
      });
    },

    rejectRequisition(context, id, input) {
      const resolved = gate.requireTenant(context, APPROVE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, id, APPROVE);
        requireStatus(row, ["submitted"], "rejected");
        const reason = requireReason(request.reason, "a reason for rejecting the requisition");
        tx.update(REQUISITIONS, row.id, {
          status: "rejected",
          decidedBy: resolved.user.id,
          decidedAt: clock(),
          decisionReason: reason,
        });
        recordStatus(tx, row, "rejected", "requisition_rejected");
        return freeze(tx.get(REQUISITIONS, row.id));
      });
    },

    // The whole requisition is issued or none of it: one Issue movement per line in one transaction,
    // refused (and nothing posted) if any line is short (D91).
    issueRequisition(context, id) {
      const resolved = gate.requireTenant(context, APPROVE);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, id, APPROVE);
        requireStatus(row, ["approved"], "issued");
        const materials = idMap(tx.list("materials"));
        const lines = tx.list(LINES, (line) => line.requisitionId === row.id);
        for (const line of lines) {
          const material = materials.get(line.materialId);
          requireEnough(
            balanceAt(tx, row.factoryId, line.materialId),
            line.quantity,
            material?.name ?? "the material"
          );
          tx.insert(MOVEMENTS, {
            factoryId: row.factoryId,
            materialId: line.materialId,
            type: "issue",
            direction: directionOf("issue"),
            quantity: line.quantity,
            date: resolved.today,
            reason: null,
            receiptId: null,
            requisitionId: row.id,
            reversesId: null,
            recordedBy: resolved.user.id,
            recordedAt: clock(),
          });
        }
        tx.update(REQUISITIONS, row.id, {
          status: "issued",
          issuedBy: resolved.user.id,
          issuedAt: clock(),
        });
        recordStatus(tx, row, "issued", "requisition_issued");
        return freeze(tx.get(REQUISITIONS, row.id));
      });
    },

    // A requisition is cancelled before it is issued; the reason is optional (D91).
    cancelRequisition(context, id, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, id, MANAGE);
        requireStatus(row, CANCELLABLE_REQUISITION, "cancelled");
        const reason = optionalText(request.reason, "the reason", 200);
        tx.update(REQUISITIONS, row.id, { status: "cancelled", cancelReason: reason });
        recordStatus(tx, row, "cancelled", "requisition_cancelled");
        return freeze(tx.get(REQUISITIONS, row.id));
      });
    },
  });
}
