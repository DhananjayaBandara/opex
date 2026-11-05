// One goods receipt (D88): a draft is recorded, received (inspection done) and then posted, which adds
// one Receipt movement per accepted line to the store. A posted receipt is never edited or deleted;
// it is reversed with a reason, which adds the opposite movements and keeps both entries (C12).
import { h } from "../dom.js";
import { confirmDialog } from "../dialog.js";
import {
  attempt,
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
  MOVEMENT_LABELS,
  READ_ONLY_NOTE,
  addressId,
  dateText,
  poAddress,
  row,
  supply,
  text,
  withUnit,
} from "./supply-common.js";
import { receiptDialog } from "./supply-receipt-form.js";

const NEXT_STEP = {
  draft: "A draft receipt can still be changed. Receive it once the goods are checked.",
  received: "Received and checked. Post it to put the accepted goods into the store.",
  posted: "Posted: the accepted goods are in the store. It can only be reversed, with a reason.",
  reversed: "Reversed: the opposite stock entries were added and both are kept.",
  cancelled: "Cancelled: nothing reached the store.",
};

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const id = addressId();
    if (!id) {
      return emptyState({
        title: "No goods receipt chosen",
        body: "Open a goods receipt from the list.",
        action: h("a", { class: "btn btn-primary", href: "#/supply/receipts" }, "Goods receipts"),
      });
    }
    const view = supply((p, ctx) => p.receipt(ctx, id));
    const { receipt } = view;
    const mayPost = view.may.post && !session.supporting;
    const run = (call, success) => {
      attempt(() => supply(call), success);
      redraw();
    };

    const edit = () => {
      const po = supply((p, ctx) => p.purchaseOrder(ctx, receipt.poId));
      return receiptDialog({
        po,
        receipt: view,
        onSaved: () => {
          toast("Receipt saved", "good");
          redraw();
        },
      });
    };

    const reverse = () =>
      confirmDialog({
        title: `Reverse ${receipt.number}?`,
        message:
          "The accepted goods are taken out of the store again by opposite entries. It is refused when the goods are no longer on hand.",
        confirmLabel: "Reverse receipt",
        danger: true,
        reason: true,
        reasonLabel: "Reason for reversing",
        onConfirm: (reason) => {
          supply((p, ctx) => p.reverseReceipt(ctx, receipt.id, { reason }));
          toast("Receipt reversed", "good");
          redraw();
        },
      });

    const cancel = () =>
      confirmDialog({
        title: `Cancel ${receipt.number}?`,
        message: "Nothing is added to the store. A cancelled receipt cannot be changed.",
        confirmLabel: "Cancel receipt",
        danger: true,
        reason: true,
        reasonLabel: "Reason for cancelling",
        onConfirm: (reason) => {
          supply((p, ctx) => p.cancelReceipt(ctx, receipt.id, { reason }));
          toast("Receipt cancelled", "good");
          redraw();
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
            ["Status", statusBadge(receipt.status)],
            ["Purchase order", h("a", { href: poAddress(receipt.poId) }, receipt.poNumber)],
            ["Supplier", text(receipt.supplierName)],
            ["Factory", text(receipt.factoryName)],
            ["Received on", dateText(receipt.receiptDate)],
            ["Delivery challan", text(receipt.challan)],
          ].flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])
        ),
        receipt.note ? h("p", {}, receipt.note) : null,
        receipt.cancelReason ? notice(`Cancelled: ${receipt.cancelReason}`, "warn") : null,
        receipt.reverseReason ? notice(`Reversed: ${receipt.reverseReason}`, "warn") : null,
        view.poStatus && view.poStatus !== "issued" && receipt.status === "draft"
          ? notice(`The purchase order is ${view.poStatus}; this draft cannot be received.`, "warn")
          : null,
        mayPost
          ? row(
              view.editable ? button("Edit", edit) : null,
              view.canReceive
                ? button(
                    "Mark as received",
                    () =>
                      run(
                        (p, ctx) => p.receiveReceipt(ctx, receipt.id),
                        "Receipt marked as received"
                      ),
                    { kind: "primary" }
                  )
                : null,
              view.canPost
                ? button(
                    "Post to store",
                    () => run((p, ctx) => p.postReceipt(ctx, receipt.id), "Receipt posted"),
                    { kind: "primary" }
                  )
                : null,
              view.canReverse ? button("Reverse", reverse, { kind: "danger" }) : null,
              view.canCancel ? button("Cancel receipt", cancel, { kind: "danger" }) : null
            )
          : null
      )
    );

    const lines = card(
      "Lines",
      dataTable({
        caption: "Receipt lines",
        pageSize: 10,
        columns: [
          {
            key: "material",
            label: "Material",
            sort: (r) => r.materialCode,
            render: (r) => `${r.materialCode} · ${r.materialName}`,
          },
          {
            key: "ordered",
            label: "Ordered",
            sort: (r) => r.ordered ?? 0,
            align: "end",
            render: (r) => (r.ordered === null ? "—" : withUnit(r.ordered, r.unit)),
          },
          {
            key: "before",
            label: "Accepted earlier",
            sort: (r) => r.postedBefore,
            align: "end",
            render: (r) => withUnit(r.postedBefore, r.unit),
          },
          {
            key: "received",
            label: "Received",
            sort: (r) => r.received,
            align: "end",
            render: (r) => withUnit(r.received, r.unit),
          },
          {
            key: "accepted",
            label: "Accepted",
            sort: (r) => r.accepted,
            align: "end",
            render: (r) => withUnit(r.accepted, r.unit),
          },
          {
            key: "rejected",
            label: "Rejected",
            sort: (r) => r.rejected,
            align: "end",
            render: (r) => withUnit(r.rejected, r.unit),
          },
          { key: "reason", label: "Rejection reason", render: (r) => text(r.rejectionReason) },
        ],
        rows: view.lines,
        rowKey: (r) => r.id,
        empty: { title: "No lines", body: "This receipt has no lines." },
      })
    );

    const movements = card(
      "Stock movements",
      view.movements.length === 0
        ? h("p", { class: "muted" }, "Nothing has been added to the store by this receipt.")
        : dataTable({
            caption: "Stock movements made by this receipt",
            pageSize: 10,
            columns: [
              {
                key: "type",
                label: "Movement",
                sort: (r) => r.type,
                render: (r) => MOVEMENT_LABELS[r.type] ?? r.type,
              },
              { key: "material", label: "Material", render: (r) => text(r.materialName) },
              {
                key: "direction",
                label: "Direction",
                render: (r) => (r.direction === "in" ? "Into the store" : "Out of the store"),
              },
              {
                key: "quantity",
                label: "Quantity",
                sort: (r) => r.quantity,
                align: "end",
              },
              {
                key: "date",
                label: "Date",
                sort: (r) => r.date,
                render: (r) => dateText(r.date),
              },
            ],
            rows: view.movements,
            rowKey: (r) => r.id,
          })
    );

    return h(
      "div",
      {},
      pageHeader(
        receipt.number,
        text(receipt.supplierName),
        h("a", { class: "btn btn-secondary", href: "#/supply/receipts" }, "All receipts")
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      notice(NEXT_STEP[receipt.status] ?? "", "info"),
      header,
      lines,
      movements
    );
  });
  return root;
}
