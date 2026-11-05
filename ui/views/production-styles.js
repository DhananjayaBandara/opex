// The style master: each style's code, name, buyer and SMV, which plans refer to (FR-PROD-001, D34).
// Changing a style's SMV does not rewrite days that already opened; they keep the SMV they copied.
import { h } from "../dom.js";
import { button, card, mount, notice, pageHeader, toast } from "../kit.js";
import { formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { FIELD_ERRORS } from "../crud.js";
import { session } from "../session.js";
import { production } from "./production-common.js";

const ERRORS = { ...FIELD_ERRORS, invalid_smv: "smv", duplicate: "code" };

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    // The style master is shared by every factory, so only people with tenant-wide production
    // rights can change it (D34).
    const mayEdit =
      session.can("production.enter") &&
      !session.supporting &&
      !session.who.assignmentScoped &&
      session.who.factoryScope.all;
    const rows = production((p, ctx) => p.styles(ctx));

    const fields = [
      { name: "code", label: "Style code", required: true, maxlength: 40 },
      { name: "name", label: "Name", required: true },
      { name: "buyer", label: "Buyer" },
      {
        name: "smv",
        label: "SMV (standard minute value)",
        type: "number",
        min: 0,
        step: "any",
        required: true,
        hint: "Minutes to make one piece, above 0",
      },
    ];

    const create = () =>
      formDialog({
        title: "Add a style",
        fields,
        errorFields: ERRORS,
        submitLabel: "Add style",
        onSubmit: (values) => {
          production((p, ctx) => p.createStyle(ctx, values));
          toast("Style added", "good");
          redraw();
        },
      });

    const edit = (row) =>
      formDialog({
        title: `Edit ${row.code}`,
        fields,
        initial: { code: row.code, name: row.name, buyer: row.buyer ?? "", smv: row.smv },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          production((p, ctx) => p.updateStyle(ctx, row.id, values));
          toast("Style saved", "good");
          redraw();
        },
      });

    return h(
      "div",
      {},
      pageHeader(
        "Style master",
        "Styles and their standard minute values.",
        mayEdit ? button("Add a style", create, { kind: "primary" }) : null
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      !mayEdit && !session.supporting
        ? notice("Styles are changed by people with tenant-wide production access.", "info")
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
              render: (r) => r.buyer ?? "—",
            },
            { key: "smv", label: "SMV", sort: (r) => r.smv },
            { key: "plans", label: "Plans", sort: (r) => r.plans },
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
          empty: { title: "No styles yet", body: "Add the first style to plan production." },
        })
      )
    );
  });
  return root;
}
