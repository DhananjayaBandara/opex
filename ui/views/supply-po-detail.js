// One purchase order (D87): header, lines, issuing, cancelling and the goods receipts against it.
// The service says what the caller may do and what the status allows (`editable`, `canIssue`,
// `canCancel`, `canReceive`); the page draws only those, and every call checks again. Issuing locks
// the lines.
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
import {
  COMMON_ERRORS,
  READ_ONLY_NOTE,
  addressId,
  dateText,
  moneyText,
  receiptAddress,
  rfqAddress,
  row,
  supply,
  text,
  withUnit,
} from "./supply-common.js";
import { DELIVERY_LABEL } from "./supply-pos.js";
import { receiptDialog } from "./supply-receipt-form.js";

const ERRORS = {
  ...COMMON_ERRORS,
  invalid_dates: "expectedDate",
  invalid_date: "orderDate",
  inactive_parent: "materialId",
  not_found: "materialId",
  duplicate: "materialId",
  invalid_number: "quantity",
};

const link = (label, onClick) => button(label, onClick, { kind: "link" });

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const id = addressId();
    if (!id) {
      return emptyState({
        title: "No purchase order chosen",
        body: "Open a purchase order from the list.",
        action: h(
          "a",
          { class: "btn btn-primary", href: "#/supply/purchase-orders" },
          "Purchase orders"
        ),
      });
    }
    const view = supply((p, ctx) => p.purchaseOrder(ctx, id));
    const { po } = view;
    const mayManage = view.may.manage && !session.supporting;
    const mayReceive = view.may.receive && !session.supporting;
    const editable = mayManage && view.editable;
    const run = (call, success) => {
      const result = attempt(() => supply(call), success);
      redraw();
      return result;
    };

    // ---- Header and status --------------------------------------------------------------------

    const edit = () =>
      formDialog({
        title: `Edit ${po.number}`,
        fields: [
          { name: "orderDate", label: "Order date", type: "date", required: true },
          { name: "expectedDate", label: "Expected delivery", type: "date", required: true },
          { name: "currency", label: "Currency", maxlength: 3, hint: "Three letters" },
          { name: "note", label: "Note", type: "textarea" },
        ],
        initial: {
          orderDate: po.orderDate,
          expectedDate: po.expectedDate,
          currency: po.currency,
          note: po.note ?? "",
        },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          supply((p, ctx) =>
            p.updatePurchaseOrder(ctx, po.id, { ...values, note: values.note || null })
          );
          toast("Purchase order saved", "good");
          redraw();
        },
      });

    const issue = () =>
      confirmDialog({
        title: `Issue ${po.number}?`,
        message: `It is sent to ${po.supplierName} for ${moneyText(
          po.value,
          po.currency
        )} and its lines are locked.`,
        confirmLabel: "Issue order",
        onConfirm: () => {
          supply((p, ctx) => p.issuePurchaseOrder(ctx, po.id));
          toast("Purchase order issued", "good");
          redraw();
        },
      });

    const cancel = () =>
      confirmDialog({
        title: `Cancel ${po.number}?`,
        message:
          "A cancelled order cannot be received against. It is refused while a receipt is received or posted: cancel or reverse that receipt first.",
        confirmLabel: "Cancel order",
        danger: true,
        reason: true,
        reasonLabel: "Reason for cancelling",
        onConfirm: (reason) => {
          supply((p, ctx) => p.cancelPurchaseOrder(ctx, po.id, { reason }));
          toast("Purchase order cancelled", "good");
          redraw();
        },
      });

    const receive = () =>
      receiptDialog({
        po: view,
        onSaved: (receipt) => {
          toast("Draft receipt created", "good");
          window.location.hash = receiptAddress(receipt.id).slice(1);
        },
      });

    const header = card(
      null,
      h(
        "div",
        {},
        h(
          "dl",
          { class: "facts" },
          ...[
            ["Status", statusBadge(po.status)],
            ["Supplier", text(po.supplierName)],
            ["Deliver to", text(po.factoryName)],
            ["Order date", dateText(po.orderDate)],
            ["Expected delivery", dateText(po.expectedDate)],
            [
              "Delivery",
              po.status === "issued"
                ? h(
                    "span",
                    {},
                    DELIVERY_LABEL[po.delivery] ?? po.delivery,
                    po.late ? [" ", badge("Late", "bad")] : null
                  )
                : "—",
            ],
            ["Currency", po.currency],
            ["Subtotal", moneyText(po.subtotal, po.currency)],
            ["Tax", moneyText(po.tax, po.currency)],
            ["Value", moneyText(po.value, po.currency)],
            ["From RFQ", po.rfqId ? h("a", { href: rfqAddress(po.rfqId) }, view.rfqNumber) : "—"],
          ].flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])
        ),
        po.note ? h("p", {}, po.note) : null,
        po.cancelReason ? notice(`Cancelled: ${po.cancelReason}`, "warn") : null,
        mayManage || mayReceive
          ? row(
              editable ? button("Edit", edit) : null,
              mayManage && view.canIssue ? button("Issue order", issue, { kind: "primary" }) : null,
              mayReceive && view.canReceive
                ? button("Record goods received", receive, { kind: "primary" })
                : null,
              mayManage && view.canCancel
                ? button("Cancel order", cancel, { kind: "danger" })
                : null
            )
          : null
      )
    );

    // ---- Lines --------------------------------------------------------------------------------

    const lineFields = (line) => [
      ...(line
        ? []
        : [
            {
              name: "materialId",
              label: "Material",
              type: "select",
              options: supply((p, ctx) => p.materials(ctx))
                .filter(
                  (material) =>
                    material.active && !view.lines.some((entry) => entry.materialId === material.id)
                )
                .map((material) => ({
                  value: material.id,
                  label: `${material.code} · ${material.name} (${material.unit})`,
                })),
              required: true,
            },
          ]),
      {
        name: "quantity",
        label: line ? `Quantity (${line.unit})` : "Quantity",
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
      { name: "taxAmount", label: "Tax on the line", type: "number", min: 0, step: "0.01" },
    ];

    const addLine = () => {
      const fields = lineFields(null);
      if (fields[0].options.length === 0) {
        toast("Every active material is already on this order", "warn");
        return undefined;
      }
      return formDialog({
        title: "Add a line",
        fields,
        initial: { taxAmount: 0 },
        errorFields: ERRORS,
        submitLabel: "Add line",
        onSubmit: (values) => {
          supply((p, ctx) => p.addPoLine(ctx, po.id, values));
          toast("Line added", "good");
          redraw();
        },
      });
    };

    const editLine = (line) =>
      formDialog({
        title: `Edit ${line.materialCode}`,
        fields: lineFields(line),
        initial: { quantity: line.quantity, unitPrice: line.unitPrice, taxAmount: line.taxAmount },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          supply((p, ctx) => p.updatePoLine(ctx, line.id, values));
          toast("Line saved", "good");
          redraw();
        },
      });

    const lines = card(
      "Lines",
      dataTable({
        caption: "Purchase order lines",
        pageSize: 10,
        columns: [
          {
            key: "material",
            label: "Material",
            sort: (r) => r.materialCode,
            render: (r) => `${r.materialCode} · ${r.materialName}`,
          },
          {
            key: "quantity",
            label: "Ordered",
            sort: (r) => r.quantity,
            align: "end",
            render: (r) => withUnit(r.quantity, r.unit),
          },
          {
            key: "price",
            label: "Unit price",
            sort: (r) => r.unitPrice,
            align: "end",
            render: (r) => moneyText(r.unitPrice),
          },
          {
            key: "tax",
            label: "Tax",
            sort: (r) => r.taxAmount,
            align: "end",
            render: (r) => moneyText(r.taxAmount),
          },
          {
            key: "amount",
            label: "Amount",
            sort: (r) => r.amount,
            align: "end",
            render: (r) => moneyText(r.amount, po.currency),
          },
          {
            key: "accepted",
            label: "Accepted so far",
            sort: (r) => r.accepted,
            align: "end",
            render: (r) => (po.status === "draft" ? "—" : withUnit(r.accepted, r.unit)),
          },
          {
            key: "pending",
            label: "Still to arrive",
            sort: (r) => r.pending,
            align: "end",
            render: (r) => (po.status === "issued" ? withUnit(r.pending, r.unit) : "—"),
          },
          {
            key: "actions",
            label: "",
            align: "end",
            render: (r) =>
              editable
                ? row(
                    link("Edit", () => editLine(r)),
                    link("Remove", () => run((p, ctx) => p.removePoLine(ctx, r.id), "Line removed"))
                  )
                : null,
          },
        ],
        rows: view.lines,
        rowKey: (r) => r.id,
        empty: {
          title: "No lines yet",
          body: editable ? "Add the materials to order." : "This order has no lines.",
        },
      }),
      editable ? button("Add a line", addLine) : null
    );

    // ---- Goods receipts -----------------------------------------------------------------------

    const receipts = card(
      "Goods receipts",
      dataTable({
        caption: "Goods receipts against this order",
        pageSize: 10,
        columns: [
          {
            key: "number",
            label: "Receipt",
            sort: (r) => r.number,
            render: (r) => h("a", { href: receiptAddress(r.id) }, r.number),
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
        rows: view.receipts,
        rowKey: (r) => r.id,
        empty: {
          title: "Nothing received yet",
          body:
            po.status === "issued"
              ? "Record goods received when a delivery arrives."
              : "Goods can be received once the order is issued.",
        },
      })
    );

    return h(
      "div",
      {},
      pageHeader(
        po.number,
        text(po.supplierName),
        h("a", { class: "btn btn-secondary", href: "#/supply/purchase-orders" }, "All orders")
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      po.status === "issued" ? notice("This order is issued; its lines are locked.", "info") : null,
      header,
      lines,
      receipts
    );
  });
  return root;
}
