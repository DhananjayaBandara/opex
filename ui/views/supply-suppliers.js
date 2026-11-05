// Suppliers: who the factories buy from (D84). Organization-wide data; a supplier is deactivated,
// never deleted, so past quotations, orders and invoices keep their name.
import { h } from "../dom.js";
import { formDialog } from "../dialog.js";
import { attempt, button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { COMMON_ERRORS, READ_ONLY_NOTE, mayChangeShared, supply, text } from "./supply-common.js";

const FIELDS = [
  { name: "code", label: "Code", required: true, maxlength: 20, hint: "Letters, digits, - and _" },
  { name: "name", label: "Supplier name", required: true },
  { name: "contactName", label: "Contact person" },
  { name: "email", label: "Email", type: "email" },
  { name: "phone", label: "Phone", hint: "Digits, spaces and + ( ) -" },
  { name: "paymentTerms", label: "Payment terms", hint: "For example Net 30" },
];

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const mayEdit = mayChangeShared("material.manage");
    const rows = supply((p, ctx) => p.suppliers(ctx));

    const create = () =>
      formDialog({
        title: "Add a supplier",
        fields: FIELDS,
        errorFields: COMMON_ERRORS,
        submitLabel: "Add supplier",
        onSubmit: (values) => {
          supply((p, ctx) => p.createSupplier(ctx, values));
          toast("Supplier added", "good");
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
          contactName: row.contactName ?? "",
          email: row.email ?? "",
          phone: row.phone ?? "",
          paymentTerms: row.paymentTerms ?? "",
        },
        errorFields: COMMON_ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          supply((p, ctx) => p.updateSupplier(ctx, row.id, values));
          toast("Supplier saved", "good");
          redraw();
        },
      });

    const toggle = (row) => {
      attempt(
        () => supply((p, ctx) => p.setSupplierActive(ctx, row.id, !row.active)),
        row.active ? `${row.name} deactivated` : `${row.name} reactivated`
      );
      redraw();
    };

    return h(
      "div",
      {},
      pageHeader(
        "Suppliers",
        "The companies materials are bought from.",
        mayEdit ? button("Add a supplier", create, { kind: "primary" }) : null
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      !mayEdit && !session.supporting
        ? notice("Suppliers are changed by people who manage materials in every factory.", "info")
        : null,
      card(
        null,
        dataTable({
          caption: "Suppliers",
          pageSize: 12,
          columns: [
            { key: "code", label: "Code", sort: (r) => r.code },
            { key: "name", label: "Name", sort: (r) => r.name },
            {
              key: "contact",
              label: "Contact",
              render: (r) => text([r.contactName, r.email, r.phone].filter(Boolean).join(" · ")),
            },
            {
              key: "terms",
              label: "Payment terms",
              sort: (r) => r.paymentTerms ?? "",
              render: (r) => text(r.paymentTerms),
            },
            {
              key: "purchaseOrders",
              label: "Purchase orders",
              sort: (r) => r.purchaseOrders,
              align: "end",
            },
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
                      })
                    )
                  : null,
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.code} ${r.name} ${r.contactName ?? ""} ${r.email ?? ""}`,
          empty: {
            title: "No suppliers yet",
            body: mayEdit ? "Add the first supplier." : "No suppliers have been added.",
          },
        })
      )
    );
  });
  return root;
}
