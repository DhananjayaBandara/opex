// Styles and SMV from the orders side (D73): the same style master Production uses, with the buyer
// each style belongs to. A style linked to a buyer can be used only on that buyer's orders, and
// Production no longer changes its buyer text.
import { h } from "../dom.js";
import { FIELD_ERRORS } from "../crud.js";
import { formDialog } from "../dialog.js";
import { button, card, mount, notice, pageHeader, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { mayChangeShared, optionsOf, orders } from "./orders-common.js";

const ERRORS = {
  ...FIELD_ERRORS,
  invalid_smv: "smv",
  duplicate: "code",
  inactive_parent: "buyerId",
  buyer_in_use: "buyerId",
  not_found: "buyerId",
};

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const mayEdit = mayChangeShared("order.manage");
    const rows = orders((o, ctx) => o.styles(ctx));
    const buyers = orders((o, ctx) => o.buyers(ctx)).filter((buyer) => buyer.active);

    const fields = (row) => [
      { name: "code", label: "Style code", required: true, maxlength: 20 },
      { name: "name", label: "Name", required: true },
      {
        name: "buyerId",
        label: "Buyer",
        type: "select",
        options: optionsOf(
          [
            ...buyers,
            // A buyer that has since been deactivated stays selectable on the styles that already use it.
            ...(row?.buyerId && !buyers.some((buyer) => buyer.id === row.buyerId)
              ? [{ id: row.buyerId, name: row.buyer }]
              : []),
          ],
          { empty: "No buyer yet" }
        ),
        hint: "A style with a buyer can be used only on that buyer's orders",
      },
      {
        name: "smv",
        label: "SMV (standard minute value)",
        type: "number",
        min: 0,
        step: "any",
        required: true,
        hint: "Minutes to make one piece, above 0 and at most 500",
      },
    ];

    const create = () =>
      formDialog({
        title: "Add a style",
        fields: fields(null),
        errorFields: ERRORS,
        submitLabel: "Add style",
        onSubmit: (values) => {
          orders((o, ctx) => o.createStyle(ctx, values));
          toast("Style added", "good");
          redraw();
        },
      });

    const edit = (row) =>
      formDialog({
        title: `Edit ${row.code}`,
        fields: fields(row),
        initial: {
          code: row.code,
          name: row.name,
          buyerId: row.buyerId ?? "",
          smv: row.smv,
        },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.updateStyle(ctx, row.id, values));
          toast("Style saved", "good");
          redraw();
        },
      });

    return h(
      "div",
      {},
      pageHeader(
        "Styles & SMV",
        "Styles, the buyer each belongs to, and the standard minutes per piece.",
        mayEdit ? button("Add a style", create, { kind: "primary" }) : null
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      !mayEdit && !session.supporting
        ? notice("Styles are changed by people who manage orders in every factory.", "info")
        : null,
      card(
        null,
        dataTable({
          caption: "Styles",
          pageSize: 12,
          columns: [
            { key: "code", label: "Code", sort: (r) => r.code },
            { key: "name", label: "Name", sort: (r) => r.name },
            {
              key: "buyer",
              label: "Buyer",
              sort: (r) => r.buyer ?? "",
              render: (r) =>
                r.buyerId
                  ? r.buyer
                  : r.buyer
                    ? h(
                        "span",
                        {},
                        r.buyer,
                        " ",
                        h("small", { class: "muted" }, "(text, not linked)")
                      )
                    : "—",
            },
            { key: "smv", label: "SMV", sort: (r) => r.smv, align: "end" },
            { key: "plans", label: "Plans", sort: (r) => r.plans, align: "end" },
            { key: "lines", label: "Order lines", sort: (r) => r.lines, align: "end" },
            {
              key: "actions",
              label: "",
              align: "end",
              render: (r) =>
                mayEdit
                  ? h(
                      "div",
                      { class: "actions end" },
                      button("Edit", () => edit(r), { kind: "link" })
                    )
                  : null,
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.code} ${r.name} ${r.buyer ?? ""}`,
          empty: { title: "No styles yet", body: "Add the first style to take orders." },
        })
      ),
      h(
        "p",
        { class: "muted" },
        "Production uses the same style list under Production › Style master."
      )
    );
  });
  return root;
}
