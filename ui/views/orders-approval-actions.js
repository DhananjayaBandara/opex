// The dialogs for buyer approvals, shared by the order page and the Buyer approvals page (D78): ask
// the buyer, record the buyer's decision, resubmit after a revision, and read the history. Each one
// calls the orders service, which checks the permission and the order's factory again.
import { FIELD_ERRORS } from "../crud.js";
import { formDialog, infoDialog } from "../dialog.js";
import { formatInstant, statusBadge, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { optionsOf, orders, text } from "./orders-common.js";

const ERRORS = { ...FIELD_ERRORS, duplicate: "typeId", invalid_date: "dueDate" };

// `order` fixes the order (the order page); otherwise `openOrders` is the list to choose from.
export function requestApprovalDialog({ order = null, openOrders = [], redraw }) {
  const types = orders((o, ctx) => o.approvalTypes(ctx)).filter((type) => type.active);
  if (types.length === 0) {
    toast("There is no active approval type", "warn");
    return undefined;
  }
  if (order === null && openOrders.length === 0) {
    toast("There is no open order to ask about", "warn");
    return undefined;
  }
  return formDialog({
    title: "Ask the buyer for an approval",
    fields: [
      ...(order === null
        ? [
            {
              name: "orderId",
              label: "Order",
              type: "select",
              required: true,
              options: optionsOf(
                openOrders.map((row) => ({
                  id: row.id,
                  label: `${row.reference} · ${row.buyerName ?? "no buyer"}`,
                }))
              ),
            },
          ]
        : []),
      {
        name: "typeId",
        label: "Approval",
        type: "select",
        options: optionsOf(types),
        required: true,
      },
      { name: "dueDate", label: "Needed by", type: "date", required: true, min: session.who.today },
      { name: "note", label: "Note", type: "textarea" },
    ],
    initial: { dueDate: session.who.today },
    errorFields: ERRORS,
    submitLabel: "Request",
    onSubmit: (values) => {
      orders((o, ctx) => o.requestApproval(ctx, order?.id ?? values.orderId, values));
      toast("Approval requested", "good");
      redraw();
    },
  });
}

export function decideApprovalDialog(approval, redraw) {
  return formDialog({
    title: `Record the buyer's decision: ${approval.typeName}`,
    description: `${text(approval.orderReference)} · ${text(approval.buyerName)}`,
    fields: [
      {
        name: "decision",
        label: "Decision",
        type: "select",
        required: true,
        options: [
          { value: "approved", label: "Approved" },
          { value: "rejected", label: "Rejected" },
          { value: "revision_requested", label: "Revision requested" },
        ],
      },
      {
        name: "remarks",
        label: "Remarks",
        type: "textarea",
        required: true,
        hint: "What the buyer said, kept with the decision",
      },
    ],
    errorFields: { invalid_decision: "decision", reason_required: "remarks" },
    submitLabel: "Record decision",
    onSubmit: (values) => {
      orders((o, ctx) => o.decideApproval(ctx, approval.id, values));
      toast("Decision recorded", "good");
      redraw();
    },
  });
}

export function resubmitApprovalDialog(approval, redraw) {
  return formDialog({
    title: `Resubmit ${approval.typeName}`,
    description: `${text(approval.orderReference)} · the buyer asked for a revision`,
    fields: [
      { name: "dueDate", label: "Needed by", type: "date", required: true, min: session.who.today },
      { name: "note", label: "What changed", type: "textarea" },
    ],
    initial: { dueDate: session.who.today },
    errorFields: ERRORS,
    submitLabel: "Resubmit",
    onSubmit: (values) => {
      orders((o, ctx) => o.resubmitApproval(ctx, approval.id, values));
      toast("Approval resubmitted", "good");
      redraw();
    },
  });
}

export function approvalHistoryDialog(approval) {
  const entries = orders((o, ctx) => o.approvalHistory(ctx, approval.id));
  return infoDialog({
    title: `${approval.typeName}: history`,
    body: dataTable({
      caption: "Approval history",
      pageSize: 10,
      columns: [
        { key: "n", label: "#", render: (r) => r.sequence },
        { key: "decision", label: "Step", render: (r) => statusBadge(r.decision) },
        { key: "remarks", label: "Remarks", render: (r) => text(r.remarks) },
        { key: "by", label: "By", render: (r) => text(r.by) },
        { key: "at", label: "When", render: (r) => formatInstant(r.at) },
      ],
      rows: entries,
      rowKey: (r) => r.sequence,
    }),
  });
}
