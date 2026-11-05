// One material requisition (D91). The service says what the caller may do and what the status allows
// (`editable`, `canSubmit`, `canApprove`, `canReject`, `canIssue`, `canCancel`); the page draws only
// those, and every call checks again. Lines short of stock are marked in words, and issuing is refused
// when the store cannot cover a line.
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
  inventory,
  row,
  supply,
  text,
  withUnit,
} from "./supply-common.js";

const ERRORS = {
  ...COMMON_ERRORS,
  invalid_date: "neededBy",
  duplicate_line: "materialId",
  inactive_parent: "materialId",
  not_found: "materialId",
};

const link = (label, onClick) => button(label, onClick, { kind: "link" });

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const id = addressId();
    if (!id) {
      return emptyState({
        title: "No requisition chosen",
        body: "Open a requisition from the list.",
        action: h("a", { class: "btn btn-primary", href: "#/supply/requisitions" }, "Requisitions"),
      });
    }
    const view = inventory((i, ctx) => i.requisition(ctx, id));
    const { requisition } = view;
    const live = !session.supporting;
    const run = (call, success) => {
      attempt(() => inventory(call), success);
      redraw();
    };

    const edit = () =>
      formDialog({
        title: `Edit ${requisition.number}`,
        fields: [
          { name: "neededBy", label: "Needed by", type: "date" },
          { name: "note", label: "Note", type: "textarea" },
        ],
        initial: { neededBy: requisition.neededBy ?? "", note: requisition.note ?? "" },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          inventory((i, ctx) =>
            i.updateRequisition(ctx, requisition.id, {
              neededBy: values.neededBy || null,
              note: values.note || null,
            })
          );
          toast("Requisition saved", "good");
          redraw();
        },
      });

    const reject = () =>
      confirmDialog({
        title: `Reject ${requisition.number}?`,
        message: "The person who raised it sees the reason.",
        confirmLabel: "Reject",
        danger: true,
        reason: true,
        reasonLabel: "Reason for rejecting",
        onConfirm: (reason) => {
          inventory((i, ctx) => i.rejectRequisition(ctx, requisition.id, { reason }));
          toast("Requisition rejected", "good");
          redraw();
        },
      });

    const cancel = () =>
      confirmDialog({
        title: `Cancel ${requisition.number}?`,
        message: "Nothing is taken from the store.",
        confirmLabel: "Cancel requisition",
        danger: true,
        reason: true,
        reasonLabel: "Reason for cancelling",
        onConfirm: (reason) => {
          inventory((i, ctx) => i.cancelRequisition(ctx, requisition.id, { reason }));
          toast("Requisition cancelled", "good");
          redraw();
        },
      });

    const issue = () =>
      confirmDialog({
        title: `Issue ${requisition.number}?`,
        message: view.anyShort
          ? "The store does not cover every line; issuing is refused until it does."
          : "One Issue movement per line takes the materials out of the store.",
        confirmLabel: "Issue materials",
        onConfirm: () => {
          inventory((i, ctx) => i.issueRequisition(ctx, requisition.id));
          toast("Materials issued", "good");
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
            ["Status", statusBadge(requisition.status)],
            ["Factory", text(requisition.factoryName)],
            ["Needed by", dateText(requisition.neededBy)],
            ["Raised by", text(requisition.requestedBy)],
            ["Submitted", dateText(requisition.submittedAt?.slice(0, 10))],
            ["Decided by", text(requisition.decidedBy)],
            ["Issued by", text(requisition.issuedBy)],
          ].flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])
        ),
        requisition.note ? h("p", {}, requisition.note) : null,
        requisition.decisionReason
          ? notice(`Rejected: ${requisition.decisionReason}`, "warn")
          : null,
        requisition.cancelReason ? notice(`Cancelled: ${requisition.cancelReason}`, "warn") : null,
        view.anyShort && ["draft", "submitted", "approved"].includes(requisition.status)
          ? notice("Some lines are short of stock in this factory's store.", "warn")
          : null,
        live
          ? row(
              view.editable ? button("Edit", edit) : null,
              view.canSubmit
                ? button(
                    "Submit for approval",
                    () =>
                      run(
                        (i, ctx) => i.submitRequisition(ctx, requisition.id),
                        "Requisition submitted"
                      ),
                    { kind: "primary" }
                  )
                : null,
              view.canApprove
                ? button(
                    "Approve",
                    () =>
                      run(
                        (i, ctx) => i.approveRequisition(ctx, requisition.id),
                        "Requisition approved"
                      ),
                    { kind: "primary" }
                  )
                : null,
              view.canReject ? button("Reject", reject, { kind: "danger" }) : null,
              view.canIssue ? button("Issue materials", issue, { kind: "primary" }) : null,
              view.canCancel ? button("Cancel", cancel, { kind: "danger" }) : null
            )
          : null
      )
    );

    const addLine = () => {
      const taken = new Set(view.lines.map((line) => line.materialId));
      const choices = supply((p, ctx) => p.materials(ctx)).filter(
        (material) => material.active && !taken.has(material.id)
      );
      if (choices.length === 0) {
        toast("Every active material is already on this requisition", "warn");
        return undefined;
      }
      return formDialog({
        title: "Add a line",
        fields: [
          {
            name: "materialId",
            label: "Material",
            type: "select",
            options: choices.map((material) => ({
              value: material.id,
              label: `${material.code} · ${material.name} (${material.unit})`,
            })),
            required: true,
          },
          {
            name: "quantity",
            label: "Quantity",
            type: "number",
            min: 0,
            step: "any",
            required: true,
          },
        ],
        errorFields: ERRORS,
        submitLabel: "Add line",
        onSubmit: (values) => {
          inventory((i, ctx) => i.addRequisitionLine(ctx, requisition.id, values));
          toast("Line added", "good");
          redraw();
        },
      });
    };

    const editLine = (line) =>
      formDialog({
        title: `Edit ${line.materialCode}`,
        fields: [
          {
            name: "quantity",
            label: `Quantity (${line.unit})`,
            type: "number",
            min: 0,
            step: "any",
            required: true,
          },
        ],
        initial: { quantity: line.quantity },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          inventory((i, ctx) => i.updateRequisitionLine(ctx, line.id, values));
          toast("Line saved", "good");
          redraw();
        },
      });

    const editable = live && view.editable;
    const lines = card(
      "Lines",
      dataTable({
        caption: "Requisition lines",
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
            label: "Requested",
            sort: (r) => r.quantity,
            align: "end",
            render: (r) => withUnit(r.quantity, r.unit),
          },
          {
            key: "onHand",
            label: "In store now",
            sort: (r) => r.onHand,
            align: "end",
            render: (r) => withUnit(r.onHand, r.unit),
          },
          {
            key: "short",
            label: "Stock",
            sort: (r) => (r.short ? 1 : 0),
            render: (r) => (r.short ? badge("Short of stock", "bad") : badge("Covered", "good")),
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
                      run((i, ctx) => i.removeRequisitionLine(ctx, r.id), "Line removed")
                    )
                  )
                : null,
          },
        ],
        rows: view.lines,
        rowKey: (r) => r.id,
        empty: {
          title: "No lines yet",
          body: editable ? "Add the materials needed." : "This requisition has no lines.",
        },
      }),
      editable ? button("Add a line", addLine) : null
    );

    return h(
      "div",
      {},
      pageHeader(
        requisition.number,
        text(requisition.factoryName),
        h("a", { class: "btn btn-secondary", href: "#/supply/requisitions" }, "All requisitions")
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      header,
      lines
    );
  });
  return root;
}
