// Goods receipts (D88): what arrived against which purchase order, and whether it has been posted into
// the store. A receipt is recorded from its purchase order page; this list is for finding it.
import { h } from "../dom.js";
import { card, mount, notice, pageHeader, statusBadge } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  READ_ONLY_NOTE,
  dateText,
  filterSelect,
  poAddress,
  queryOf,
  receiptAddress,
  supply,
  text,
} from "./supply-common.js";

export const RECEIPT_STATUS_LABEL = {
  draft: "Draft",
  received: "Received",
  posted: "Posted",
  reversed: "Reversed",
  cancelled: "Cancelled",
};

export function render() {
  const root = h("div");
  const filter = { factoryId: "", poId: "", status: "" };
  mount(root, (redraw) => {
    const factories = supply((p, ctx) => p.factories(ctx));
    const orders = supply((p, ctx) => p.purchaseOrders(ctx, {}));
    const rows = supply((p, ctx) => p.receipts(ctx, queryOf(filter)));

    return h(
      "div",
      {},
      pageHeader(
        "Goods receipts",
        "Deliveries checked on arrival. Posting a receipt puts the accepted goods into the store."
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      h(
        "div",
        { class: "tools" },
        filterSelect(
          filter,
          "factoryId",
          "Factory",
          [
            { value: "", label: "All factories" },
            ...factories.map((row) => ({ value: row.id, label: row.name })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "poId",
          "Purchase order",
          [
            { value: "", label: "All orders" },
            ...orders.map((row) => ({ value: row.id, label: row.number })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "status",
          "Status",
          [
            { value: "", label: "Any status" },
            ...Object.entries(RECEIPT_STATUS_LABEL).map(([value, label]) => ({ value, label })),
          ],
          redraw
        )
      ),
      card(
        null,
        dataTable({
          caption: "Goods receipts",
          pageSize: 12,
          columns: [
            {
              key: "number",
              label: "Receipt",
              sort: (r) => r.number,
              render: (r) => h("a", { href: receiptAddress(r.id) }, r.number),
            },
            {
              key: "po",
              label: "Purchase order",
              sort: (r) => r.poNumber ?? "",
              render: (r) => h("a", { href: poAddress(r.poId) }, r.poNumber),
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
              render: (r) => statusBadge(r.status),
            },
            {
              key: "date",
              label: "Received on",
              sort: (r) => r.receiptDate,
              render: (r) => dateText(r.receiptDate),
            },
            { key: "challan", label: "Challan", render: (r) => text(r.challan) },
            { key: "received", label: "Received", sort: (r) => r.received, align: "end" },
            { key: "accepted", label: "Accepted", sort: (r) => r.accepted, align: "end" },
            { key: "rejected", label: "Rejected", sort: (r) => r.rejected, align: "end" },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) =>
            `${r.number} ${r.poNumber ?? ""} ${r.supplierName ?? ""} ${r.challan ?? ""}`,
          empty: {
            title: "No goods receipts",
            body: "Record one from an issued purchase order.",
          },
        })
      )
    );
  });
  return root;
}
