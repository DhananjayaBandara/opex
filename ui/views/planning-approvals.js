// Buyer approvals: every request across the orders a person can see, with the buyer's decision and
// its history, and the approval types an order can ask for (D78). A decision is entered by someone
// allowed to record it, is never edited, and a rejection or a revision request keeps its history.
import { h } from "../dom.js";
import { FIELD_ERRORS } from "../crud.js";
import { confirmDialog, formDialog } from "../dialog.js";
import {
  attempt,
  badge,
  button,
  card,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { fullDate } from "../charts.js";
import {
  approvalHistoryDialog,
  decideApprovalDialog,
  requestApprovalDialog,
  resubmitApprovalDialog,
} from "./orders-approval-actions.js";
import { mayChangeShared, mayWrite, orderAddress, orders, text } from "./orders-common.js";

const TYPE_ERRORS = {
  ...FIELD_ERRORS,
  invalid_code: "code",
  duplicate: "code",
  invalid_name: "name",
};

const STATUSES = [
  { value: "", label: "Any status" },
  { value: "pending", label: "Pending" },
  { value: "revision_requested", label: "Revision requested" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export function render() {
  const root = h("div");
  const filter = { status: "", factoryId: "" };
  mount(root, (redraw) => {
    const mayEditTypes = mayChangeShared("planning.manage");
    const mayRequest = mayWrite("planning.manage");
    const mayDecide = mayWrite("approval.decide");
    const factories = orders((o, ctx) => o.factories(ctx));
    const types = orders((o, ctx) => o.approvalTypes(ctx));
    const query = Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== ""));
    const rows = orders((o, ctx) => o.approvals(ctx, query));

    const select = (label, id, name, options) => {
      const control = h(
        "select",
        {
          id,
          onchange: () => {
            filter[name] = control.value;
            redraw();
          },
        },
        options.map((option) =>
          h(
            "option",
            { value: option.value, selected: option.value === filter[name] },
            option.label
          )
        )
      );
      return h("span", {}, h("label", { for: id }, label), " ", control);
    };

    const request = () => {
      const open = orders((o, ctx) => o.orders(ctx)).filter(
        (row) => row.status !== "closed" && row.status !== "cancelled" && row.status !== "shipped"
      );
      return requestApprovalDialog({ openOrders: open, redraw });
    };

    // ---- Approval types -----------------------------------------------------------------------

    const typeFields = [
      {
        name: "code",
        label: "Code",
        required: true,
        maxlength: 20,
        hint: "Letters, digits, - and _",
      },
      { name: "name", label: "Approval", required: true },
      { name: "description", label: "Description", type: "textarea" },
      { name: "blocking", label: "Blocks production until approved", type: "checkbox" },
    ];

    const createType = () =>
      formDialog({
        title: "Add an approval type",
        fields: typeFields,
        initial: { blocking: false },
        errorFields: TYPE_ERRORS,
        submitLabel: "Add type",
        onSubmit: (values) => {
          orders((o, ctx) => o.createApprovalType(ctx, values));
          toast("Approval type added", "good");
          redraw();
        },
      });

    const editType = (row) =>
      formDialog({
        title: `Edit ${row.name}`,
        fields: typeFields,
        initial: {
          code: row.code,
          name: row.name,
          description: row.description ?? "",
          blocking: row.blocking === true,
        },
        errorFields: TYPE_ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.updateApprovalType(ctx, row.id, values));
          toast("Approval type saved", "good");
          redraw();
        },
      });

    const toggleType = (row) => {
      attempt(
        () => orders((o, ctx) => o.setApprovalTypeActive(ctx, row.id, !row.active)),
        row.active ? `${row.name} deactivated` : `${row.name} reactivated`
      );
      redraw();
    };

    const removeType = (row) =>
      confirmDialog({
        title: `Delete ${row.name}?`,
        message:
          "An approval type that orders have asked for cannot be deleted; deactivate it instead.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          orders((o, ctx) => o.removeApprovalType(ctx, row.id));
          toast("Approval type deleted", "good");
          redraw();
        },
      });

    // ---- Screen -------------------------------------------------------------------------------

    return h(
      "div",
      {},
      pageHeader(
        "Buyer approvals",
        "What each buyer has been asked to approve, and what they decided.",
        mayRequest ? button("Request an approval", request, { kind: "primary" }) : null
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      card(
        "Approvals",
        h(
          "div",
          {},
          h(
            "div",
            { class: "tools" },
            select("Status", "appr-status", "status", STATUSES),
            select("Factory", "appr-factory", "factoryId", [
              { value: "", label: "All factories" },
              ...factories.map((row) => ({ value: row.id, label: row.name })),
            ])
          ),
          dataTable({
            caption: "Buyer approvals",
            pageSize: 12,
            columns: [
              {
                key: "order",
                label: "Order",
                sort: (r) => r.orderReference ?? "",
                render: (r) => h("a", { href: orderAddress(r.orderId) }, text(r.orderReference)),
              },
              {
                key: "buyer",
                label: "Buyer",
                sort: (r) => r.buyerName ?? "",
                render: (r) => text(r.buyerName),
              },
              {
                key: "type",
                label: "Approval",
                sort: (r) => r.typeName,
                render: (r) =>
                  h("span", {}, r.typeName, " ", r.blocking ? badge("blocking", "warn") : null),
              },
              {
                key: "due",
                label: "Needed by",
                sort: (r) => r.dueDate,
                render: (r) =>
                  h(
                    "span",
                    {},
                    fullDate(r.dueDate),
                    r.overdue ? [" ", badge("overdue", "bad")] : null
                  ),
              },
              {
                key: "status",
                label: "Status",
                sort: (r) => r.status,
                render: (r) => statusBadge(r.status),
              },
              { key: "by", label: "Requested by", render: (r) => text(r.requestedBy) },
              {
                key: "actions",
                label: "",
                align: "end",
                render: (r) => {
                  const live = r.orderStatus !== "closed" && r.orderStatus !== "cancelled";
                  return h(
                    "div",
                    { class: "actions end" },
                    button("History", () => approvalHistoryDialog(r), { kind: "link" }),
                    mayDecide && live && r.status === "pending"
                      ? button("Decide", () => decideApprovalDialog(r, redraw), { kind: "link" })
                      : null,
                    mayRequest && live && r.status === "revision_requested"
                      ? button("Resubmit", () => resubmitApprovalDialog(r, redraw), {
                          kind: "link",
                        })
                      : null
                  );
                },
              },
            ],
            rows,
            rowKey: (r) => r.id,
            searchText: (r) => `${r.orderReference ?? ""} ${r.buyerName ?? ""} ${r.typeName}`,
            empty: { title: "No approvals", body: "Nothing has been requested from a buyer yet." },
          })
        )
      ),
      card(
        "Approval types",
        h(
          "div",
          {},
          !mayEditTypes && !session.supporting
            ? notice(
                "Approval types are changed by people who manage planning in every factory.",
                "info"
              )
            : null,
          dataTable({
            caption: "Approval types",
            pageSize: 8,
            columns: [
              { key: "code", label: "Code", sort: (r) => r.code },
              { key: "name", label: "Approval", sort: (r) => r.name },
              { key: "description", label: "Description", render: (r) => text(r.description) },
              {
                key: "blocking",
                label: "Blocks production",
                sort: (r) => (r.blocking ? 0 : 1),
                render: (r) => (r.blocking ? badge("blocking", "warn") : "—"),
              },
              { key: "requests", label: "Requests", sort: (r) => r.requests, align: "end" },
              {
                key: "active",
                label: "Status",
                sort: (r) => (r.active ? 0 : 1),
                render: (r) => statusBadge(r.active ? "active" : "inactive"),
              },
              {
                key: "actions",
                label: "",
                align: "end",
                render: (r) =>
                  mayEditTypes
                    ? h(
                        "div",
                        { class: "actions end" },
                        button("Edit", () => editType(r), { kind: "link" }),
                        button(r.active ? "Deactivate" : "Reactivate", () => toggleType(r), {
                          kind: "link",
                        }),
                        button("Delete", () => removeType(r), { kind: "link" })
                      )
                    : null,
              },
            ],
            rows: types,
            rowKey: (r) => r.id,
            empty: {
              title: "No approval types",
              body: "Add the approvals buyers give, such as samples or fabric.",
            },
          })
        ),
        mayEditTypes ? button("Add an approval type", createType) : null
      )
    );
  });
  return root;
}
