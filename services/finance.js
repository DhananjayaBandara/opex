// Invoices and payments (SRS 3.1, 7.4; architecture 12; decisions D92 to D94; constraints C12, P20).
//
// Customer invoices bill a buyer, optionally for one of the buyer's orders; supplier invoices record
// what a supplier billed, optionally against a purchase order and a posted receipt. Subtotal, tax,
// total, paid amount, balance, settlement and Overdue are always worked out from the lines and the
// payments, never stored or accepted from the caller. Payments are append-only. The three-way match
// is traceability only: it informs and never blocks (P20). Nothing is posted to a ledger.
//
// Every call resolves the tenant and the caller's access from the context. An invoice follows the
// factory of its order or purchase order; one with neither belongs to the whole organization and
// needs a tenant-wide scope. Each write runs in one transaction with its audit event.
// Browser-safe: no Node imports.
import {
  METHOD_LABELS,
  buildInvoice,
  buildInvoiceLine,
  buildPayment,
  changeInvoice,
  invoiceLineTotal,
  invoiceTotals,
  kindOf,
  matchStatement,
  paidOf,
  requireIssuable,
  settlementOf,
  supplierNumberOf,
} from "../domain/finance.js";
import {
  PREFIXES,
  amountOf,
  lineAmount,
  nextNumber,
  poValue,
  round2,
} from "../domain/procurement.js";
import { blank, requireReason } from "../domain/workforce.js";
import { fail } from "./errors.js";
import {
  acceptedByPoLine,
  byName,
  createSupplyHelpers,
  freeze,
  idMap,
  isObject,
} from "./supply-common.js";

const VIEW = "finance.view";
const ISSUE = "invoice.issue";
const PAY = "invoice.record_payment";

const INVOICES = "invoices";
const INVOICE_LINES = "invoiceLines";
const PAYMENTS = "invoicePayments";
const ORDERS = "buyerOrders";
const ORDER_LINES = "buyerOrderLines";

const IMMUTABLE = (fields, names) => {
  for (const field of names) {
    if (fields[field] !== undefined)
      throw fail("immutable_field", `${field} cannot be edited here`);
  }
};

const clip = (text) => (text.length > 200 ? `${text.slice(0, 197)}...` : text);

export function createFinance({ store, gate, clock }) {
  const { sessionFor, allowed, tenantWideAllowed, requireRow, companyCurrency, nameOf } =
    createSupplyHelpers({ store, gate });

  // The WHERE of an invoice: its factory, or the whole organization when it has none (D83).
  const invoiceAllowed = (resolved, permission, invoice) =>
    invoice.factoryId === null || invoice.factoryId === undefined
      ? tenantWideAllowed(resolved, permission)
      : allowed(resolved, permission, invoice.factoryId);

  function authorizeInvoice(resolved, permission, invoice) {
    if (invoice.factoryId === null || invoice.factoryId === undefined) {
      gate.authorizeTenantWide(resolved, permission);
    } else {
      gate.authorize(resolved, permission, { factoryId: invoice.factoryId });
    }
  }

  function invoiceFor(tx, resolved, id, permission = VIEW) {
    const row = requireRow(tx, INVOICES, id, "invoice");
    authorizeInvoice(resolved, permission, row);
    return row;
  }

  function lookups(reader) {
    return {
      buyers: idMap(reader.list("buyers")),
      suppliers: idMap(reader.list("suppliers")),
      orders: idMap(reader.list(ORDERS)),
      purchaseOrders: idMap(reader.list("purchaseOrders")),
      receipts: idMap(reader.list("goodsReceipts")),
      factories: idMap(reader.list("factories")),
    };
  }

  const orderValue = (lines) =>
    round2(
      lines
        .filter((line) => line.status !== "cancelled" && line.unitPrice != null)
        .reduce((sum, line) => sum + lineAmount(line.quantity, line.unitPrice), 0)
    );

  function derive(invoice, lines, payments, today) {
    const totals = invoiceTotals(lines, invoice.taxAmount);
    return {
      totals,
      ...settlementOf({ ...invoice, total: totals.total, paid: paidOf(payments) }, today),
    };
  }

  function invoiceRow(invoice, lines, payments, look, today) {
    const figures = derive(invoice, lines, payments, today);
    const party =
      invoice.kind === "customer"
        ? look.buyers.get(invoice.buyerId)?.name
        : look.suppliers.get(invoice.supplierId)?.name;
    return freeze({
      id: invoice.id,
      kind: invoice.kind,
      number: invoice.number ?? null,
      supplierNumber: invoice.supplierNumber ?? null,
      displayNumber: invoice.number ?? invoice.supplierNumber ?? null,
      status: invoice.status,
      partyId: invoice.kind === "customer" ? invoice.buyerId : invoice.supplierId,
      partyName: party ?? null,
      buyerId: invoice.buyerId ?? null,
      supplierId: invoice.supplierId ?? null,
      orderId: invoice.orderId ?? null,
      orderReference: invoice.orderId
        ? (look.orders.get(invoice.orderId)?.reference ?? null)
        : null,
      poId: invoice.poId ?? null,
      poNumber: invoice.poId ? (look.purchaseOrders.get(invoice.poId)?.number ?? null) : null,
      receiptId: invoice.receiptId ?? null,
      receiptNumber: invoice.receiptId
        ? (look.receipts.get(invoice.receiptId)?.number ?? null)
        : null,
      factoryId: invoice.factoryId ?? null,
      factoryName: invoice.factoryId ? (look.factories.get(invoice.factoryId)?.name ?? null) : null,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      note: invoice.note ?? null,
      cancelReason: invoice.cancelReason ?? null,
      issuedAt: invoice.issuedAt ?? null,
      lines: lines.length,
      subtotal: figures.totals.subtotal,
      tax: figures.totals.tax,
      total: figures.totals.total,
      paid: figures.paid,
      balance: invoice.status === "issued" ? figures.balance : 0,
      settlement: invoice.status === "issued" ? figures.settlement : null,
      overdue: figures.overdue,
    });
  }

  function paymentRow(payment, invoice, look, userName) {
    return freeze({
      id: payment.id,
      invoiceId: payment.invoiceId,
      invoiceNumber: invoice?.number ?? invoice?.supplierNumber ?? null,
      kind: invoice?.kind ?? null,
      partyName: invoice
        ? invoice.kind === "customer"
          ? (look.buyers.get(invoice.buyerId)?.name ?? null)
          : (look.suppliers.get(invoice.supplierId)?.name ?? null)
        : null,
      currency: invoice?.currency ?? null,
      amount: payment.amount,
      date: payment.date,
      method: payment.method,
      methodLabel: METHOD_LABELS[payment.method] ?? payment.method,
      reference: payment.reference ?? null,
      idempotencyKey: payment.idempotencyKey ?? null,
      recordedBy: userName(payment.recordedBy),
      recordedAt: payment.recordedAt,
    });
  }

  // Traceability (D94): review information, never a block.
  function traceOf(invoice, reader, look) {
    if (invoice.kind === "customer") {
      if (!invoice.orderId) return null;
      const order = look.orders.get(invoice.orderId);
      if (order === undefined) return null;
      const ordered = orderValue(reader.list(ORDER_LINES, (line) => line.orderId === order.id));
      const others = reader.list(
        INVOICES,
        (row) => row.orderId === order.id && row.status !== "cancelled"
      );
      const invoiced = round2(
        others.reduce(
          (sum, row) =>
            sum +
            invoiceTotals(
              reader.list(INVOICE_LINES, (line) => line.invoiceId === row.id),
              row.taxAmount
            ).subtotal,
          0
        )
      );
      const remaining = round2(ordered - invoiced);
      return freeze({
        kind: "customer",
        reference: order.reference,
        currency: order.currency,
        ordered,
        invoiced,
        remaining,
        statement:
          remaining < 0
            ? `Invoiced is ${Math.abs(remaining).toFixed(2)} above the order value.`
            : remaining === 0
              ? "The order value is fully invoiced."
              : `${remaining.toFixed(2)} of the order value is not yet invoiced.`,
      });
    }
    if (!invoice.poId) return null;
    const po = look.purchaseOrders.get(invoice.poId);
    if (po === undefined) return null;
    const poLines = reader.list("purchaseOrderLines", (line) => line.poId === po.id);
    const accepted = acceptedByPoLine(reader);
    const acceptedValue = round2(
      poLines.reduce((sum, line) => sum + lineAmount(accepted.get(line.id) ?? 0, line.unitPrice), 0)
    );
    const others = reader.list(
      INVOICES,
      (row) => row.poId === po.id && row.kind === "supplier" && row.status !== "cancelled"
    );
    const invoiced = round2(
      others.reduce(
        (sum, row) =>
          sum +
          invoiceTotals(
            reader.list(INVOICE_LINES, (line) => line.invoiceId === row.id),
            row.taxAmount
          ).subtotal,
        0
      )
    );
    return freeze({
      kind: "supplier",
      poNumber: po.number,
      receiptNumber: invoice.receiptId
        ? (look.receipts.get(invoice.receiptId)?.number ?? null)
        : null,
      currency: po.currency,
      ...matchStatement({
        ordered: poValue(poLines).subtotal,
        accepted: acceptedValue,
        invoiced,
      }),
      basis: "Values are before tax.",
    });
  }

  function sourceLines(tx, invoice) {
    if (invoice.kind === "customer") {
      if (!invoice.orderId) {
        throw fail("no_source", "link an order to fill the lines from it");
      }
      const styles = idMap(tx.list("styles"));
      return tx
        .list(ORDER_LINES, (line) => line.orderId === invoice.orderId)
        .filter((line) => line.status !== "cancelled" && line.unitPrice != null)
        .map((line) => {
          const style = styles.get(line.styleId);
          return {
            description: clip(style ? `${style.code} ${style.name}` : "Style"),
            quantity: line.quantity,
            unitPrice: line.unitPrice,
          };
        });
    }
    if (!invoice.receiptId) {
      throw fail("no_source", "link a posted receipt to fill the lines from the goods accepted");
    }
    const materials = idMap(tx.list("materials"));
    const poLines = idMap(tx.list("purchaseOrderLines", (line) => line.poId === invoice.poId));
    return tx
      .list(
        "goodsReceiptLines",
        (line) => line.receiptId === invoice.receiptId && line.accepted > 0
      )
      .map((line) => {
        const material = materials.get(line.materialId);
        return {
          description: clip(material ? `${material.code} ${material.name}` : "Material"),
          quantity: line.accepted,
          unitPrice: poLines.get(line.poLineId)?.unitPrice ?? 0,
        };
      });
  }

  function insertLine(tx, invoice, input) {
    const fields = isObject(input) ? input : {};
    return tx.insert(INVOICE_LINES, {
      invoiceId: invoice.id,
      factoryId: invoice.factoryId ?? null,
      ...buildInvoiceLine(fields),
    });
  }

  function requireDraft(row) {
    if (row.status !== "draft") {
      throw fail("invoice_locked", "only a draft invoice can be changed");
    }
  }

  return Object.freeze({
    // The buyers and suppliers an invoice can name; finance does not depend on the order or
    // procurement permissions.
    parties(context) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const pick = (row) =>
        freeze({ id: row.id, code: row.code, name: row.name, active: row.active !== false });
      return freeze({
        buyers: Object.freeze(session.list("buyers").sort(byName).map(pick)),
        suppliers: Object.freeze(session.list("suppliers").sort(byName).map(pick)),
        currency: companyCurrency(session),
      });
    },

    // The documents an invoice can be linked to: a buyer's open orders, a supplier's issued
    // purchase orders and their posted receipts, limited to the factories the caller may invoice.
    sources(context, input) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { buyerId, supplierId } = isObject(input) ? input : {};
      const look = lookups(session);
      const orderLines = session.list(ORDER_LINES);
      const poLines = session.list("purchaseOrderLines");
      return freeze({
        orders: Object.freeze(
          buyerId === undefined
            ? []
            : session
                .list(
                  ORDERS,
                  (row) =>
                    row.buyerId === buyerId &&
                    row.status !== "cancelled" &&
                    allowed(resolved, ISSUE, row.factoryId)
                )
                .sort((a, b) => a.reference.localeCompare(b.reference))
                .map((row) =>
                  freeze({
                    id: row.id,
                    reference: row.reference,
                    currency: row.currency,
                    status: row.status,
                    factoryName: look.factories.get(row.factoryId)?.name ?? null,
                    value: orderValue(orderLines.filter((line) => line.orderId === row.id)),
                  })
                )
        ),
        purchaseOrders: Object.freeze(
          supplierId === undefined
            ? []
            : session
                .list(
                  "purchaseOrders",
                  (row) =>
                    row.supplierId === supplierId &&
                    row.status === "issued" &&
                    allowed(resolved, ISSUE, row.factoryId)
                )
                .sort((a, b) => a.number.localeCompare(b.number))
                .map((row) =>
                  freeze({
                    id: row.id,
                    number: row.number,
                    currency: row.currency,
                    factoryName: look.factories.get(row.factoryId)?.name ?? null,
                    value: poValue(poLines.filter((line) => line.poId === row.id)).total,
                  })
                )
        ),
        receipts: Object.freeze(
          supplierId === undefined
            ? []
            : session
                .list(
                  "goodsReceipts",
                  (row) =>
                    row.supplierId === supplierId &&
                    row.status === "posted" &&
                    allowed(resolved, ISSUE, row.factoryId)
                )
                .sort((a, b) => a.number.localeCompare(b.number))
                .map((row) =>
                  freeze({
                    id: row.id,
                    number: row.number,
                    poId: row.poId,
                    poNumber: look.purchaseOrders.get(row.poId)?.number ?? null,
                    receiptDate: row.receiptDate,
                  })
                )
        ),
      });
    },

    invoices(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { kind, status, settlement, overdue, buyerId, supplierId } = isObject(filter)
        ? filter
        : {};
      const look = lookups(session);
      const lines = session.list(INVOICE_LINES);
      const payments = session.list(PAYMENTS);
      return Object.freeze(
        session
          .list(
            INVOICES,
            (row) =>
              invoiceAllowed(resolved, VIEW, row) &&
              (kind === undefined || row.kind === kind) &&
              (status === undefined || row.status === status) &&
              (buyerId === undefined || row.buyerId === buyerId) &&
              (supplierId === undefined || row.supplierId === supplierId)
          )
          .map((row) =>
            invoiceRow(
              row,
              lines.filter((line) => line.invoiceId === row.id),
              payments.filter((payment) => payment.invoiceId === row.id),
              look,
              resolved.today
            )
          )
          .filter(
            (row) =>
              (settlement === undefined || row.settlement === settlement) &&
              (overdue === undefined || row.overdue === overdue)
          )
          .sort(
            (a, b) =>
              b.invoiceDate.localeCompare(a.invoiceDate) ||
              String(b.displayNumber).localeCompare(String(a.displayNumber))
          )
      );
    },

    invoice(context, id) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const row = invoiceFor(session, resolved, id);
      const look = lookups(session);
      const userName = nameOf(resolved);
      const lines = session.list(INVOICE_LINES, (line) => line.invoiceId === row.id);
      const payments = session
        .list(PAYMENTS, (payment) => payment.invoiceId === row.id)
        .sort((a, b) => a.date.localeCompare(b.date) || a.recordedAt.localeCompare(b.recordedAt));
      const header = invoiceRow(row, lines, payments, look, resolved.today);
      const mayIssue = invoiceAllowed(resolved, ISSUE, row);
      const mayPay = invoiceAllowed(resolved, PAY, row);
      const linked = row.kind === "customer" ? Boolean(row.orderId) : Boolean(row.receiptId);
      return freeze({
        invoice: header,
        lines: Object.freeze(
          lines.map((line) =>
            freeze({
              id: line.id,
              description: line.description,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              amount: invoiceLineTotal(line),
            })
          )
        ),
        payments: Object.freeze(
          payments.map((payment) => paymentRow(payment, row, look, userName))
        ),
        trace: traceOf(row, session, look),
        editable: mayIssue && row.status === "draft",
        canFill: mayIssue && row.status === "draft" && linked,
        canIssue: mayIssue && row.status === "draft" && lines.length > 0,
        canCancel: mayIssue && row.status === "draft",
        canPay: mayPay && row.status === "issued" && header.balance > 0,
      });
    },

    createInvoice(context, input) {
      const resolved = gate.requireTenant(context, ISSUE);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const kind = kindOf(fields.kind);
        let source = { factoryId: null, currency: null };
        const links = {
          buyerId: null,
          supplierId: null,
          orderId: null,
          poId: null,
          receiptId: null,
        };
        let supplierFields = { supplierNumber: null, supplierKey: null };
        if (kind === "customer") {
          const buyer = requireRow(tx, "buyers", fields.buyerId, "buyer");
          if (buyer.active === false) {
            throw fail("inactive_parent", `${buyer.name} is inactive and cannot be invoiced`);
          }
          links.buyerId = buyer.id;
          if (!blank(fields.orderId)) {
            const order = requireRow(tx, ORDERS, fields.orderId, "order");
            if (order.buyerId !== buyer.id) {
              throw fail("source_mismatch", "that order belongs to another buyer");
            }
            if (order.status === "cancelled") {
              throw fail(
                "invalid_source",
                `${order.reference} is cancelled and cannot be invoiced`
              );
            }
            links.orderId = order.id;
            source = { factoryId: order.factoryId, currency: order.currency };
          }
        } else {
          const supplier = requireRow(tx, "suppliers", fields.supplierId, "supplier");
          if (supplier.active === false) {
            throw fail("inactive_parent", `${supplier.name} is inactive and cannot be invoiced`);
          }
          links.supplierId = supplier.id;
          supplierFields = supplierNumberOf(fields.supplierNumber);
          let poId = blank(fields.poId) ? null : fields.poId;
          if (!blank(fields.receiptId)) {
            const receipt = requireRow(tx, "goodsReceipts", fields.receiptId, "goods receipt");
            if (receipt.supplierId !== supplier.id) {
              throw fail("source_mismatch", "that receipt is from another supplier");
            }
            if (receipt.status !== "posted") {
              throw fail("invalid_source", `${receipt.number} is ${receipt.status}, not posted`);
            }
            if (poId !== null && poId !== receipt.poId) {
              throw fail("source_mismatch", "that receipt belongs to another purchase order");
            }
            poId = receipt.poId;
            links.receiptId = receipt.id;
          }
          if (poId !== null) {
            const po = requireRow(tx, "purchaseOrders", poId, "purchase order");
            if (po.supplierId !== supplier.id) {
              throw fail("source_mismatch", "that purchase order is from another supplier");
            }
            if (po.status !== "issued") {
              throw fail("invalid_source", `${po.number} is ${po.status}, not issued`);
            }
            links.poId = po.id;
            source = { factoryId: po.factoryId, currency: po.currency };
          }
        }
        // The caller must be able to invoice in the document's factory (or organization-wide).
        authorizeInvoice(resolved, ISSUE, { factoryId: source.factoryId });
        const values = buildInvoice(fields, source.currency ?? companyCurrency(tx));
        const number =
          kind === "customer"
            ? nextNumber(
                PREFIXES.invoice,
                tx.list(INVOICES, (row) => row.number != null).map((row) => row.number)
              )
            : null;
        const row = tx.insert(INVOICES, {
          ...values,
          kind,
          number,
          ...supplierFields,
          ...links,
          factoryId: source.factoryId,
          status: "draft",
          cancelReason: null,
          issuedAt: null,
          createdBy: resolved.user.id,
        });
        for (const line of Array.isArray(fields.lines) ? fields.lines : []) {
          insertLine(tx, row, line);
        }
        return freeze(tx.get(INVOICES, row.id));
      });
    },

    updateInvoice(context, id, patch) {
      const resolved = gate.requireTenant(context, ISSUE);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, [
        "kind",
        "buyerId",
        "supplierId",
        "orderId",
        "poId",
        "receiptId",
        "factoryId",
        "number",
        "status",
        "lines",
      ]);
      return sessionFor(resolved).transaction((tx) => {
        const row = invoiceFor(tx, resolved, id, ISSUE);
        requireDraft(row);
        const values = changeInvoice(fields, row);
        if (fields.supplierNumber !== undefined) {
          if (row.kind !== "supplier") {
            throw fail("invalid_field", "only a supplier invoice has a supplier's number");
          }
          Object.assign(values, supplierNumberOf(fields.supplierNumber));
        }
        return freeze(tx.update(INVOICES, row.id, values));
      });
    },

    addInvoiceLine(context, invoiceId, input) {
      const resolved = gate.requireTenant(context, ISSUE);
      return sessionFor(resolved).transaction((tx) => {
        const row = invoiceFor(tx, resolved, invoiceId, ISSUE);
        requireDraft(row);
        return freeze(insertLine(tx, row, input));
      });
    },

    updateInvoiceLine(context, id, patch) {
      const resolved = gate.requireTenant(context, ISSUE);
      const fields = isObject(patch) ? patch : {};
      IMMUTABLE(fields, ["invoiceId", "factoryId"]);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, INVOICE_LINES, id, "invoice line");
        const row = invoiceFor(tx, resolved, line.invoiceId, ISSUE);
        requireDraft(row);
        const merged = buildInvoiceLine({ ...line, ...fields });
        return freeze(tx.update(INVOICE_LINES, line.id, merged));
      });
    },

    removeInvoiceLine(context, id) {
      const resolved = gate.requireTenant(context, ISSUE);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, INVOICE_LINES, id, "invoice line");
        const row = invoiceFor(tx, resolved, line.invoiceId, ISSUE);
        requireDraft(row);
        tx.remove(INVOICE_LINES, line.id);
        return freeze({ id: line.id });
      });
    },

    // Replaces the lines with the order's priced lines, or the receipt's accepted quantities at the
    // purchase order's price (D92).
    fillInvoice(context, id) {
      const resolved = gate.requireTenant(context, ISSUE);
      return sessionFor(resolved).transaction((tx) => {
        const row = invoiceFor(tx, resolved, id, ISSUE);
        requireDraft(row);
        const built = sourceLines(tx, row);
        if (built.length === 0) {
          throw fail("nothing_to_fill", "the linked document has nothing to invoice");
        }
        for (const line of tx.list(INVOICE_LINES, (entry) => entry.invoiceId === row.id)) {
          tx.remove(INVOICE_LINES, line.id);
        }
        for (const line of built) insertLine(tx, row, line);
        tx.record({
          action: "invoice_filled",
          entityType: INVOICES,
          entityId: row.id,
          changes: { lines: { before: null, after: built.length } },
        });
        return freeze(tx.get(INVOICES, row.id));
      });
    },

    // Issuing needs a line and a total above 0 and locks the invoice.
    issueInvoice(context, id) {
      const resolved = gate.requireTenant(context, ISSUE);
      return sessionFor(resolved).transaction((tx) => {
        const row = invoiceFor(tx, resolved, id, ISSUE);
        requireDraft(row);
        const lines = tx.list(INVOICE_LINES, (line) => line.invoiceId === row.id);
        requireIssuable(lines, invoiceTotals(lines, row.taxAmount));
        tx.update(INVOICES, row.id, { status: "issued", issuedAt: clock() });
        tx.record({
          action: "invoice_issued",
          entityType: INVOICES,
          entityId: row.id,
          changes: { status: { before: "draft", after: "issued" } },
        });
        return freeze(tx.get(INVOICES, row.id));
      });
    },

    // Only a draft is cancelled; after issue a correction is a credit note (real system, D92).
    cancelInvoice(context, id, input) {
      const resolved = gate.requireTenant(context, ISSUE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = invoiceFor(tx, resolved, id, ISSUE);
        if (row.status !== "draft") {
          throw fail(
            "invalid_transition",
            `${row.status === "issued" ? "an issued" : "a cancelled"} invoice cannot be cancelled`
          );
        }
        const reason = requireReason(request.reason, "a reason for cancelling the invoice");
        tx.update(INVOICES, row.id, { status: "cancelled", cancelReason: reason });
        tx.record({
          action: "invoice_cancelled",
          entityType: INVOICES,
          entityId: row.id,
          changes: { status: { before: "draft", after: "cancelled" } },
        });
        return freeze(tx.get(INVOICES, row.id));
      });
    },

    // ---- Payments (D93) -----------------------------------------------------------------------

    payments(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { invoiceId, kind, method, from, to } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const userName = nameOf(resolved);
      const invoices = idMap(session.list(INVOICES));
      return Object.freeze(
        session
          .list(PAYMENTS, (row) => {
            const invoice = invoices.get(row.invoiceId);
            return (
              invoice !== undefined &&
              invoiceAllowed(resolved, VIEW, invoice) &&
              (invoiceId === undefined || row.invoiceId === invoiceId) &&
              (kind === undefined || invoice.kind === kind) &&
              (method === undefined || row.method === method) &&
              (from === undefined || row.date >= from) &&
              (to === undefined || row.date <= to)
            );
          })
          .sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt))
          .map((row) => paymentRow(row, invoices.get(row.invoiceId), look, userName))
      );
    },

    // A payment on an issued invoice. A retry with the same Idempotency-Key and amount returns the
    // first payment; the same key with another amount is refused (D93).
    recordPayment(context, invoiceId, input) {
      const resolved = gate.requireTenant(context, PAY);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const invoice = invoiceFor(tx, resolved, invoiceId, PAY);
        const look = lookups(tx);
        const userName = nameOf(resolved);
        const key = blank(fields.idempotencyKey) ? null : String(fields.idempotencyKey).trim();
        if (key !== null && key.length > 0 && key.length <= 80) {
          const earlier = tx.list(
            PAYMENTS,
            (row) => row.invoiceId === invoice.id && row.idempotencyKey === key
          )[0];
          if (earlier !== undefined) {
            if (earlier.amount !== amountOf(fields.amount, "the amount")) {
              throw fail(
                "idempotency_conflict",
                "that Idempotency-Key was used for a payment of another amount"
              );
            }
            return freeze({ ...paymentRow(earlier, invoice, look, userName), replayed: true });
          }
        }
        if (invoice.status !== "issued") {
          throw fail("invoice_not_issued", `a ${invoice.status} invoice cannot take payments`);
        }
        const lines = tx.list(INVOICE_LINES, (line) => line.invoiceId === invoice.id);
        const payments = tx.list(PAYMENTS, (row) => row.invoiceId === invoice.id);
        const before = derive(invoice, lines, payments, resolved.today);
        if (before.balance <= 0) {
          throw fail("invoice_settled", "this invoice is already paid in full");
        }
        const values = buildPayment(fields, invoice, before.balance, resolved.today);
        const row = tx.insert(PAYMENTS, {
          ...values,
          invoiceId: invoice.id,
          factoryId: invoice.factoryId ?? null,
          recordedBy: resolved.user.id,
          recordedAt: clock(),
        });
        tx.record({
          action: "payment_recorded",
          entityType: INVOICES,
          entityId: invoice.id,
          changes: { paid: { before: before.paid, after: round2(before.paid + values.amount) } },
        });
        return freeze({ ...paymentRow(row, invoice, look, userName), replayed: false });
      });
    },
  });
}
