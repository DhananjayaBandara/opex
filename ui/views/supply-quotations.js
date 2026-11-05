// Quotations: every price offer recorded against a request for quotation (D86), across all RFQs. They
// are recorded and replaced on the RFQ page, so this list is for finding and comparing; each row opens
// its RFQ. An expired quotation says so in words.
import { h } from "../dom.js";
import { badge, card, mount, notice, pageHeader, statusBadge } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  READ_ONLY_NOTE,
  dateText,
  filterSelect,
  linkTo,
  moneyText,
  poAddress,
  queryOf,
  rfqAddress,
  supply,
  text,
} from "./supply-common.js";

const STATUS_LABEL = { quoted: "Quoted", awarded: "Awarded", not_awarded: "Not awarded" };

export function render() {
  const root = h("div");
  const filter = { rfqId: "", supplierId: "", status: "" };
  mount(root, (redraw) => {
    const rfqs = supply((p, ctx) => p.rfqs(ctx, {}));
    const suppliers = supply((p, ctx) => p.suppliers(ctx));
    const rows = supply((p, ctx) => p.quotations(ctx, queryOf(filter)));

    return h(
      "div",
      {},
      pageHeader(
        "Quotations",
        "Price offers from suppliers. Record or replace one on its RFQ page."
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      h(
        "div",
        { class: "tools" },
        filterSelect(
          filter,
          "rfqId",
          "RFQ",
          [
            { value: "", label: "All RFQs" },
            ...rfqs.map((row) => ({ value: row.id, label: row.number })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "supplierId",
          "Supplier",
          [
            { value: "", label: "Any supplier" },
            ...suppliers.map((row) => ({ value: row.id, label: row.name })),
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
        )
      ),
      card(
        null,
        dataTable({
          caption: "Quotations",
          pageSize: 12,
          columns: [
            {
              key: "rfq",
              label: "RFQ",
              sort: (r) => r.rfqNumber,
              render: (r) => h("a", { href: rfqAddress(r.rfqId) }, r.rfqNumber),
            },
            {
              key: "supplier",
              label: "Supplier",
              sort: (r) => r.supplierName ?? "",
              render: (r) => text(r.supplierName),
            },
            {
              key: "factory",
              label: "Factory",
              sort: (r) => r.factoryName ?? "",
              render: (r) => text(r.factoryName),
            },
            {
              key: "status",
              label: "Status",
              sort: (r) => r.status,
              render: (r) =>
                h(
                  "span",
                  {},
                  statusBadge(r.status),
                  r.expired ? [" ", badge("Quotation expired", "warn")] : null
                ),
            },
            {
              key: "date",
              label: "Quoted on",
              sort: (r) => r.date,
              render: (r) => dateText(r.date),
            },
            {
              key: "valid",
              label: "Valid until",
              sort: (r) => r.validUntil ?? "",
              render: (r) => dateText(r.validUntil),
            },
            {
              key: "covered",
              label: "Lines quoted",
              sort: (r) => r.covered,
              align: "end",
              render: (r) => `${r.covered} of ${r.asked}`,
            },
            {
              key: "lead",
              label: "Longest lead time",
              sort: (r) => r.longestLeadDays,
              align: "end",
              render: (r) => `${r.longestLeadDays} days`,
            },
            {
              key: "total",
              label: "Total",
              sort: (r) => r.total,
              align: "end",
              render: (r) => moneyText(r.total, r.currency),
            },
            {
              key: "po",
              label: "Purchase order",
              render: (r) =>
                r.purchaseOrderId ? linkTo("Open", poAddress(r.purchaseOrderId)) : "—",
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.rfqNumber} ${r.supplierName ?? ""} ${r.supplierRef ?? ""}`,
          empty: {
            title: "No quotations",
            body: "Quotations appear once suppliers answer an RFQ.",
          },
        })
      )
    );
  });
  return root;
}
