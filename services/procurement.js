// Procurement (SRS 3.1, 7.4, 9.5; architecture 9; decisions D83 to D88).
//
// Materials and suppliers, requests for quotation (RFQ), quotations and the award, purchase orders
// (PO) and goods receipts (GRN) with inspection, posting and reversal.
//
// Every call resolves the tenant and the caller's access from the context, never from the payload.
// Materials and suppliers belong to the whole organization, so changing them needs a tenant-wide
// scope; RFQs, quotations, POs and receipts belong to a factory and need a scope that covers it
// (WHERE), failing closed. Each write runs in one transaction with its audit event, so a refused call
// leaves neither a row nor an event. Delivery, totals and comparisons are worked out here on every
// read and never accepted from the caller. Posting a receipt writes its stock movements in the same
// transaction (D88).
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";
import { directionOf, reversalOf, requireEnough } from "../domain/inventory.js";
import {
  PREFIXES,
  buildMaterial,
  buildPo,
  buildPoLine,
  buildQuotation,
  buildQuotationLine,
  buildReceipt,
  buildReceiptLine,
  buildRfq,
  buildRfqLine,
  buildSupplier,
  candidateList,
  changeMaterial,
  changePo,
  changePoLine,
  changeReceipt,
  changeRfq,
  changeRfqLine,
  changeSupplier,
  compareQuotations,
  deliveryOf,
  lineAmount,
  nextNumber,
  poValue,
  quotationTotal,
  requireCancellable,
  requireDraft,
  round3,
} from "../domain/procurement.js";
import { requireReason } from "../domain/workforce.js";
import { fail } from "./errors.js";
import {
  MOVEMENTS,
  acceptedByPoLine,
  byName,
  createSupplyHelpers,
  freeze,
  idMap,
  isObject,
} from "./supply-common.js";

const VIEW = "procurement.view";
const MATERIAL = "material.manage";
const RFQ = "rfq.manage";
const PO = "po.manage";
const GRN = "grn.post";

const FOR = Object.freeze({
  view: VIEW,
  rfq: RFQ,
  po: PO,
  grn: GRN,
  adjust: "stock.adjust",
  requisition: "requisition.manage",
  approve: "requisition.approve",
});

const MATERIALS = "materials";
const SUPPLIERS = "suppliers";
const RFQS = "rfqs";
const RFQ_LINES = "rfqLines";
const QUOTATIONS = "quotations";
const QUOTATION_LINES = "quotationLines";
const POS = "purchaseOrders";
const PO_LINES = "purchaseOrderLines";
const RECEIPTS = "goodsReceipts";
const RECEIPT_LINES = "goodsReceiptLines";

const IMMUTABLE = (fields, names) => {
  for (const field of names) {
    if (fields[field] !== undefined) {
      throw fail("immutable_field", `${field} cannot be edited here`);
    }
  }
};

export function createProcurement({ store, gate, clock }) {
  const {
    sessionFor,
    allowed,
    masterWrite,
    requireRow,
    companyCurrency,
    balanceAt,
    factoryFor,
    activeMaterial,
    activeSupplier,
  } = createSupplyHelpers({ store, gate });

  function lookups(reader) {
    return {
      factories: idMap(reader.list("factories")),
      materials: idMap(reader.list(MATERIALS)),
      suppliers: idMap(reader.list(SUPPLIERS)),
    };
  }

  const numbersOf = (reader, collection) => reader.list(collection).map((row) => row.number);

  function documentFor(tx, resolved, collection, id, noun, permission = VIEW) {
    const row = requireRow(tx, collection, id, noun);
    gate.authorize(resolved, permission, { factoryId: row.factoryId });
    return row;
  }

  const recordStatus = (tx, collection, row, status, extra = {}) =>
    tx.record({
      action: extra.action,
      entityType: collection,
      entityId: row.id,
      changes: { status: { before: row.status, after: status }, ...(extra.changes ?? {}) },
    });

  // ---- Views ----------------------------------------------------------------------------------

  function materialLine(line, look) {
    const material = look.materials.get(line.materialId);
    return {
      materialId: line.materialId,
      materialCode: material?.code ?? null,
      materialName: material?.name ?? null,
      unit: material?.unit ?? null,
    };
  }

  function rfqRow(rfq, lines, quotations, look) {
    const awarded = quotations.find((row) => row.id === rfq.awardedQuotationId);
    return freeze({
      id: rfq.id,
      number: rfq.number,
      factoryId: rfq.factoryId,
      factoryName: look.factories.get(rfq.factoryId)?.name ?? null,
      status: rfq.status,
      requestDate: rfq.requestDate,
      dueDate: rfq.dueDate,
      note: rfq.note ?? null,
      cancelReason: rfq.cancelReason ?? null,
      candidates: Object.freeze(
        rfq.supplierIds.map((id) =>
          freeze({
            id,
            name: look.suppliers.get(id)?.name ?? null,
            quoted: quotations.some((row) => row.supplierId === id),
          })
        )
      ),
      lines: lines.length,
      quotations: quotations.length,
      awardedSupplierName: awarded ? (look.suppliers.get(awarded.supplierId)?.name ?? null) : null,
      purchaseOrderId: rfq.purchaseOrderId ?? null,
    });
  }

  function quotationView(quotation, qLines, rfq, rfqLines, look, today) {
    const lines = qLines.map((line) => ({
      ...line,
      rfqLine: rfqLines.find((row) => row.id === line.rfqLineId),
    }));
    return freeze({
      id: quotation.id,
      rfqId: quotation.rfqId,
      rfqNumber: rfq?.number ?? null,
      rfqStatus: rfq?.status ?? null,
      factoryId: quotation.factoryId,
      factoryName: look.factories.get(quotation.factoryId)?.name ?? null,
      supplierId: quotation.supplierId,
      supplierName: look.suppliers.get(quotation.supplierId)?.name ?? null,
      status: quotation.status,
      supplierRef: quotation.supplierRef ?? null,
      date: quotation.date,
      validUntil: quotation.validUntil ?? null,
      currency: quotation.currency,
      total: quotationTotal(qLines),
      covered: qLines.length,
      asked: rfqLines.length,
      longestLeadDays: qLines.reduce((most, line) => Math.max(most, line.leadDays), 0),
      expired: quotation.validUntil != null && quotation.validUntil < today,
      purchaseOrderId: quotation.status === "awarded" ? (rfq?.purchaseOrderId ?? null) : null,
      lines: Object.freeze(
        lines.map((line) =>
          freeze({
            id: line.id,
            rfqLineId: line.rfqLineId,
            ...materialLine(line.rfqLine ?? {}, look),
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            leadDays: line.leadDays,
            amount: lineAmount(line.quantity, line.unitPrice),
          })
        )
      ),
    });
  }

  function poRow(po, lines, accepted, receipts, look, today, rfq) {
    const value = poValue(lines);
    const delivery = deliveryOf(lines, accepted, po.expectedDate, today, po.status);
    return freeze({
      id: po.id,
      number: po.number,
      factoryId: po.factoryId,
      factoryName: look.factories.get(po.factoryId)?.name ?? null,
      supplierId: po.supplierId,
      supplierName: look.suppliers.get(po.supplierId)?.name ?? null,
      status: po.status,
      orderDate: po.orderDate,
      expectedDate: po.expectedDate,
      currency: po.currency,
      note: po.note ?? null,
      cancelReason: po.cancelReason ?? null,
      rfqId: po.rfqId ?? null,
      rfqNumber: rfq?.number ?? null,
      quotationId: po.quotationId ?? null,
      lines: lines.length,
      subtotal: value.subtotal,
      tax: value.tax,
      value: value.total,
      delivery: po.status === "issued" ? delivery.delivery : null,
      pending: po.status === "issued" ? delivery.pending : 0,
      late: delivery.late,
      receipts: receipts.length,
    });
  }

  function receiptRow(receipt, lines, po, look) {
    const sum = (field) => round3(lines.reduce((total, line) => total + line[field], 0));
    return freeze({
      id: receipt.id,
      number: receipt.number,
      poId: receipt.poId,
      poNumber: po?.number ?? null,
      factoryId: receipt.factoryId,
      factoryName: look.factories.get(receipt.factoryId)?.name ?? null,
      supplierId: receipt.supplierId,
      supplierName: look.suppliers.get(receipt.supplierId)?.name ?? null,
      status: receipt.status,
      receiptDate: receipt.receiptDate,
      challan: receipt.challan ?? null,
      note: receipt.note ?? null,
      cancelReason: receipt.cancelReason ?? null,
      reverseReason: receipt.reverseReason ?? null,
      receivedAt: receipt.receivedAt ?? null,
      postedAt: receipt.postedAt ?? null,
      reversedAt: receipt.reversedAt ?? null,
      lines: lines.length,
      received: sum("received"),
      accepted: sum("accepted"),
      rejected: sum("rejected"),
    });
  }

  const linesOf = (all, key, id) => all.filter((row) => row[key] === id);

  // ---- Checks ---------------------------------------------------------------------------------

  function requireIssuedPo(po) {
    if (po.status !== "issued") {
      throw fail("po_not_issued", `purchase order ${po.number} is ${po.status}, not issued`);
    }
  }

  // The accepted quantity of other Posted receipts plus this one cannot pass the ordered quantity
  // (P18).
  function requireWithinOrder(tx, receiptLines, poLines) {
    const accepted = acceptedByPoLine(tx);
    for (const line of receiptLines) {
      const poLine = poLines.get(line.poLineId);
      if (poLine === undefined) throw fail("not_found", "that order line was not found");
      const total = round3((accepted.get(line.poLineId) ?? 0) + line.accepted);
      if (total > poLine.quantity) {
        throw fail(
          "over_receipt",
          `accepting ${line.accepted} would bring the total to ${total}, above the ${poLine.quantity} ordered`
        );
      }
    }
  }

  function insertReceiptLines(tx, receipt, po, inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw fail("no_lines", "add at least one line to the receipt");
    }
    const poLines = tx.list(PO_LINES, (row) => row.poId === po.id);
    for (const input of inputs) {
      const fields = isObject(input) ? input : {};
      const poLine = poLines.find((row) => row.id === fields.poLineId);
      if (poLine === undefined) throw fail("not_found", "that order line was not found");
      tx.insert(RECEIPT_LINES, {
        receiptId: receipt.id,
        factoryId: receipt.factoryId,
        poLineId: poLine.id,
        materialId: poLine.materialId,
        ...buildReceiptLine(fields),
      });
    }
  }

  function insertRfqLine(tx, rfq, input) {
    const fields = isObject(input) ? input : {};
    const material = activeMaterial(tx, fields.materialId);
    return tx.insert(RFQ_LINES, {
      rfqId: rfq.id,
      factoryId: rfq.factoryId,
      materialId: material.id,
      ...buildRfqLine(fields, rfq.requestDate),
    });
  }

  function insertPoLine(tx, po, input) {
    const fields = isObject(input) ? input : {};
    const material = activeMaterial(tx, fields.materialId);
    return tx.insert(PO_LINES, {
      poId: po.id,
      factoryId: po.factoryId,
      materialId: material.id,
      ...buildPoLine(fields),
    });
  }

  return Object.freeze({
    // The factories the caller may use for a purpose: viewing, or one of the write permissions.
    factories(context, input) {
      const purpose = isObject(input) ? input.for : undefined;
      const permission = Object.hasOwn(FOR, purpose) ? FOR[purpose] : VIEW;
      const resolved = gate.requireTenant(context, permission);
      return Object.freeze(
        sessionFor(resolved)
          .list(
            "factories",
            (row) =>
              allowed(resolved, permission, row.id) && (permission === VIEW || row.active !== false)
          )
          .sort(byName)
          .map((row) => freeze({ id: row.id, code: row.code, name: row.name }))
      );
    },

    // ---- Materials (D84) ----------------------------------------------------------------------

    materials(context) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const onHand = new Map();
      for (const movement of session.list(MOVEMENTS, (row) =>
        allowed(resolved, VIEW, row.factoryId)
      )) {
        const quantity = movement.direction === "in" ? movement.quantity : -movement.quantity;
        onHand.set(movement.materialId, (onHand.get(movement.materialId) ?? 0) + quantity);
      }
      return Object.freeze(
        session
          .list(MATERIALS)
          .sort(byName)
          .map((row) => freeze({ ...row, onHand: round3(onHand.get(row.id) ?? 0) }))
      );
    },

    createMaterial(context, input) {
      const resolved = masterWrite(context, MATERIAL);
      const values = buildMaterial(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => freeze(tx.insert(MATERIALS, values)));
    },

    updateMaterial(context, id, patch) {
      const resolved = masterWrite(context, MATERIAL);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["unit", "active"]);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, MATERIALS, id, "material");
        return freeze(tx.update(MATERIALS, row.id, changeMaterial(fields)));
      });
    },

    // Deactivated, never deleted; stock already held can still be moved out (AC-9.2).
    setMaterialActive(context, id, active) {
      const resolved = masterWrite(context, MATERIAL);
      if (typeof active !== "boolean") throw fail("invalid_field", "active must be true or false");
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, MATERIALS, id, "material");
        return freeze(tx.update(MATERIALS, row.id, { active }));
      });
    },

    // ---- Suppliers (D84) ----------------------------------------------------------------------

    suppliers(context) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const orders = session.list(POS, (row) => allowed(resolved, VIEW, row.factoryId));
      return Object.freeze(
        session
          .list(SUPPLIERS)
          .sort(byName)
          .map((row) =>
            freeze({
              ...row,
              purchaseOrders: orders.filter((order) => order.supplierId === row.id).length,
            })
          )
      );
    },

    createSupplier(context, input) {
      const resolved = masterWrite(context, MATERIAL);
      const values = buildSupplier(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => freeze(tx.insert(SUPPLIERS, values)));
    },

    updateSupplier(context, id, patch) {
      const resolved = masterWrite(context, MATERIAL);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["active"]);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, SUPPLIERS, id, "supplier");
        return freeze(tx.update(SUPPLIERS, row.id, changeSupplier(fields)));
      });
    },

    setSupplierActive(context, id, active) {
      const resolved = masterWrite(context, MATERIAL);
      if (typeof active !== "boolean") throw fail("invalid_field", "active must be true or false");
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, SUPPLIERS, id, "supplier");
        return freeze(tx.update(SUPPLIERS, row.id, { active }));
      });
    },

    // ---- RFQs (D86) ---------------------------------------------------------------------------

    rfqs(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { factoryId, status, supplierId } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const lines = session.list(RFQ_LINES);
      const quotations = session.list(QUOTATIONS);
      return Object.freeze(
        session
          .list(
            RFQS,
            (row) =>
              allowed(resolved, VIEW, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (status === undefined || row.status === status) &&
              (supplierId === undefined || row.supplierIds.includes(supplierId))
          )
          .sort((a, b) => b.number.localeCompare(a.number))
          .map((row) =>
            rfqRow(row, linesOf(lines, "rfqId", row.id), linesOf(quotations, "rfqId", row.id), look)
          )
      );
    },

    // The RFQ with its lines, quotations and comparison, and what the caller may do to it.
    rfq(context, id) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const rfq = documentFor(session, resolved, RFQS, id, "RFQ");
      const look = lookups(session);
      const lines = session
        .list(RFQ_LINES, (row) => row.rfqId === rfq.id)
        .sort((a, b) =>
          (look.materials.get(a.materialId)?.code ?? "").localeCompare(
            look.materials.get(b.materialId)?.code ?? ""
          )
        );
      const quotations = session.list(QUOTATIONS, (row) => row.rfqId === rfq.id);
      const qLines = session.list(QUOTATION_LINES, (row) => row.rfqId === rfq.id);
      const withLines = quotations.map((row) => ({
        ...row,
        lines: linesOf(qLines, "quotationId", row.id),
      }));
      const comparison = compareQuotations(lines, withLines, resolved.today);
      const may = allowed(resolved, RFQ, rfq.factoryId);
      const rfqPoNumber =
        rfq.purchaseOrderId === null || rfq.purchaseOrderId === undefined
          ? null
          : (session.get(POS, rfq.purchaseOrderId)?.number ?? null);
      return freeze({
        rfq: rfqRow(rfq, lines, quotations, look),
        purchaseOrderNumber: rfqPoNumber,
        lines: Object.freeze(
          lines.map((line) =>
            freeze({
              id: line.id,
              ...materialLine(line, look),
              quantity: line.quantity,
              requiredDate: line.requiredDate ?? null,
            })
          )
        ),
        quotations: Object.freeze(
          withLines
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((row) => quotationView(row, row.lines, rfq, lines, look, resolved.today))
        ),
        comparison: freeze({
          lines: Object.freeze(
            comparison.lines.map((line) =>
              freeze({
                rfqLineId: line.rfqLineId,
                ...materialLine(line, look),
                offers: Object.freeze(
                  line.offers.map((offer) =>
                    freeze({
                      ...offer,
                      supplierName: look.suppliers.get(offer.supplierId)?.name ?? null,
                    })
                  )
                ),
              })
            )
          ),
          summaries: Object.freeze(
            comparison.summaries.map((summary) =>
              freeze({
                ...summary,
                supplierName: look.suppliers.get(summary.supplierId)?.name ?? null,
              })
            )
          ),
        }),
        editable: may && rfq.status === "draft",
        may: freeze({ manage: may }),
        canSend: may && rfq.status === "draft" && lines.length > 0 && rfq.supplierIds.length > 0,
        canQuote: may && rfq.status === "sent",
        canAward: may && rfq.status === "sent" && quotations.some((row) => row.status === "quoted"),
        canCancel: may && (rfq.status === "draft" || rfq.status === "sent"),
      });
    },

    createRfq(context, input) {
      const resolved = gate.requireTenant(context, RFQ);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const factory = factoryFor(tx, resolved, RFQ, fields.factoryId);
        const values = buildRfq(fields);
        const supplierIds = candidateList(fields.supplierIds ?? []);
        for (const supplierId of supplierIds) activeSupplier(tx, supplierId);
        const row = tx.insert(RFQS, {
          ...values,
          number: nextNumber(PREFIXES.rfq, numbersOf(tx, RFQS)),
          factoryId: factory.id,
          supplierIds,
          status: "draft",
          cancelReason: null,
          awardedQuotationId: null,
          purchaseOrderId: null,
          sentAt: null,
          createdBy: resolved.user.id,
        });
        for (const line of Array.isArray(fields.lines) ? fields.lines : []) {
          insertRfqLine(tx, row, line);
        }
        return freeze(tx.get(RFQS, row.id));
      });
    },

    updateRfq(context, id, patch) {
      const resolved = gate.requireTenant(context, RFQ);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["factoryId", "number", "status", "cancelReason", "lines"]);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, RFQS, id, "RFQ", RFQ);
        requireDraft(row.status, "rfq");
        const values = changeRfq(fields, row);
        if (fields.supplierIds !== undefined) {
          values.supplierIds = candidateList(fields.supplierIds);
          for (const supplierId of values.supplierIds) activeSupplier(tx, supplierId);
        }
        return freeze(tx.update(RFQS, row.id, values));
      });
    },

    addRfqLine(context, rfqId, input) {
      const resolved = gate.requireTenant(context, RFQ);
      return sessionFor(resolved).transaction((tx) => {
        const rfq = documentFor(tx, resolved, RFQS, rfqId, "RFQ", RFQ);
        requireDraft(rfq.status, "rfq");
        return freeze(insertRfqLine(tx, rfq, input));
      });
    },

    updateRfqLine(context, id, patch) {
      const resolved = gate.requireTenant(context, RFQ);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["rfqId", "materialId", "factoryId"]);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, RFQ_LINES, id, "RFQ line");
        const rfq = documentFor(tx, resolved, RFQS, line.rfqId, "RFQ", RFQ);
        requireDraft(rfq.status, "rfq");
        return freeze(tx.update(RFQ_LINES, line.id, changeRfqLine(fields, rfq.requestDate)));
      });
    },

    removeRfqLine(context, id) {
      const resolved = gate.requireTenant(context, RFQ);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, RFQ_LINES, id, "RFQ line");
        const rfq = documentFor(tx, resolved, RFQS, line.rfqId, "RFQ", RFQ);
        requireDraft(rfq.status, "rfq");
        tx.remove(RFQ_LINES, line.id);
        return freeze({ id: line.id });
      });
    },

    // Locks the RFQ: it needs a line and at least one active supplier to ask (AC-9.5).
    sendRfq(context, id) {
      const resolved = gate.requireTenant(context, RFQ);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, RFQS, id, "RFQ", RFQ);
        requireDraft(row.status, "rfq");
        if (tx.list(RFQ_LINES, (line) => line.rfqId === row.id).length === 0) {
          throw fail("no_lines", "add at least one line before sending the RFQ");
        }
        if (row.supplierIds.length === 0) {
          throw fail("no_suppliers", "choose at least one supplier before sending the RFQ");
        }
        for (const supplierId of row.supplierIds) activeSupplier(tx, supplierId);
        tx.update(RFQS, row.id, { status: "sent", sentAt: clock() });
        recordStatus(tx, RFQS, row, "sent", { action: "rfq_sent" });
        return freeze(tx.get(RFQS, row.id));
      });
    },

    cancelRfq(context, id, input) {
      const resolved = gate.requireTenant(context, RFQ);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, RFQS, id, "RFQ", RFQ);
        const reason = requireCancellable(row.status, ["draft", "sent"], "RFQ", request.reason);
        tx.update(RFQS, row.id, { status: "cancelled", cancelReason: reason });
        recordStatus(tx, RFQS, row, "cancelled", { action: "rfq_cancelled" });
        return freeze(tx.get(RFQS, row.id));
      });
    },

    // ---- Quotations (D86) ---------------------------------------------------------------------

    quotations(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { rfqId, supplierId, status } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const rfqs = idMap(session.list(RFQS));
      const rfqLines = session.list(RFQ_LINES);
      const qLines = session.list(QUOTATION_LINES);
      return Object.freeze(
        session
          .list(
            QUOTATIONS,
            (row) =>
              allowed(resolved, VIEW, row.factoryId) &&
              (rfqId === undefined || row.rfqId === rfqId) &&
              (supplierId === undefined || row.supplierId === supplierId) &&
              (status === undefined || row.status === status)
          )
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((row) =>
            quotationView(
              row,
              linesOf(qLines, "quotationId", row.id),
              rfqs.get(row.rfqId),
              linesOf(rfqLines, "rfqId", row.rfqId),
              look,
              resolved.today
            )
          )
      );
    },

    // A candidate's quotation on a sent RFQ, once each; it can be replaced while it is still quoted.
    recordQuotation(context, rfqId, input) {
      const resolved = gate.requireTenant(context, RFQ);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const rfq = documentFor(tx, resolved, RFQS, rfqId, "RFQ", RFQ);
        if (rfq.status !== "sent") {
          throw fail("rfq_not_open", "quotations are recorded on a sent RFQ");
        }
        const supplier = activeSupplier(tx, fields.supplierId);
        if (!rfq.supplierIds.includes(supplier.id)) {
          throw fail("not_invited", `${supplier.name} was not asked to quote on this RFQ`);
        }
        const header = buildQuotation(fields, companyCurrency(tx));
        if (!Array.isArray(fields.lines) || fields.lines.length === 0) {
          throw fail("no_lines", "quote at least one line");
        }
        const rfqLines = tx.list(RFQ_LINES, (row) => row.rfqId === rfq.id);
        const built = fields.lines.map((input) => {
          const line = isObject(input) ? input : {};
          const asked = rfqLines.find((row) => row.id === line.rfqLineId);
          if (asked === undefined) throw fail("not_found", "that RFQ line was not found");
          return { rfqLineId: asked.id, ...buildQuotationLine(line) };
        });
        const existing = tx.list(
          QUOTATIONS,
          (row) => row.rfqId === rfq.id && row.supplierId === supplier.id
        )[0];
        let quotation;
        if (existing === undefined) {
          quotation = tx.insert(QUOTATIONS, {
            ...header,
            rfqId: rfq.id,
            factoryId: rfq.factoryId,
            supplierId: supplier.id,
            status: "quoted",
            recordedBy: resolved.user.id,
            recordedAt: clock(),
          });
        } else {
          if (existing.status !== "quoted") {
            throw fail("quotation_locked", "this quotation has already been decided");
          }
          for (const line of tx.list(QUOTATION_LINES, (row) => row.quotationId === existing.id)) {
            tx.remove(QUOTATION_LINES, line.id);
          }
          quotation = tx.update(QUOTATIONS, existing.id, {
            ...header,
            recordedBy: resolved.user.id,
            recordedAt: clock(),
          });
        }
        for (const line of built) {
          tx.insert(QUOTATION_LINES, {
            ...line,
            quotationId: quotation.id,
            rfqId: rfq.id,
            factoryId: rfq.factoryId,
          });
        }
        tx.record({
          action: "quotation_recorded",
          entityType: QUOTATIONS,
          entityId: quotation.id,
          changes: { lines: { before: null, after: built.length } },
        });
        return freeze(tx.get(QUOTATIONS, quotation.id));
      });
    },

    // The award, in one transaction: the quotation is awarded, the others are not, the RFQ is
    // awarded and a draft purchase order is made from the quoted lines (AC-9.6).
    awardQuotation(context, quotationId) {
      const resolved = gate.requireTenant(context, RFQ);
      return sessionFor(resolved).transaction((tx) => {
        const quotation = documentFor(tx, resolved, QUOTATIONS, quotationId, "quotation", RFQ);
        const rfq = requireRow(tx, RFQS, quotation.rfqId, "RFQ");
        if (rfq.status !== "sent") {
          throw fail(
            "invalid_transition",
            rfq.status === "awarded"
              ? `${rfq.number} has already been awarded`
              : `${rfq.number} is ${rfq.status} and cannot be awarded`
          );
        }
        if (quotation.status !== "quoted") {
          throw fail("invalid_transition", "only a quoted quotation can be awarded");
        }
        const supplier = activeSupplier(tx, quotation.supplierId);
        const qLines = tx.list(QUOTATION_LINES, (row) => row.quotationId === quotation.id);
        if (qLines.length === 0) throw fail("no_lines", "the quotation has no lines");
        const rfqLines = idMap(tx.list(RFQ_LINES, (row) => row.rfqId === rfq.id));
        const longest = qLines.reduce((most, line) => Math.max(most, line.leadDays), 0);
        const po = tx.insert(POS, {
          number: nextNumber(PREFIXES.po, numbersOf(tx, POS)),
          factoryId: rfq.factoryId,
          supplierId: supplier.id,
          orderDate: resolved.today,
          expectedDate: addDays(resolved.today, longest),
          currency: quotation.currency,
          note: `From ${rfq.number}${quotation.supplierRef ? `, quotation ${quotation.supplierRef}` : ""}`,
          status: "draft",
          cancelReason: null,
          rfqId: rfq.id,
          quotationId: quotation.id,
          issuedAt: null,
          createdBy: resolved.user.id,
        });
        for (const line of qLines) {
          const asked = rfqLines.get(line.rfqLineId);
          const material = activeMaterial(tx, asked?.materialId);
          tx.insert(PO_LINES, {
            poId: po.id,
            factoryId: rfq.factoryId,
            materialId: material.id,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            taxAmount: 0,
          });
        }
        for (const other of tx.list(QUOTATIONS, (row) => row.rfqId === rfq.id)) {
          tx.update(QUOTATIONS, other.id, {
            status: other.id === quotation.id ? "awarded" : "not_awarded",
          });
        }
        tx.update(RFQS, rfq.id, {
          status: "awarded",
          awardedQuotationId: quotation.id,
          purchaseOrderId: po.id,
        });
        recordStatus(tx, RFQS, rfq, "awarded", {
          action: "rfq_awarded",
          changes: { purchaseOrderId: { before: null, after: po.id } },
        });
        return freeze({
          quotation: tx.get(QUOTATIONS, quotation.id),
          purchaseOrder: tx.get(POS, po.id),
        });
      });
    },

    // ---- Purchase orders (D87) ----------------------------------------------------------------

    purchaseOrders(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { factoryId, supplierId, status } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const lines = session.list(PO_LINES);
      const receipts = session.list(RECEIPTS);
      const accepted = acceptedByPoLine(session);
      const rfqs = idMap(session.list(RFQS));
      return Object.freeze(
        session
          .list(
            POS,
            (row) =>
              allowed(resolved, VIEW, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (supplierId === undefined || row.supplierId === supplierId) &&
              (status === undefined || row.status === status)
          )
          .sort((a, b) => b.number.localeCompare(a.number))
          .map((row) =>
            poRow(
              row,
              linesOf(lines, "poId", row.id),
              accepted,
              linesOf(receipts, "poId", row.id),
              look,
              resolved.today,
              rfqs.get(row.rfqId)
            )
          )
      );
    },

    purchaseOrder(context, id) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const po = documentFor(session, resolved, POS, id, "purchase order");
      const look = lookups(session);
      const lines = session.list(PO_LINES, (row) => row.poId === po.id);
      const accepted = acceptedByPoLine(session);
      const receipts = session.list(RECEIPTS, (row) => row.poId === po.id);
      const receiptLines = session.list(RECEIPT_LINES, (row) => row.factoryId === po.factoryId);
      const rfq = po.rfqId ? session.get(RFQS, po.rfqId) : null;
      const delivery = deliveryOf(lines, accepted, po.expectedDate, resolved.today, po.status);
      const may = allowed(resolved, PO, po.factoryId);
      const mayReceive = allowed(resolved, GRN, po.factoryId);
      return freeze({
        po: poRow(po, lines, accepted, receipts, look, resolved.today, rfq),
        rfqNumber: rfq?.number ?? null,
        lines: Object.freeze(
          lines
            .sort((a, b) =>
              (look.materials.get(a.materialId)?.code ?? "").localeCompare(
                look.materials.get(b.materialId)?.code ?? ""
              )
            )
            .map((line) => {
              const row = delivery.rows.find((entry) => entry.lineId === line.id);
              return freeze({
                id: line.id,
                ...materialLine(line, look),
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                taxAmount: line.taxAmount ?? 0,
                amount: lineAmount(line.quantity, line.unitPrice),
                accepted: row.accepted,
                pending: row.pending,
              });
            })
        ),
        receipts: Object.freeze(
          receipts
            .sort((a, b) => b.number.localeCompare(a.number))
            .map((row) => receiptRow(row, linesOf(receiptLines, "receiptId", row.id), po, look))
        ),
        editable: may && po.status === "draft",
        may: freeze({ manage: may, receive: mayReceive }),
        canIssue: may && po.status === "draft" && lines.length > 0,
        canCancel: may && (po.status === "draft" || po.status === "issued"),
        canReceive: mayReceive && po.status === "issued" && delivery.pending > 0,
      });
    },

    createPurchaseOrder(context, input) {
      const resolved = gate.requireTenant(context, PO);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const factory = factoryFor(tx, resolved, PO, fields.factoryId);
        const supplier = activeSupplier(tx, fields.supplierId);
        const values = buildPo(fields, companyCurrency(tx));
        const row = tx.insert(POS, {
          ...values,
          number: nextNumber(PREFIXES.po, numbersOf(tx, POS)),
          factoryId: factory.id,
          supplierId: supplier.id,
          status: "draft",
          cancelReason: null,
          rfqId: null,
          quotationId: null,
          issuedAt: null,
          createdBy: resolved.user.id,
        });
        for (const line of Array.isArray(fields.lines) ? fields.lines : []) {
          insertPoLine(tx, row, line);
        }
        return freeze(tx.get(POS, row.id));
      });
    },

    updatePurchaseOrder(context, id, patch) {
      const resolved = gate.requireTenant(context, PO);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["factoryId", "supplierId", "number", "status", "cancelReason", "lines"]);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, POS, id, "purchase order", PO);
        requireDraft(row.status, "po");
        return freeze(tx.update(POS, row.id, changePo(fields, row)));
      });
    },

    addPoLine(context, poId, input) {
      const resolved = gate.requireTenant(context, PO);
      return sessionFor(resolved).transaction((tx) => {
        const po = documentFor(tx, resolved, POS, poId, "purchase order", PO);
        requireDraft(po.status, "po");
        return freeze(insertPoLine(tx, po, input));
      });
    },

    updatePoLine(context, id, patch) {
      const resolved = gate.requireTenant(context, PO);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["poId", "materialId", "factoryId"]);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, PO_LINES, id, "order line");
        const po = documentFor(tx, resolved, POS, line.poId, "purchase order", PO);
        requireDraft(po.status, "po");
        return freeze(tx.update(PO_LINES, line.id, changePoLine(fields)));
      });
    },

    removePoLine(context, id) {
      const resolved = gate.requireTenant(context, PO);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, PO_LINES, id, "order line");
        const po = documentFor(tx, resolved, POS, line.poId, "purchase order", PO);
        requireDraft(po.status, "po");
        tx.remove(PO_LINES, line.id);
        return freeze({ id: line.id });
      });
    },

    // Issuing locks the lines (AC-9.7).
    issuePurchaseOrder(context, id) {
      const resolved = gate.requireTenant(context, PO);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, POS, id, "purchase order", PO);
        requireDraft(row.status, "po");
        const lines = tx.list(PO_LINES, (line) => line.poId === row.id);
        if (lines.length === 0) throw fail("no_lines", "add at least one line before issuing");
        activeSupplier(tx, row.supplierId);
        for (const line of lines) activeMaterial(tx, line.materialId);
        tx.update(POS, row.id, { status: "issued", issuedAt: clock() });
        recordStatus(tx, POS, row, "issued", { action: "purchase_order_issued" });
        return freeze(tx.get(POS, row.id));
      });
    },

    // Refused while any receipt of it is Received or Posted (AC-9.7).
    cancelPurchaseOrder(context, id, input) {
      const resolved = gate.requireTenant(context, PO);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, POS, id, "purchase order", PO);
        const reason = requireCancellable(
          row.status,
          ["draft", "issued"],
          "purchase order",
          request.reason
        );
        const open = tx.list(
          RECEIPTS,
          (receipt) =>
            receipt.poId === row.id &&
            (receipt.status === "received" || receipt.status === "posted")
        );
        if (open.length > 0) {
          throw fail(
            "has_receipts",
            `${open.map((receipt) => receipt.number).join(", ")} must be cancelled or reversed first`
          );
        }
        tx.update(POS, row.id, { status: "cancelled", cancelReason: reason });
        recordStatus(tx, POS, row, "cancelled", { action: "purchase_order_cancelled" });
        return freeze(tx.get(POS, row.id));
      });
    },

    // ---- Goods receipts (D88) -----------------------------------------------------------------

    receipts(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { factoryId, poId, status } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const lines = session.list(RECEIPT_LINES);
      const orders = idMap(session.list(POS));
      return Object.freeze(
        session
          .list(
            RECEIPTS,
            (row) =>
              allowed(resolved, VIEW, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (poId === undefined || row.poId === poId) &&
              (status === undefined || row.status === status)
          )
          .sort((a, b) => b.number.localeCompare(a.number))
          .map((row) =>
            receiptRow(row, linesOf(lines, "receiptId", row.id), orders.get(row.poId), look)
          )
      );
    },

    receipt(context, id) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const receipt = documentFor(session, resolved, RECEIPTS, id, "goods receipt");
      const look = lookups(session);
      const po = session.get(POS, receipt.poId);
      const lines = session.list(RECEIPT_LINES, (row) => row.receiptId === receipt.id);
      const poLines = idMap(session.list(PO_LINES, (row) => row.poId === receipt.poId));
      const accepted = acceptedByPoLine(session);
      const may = allowed(resolved, GRN, receipt.factoryId);
      const movements = session
        .list(MOVEMENTS, (row) => row.receiptId === receipt.id)
        .sort((a, b) => a.type.localeCompare(b.type));
      return freeze({
        receipt: receiptRow(receipt, lines, po, look),
        poStatus: po?.status ?? null,
        lines: Object.freeze(
          lines.map((line) => {
            const poLine = poLines.get(line.poLineId);
            const posted = accepted.get(line.poLineId) ?? 0;
            return freeze({
              id: line.id,
              poLineId: line.poLineId,
              ...materialLine(line, look),
              ordered: poLine?.quantity ?? null,
              postedBefore: receipt.status === "posted" ? round3(posted - line.accepted) : posted,
              received: line.received,
              accepted: line.accepted,
              rejected: line.rejected,
              rejectionReason: line.rejectionReason ?? null,
            });
          })
        ),
        movements: Object.freeze(
          movements.map((row) =>
            freeze({
              id: row.id,
              type: row.type,
              direction: row.direction,
              quantity: row.quantity,
              date: row.date,
              materialName: look.materials.get(row.materialId)?.name ?? null,
            })
          )
        ),
        may: freeze({ post: may }),
        editable: may && receipt.status === "draft",
        canReceive: may && receipt.status === "draft",
        canPost: may && receipt.status === "received",
        canReverse: may && receipt.status === "posted",
        canCancel: may && (receipt.status === "draft" || receipt.status === "received"),
      });
    },

    createReceipt(context, input) {
      const resolved = gate.requireTenant(context, GRN);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const po = requireRow(tx, POS, fields.poId, "purchase order");
        gate.authorize(resolved, GRN, { factoryId: po.factoryId });
        requireIssuedPo(po);
        const values = buildReceipt(fields, resolved.today);
        const row = tx.insert(RECEIPTS, {
          ...values,
          number: nextNumber(PREFIXES.grn, numbersOf(tx, RECEIPTS)),
          factoryId: po.factoryId,
          poId: po.id,
          supplierId: po.supplierId,
          status: "draft",
          cancelReason: null,
          reverseReason: null,
          receivedAt: null,
          postedAt: null,
          reversedAt: null,
          createdBy: resolved.user.id,
        });
        insertReceiptLines(tx, row, po, fields.lines);
        return freeze(tx.get(RECEIPTS, row.id));
      });
    },

    // Header fields and, when given, a replacement set of lines; only while the receipt is a draft.
    updateReceipt(context, id, patch) {
      const resolved = gate.requireTenant(context, GRN);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["poId", "factoryId", "number", "status"]);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, RECEIPTS, id, "goods receipt", GRN);
        if (row.status !== "draft") {
          throw fail("receipt_locked", "only a draft receipt can be changed");
        }
        const po = requireRow(tx, POS, row.poId, "purchase order");
        requireIssuedPo(po);
        const values = changeReceipt(fields, resolved.today);
        if (fields.lines !== undefined) {
          for (const line of tx.list(RECEIPT_LINES, (entry) => entry.receiptId === row.id)) {
            tx.remove(RECEIPT_LINES, line.id);
          }
          insertReceiptLines(tx, row, po, fields.lines);
        }
        return freeze(tx.update(RECEIPTS, row.id, values));
      });
    },

    // Records the inspection and rechecks that the purchase order is still issued.
    receiveReceipt(context, id) {
      const resolved = gate.requireTenant(context, GRN);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, RECEIPTS, id, "goods receipt", GRN);
        if (row.status !== "draft") {
          throw fail("invalid_transition", `a ${row.status} receipt cannot be received`);
        }
        requireIssuedPo(requireRow(tx, POS, row.poId, "purchase order"));
        tx.update(RECEIPTS, row.id, { status: "received", receivedAt: clock() });
        recordStatus(tx, RECEIPTS, row, "received", { action: "receipt_received" });
        return freeze(tx.get(RECEIPTS, row.id));
      });
    },

    // Posting, the Posted status and one Receipt movement per accepted line happen together; a
    // refused post leaves nothing behind (P18).
    postReceipt(context, id) {
      const resolved = gate.requireTenant(context, GRN);
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, RECEIPTS, id, "goods receipt", GRN);
        if (row.status !== "received") {
          throw fail(
            "invalid_transition",
            row.status === "draft"
              ? "receive the goods before posting the receipt"
              : `a ${row.status} receipt cannot be posted`
          );
        }
        const po = requireRow(tx, POS, row.poId, "purchase order");
        requireIssuedPo(po);
        const lines = tx.list(RECEIPT_LINES, (line) => line.receiptId === row.id);
        requireWithinOrder(tx, lines, idMap(tx.list(PO_LINES, (line) => line.poId === po.id)));
        for (const line of lines) {
          if (line.accepted <= 0) continue;
          activeMaterial(tx, line.materialId);
          tx.insert(MOVEMENTS, {
            factoryId: row.factoryId,
            materialId: line.materialId,
            type: "receipt",
            direction: directionOf("receipt"),
            quantity: line.accepted,
            date: row.receiptDate,
            reason: null,
            receiptId: row.id,
            requisitionId: null,
            reversesId: null,
            recordedBy: resolved.user.id,
            recordedAt: clock(),
          });
        }
        tx.update(RECEIPTS, row.id, { status: "posted", postedAt: clock() });
        recordStatus(tx, RECEIPTS, row, "posted", { action: "receipt_posted" });
        return freeze(tx.get(RECEIPTS, row.id));
      });
    },

    // Adds the opposite movements and keeps the receipt and its history; refused when the goods are
    // no longer on hand (AC-9.8).
    reverseReceipt(context, id, input) {
      const resolved = gate.requireTenant(context, GRN);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, RECEIPTS, id, "goods receipt", GRN);
        if (row.status !== "posted") {
          throw fail("invalid_transition", `a ${row.status} receipt cannot be reversed`);
        }
        const reason = requireReason(request.reason, "a reason for reversing the receipt");
        const materials = idMap(tx.list(MATERIALS));
        const originals = tx.list(
          MOVEMENTS,
          (movement) => movement.receiptId === row.id && movement.type === "receipt"
        );
        for (const original of originals) {
          requireEnough(
            balanceAt(tx, original.factoryId, original.materialId),
            original.quantity,
            materials.get(original.materialId)?.name ?? "the material"
          );
          tx.insert(MOVEMENTS, {
            ...reversalOf(original, resolved.today, reason),
            factoryId: original.factoryId,
            materialId: original.materialId,
            receiptId: row.id,
            requisitionId: null,
            recordedBy: resolved.user.id,
            recordedAt: clock(),
          });
        }
        tx.update(RECEIPTS, row.id, {
          status: "reversed",
          reverseReason: reason,
          reversedAt: clock(),
        });
        recordStatus(tx, RECEIPTS, row, "reversed", { action: "receipt_reversed" });
        return freeze(tx.get(RECEIPTS, row.id));
      });
    },

    // A draft or received receipt can be cancelled, even after its purchase order was cancelled.
    cancelReceipt(context, id, input) {
      const resolved = gate.requireTenant(context, GRN);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = documentFor(tx, resolved, RECEIPTS, id, "goods receipt", GRN);
        const reason = requireCancellable(
          row.status,
          ["draft", "received"],
          "receipt",
          request.reason
        );
        tx.update(RECEIPTS, row.id, { status: "cancelled", cancelReason: reason });
        recordStatus(tx, RECEIPTS, row, "cancelled", { action: "receipt_cancelled" });
        return freeze(tx.get(RECEIPTS, row.id));
      });
    },
  });
}
