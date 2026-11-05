// Buyers: the customers whose orders the factories make (D72, D73). Organization-wide data: only
// someone with order management over every factory changes it. A buyer that styles or orders use is
// deactivated, never deleted.
import { h } from "../dom.js";
import { FIELD_ERRORS } from "../crud.js";
import { confirmDialog, formDialog } from "../dialog.js";
import { attempt, button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { mayChangeShared, orders, text } from "./orders-common.js";

const ERRORS = { ...FIELD_ERRORS, invalid_email: "contactEmail", duplicate: "code" };

const FIELDS = [
  { name: "code", label: "Code", required: true, maxlength: 20, hint: "Letters, digits, - and _" },
  { name: "name", label: "Buyer name", required: true },
  { name: "country", label: "Country" },
  { name: "contactName", label: "Contact person" },
  { name: "contactEmail", label: "Contact email", type: "email" },
];

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const mayEdit = mayChangeShared("order.manage");
    const rows = orders((o, ctx) => o.buyers(ctx));

    const create = () =>
      formDialog({
        title: "Add a buyer",
        fields: FIELDS,
        errorFields: ERRORS,
        submitLabel: "Add buyer",
        onSubmit: (values) => {
          orders((o, ctx) => o.createBuyer(ctx, values));
          toast("Buyer added", "good");
          redraw();
        },
      });

    const edit = (row) =>
      formDialog({
        title: `Edit ${row.name}`,
        fields: FIELDS,
        initial: {
          code: row.code,
          name: row.name,
          country: row.country ?? "",
          contactName: row.contactName ?? "",
          contactEmail: row.contactEmail ?? "",
        },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.updateBuyer(ctx, row.id, values));
          toast("Buyer saved", "good");
          redraw();
        },
      });

    const toggle = (row) => {
      attempt(
        () => orders((o, ctx) => o.setBuyerActive(ctx, row.id, !row.active)),
        row.active ? `${row.name} deactivated` : `${row.name} reactivated`
      );
      redraw();
    };

    const remove = (row) =>
      confirmDialog({
        title: `Delete ${row.name}?`,
        message: "A buyer that styles or orders use cannot be deleted; deactivate it instead.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          orders((o, ctx) => o.removeBuyer(ctx, row.id));
          toast("Buyer deleted", "good");
          redraw();
        },
      });

    return h(
      "div",
      {},
      pageHeader(
        "Buyers",
        "The customers whose orders are made.",
        mayEdit ? button("Add a buyer", create, { kind: "primary" }) : null
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      !mayEdit && !session.supporting
        ? notice("Buyers are changed by people who manage orders in every factory.", "info")
        : null,
      card(
        null,
        dataTable({
          caption: "Buyers",
          pageSize: 12,
          columns: [
            { key: "code", label: "Code", sort: (r) => r.code },
            { key: "name", label: "Name", sort: (r) => r.name },
            {
              key: "country",
              label: "Country",
              sort: (r) => r.country ?? "",
              render: (r) => text(r.country),
            },
            {
              key: "contact",
              label: "Contact",
              render: (r) => text([r.contactName, r.contactEmail].filter(Boolean).join(" · ")),
            },
            { key: "styles", label: "Styles", sort: (r) => r.styles, align: "end" },
            { key: "orders", label: "Orders", sort: (r) => r.orders, align: "end" },
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
                mayEdit
                  ? h(
                      "div",
                      { class: "actions end" },
                      button("Edit", () => edit(r), { kind: "link" }),
                      button(r.active ? "Deactivate" : "Reactivate", () => toggle(r), {
                        kind: "link",
                      }),
                      button("Delete", () => remove(r), { kind: "link" })
                    )
                  : null,
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.code} ${r.name} ${r.country ?? ""} ${r.contactName ?? ""}`,
          empty: { title: "No buyers yet", body: "Add a buyer before creating an order." },
        })
      )
    );
  });
  return root;
}
