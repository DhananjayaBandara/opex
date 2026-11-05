// Payments (D93): the money received against customer invoices and paid against supplier invoices. A
// payment is recorded on its invoice and cannot exceed the balance; each row links back to the invoice.
// This page is the cross-invoice view, so it only reads.
import { h } from "../dom.js";
import { card, mount, notice, pageHeader } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  READ_ONLY_NOTE,
  dateText,
  filterDate,
  filterSelect,
  finance,
  invoiceAddress,
  moneyText,
  queryOf,
  text,
} from "./supply-common.js";

const METHOD_OPTIONS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
];

export function render() {
  const root = h("div");
  const filter = { kind: "", method: "", from: "", to: "" };
  mount(root, (redraw) => {
    const rows = finance((f, ctx) => f.payments(ctx, queryOf(filter)));

    return h(
      "div",
      {},
      pageHeader(
        "Payments",
        "Payments received from buyers and made to suppliers. Record one from its invoice."
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
            { value: "", label: "Received and paid" },
            { value: "customer", label: "Received from buyers" },
            { value: "supplier", label: "Paid to suppliers" },
          ],
          redraw
        ),
        filterSelect(
          filter,
          "method",
          "Method",
          [{ value: "", label: "Any method" }, ...METHOD_OPTIONS],
          redraw
        ),
        filterDate(filter, "from", "From", redraw),
        filterDate(filter, "to", "To", redraw)
      ),
      card(
        null,
        dataTable({
          caption: "Payments",
          pageSize: 15,
          columns: [
            {
              key: "date",
              label: "Date",
              sort: (r) => `${r.date} ${r.recordedAt ?? ""}`,
              render: (r) => dateText(r.date),
            },
            {
              key: "invoice",
              label: "Invoice",
              sort: (r) => String(r.invoiceNumber ?? ""),
              render: (r) => h("a", { href: invoiceAddress(r.invoiceId) }, r.invoiceNumber),
            },
            {
              key: "kind",
              label: "Kind",
              sort: (r) => r.kind,
              render: (r) => (r.kind === "customer" ? "Received" : "Paid"),
            },
            {
              key: "party",
              label: "Party",
              sort: (r) => r.partyName ?? "",
              render: (r) => text(r.partyName),
            },
            {
              key: "amount",
              label: "Amount",
              sort: (r) => r.amount,
              align: "end",
              render: (r) => moneyText(r.amount, r.currency),
            },
            { key: "method", label: "Method", sort: (r) => r.method, render: (r) => r.methodLabel },
            { key: "reference", label: "Reference", render: (r) => text(r.reference) },
            { key: "by", label: "Recorded by", render: (r) => text(r.recordedBy) },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.invoiceNumber ?? ""} ${r.partyName ?? ""} ${r.reference ?? ""}`,
          empty: {
            title: "No payments",
            body: "Payments appear once they are recorded against an issued invoice.",
          },
        })
      )
    );
  });
  return root;
}
