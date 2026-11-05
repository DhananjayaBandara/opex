// Requests for quotation (D86): the list, and a new RFQ. An RFQ opens on its own page, which holds the
// lines, the suppliers asked, their quotations and the comparison that leads to an award.
import { h } from "../dom.js";
import { formDialog } from "../dialog.js";
import { button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  COMMON_ERRORS,
  READ_ONLY_NOTE,
  dateText,
  filterSelect,
  linkTo,
  mayWrite,
  poAddress,
  queryOf,
  rfqAddress,
  supply,
  text,
} from "./supply-common.js";

export const RFQ_STATUS_LABEL = {
  draft: "Draft",
  sent: "Sent",
  awarded: "Awarded",
  cancelled: "Cancelled",
};

const ERRORS = {
  ...COMMON_ERRORS,
  invalid_dates: "dueDate",
  invalid_date: "requestDate",
  invalid_suppliers: "supplierIds",
  not_found: "factoryId",
  inactive_parent: "supplierIds",
};

export function render() {
  const root = h("div");
  const filter = { factoryId: "", status: "", supplierId: "" };
  mount(root, (redraw) => {
    const mayCreate = mayWrite("rfq.manage");
    const suppliers = supply((p, ctx) => p.suppliers(ctx));
    const factories = supply((p, ctx) => p.factories(ctx));
    const rows = supply((p, ctx) => p.rfqs(ctx, queryOf(filter)));

    const create = () => {
      const placeable = supply((p, ctx) => p.factories(ctx, { for: "rfq" }));
      const open = suppliers.filter((supplier) => supplier.active);
      if (placeable.length === 0) {
        toast("You can request quotations in none of the factories", "warn");
        return undefined;
      }
      return formDialog({
        title: "New request for quotation",
        description: "Add the lines on the next page, then send it to the suppliers.",
        fields: [
          {
            name: "factoryId",
            label: "Factory",
            type: "select",
            options: placeable.map((factory) => ({ value: factory.id, label: factory.name })),
            required: true,
          },
          { name: "requestDate", label: "Request date", type: "date", required: true },
          {
            name: "dueDate",
            label: "Quotations due by",
            type: "date",
            required: true,
          },
          {
            name: "supplierIds",
            label: "Suppliers to ask",
            type: "checkboxes",
            options: open.map((supplier) => ({ value: supplier.id, label: supplier.name })),
            hint: "Only active suppliers are offered",
          },
          { name: "note", label: "Note", type: "textarea" },
        ],
        initial: { requestDate: session.who.today, supplierIds: [] },
        errorFields: ERRORS,
        submitLabel: "Create RFQ",
        onSubmit: (values) => {
          const rfq = supply((p, ctx) => p.createRfq(ctx, { ...values, lines: [] }));
          toast("RFQ created", "good");
          window.location.hash = rfqAddress(rfq.id).slice(1);
        },
      });
    };

    return h(
      "div",
      {},
      pageHeader(
        "Requests for quotation",
        "Ask suppliers for prices, compare their quotations and award one.",
        mayCreate ? button("New RFQ", create, { kind: "primary" }) : null
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
          "status",
          "Status",
          [
            { value: "", label: "Any status" },
            ...Object.entries(RFQ_STATUS_LABEL).map(([value, label]) => ({ value, label })),
          ],
          redraw
        ),
        filterSelect(
          filter,
          "supplierId",
          "Supplier asked",
          [
            { value: "", label: "Any supplier" },
            ...suppliers.map((row) => ({ value: row.id, label: row.name })),
          ],
          redraw
        )
      ),
      card(
        null,
        dataTable({
          caption: "Requests for quotation",
          pageSize: 12,
          columns: [
            {
              key: "number",
              label: "RFQ",
              sort: (r) => r.number,
              render: (r) => h("a", { href: rfqAddress(r.id) }, r.number),
            },
            {
              key: "factory",
              label: "Factory",
              sort: (r) => r.factoryName ?? "",
              render: (r) => text(r.factoryName),
            },
            {
              key: "status",
              label: "Status",
              sort: (r) => r.status,
              render: (r) => statusBadge(r.status),
            },
            {
              key: "requested",
              label: "Requested",
              sort: (r) => r.requestDate,
              render: (r) => dateText(r.requestDate),
            },
            {
              key: "due",
              label: "Due by",
              sort: (r) => r.dueDate,
              render: (r) => dateText(r.dueDate),
            },
            { key: "lines", label: "Lines", sort: (r) => r.lines, align: "end" },
            {
              key: "suppliers",
              label: "Suppliers asked",
              render: (r) => text(r.candidates.map((candidate) => candidate.name).join(", ")),
            },
            {
              key: "quotations",
              label: "Quotations",
              sort: (r) => r.quotations,
              align: "end",
              render: (r) => `${r.quotations} of ${r.candidates.length}`,
            },
            {
              key: "awarded",
              label: "Awarded to",
              sort: (r) => r.awardedSupplierName ?? "",
              render: (r) =>
                r.purchaseOrderId
                  ? linkTo(r.awardedSupplierName, poAddress(r.purchaseOrderId))
                  : text(r.awardedSupplierName),
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) =>
            `${r.number} ${r.factoryName ?? ""} ${r.candidates.map((c) => c.name).join(" ")}`,
          empty: {
            title: "No requests for quotation",
            body: mayCreate ? "Create the first RFQ." : "No RFQs match this view.",
          },
        })
      )
    );
  });
  return root;
}
