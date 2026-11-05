// Factories: create, edit, deactivate/reactivate, delete when unreferenced, and reorder (FR-ORG-001).
import { h } from "../dom.js";
import { attempt, button, card, mount, pageHeader, statusBadge, toast } from "../kit.js";
import { formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { FIELD_ERRORS, org, rowActions } from "../crud.js";
import { session } from "../session.js";

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const factories = org((o, ctx) => o.list(ctx, "factory", { includeInactive: true }));
    const manage = session.can("factory.manage");
    const fields = [
      {
        name: "code",
        label: "Code",
        required: true,
        hint: "1 to 20 letters, digits, hyphens or underscores; stored in capitals",
      },
      { name: "name", label: "Name", required: true },
      { name: "location", label: "Location" },
    ];
    const edit = (factory) =>
      formDialog({
        title: factory ? `Edit ${factory.name}` : "New factory",
        fields,
        initial: factory ?? {},
        errorFields: FIELD_ERRORS,
        onSubmit: (values) => {
          if (factory) org((o, ctx) => o.update(ctx, "factory", factory.id, values));
          else org((o, ctx) => o.create(ctx, "factory", values));
          toast(factory ? "Factory saved" : "Factory created", "good");
          redraw();
        },
      });
    const move = (index, step) => {
      const ids = factories.map((factory) => factory.id);
      [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
      attempt(() => org((o, ctx) => o.reorder(ctx, "factory", ids)));
      redraw();
    };
    const position = (row) => factories.findIndex((factory) => factory.id === row.id);

    return h(
      "div",
      {},
      pageHeader(
        "Factories",
        "The sites of the organization, in display order.",
        manage ? button("New factory", () => edit(null), { kind: "primary" }) : null
      ),
      card(
        null,
        dataTable({
          caption: "Factories",
          columns: [
            { key: "code", label: "Code" },
            { key: "name", label: "Name" },
            { key: "location", label: "Location", render: (r) => r.location ?? "—" },
            {
              key: "active",
              label: "Status",
              render: (r) => statusBadge(r.active ? "active" : "inactive"),
            },
            ...(manage
              ? [
                  {
                    key: "actions",
                    label: "",
                    align: "end",
                    render: (r) =>
                      h(
                        "div",
                        { class: "actions end" },
                        button("↑", () => move(position(r), -1), {
                          kind: "link",
                          title: "Move up",
                          disabled: position(r) === 0,
                        }),
                        button("↓", () => move(position(r), 1), {
                          kind: "link",
                          title: "Move down",
                          disabled: position(r) === factories.length - 1,
                        }),
                        button("Edit", () => edit(r), { kind: "link" }),
                        rowActions({ kind: "factory", row: r, noun: "factory", redraw })
                      ),
                  },
                ]
              : []),
          ],
          rows: factories,
          rowClass: (r) => (r.active ? null : "is-inactive"),
          searchText: (r) => `${r.code} ${r.name} ${r.location ?? ""}`,
          empty: {
            title: "No factories yet",
            body: manage
              ? "Create the first factory to start building the organization."
              : "Nothing has been set up yet.",
          },
        })
      )
    );
  });
  return root;
}
