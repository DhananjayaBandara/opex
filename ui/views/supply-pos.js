// Purchase orders (D87): the list, and a new draft. An order opens on its own page, which holds the
// lines, issuing, cancelling and the goods receipts recorded against it. Delivery is always written
// in words ("Partly received", "Late"), never shown only by colour.
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
  mayWrite,
  moneyText,
  poAddress,
  queryOf,
  rfqAddress,
  supply,
  text,
} from "./supply-common.js";

export const PO_STATUS_LABEL = { draft: "Draft", issued: "Issued", cancelled: "Cancelled" };
export const DELIVERY_LABEL = {
  not_received: "Not received",
  partly_received: "Partly received",
  complete: "Complete",
};

const ERRORS = {
  ...COMMON_ERRORS,
  invalid_dates: "expectedDate",
  invalid_date: "orderDate",
  inactive_parent: "supplierId",
  not_found: "supplierId",
};

export function render() {
  const root = h("div");
  const filter = { factoryId: "", supplierId: "", status: "" };
  mount(root, (redraw) => {
    const mayCreate = mayWrite("po.manage");
    const factories = supply((p, ctx) => p.factories(ctx));
    const suppliers = supply((p, ctx) => p.suppliers(ctx));
    const rows = supply((p, ctx) => p.purchaseOrders(ctx, queryOf(filter)));

    const create = () => {
      const placeable = supply((p, ctx) => p.factories(ctx, { for: "po" }));
      const open = suppliers.filter((supplier) => supplier.active);
      if (placeable.length === 0 || open.length === 0) {
        toast("There is no factory or active supplier to order from", "warn");
        return undefined;
      }
      return formDialog({
        title: "New purchase order",
        description: "It starts as a draft. Add the lines on the next page, then issue it.",
        fields: [
          {
            name: "factoryId",
            label: "Deliver to factory",
            type: "select",
            options: placeable.map((factory) => ({ value: factory.id, label: factory.name })),
            required: true,
          },
          {
            name: "supplierId",
            label: "Supplier",
            type: "select",
            options: open.map((supplier) => ({ value: supplier.id, label: supplier.name })),
            required: true,
          },
          { name: "orderDate", label: "Order date", type: "date", required: true },
          { name: "expectedDate", label: "Expected delivery", type: "date", required: true },
          {
            name: "currency",
            label: "Currency",
            maxlength: 3,
            hint: "Three letters; the company currency when left empty",
          },
          { name: "note", label: "Note", type: "textarea" },
        ],
        initial: { orderDate: session.who.today },
        errorFields: ERRORS,
        submitLabel: "Create draft",
        onSubmit: (values) => {
          const po = supply((p, ctx) =>
            p.createPurchaseOrder(ctx, {
              ...values,
              currency: values.currency || undefined,
              lines: [],
            })
          );
          toast("Draft purchase order created", "good");
          window.location.hash = poAddress(po.id).slice(1);
        },
      });
    };

    return h(
      "div",
      {},
      pageHeader(
        "Purchase orders",
        "What has been ordered from suppliers, and how much of it has arrived.",
        mayCreate ? button("New purchase order", create, { kind: "primary" }) : null
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
            ...Object.entries(PO_STATUS_LABEL).map(([value, label]) => ({ value, label })),
          ],
          redraw
        )
      ),
      card(
        null,
        dataTable({
          caption: "Purchase orders",
          pageSize: 12,
          columns: [
            {
              key: "number",
              label: "Order",
              sort: (r) => r.number,
              render: (r) => h("a", { href: poAddress(r.id) }, r.number),
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
              key: "ordered",
              label: "Ordered",
              sort: (r) => r.orderDate,
              render: (r) => dateText(r.orderDate),
            },
            {
              key: "expected",
              label: "Expected",
              sort: (r) => r.expectedDate,
              render: (r) => dateText(r.expectedDate),
            },
            {
              key: "value",
              label: "Value",
              sort: (r) => r.value,
              align: "end",
              render: (r) => moneyText(r.value, r.currency),
            },
            {
              key: "delivery",
              label: "Delivery",
              sort: (r) => r.delivery,
              render: (r) =>
                r.status === "issued"
                  ? h(
                      "span",
                      {},
                      DELIVERY_LABEL[r.delivery] ?? r.delivery,
                      r.late ? [" ", badge("Late", "bad")] : null
                    )
                  : "—",
            },
            { key: "receipts", label: "Receipts", sort: (r) => r.receipts, align: "end" },
            {
              key: "rfq",
              label: "From RFQ",
              render: (r) => (r.rfqId ? h("a", { href: rfqAddress(r.rfqId) }, r.rfqNumber) : "—"),
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.number} ${r.supplierName ?? ""} ${r.factoryName ?? ""}`,
          empty: {
            title: "No purchase orders",
            body: mayCreate ? "Create a draft, or award an RFQ." : "No orders match this view.",
          },
        })
      )
    );
  });
  return root;
}
