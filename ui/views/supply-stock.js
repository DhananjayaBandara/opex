// Store and stock (D89, D90): the balance of each material at each factory, worked out from its stock
// movements and never typed in (C12). The indicator is always a word. A person with the stock
// permission records an opening balance, an issue, a return or an adjustment; a receipt and a
// reversal come only from goods receipts.
import { h } from "../dom.js";
import { formDialog } from "../dialog.js";
import { badge, button, card, mount, notice, pageHeader, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  COMMON_ERRORS,
  MOVEMENT_LABELS,
  READ_ONLY_NOTE,
  dateText,
  filterSelect,
  inventory,
  mayWrite,
  quantityText,
  queryOf,
  supply,
  text,
  withUnit,
} from "./supply-common.js";

export const INDICATOR_TEXT = {
  out_of_stock: "Out of stock",
  below_reorder: "Below reorder level",
  no_estimate: "No estimate for cover",
  ok: "OK",
};
const INDICATOR_TONE = {
  out_of_stock: "bad",
  below_reorder: "warn",
  no_estimate: "neutral",
  ok: "good",
};

export const indicatorBadge = (indicator) =>
  badge(INDICATOR_TEXT[indicator] ?? indicator, INDICATOR_TONE[indicator] ?? "neutral");

const MANUAL_TYPES = ["opening", "issue", "return", "adjustment_in", "adjustment_out"];

const ERRORS = {
  ...COMMON_ERRORS,
  invalid_number: "quantity",
  invalid_field: "quantity",
  invalid_date: "date",
  insufficient_stock: "quantity",
  inactive_parent: "materialId",
};

// The "record a stock movement" form, shared by the stock and movements pages.
export function movementDialog({ factoryId, materialId, onSaved }) {
  const placeable = supply((p, ctx) => p.factories(ctx, { for: "adjust" }));
  const materials = supply((p, ctx) => p.materials(ctx));
  if (placeable.length === 0) {
    toast("You can record stock movements in none of the factories", "warn");
    return undefined;
  }
  return formDialog({
    title: "Record a stock movement",
    description:
      "Stock never goes below zero. An adjustment needs a reason; an opening balance is the first entry of a material at a factory.",
    fields: [
      {
        name: "factoryId",
        label: "Factory",
        type: "select",
        options: placeable.map((factory) => ({ value: factory.id, label: factory.name })),
        required: true,
      },
      {
        name: "materialId",
        label: "Material",
        type: "select",
        options: materials.map((material) => ({
          value: material.id,
          label: `${material.code} · ${material.name} (${material.unit})${
            material.active ? "" : " — inactive"
          }`,
        })),
        required: true,
      },
      {
        name: "type",
        label: "Movement",
        type: "select",
        options: MANUAL_TYPES.map((value) => ({ value, label: MOVEMENT_LABELS[value] })),
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
      { name: "date", label: "Date", type: "date", required: true },
      {
        name: "reason",
        label: "Reason",
        maxlength: 200,
        hint: "Required for an adjustment (3 to 200 characters)",
      },
    ],
    initial: {
      factoryId: factoryId ?? placeable[0].id,
      materialId: materialId ?? materials[0]?.id,
      type: "issue",
      date: session.who.today,
    },
    errorFields: ERRORS,
    submitLabel: "Record movement",
    onSubmit: (values) => {
      inventory((i, ctx) =>
        i.recordMovement(ctx, { ...values, reason: values.reason || undefined })
      );
      toast("Movement recorded", "good");
      onSaved();
    },
  });
}

export function render() {
  const root = h("div");
  const filter = { factoryId: "", materialId: "", indicator: "" };
  mount(root, (redraw) => {
    const mayAdjust = mayWrite("stock.adjust");
    const factories = supply((p, ctx) => p.factories(ctx));
    const materials = supply((p, ctx) => p.materials(ctx));
    const rows = inventory((i, ctx) => i.stock(ctx, queryOf(filter)));

    return h(
      "div",
      {},
      pageHeader(
        "Store and stock",
        "What is in each factory's store now, and how long it will last.",
        mayAdjust
          ? button("Record a movement", () => movementDialog({ onSaved: redraw }), {
              kind: "primary",
            })
          : null
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      h(
        "div",
        { class: "tools" },
        filterSelect(
          filter,
          "factoryId",
          "Factory",
          [
            { value: "", label: "All factories" },
            ...factories.map((row) => ({ value: row.id, label: row.name })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "materialId",
          "Material",
          [
            { value: "", label: "All materials" },
            ...materials.map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "indicator",
          "Indicator",
          [
            { value: "", label: "Any" },
            ...Object.entries(INDICATOR_TEXT).map(([value, label]) => ({ value, label })),
          ],
          redraw
        )
      ),
      card(
        null,
        dataTable({
          caption: "Stock by factory and material",
          pageSize: 12,
          columns: [
            {
              key: "factory",
              label: "Factory",
              sort: (r) => r.factoryName ?? "",
              render: (r) => text(r.factoryName),
            },
            {
              key: "material",
              label: "Material",
              sort: (r) => r.materialCode,
              render: (r) => `${r.materialCode} · ${r.materialName}`,
            },
            {
              key: "balance",
              label: "On hand",
              sort: (r) => r.balance,
              align: "end",
              render: (r) => withUnit(r.balance, r.unit),
            },
            {
              key: "reorder",
              label: "Reorder level",
              sort: (r) => r.reorderLevel ?? 0,
              align: "end",
              render: (r) => quantityText(r.reorderLevel ?? 0),
            },
            {
              key: "cover",
              label: "Days of cover",
              sort: (r) => r.coverDays ?? -1,
              align: "end",
              render: (r) => (r.coverDays === null ? "—" : quantityText(r.coverDays)),
            },
            {
              key: "indicator",
              label: "Indicator",
              sort: (r) => r.indicator,
              render: (r) => indicatorBadge(r.indicator),
            },
            {
              key: "onOrder",
              label: "On order",
              sort: (r) => r.onOrder,
              align: "end",
              render: (r) => withUnit(r.onOrder, r.unit),
            },
            {
              key: "last",
              label: "Last movement",
              sort: (r) => r.lastMovementDate ?? "",
              render: (r) => dateText(r.lastMovementDate),
            },
            {
              key: "actions",
              label: "",
              align: "end",
              render: (r) =>
                mayAdjust
                  ? button(
                      "Record movement",
                      () =>
                        movementDialog({
                          factoryId: r.factoryId,
                          materialId: r.materialId,
                          onSaved: redraw,
                        }),
                      { kind: "link" }
                    )
                  : null,
            },
          ],
          rows,
          rowKey: (r) => `${r.factoryId}|${r.materialId}`,
          searchText: (r) => `${r.materialCode} ${r.materialName} ${r.factoryName ?? ""}`,
          empty: {
            title: "No stock recorded",
            body: mayAdjust
              ? "Record an opening balance to start a material's stock."
              : "No stock has been recorded yet.",
          },
        })
      )
    );
  });
  return root;
}
