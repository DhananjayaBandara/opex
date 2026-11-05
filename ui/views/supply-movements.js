// Stock movements (D89, D90): the append-only record every balance is worked out from (C12). A movement
// is never edited or deleted; a mistake is corrected by a reversal or an adjustment with a reason, and
// both entries stay. Each row says what made it (a goods receipt, a requisition, or a person).
import { h } from "../dom.js";
import { button, card, mount, notice, pageHeader } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  MOVEMENT_LABELS,
  READ_ONLY_NOTE,
  dateText,
  filterDate,
  filterSelect,
  inventory,
  mayWrite,
  queryOf,
  receiptAddress,
  requisitionAddress,
  supply,
  text,
  withUnit,
} from "./supply-common.js";
import { movementDialog } from "./supply-stock.js";

export function render() {
  const root = h("div");
  const filter = { factoryId: "", materialId: "", type: "", from: "", to: "" };
  mount(root, (redraw) => {
    const mayAdjust = mayWrite("stock.adjust");
    const factories = supply((p, ctx) => p.factories(ctx));
    const materials = supply((p, ctx) => p.materials(ctx));
    const rows = inventory((i, ctx) => i.movements(ctx, queryOf(filter)));

    return h(
      "div",
      {},
      pageHeader(
        "Stock movements",
        "Everything that moved in or out of the stores. Entries are kept; corrections are new entries.",
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
          "type",
          "Movement",
          [
            { value: "", label: "Any movement" },
            ...Object.entries(MOVEMENT_LABELS).map(([value, label]) => ({ value, label })),
          ],
          redraw
        ),
        filterDate(filter, "from", "From", redraw),
        filterDate(filter, "to", "To", redraw)
      ),
      card(
        null,
        dataTable({
          caption: "Stock movements",
          pageSize: 15,
          columns: [
            {
              key: "date",
              label: "Date",
              sort: (r) => `${r.date} ${r.recordedAt ?? ""}`,
              render: (r) => dateText(r.date),
            },
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
              key: "type",
              label: "Movement",
              sort: (r) => r.type,
              render: (r) => MOVEMENT_LABELS[r.type] ?? r.type,
            },
            {
              key: "direction",
              label: "Direction",
              sort: (r) => r.direction,
              render: (r) => (r.direction === "in" ? "Into the store" : "Out of the store"),
            },
            {
              key: "quantity",
              label: "Quantity",
              sort: (r) => (r.direction === "in" ? r.quantity : -r.quantity),
              align: "end",
              render: (r) => `${r.direction === "in" ? "+" : "−"}${withUnit(r.quantity, r.unit)}`,
            },
            { key: "reason", label: "Reason", render: (r) => text(r.reason) },
            {
              key: "source",
              label: "Source",
              render: (r) =>
                r.receiptId
                  ? h("a", { href: receiptAddress(r.receiptId) }, r.receiptNumber)
                  : r.requisitionId
                    ? h("a", { href: requisitionAddress(r.requisitionId) }, r.requisitionNumber)
                    : "Recorded by hand",
            },
            { key: "by", label: "Recorded by", render: (r) => text(r.recordedBy) },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) =>
            `${r.materialCode} ${r.materialName} ${r.factoryName ?? ""} ${r.reason ?? ""} ${
              r.receiptNumber ?? ""
            } ${r.requisitionNumber ?? ""}`,
          empty: {
            title: "No stock movements",
            body: "Movements appear once stock is recorded or a receipt is posted.",
          },
        })
      )
    );
  });
  return root;
}
