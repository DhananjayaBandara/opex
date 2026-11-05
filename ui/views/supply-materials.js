// Materials: the fabrics, trims and packing the factories buy and keep (D84). Organization-wide data:
// only someone with the material permission over every factory changes it. A material is deactivated,
// never deleted, and its unit is fixed once it exists because every quantity is counted in it.
import { h } from "../dom.js";
import { formDialog } from "../dialog.js";
import { attempt, button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  COMMON_ERRORS,
  READ_ONLY_NOTE,
  UNIT_LABELS,
  mayChangeShared,
  moneyText,
  quantityText,
  supply,
  text,
} from "./supply-common.js";

const ERRORS = { ...COMMON_ERRORS, invalid_unit: "unit", invalid_field: "reorderLevel" };

const UNIT_OPTIONS = Object.entries(UNIT_LABELS).map(([value, label]) => ({ value, label }));

const fieldsFor = (existing) => [
  { name: "code", label: "Code", required: true, maxlength: 20, hint: "Letters, digits, - and _" },
  { name: "name", label: "Material name", required: true },
  { name: "category", label: "Category", hint: "For example Fabric, Trim or Packing" },
  existing
    ? { name: "unitShown", label: "Unit", readonly: true, hint: "Fixed once the material exists" }
    : { name: "unit", label: "Unit", type: "select", options: UNIT_OPTIONS, required: true },
  { name: "reorderLevel", label: "Reorder level", type: "number", min: 0, step: "any" },
  {
    name: "dailyUse",
    label: "Daily use estimate",
    type: "number",
    min: 0,
    step: "any",
    hint: "Used to estimate how many days the stock covers",
  },
  { name: "standardCost", label: "Standard cost per unit", type: "number", min: 0, step: "0.01" },
  { name: "note", label: "Note", type: "textarea" },
];

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const mayEdit = mayChangeShared("material.manage");
    const rows = supply((p, ctx) => p.materials(ctx));

    const create = () =>
      formDialog({
        title: "Add a material",
        fields: fieldsFor(false),
        initial: { unit: "m" },
        errorFields: ERRORS,
        submitLabel: "Add material",
        onSubmit: (values) => {
          supply((p, ctx) => p.createMaterial(ctx, values));
          toast("Material added", "good");
          redraw();
        },
      });

    const edit = (row) =>
      formDialog({
        title: `Edit ${row.name}`,
        fields: fieldsFor(true),
        initial: {
          code: row.code,
          name: row.name,
          category: row.category ?? "",
          unitShown: UNIT_LABELS[row.unit] ?? row.unit,
          reorderLevel: row.reorderLevel ?? "",
          dailyUse: row.dailyUse ?? "",
          standardCost: row.standardCost ?? "",
          note: row.note ?? "",
        },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: ({ unitShown: _unit, ...values }) => {
          // An emptied estimate or cost is cleared (null), not left unchanged.
          const patch = {
            ...values,
            dailyUse: values.dailyUse ?? null,
            standardCost: values.standardCost ?? null,
          };
          supply((p, ctx) => p.updateMaterial(ctx, row.id, patch));
          toast("Material saved", "good");
          redraw();
        },
      });

    const toggle = (row) => {
      attempt(
        () => supply((p, ctx) => p.setMaterialActive(ctx, row.id, !row.active)),
        row.active ? `${row.name} deactivated` : `${row.name} reactivated`
      );
      redraw();
    };

    return h(
      "div",
      {},
      pageHeader(
        "Materials",
        "What the factories buy and keep in store.",
        mayEdit ? button("Add a material", create, { kind: "primary" }) : null
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      !mayEdit && !session.supporting
        ? notice("Materials are changed by people who manage them in every factory.", "info")
        : null,
      card(
        null,
        dataTable({
          caption: "Materials",
          pageSize: 12,
          columns: [
            { key: "code", label: "Code", sort: (r) => r.code },
            { key: "name", label: "Name", sort: (r) => r.name },
            {
              key: "category",
              label: "Category",
              sort: (r) => r.category ?? "",
              render: (r) => text(r.category),
            },
            { key: "unit", label: "Unit", sort: (r) => r.unit },
            {
              key: "reorder",
              label: "Reorder level",
              sort: (r) => r.reorderLevel ?? 0,
              align: "end",
              render: (r) => quantityText(r.reorderLevel ?? 0),
            },
            {
              key: "daily",
              label: "Daily use",
              sort: (r) => r.dailyUse ?? -1,
              align: "end",
              render: (r) => (r.dailyUse === null ? "—" : quantityText(r.dailyUse)),
            },
            {
              key: "cost",
              label: "Standard cost",
              sort: (r) => r.standardCost ?? -1,
              align: "end",
              render: (r) => moneyText(r.standardCost),
            },
            {
              key: "onHand",
              label: "On hand",
              sort: (r) => r.onHand,
              align: "end",
              render: (r) => `${quantityText(r.onHand)} ${r.unit}`,
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
          searchText: (r) => `${r.code} ${r.name} ${r.category ?? ""}`,
          empty: {
            title: "No materials yet",
            body: mayEdit
              ? "Add the materials the factories buy."
              : "No materials have been added.",
          },
        })
      )
    );
  });
  return root;
}
