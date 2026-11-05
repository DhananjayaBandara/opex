// One invoice (D92, D93). The service says what the caller may do and what the status allows
// (`editable`, `canFill`, `canIssue`, `canCancel`, `canPay`); the page draws only those, and every call
// checks again. Issuing locks the invoice; a draft is cancelled with a reason; a payment cannot exceed
// the balance. The comparison with the order or receipt is information only (P20): nothing is blocked.
import { h } from "../dom.js";
import { confirmDialog, formDialog } from "../dialog.js";
import {
  attempt,
  badge,
  button,
  card,
  emptyState,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { randomUuid } from "../../store/ids.js";
import {
  COMMON_ERRORS,
  READ_ONLY_NOTE,
  addressId,
  dateText,
  finance,
  moneyText,
  poAddress,
  quantityText,
  receiptAddress,
  row,
  text,
} from "./supply-common.js";
import { orderAddress } from "./orders-common.js";
import { KIND_LABEL, settlementBadge } from "./finance-invoices.js";

const ERRORS = {
  ...COMMON_ERRORS,
  invalid_date: "invoiceDate",
  invalid_dates: "dueDate",
  invalid_field: "description",
  invalid_number: "quantity",
  duplicate: "supplierNumber",
};

const PAYMENT_ERRORS = {
  overpayment: "amount",
  invalid_number: "amount",
  invalid_date: "date",
  invalid_method: "method",
  idempotency_conflict: "amount",
};

const METHODS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
];

const link = (label, onClick) => button(label, onClick, { kind: "link" });

// A fresh key for each time the payment form opens, so a repeated submit cannot pay twice (D93).
const newKey = () => randomUuid();

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const id = addressId();
    if (!id) {
      return emptyState({
        title: "No invoice chosen",
        body: "Open an invoice from the list.",
        action: h("a", { class: "btn btn-primary", href: "#/finance/invoices" }, "Invoices"),
      });
    }
    const view = finance((f, ctx) => f.invoice(ctx, id));
    const { invoice } = view;
    const customer = invoice.kind === "customer";
    const live = !session.supporting;
    const editable = live && view.editable;
    const run = (call, success) => {
      attempt(() => finance(call), success);
      redraw();
    };

    // ---- Header and status --------------------------------------------------------------------

    const edit = () =>
      formDialog({
        title: `Edit ${invoice.displayNumber}`,
        fields: [
          ...(customer
            ? []
            : [
                {
                  name: "supplierNumber",
                  label: "Supplier's invoice number",
                  required: true,
                  maxlength: 40,
                },
              ]),
          { name: "invoiceDate", label: "Invoice date", type: "date", required: true },
          { name: "dueDate", label: "Due date", type: "date", required: true },
          { name: "currency", label: "Currency", maxlength: 3, hint: "Three letters" },
          { name: "taxAmount", label: "Tax", type: "number", min: 0, step: "0.01" },
          { name: "note", label: "Note", type: "textarea" },
        ],
        initial: {
          supplierNumber: invoice.supplierNumber ?? "",
          invoiceDate: invoice.invoiceDate,
          dueDate: invoice.dueDate,
          currency: invoice.currency,
          taxAmount: invoice.tax,
          note: invoice.note ?? "",
        },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: ({ supplierNumber, ...values }) => {
          finance((f, ctx) =>
            f.updateInvoice(ctx, invoice.id, {
              ...values,
              taxAmount: values.taxAmount ?? 0,
              note: values.note || null,
              ...(customer ? {} : { supplierNumber }),
            })
          );
          toast("Invoice saved", "good");
          redraw();
        },
      });

    const fill = () =>
      confirmDialog({
        title: "Fill the lines from the linked document?",
        message: customer
          ? "The lines are replaced with the order's priced lines."
          : "The lines are replaced with the receipt's accepted quantities at the purchase order's prices.",
        confirmLabel: "Fill lines",
        onConfirm: () => {
          finance((f, ctx) => f.fillInvoice(ctx, invoice.id));
          toast("Lines filled", "good");
          redraw();
        },
      });

    const issue = () =>
      confirmDialog({
        title: `Issue ${invoice.displayNumber}?`,
        message: `The invoice for ${moneyText(invoice.total, invoice.currency)} is issued and locked. After this it takes payments and is never cancelled.`,
        confirmLabel: "Issue invoice",
        onConfirm: () => {
          finance((f, ctx) => f.issueInvoice(ctx, invoice.id));
          toast("Invoice issued", "good");
          redraw();
        },
      });

    const cancel = () =>
      confirmDialog({
        title: `Cancel ${invoice.displayNumber}?`,
        message: "Only a draft can be cancelled. A cancelled invoice cannot be changed or paid.",
        confirmLabel: "Cancel invoice",
        danger: true,
        reason: true,
        reasonLabel: "Reason for cancelling",
        onConfirm: (reason) => {
          finance((f, ctx) => f.cancelInvoice(ctx, invoice.id, { reason }));
          toast("Invoice cancelled", "good");
          redraw();
        },
      });

    const pay = () => {
      const key = newKey();
      return formDialog({
        title: `Record a payment for ${invoice.displayNumber}`,
        description: `Balance ${moneyText(invoice.balance, invoice.currency)}. A payment cannot be larger than the balance.`,
        fields: [
          {
            name: "amount",
            label: "Amount",
            type: "number",
            min: 0,
            step: "0.01",
            required: true,
          },
          { name: "date", label: "Payment date", type: "date", required: true },
          { name: "method", label: "Method", type: "select", options: METHODS, required: true },
          { name: "reference", label: "Reference", maxlength: 80 },
        ],
        initial: {
          amount: invoice.balance,
          date: session.who.today,
          method: "bank_transfer",
        },
        errorFields: PAYMENT_ERRORS,
        submitLabel: "Record payment",
        onSubmit: (values) => {
          const result = finance((f, ctx) =>
            f.recordPayment(ctx, invoice.id, {
              ...values,
              reference: values.reference || undefined,
              idempotencyKey: key,
            })
          );
          toast(result.replayed ? "That payment was already recorded" : "Payment recorded", "good");
          redraw();
        },
      });
    };

    const linked = [
      invoice.orderId
        ? ["Order", h("a", { href: orderAddress(invoice.orderId) }, invoice.orderReference)]
        : null,
      invoice.poId
        ? ["Purchase order", h("a", { href: poAddress(invoice.poId) }, invoice.poNumber)]
        : null,
      invoice.receiptId
        ? [
            "Goods receipt",
            h("a", { href: receiptAddress(invoice.receiptId) }, invoice.receiptNumber),
          ]
        : null,
    ].filter(Boolean);

    const header = card(
      null,
      h(
        "div",
        {},
        h(
          "dl",
          { class: "facts" },
          ...[
            ["Status", statusBadge(invoice.status)],
            ["Kind", KIND_LABEL[invoice.kind] ?? invoice.kind],
            [customer ? "Buyer" : "Supplier", text(invoice.partyName)],
            ...(customer ? [] : [["Supplier's number", text(invoice.supplierNumber)]]),
            ["Factory", text(invoice.factoryName)],
            ["Invoice date", dateText(invoice.invoiceDate)],
            ["Due", dateText(invoice.dueDate)],
            ...linked,
            ["Subtotal", moneyText(invoice.subtotal, invoice.currency)],
            ["Tax", moneyText(invoice.tax, invoice.currency)],
            ["Total", moneyText(invoice.total, invoice.currency)],
            ["Paid", moneyText(invoice.paid, invoice.currency)],
            [
              "Balance",
              invoice.status === "issued" ? moneyText(invoice.balance, invoice.currency) : "—",
            ],
            ["Settlement", settlementBadge(invoice)],
          ].flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])
        ),
        invoice.note ? h("p", {}, invoice.note) : null,
        invoice.cancelReason ? notice(`Cancelled: ${invoice.cancelReason}`, "warn") : null,
        live
          ? row(
              editable ? button("Edit", edit) : null,
              live && view.canFill ? button("Fill from linked document", fill) : null,
              view.canIssue ? button("Issue invoice", issue, { kind: "primary" }) : null,
              view.canPay ? button("Record payment", pay, { kind: "primary" }) : null,
              view.canCancel ? button("Cancel invoice", cancel, { kind: "danger" }) : null
            )
          : null
      )
    );

    // ---- Lines --------------------------------------------------------------------------------

    const lineFields = [
      { name: "description", label: "Description", required: true, maxlength: 200 },
      {
        name: "quantity",
        label: "Quantity",
        type: "number",
        min: 0,
        step: "any",
        required: true,
      },
      {
        name: "unitPrice",
        label: "Unit price",
        type: "number",
        min: 0,
        step: "any",
        required: true,
      },
    ];

    const addLine = () =>
      formDialog({
        title: "Add a line",
        fields: lineFields,
        initial: { quantity: 1 },
        errorFields: ERRORS,
        submitLabel: "Add line",
        onSubmit: (values) => {
          finance((f, ctx) => f.addInvoiceLine(ctx, invoice.id, values));
          toast("Line added", "good");
          redraw();
        },
      });

    const editLine = (line) =>
      formDialog({
        title: "Edit line",
        fields: lineFields,
        initial: {
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          finance((f, ctx) => f.updateInvoiceLine(ctx, line.id, values));
          toast("Line saved", "good");
          redraw();
        },
      });

    const lines = card(
      "Lines",
      dataTable({
        caption: "Invoice lines",
        pageSize: 10,
        columns: [
          { key: "description", label: "Description", sort: (r) => r.description },
          {
            key: "quantity",
            label: "Quantity",
            sort: (r) => r.quantity,
            align: "end",
            render: (r) => quantityText(r.quantity),
          },
          {
            key: "price",
            label: "Unit price",
            sort: (r) => r.unitPrice,
            align: "end",
            render: (r) => moneyText(r.unitPrice),
          },
          {
            key: "amount",
            label: "Amount",
            sort: (r) => r.amount,
            align: "end",
            render: (r) => moneyText(r.amount, invoice.currency),
          },
          {
            key: "actions",
            label: "",
            align: "end",
            render: (r) =>
              editable
                ? row(
                    link("Edit", () => editLine(r)),
                    link("Remove", () =>
                      run((f, ctx) => f.removeInvoiceLine(ctx, r.id), "Line removed")
                    )
                  )
                : null,
          },
        ],
        rows: view.lines,
        rowKey: (r) => r.id,
        empty: {
          title: "No lines yet",
          body: editable ? "Add a line, or fill them from the linked document." : "No lines.",
        },
      }),
      editable ? button("Add a line", addLine) : null
    );

    // ---- Payments -----------------------------------------------------------------------------

    const payments = card(
      "Payments",
      dataTable({
        caption: "Payments against this invoice",
        pageSize: 10,
        columns: [
          {
            key: "date",
            label: "Date",
            sort: (r) => r.date,
            render: (r) => dateText(r.date),
          },
          {
            key: "amount",
            label: "Amount",
            sort: (r) => r.amount,
            align: "end",
            render: (r) => moneyText(r.amount, r.currency),
          },
          { key: "method", label: "Method", render: (r) => r.methodLabel },
          { key: "reference", label: "Reference", render: (r) => text(r.reference) },
          { key: "by", label: "Recorded by", render: (r) => text(r.recordedBy) },
        ],
        rows: view.payments,
        rowKey: (r) => r.id,
        empty: {
          title: "No payments yet",
          body:
            invoice.status === "issued"
              ? "Record a payment when one is made or received."
              : "Only an issued invoice takes payments.",
        },
      })
    );

    // ---- Comparison with the order or receipt (information only) ------------------------------

    const trace = view.trace;
    const traceCard = trace
      ? card(
          "Comparison with the linked document",
          h(
            "div",
            {},
            h(
              "p",
              { class: "muted" },
              "Information only: a difference never stops an invoice from being issued or paid."
            ),
            h(
              "dl",
              { class: "facts" },
              ...(customer
                ? [
                    ["Order", trace.reference],
                    ["Order value", moneyText(trace.ordered, trace.currency)],
                    ["Invoiced so far", moneyText(trace.invoiced, trace.currency)],
                    ["Not yet invoiced", moneyText(trace.remaining, trace.currency)],
                  ]
                : [
                    ["Purchase order", text(trace.poNumber)],
                    ["Goods receipt", text(trace.receiptNumber)],
                    ["Ordered value", moneyText(trace.ordered, trace.currency)],
                    ["Accepted at order prices", moneyText(trace.accepted, trace.currency)],
                    ["Invoiced against this order", moneyText(trace.invoiced, trace.currency)],
                    ["Difference", moneyText(trace.difference, trace.currency)],
                  ]
              ).flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])
            ),
            h(
              "p",
              {},
              customer ? null : trace.matches ? badge("Matches", "good") : badge("Differs", "warn"),
              customer ? null : " ",
              trace.statement
            ),
            trace.basis ? h("p", { class: "muted" }, trace.basis) : null
          )
        )
      : null;

    return h(
      "div",
      {},
      pageHeader(
        invoice.displayNumber,
        text(invoice.partyName),
        h("a", { class: "btn btn-secondary", href: "#/finance/invoices" }, "All invoices")
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      header,
      lines,
      payments,
      traceCard
    );
  });
  return root;
}
