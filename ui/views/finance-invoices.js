// Invoices (D92): customer invoices to buyers and supplier invoices received from suppliers. The
// balance and settlement are worked out from the lines and payments (C12), so "Unpaid", "Part paid" and
// "Paid" always show, and "Overdue" is a separate word for an issued invoice past its due date. A new
// invoice starts as a draft: pick the party, then the document it relates to, and add the lines on the
// next page.
import { h } from "../dom.js";
import { formDialog } from "../dialog.js";
import { badge, button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  COMMON_ERRORS,
  READ_ONLY_NOTE,
  dateText,
  filterSelect,
  finance,
  invoiceAddress,
  mayWrite,
  moneyText,
  queryOf,
  text,
} from "./supply-common.js";

export const KIND_LABEL = { customer: "Customer invoice", supplier: "Supplier invoice" };
export const SETTLEMENT_LABEL = { unpaid: "Unpaid", part_paid: "Part paid", paid: "Paid" };
const STATUS_LABEL = { draft: "Draft", issued: "Issued", cancelled: "Cancelled" };

const ERRORS = {
  ...COMMON_ERRORS,
  invalid_date: "invoiceDate",
  invalid_dates: "dueDate",
  invalid_field: "supplierNumber",
  duplicate: "supplierNumber",
  inactive_parent: "partyId",
  not_found: "partyId",
};

// A date key moved on by whole days.
export function addDays(key, days) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// How the settlement of an issued invoice reads; a draft or cancelled one has none.
export function settlementBadge(row) {
  if (row.status !== "issued") return h("span", { class: "muted" }, "—");
  return h(
    "span",
    {},
    badge(
      SETTLEMENT_LABEL[row.settlement] ?? row.settlement,
      row.settlement === "paid" ? "good" : "neutral"
    ),
    row.overdue ? [" ", badge("Overdue", "bad")] : null
  );
}

// Two steps: who the invoice is for, then the document it relates to and its dates.
function newInvoice(kind) {
  const parties = finance((f, ctx) => f.parties(ctx));
  const customer = kind === "customer";
  const choices = (customer ? parties.buyers : parties.suppliers).filter((party) => party.active);
  if (choices.length === 0) {
    toast(`There is no active ${customer ? "buyer" : "supplier"} to invoice`, "warn");
    return undefined;
  }
  let partyId = choices[0].id;
  return formDialog({
    title: customer ? "New customer invoice" : "New supplier invoice",
    description: customer ? "Which buyer is it for?" : "Which supplier sent it?",
    fields: [
      {
        name: "partyId",
        label: customer ? "Buyer" : "Supplier",
        type: "select",
        options: choices.map((party) => ({ value: party.id, label: party.name })),
        required: true,
      },
    ],
    initial: { partyId },
    errorFields: ERRORS,
    submitLabel: "Next",
    onSubmit: (values) => {
      partyId = values.partyId;
    },
  }).then((chosen) => {
    if (!chosen) return false;
    const sources = finance((f, ctx) =>
      f.sources(ctx, customer ? { buyerId: partyId } : { supplierId: partyId })
    );
    const today = session.who.today;
    const fields = [
      ...(customer
        ? [
            {
              name: "orderId",
              label: "Order",
              type: "select",
              options: [
                { value: "", label: "Not linked to an order" },
                ...sources.orders.map((order) => ({
                  value: order.id,
                  label: `${order.reference} · ${moneyText(order.value, order.currency)}`,
                })),
              ],
            },
          ]
        : [
            {
              name: "supplierNumber",
              label: "Supplier's invoice number",
              required: true,
              maxlength: 40,
            },
            {
              name: "poId",
              label: "Purchase order",
              type: "select",
              options: [
                { value: "", label: "Not linked to an order" },
                ...sources.purchaseOrders.map((po) => ({
                  value: po.id,
                  label: `${po.number} · ${moneyText(po.value, po.currency)}`,
                })),
              ],
            },
            {
              name: "receiptId",
              label: "Goods receipt",
              type: "select",
              options: [
                { value: "", label: "Not linked to a receipt" },
                ...sources.receipts.map((receipt) => ({
                  value: receipt.id,
                  label: `${receipt.number} · ${receipt.poNumber ?? "no order"}`,
                })),
              ],
              hint: "Only posted receipts. The invoice is matched against it for information; nothing is blocked.",
            },
          ]),
      { name: "invoiceDate", label: "Invoice date", type: "date", required: true },
      { name: "dueDate", label: "Due date", type: "date", required: true },
      {
        name: "currency",
        label: "Currency",
        maxlength: 3,
        hint: "Three letters; the linked document's currency, or the company currency, when left empty",
      },
      { name: "taxAmount", label: "Tax", type: "number", min: 0, step: "0.01" },
      { name: "note", label: "Note", type: "textarea" },
    ];
    return formDialog({
      title: customer ? "Customer invoice details" : "Supplier invoice details",
      description: "It starts as a draft; add or fill the lines on the next page.",
      fields,
      initial: { invoiceDate: today, dueDate: addDays(today, 30), taxAmount: 0 },
      errorFields: ERRORS,
      submitLabel: "Create draft",
      onSubmit: (values) => {
        const { orderId, poId, receiptId, ...rest } = values;
        const invoice = finance((f, ctx) =>
          f.createInvoice(ctx, {
            ...rest,
            kind,
            ...(customer ? { buyerId: partyId } : { supplierId: partyId }),
            orderId: orderId || undefined,
            poId: poId || undefined,
            receiptId: receiptId || undefined,
            currency: rest.currency || undefined,
            note: rest.note || undefined,
            lines: [],
          })
        );
        toast("Draft invoice created", "good");
        window.location.hash = invoiceAddress(invoice.id).slice(1);
      },
    });
  });
}

export function render() {
  const root = h("div");
  const filter = { kind: "", status: "", settlement: "", overdue: "", party: "" };
  mount(root, (redraw) => {
    const mayIssue = mayWrite("invoice.issue");
    const parties = finance((f, ctx) => f.parties(ctx));
    const query = queryOf(filter);
    const [partyKind, partyId] = (query.party ?? "").split(":");
    delete query.party;
    if (partyId) query[partyKind === "buyer" ? "buyerId" : "supplierId"] = partyId;
    if (query.overdue !== undefined) query.overdue = query.overdue === "yes";
    const rows = finance((f, ctx) => f.invoices(ctx, query));

    return h(
      "div",
      {},
      pageHeader(
        "Invoices",
        "Invoices to buyers and invoices received from suppliers.",
        mayIssue
          ? h(
              "div",
              { class: "actions end" },
              button("New customer invoice", () => newInvoice("customer"), { kind: "primary" }),
              button("New supplier invoice", () => newInvoice("supplier"))
            )
          : null
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      h(
        "div",
        { class: "tools" },
        filterSelect(
          filter,
          "kind",
          "Kind",
          [
            { value: "", label: "Both kinds" },
            ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "status",
          "Status",
          [
            { value: "", label: "Any status" },
            ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "settlement",
          "Settlement",
          [
            { value: "", label: "Any" },
            ...Object.entries(SETTLEMENT_LABEL).map(([value, label]) => ({ value, label })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "overdue",
          "Overdue",
          [
            { value: "", label: "Any" },
            { value: "yes", label: "Overdue" },
            { value: "no", label: "Not overdue" },
          ],
          redraw
        ),
        filterSelect(
          filter,
          "party",
          "Party",
          [
            { value: "", label: "Any buyer or supplier" },
            ...parties.buyers.map((party) => ({
              value: `buyer:${party.id}`,
              label: `Buyer · ${party.name}`,
            })),
            ...parties.suppliers.map((party) => ({
              value: `supplier:${party.id}`,
              label: `Supplier · ${party.name}`,
            })),
          ],
          redraw
        )
      ),
      card(
        null,
        dataTable({
          caption: "Invoices",
          pageSize: 12,
          columns: [
            {
              key: "number",
              label: "Invoice",
              sort: (r) => String(r.displayNumber),
              render: (r) => h("a", { href: invoiceAddress(r.id) }, r.displayNumber),
            },
            {
              key: "kind",
              label: "Kind",
              sort: (r) => r.kind,
              render: (r) => KIND_LABEL[r.kind] ?? r.kind,
            },
            {
              key: "party",
              label: "Party",
              sort: (r) => r.partyName ?? "",
              render: (r) => text(r.partyName),
            },
            {
              key: "status",
              label: "Status",
              sort: (r) => r.status,
              render: (r) => statusBadge(r.status),
            },
            {
              key: "date",
              label: "Invoice date",
              sort: (r) => r.invoiceDate,
              render: (r) => dateText(r.invoiceDate),
            },
            {
              key: "due",
              label: "Due",
              sort: (r) => r.dueDate,
              render: (r) => dateText(r.dueDate),
            },
            {
              key: "total",
              label: "Total",
              sort: (r) => r.total,
              align: "end",
              render: (r) => moneyText(r.total, r.currency),
            },
            {
              key: "paid",
              label: "Paid",
              sort: (r) => r.paid,
              align: "end",
              render: (r) => moneyText(r.paid, r.currency),
            },
            {
              key: "balance",
              label: "Balance",
              sort: (r) => r.balance,
              align: "end",
              render: (r) => (r.status === "issued" ? moneyText(r.balance, r.currency) : "—"),
            },
            {
              key: "settlement",
              label: "Settlement",
              sort: (r) => r.settlement,
              render: (r) => settlementBadge(r),
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) =>
            `${r.displayNumber} ${r.partyName ?? ""} ${r.orderReference ?? ""} ${r.poNumber ?? ""}`,
          empty: {
            title: "No invoices",
            body: mayIssue ? "Create the first invoice." : "No invoices match this view.",
          },
        })
      )
    );
  });
  return root;
}
