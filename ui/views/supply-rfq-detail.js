// One request for quotation: its header, lines, the suppliers asked, their quotations and the
// comparison that leads to an award (D86). The service says what the caller may do and what the
// status allows (`canSend`, `canQuote`, `canAward`, `canCancel`, `editable`); the page draws only
// those, and every call checks again.
import { h } from "../dom.js";
import { confirmDialog, formDialog } from "../dialog.js";
import {
  attempt,
  badge,
  button,
  card,
  emptyState,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  COMMON_ERRORS,
  READ_ONLY_NOTE,
  addressId,
  dateText,
  moneyText,
  poAddress,
  quantityText,
  row,
  supply,
  text,
  withUnit,
} from "./supply-common.js";

const ERRORS = {
  ...COMMON_ERRORS,
  invalid_dates: "dueDate",
  invalid_date: "requestDate",
  invalid_suppliers: "supplierIds",
  inactive_parent: "materialId",
  not_found: "materialId",
  duplicate: "materialId",
};

const link = (label, onClick) => button(label, onClick, { kind: "link" });

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const id = addressId();
    if (!id) {
      return emptyState({
        title: "No RFQ chosen",
        body: "Open a request for quotation from the list.",
        action: h("a", { class: "btn btn-primary", href: "#/supply/rfqs" }, "RFQs"),
      });
    }
    const view = supply((p, ctx) => p.rfq(ctx, id));
    const { rfq } = view;
    const mayManage = view.may.manage && !session.supporting;
    const editable = mayManage && view.editable;
    const run = (call, success) => {
      const result = attempt(() => supply(call), success);
      redraw();
      return result;
    };

    // ---- Header and status --------------------------------------------------------------------

    const suppliersOffered = () => {
      const all = supply((p, ctx) => p.suppliers(ctx));
      const asked = new Set(rfq.candidates.map((candidate) => candidate.id));
      return all
        .filter((supplier) => supplier.active || asked.has(supplier.id))
        .map((supplier) => ({
          value: supplier.id,
          label: supplier.active ? supplier.name : `${supplier.name} (inactive)`,
        }));
    };

    const edit = () =>
      formDialog({
        title: `Edit ${rfq.number}`,
        fields: [
          { name: "requestDate", label: "Request date", type: "date", required: true },
          { name: "dueDate", label: "Quotations due by", type: "date", required: true },
          {
            name: "supplierIds",
            label: "Suppliers to ask",
            type: "checkboxes",
            options: suppliersOffered(),
          },
          { name: "note", label: "Note", type: "textarea" },
        ],
        initial: {
          requestDate: rfq.requestDate,
          dueDate: rfq.dueDate,
          supplierIds: rfq.candidates.map((candidate) => candidate.id),
          note: rfq.note ?? "",
        },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          supply((p, ctx) => p.updateRfq(ctx, rfq.id, values));
          toast("RFQ saved", "good");
          redraw();
        },
      });

    const send = () =>
      confirmDialog({
        title: `Send ${rfq.number}?`,
        message: `It goes to ${rfq.candidates.length} supplier${
          rfq.candidates.length === 1 ? "" : "s"
        } and is locked: its lines and suppliers can no longer be changed.`,
        confirmLabel: "Send RFQ",
        onConfirm: () => {
          supply((p, ctx) => p.sendRfq(ctx, rfq.id));
          toast("RFQ sent", "good");
          redraw();
        },
      });

    const cancel = () =>
      confirmDialog({
        title: `Cancel ${rfq.number}?`,
        message: "A cancelled RFQ cannot be changed or awarded.",
        confirmLabel: "Cancel RFQ",
        danger: true,
        reason: true,
        reasonLabel: "Reason for cancelling",
        onConfirm: (reason) => {
          supply((p, ctx) => p.cancelRfq(ctx, rfq.id, { reason }));
          toast("RFQ cancelled", "good");
          redraw();
        },
      });

    const header = card(
      null,
      h(
        "div",
        {},
        h(
          "dl",
          { class: "facts" },
          ...[
            ["Status", statusBadge(rfq.status)],
            ["Factory", text(rfq.factoryName)],
            ["Request date", dateText(rfq.requestDate)],
            ["Quotations due by", dateText(rfq.dueDate)],
            ["Suppliers asked", text(rfq.candidates.map((candidate) => candidate.name).join(", "))],
            [
              "Purchase order",
              view.purchaseOrderNumber
                ? h("a", { href: poAddress(rfq.purchaseOrderId) }, view.purchaseOrderNumber)
                : "—",
            ],
          ].flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])
        ),
        rfq.note ? h("p", {}, rfq.note) : null,
        rfq.cancelReason ? notice(`Cancelled: ${rfq.cancelReason}`, "warn") : null,
        mayManage
          ? row(
              editable ? button("Edit", edit) : null,
              view.canSend ? button("Send to suppliers", send, { kind: "primary" }) : null,
              view.canCancel ? button("Cancel RFQ", cancel, { kind: "danger" }) : null
            )
          : null
      )
    );

    // ---- Lines --------------------------------------------------------------------------------

    const addLine = () => {
      const taken = new Set(view.lines.map((line) => line.materialId));
      const choices = supply((p, ctx) => p.materials(ctx)).filter(
        (material) => material.active && !taken.has(material.id)
      );
      if (choices.length === 0) {
        toast("Every active material is already on this RFQ", "warn");
        return undefined;
      }
      return formDialog({
        title: "Add a line",
        fields: [
          {
            name: "materialId",
            label: "Material",
            type: "select",
            options: choices.map((material) => ({
              value: material.id,
              label: `${material.code} · ${material.name} (${material.unit})`,
            })),
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
          { name: "requiredDate", label: "Needed by", type: "date" },
        ],
        errorFields: ERRORS,
        submitLabel: "Add line",
        onSubmit: (values) => {
          supply((p, ctx) => p.addRfqLine(ctx, rfq.id, values));
          toast("Line added", "good");
          redraw();
        },
      });
    };

    const editLine = (line) =>
      formDialog({
        title: `Edit ${line.materialCode}`,
        fields: [
          {
            name: "quantity",
            label: `Quantity (${line.unit})`,
            type: "number",
            min: 0,
            step: "any",
            required: true,
          },
          { name: "requiredDate", label: "Needed by", type: "date" },
        ],
        initial: { quantity: line.quantity, requiredDate: line.requiredDate ?? "" },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          supply((p, ctx) =>
            p.updateRfqLine(ctx, line.id, { ...values, requiredDate: values.requiredDate || null })
          );
          toast("Line saved", "good");
          redraw();
        },
      });

    const lines = card(
      "Lines",
      dataTable({
        caption: "RFQ lines",
        pageSize: 10,
        columns: [
          {
            key: "material",
            label: "Material",
            sort: (r) => r.materialCode,
            render: (r) => `${r.materialCode} · ${r.materialName}`,
          },
          {
            key: "quantity",
            label: "Quantity",
            sort: (r) => r.quantity,
            align: "end",
            render: (r) => withUnit(r.quantity, r.unit),
          },
          {
            key: "needed",
            label: "Needed by",
            sort: (r) => r.requiredDate ?? "",
            render: (r) => dateText(r.requiredDate),
          },
          {
            key: "actions",
            label: "",
            align: "end",
            render: (r) =>
              editable
                ? row(
                    link("Edit", () => editLine(r)),
                    link("Remove", () =>
                      run((p, ctx) => p.removeRfqLine(ctx, r.id), "Line removed")
                    )
                  )
                : null,
          },
        ],
        rows: view.lines,
        rowKey: (r) => r.id,
        empty: {
          title: "No lines yet",
          body: editable ? "Add the materials to ask for." : "This RFQ has no lines.",
        },
      }),
      editable ? button("Add a line", addLine) : null
    );

    // ---- Suppliers asked and their quotations -------------------------------------------------

    const quotationOf = (supplierId) => view.quotations.find((q) => q.supplierId === supplierId);

    const record = (candidate) => {
      const existing = quotationOf(candidate.id);
      const fields = [
        { name: "date", label: "Quotation date", type: "date", required: true },
        { name: "validUntil", label: "Valid until", type: "date" },
        {
          name: "currency",
          label: "Currency",
          maxlength: 3,
          hint: "Three letters; the company currency when left empty",
        },
        { name: "supplierRef", label: "Supplier's reference", maxlength: 40 },
      ];
      const initial = {
        date: existing?.date ?? session.who.today,
        validUntil: existing?.validUntil ?? "",
        currency: existing?.currency ?? "",
        supplierRef: existing?.supplierRef ?? "",
      };
      view.lines.forEach((line, index) => {
        const quoted = existing?.lines.find((entry) => entry.rfqLineId === line.id);
        fields.push(
          {
            name: `price${index}`,
            label: `${line.materialName}: unit price`,
            type: "number",
            min: 0,
            step: "any",
            hint: `Asked for ${withUnit(line.quantity, line.unit)}; leave empty if not quoted`,
          },
          {
            name: `quantity${index}`,
            label: `${line.materialName}: quantity offered (${line.unit})`,
            type: "number",
            min: 0,
            step: "any",
          },
          {
            name: `lead${index}`,
            label: `${line.materialName}: lead time (days)`,
            type: "number",
            min: 0,
            step: 1,
          }
        );
        initial[`price${index}`] = quoted?.unitPrice ?? "";
        initial[`quantity${index}`] = quoted?.quantity ?? line.quantity;
        initial[`lead${index}`] = quoted?.leadDays ?? 0;
      });
      return formDialog({
        title: `${existing ? "Replace" : "Record"} the quotation from ${candidate.name}`,
        description:
          "Quote each line the supplier priced; lines left without a price are not quoted.",
        fields,
        initial,
        errorFields: ERRORS,
        submitLabel: "Save quotation",
        onSubmit: (values) => {
          const quoted = view.lines
            .map((line, index) => ({
              rfqLineId: line.id,
              unitPrice: values[`price${index}`],
              quantity: values[`quantity${index}`] ?? line.quantity,
              leadDays: values[`lead${index}`] ?? 0,
            }))
            .filter((line) => line.unitPrice !== undefined);
          supply((p, ctx) =>
            p.recordQuotation(ctx, rfq.id, {
              supplierId: candidate.id,
              date: values.date,
              validUntil: values.validUntil || undefined,
              currency: values.currency || undefined,
              supplierRef: values.supplierRef || undefined,
              lines: quoted,
            })
          );
          toast("Quotation saved", "good");
          redraw();
        },
      });
    };

    const suppliers = card(
      "Suppliers asked",
      dataTable({
        caption: "Suppliers asked",
        pageSize: 10,
        columns: [
          {
            key: "name",
            label: "Supplier",
            sort: (r) => r.name ?? "",
            render: (r) => text(r.name),
          },
          {
            key: "quotation",
            label: "Quotation",
            render: (r) => {
              const quotation = quotationOf(r.id);
              return quotation
                ? statusBadge(quotation.status)
                : h("span", { class: "muted" }, "Not yet");
            },
          },
          {
            key: "total",
            label: "Total",
            align: "end",
            render: (r) => {
              const quotation = quotationOf(r.id);
              return quotation ? moneyText(quotation.total, quotation.currency) : "—";
            },
          },
          {
            key: "actions",
            label: "",
            align: "end",
            render: (r) => {
              const quotation = quotationOf(r.id);
              if (!mayManage || !view.canQuote) return null;
              if (quotation && quotation.status !== "quoted") return null;
              return row(
                link(quotation ? "Replace quotation" : "Record quotation", () => record(r))
              );
            },
          },
        ],
        rows: rfq.candidates,
        rowKey: (r) => r.id,
        empty: {
          title: "No suppliers chosen",
          body: editable
            ? "Edit the RFQ to choose the suppliers to ask."
            : "No supplier was asked.",
        },
      })
    );

    // ---- Comparison and award -----------------------------------------------------------------

    const award = (summary) => {
      const quotation = view.quotations.find((q) => q.id === summary.quotationId);
      return confirmDialog({
        title: `Award ${rfq.number} to ${summary.supplierName}?`,
        message: `The other quotations are marked not awarded and a draft purchase order for ${moneyText(
          summary.total,
          summary.currency
        )} is made from ${quotation?.covered ?? summary.covered} quoted line(s). This cannot be undone.`,
        confirmLabel: "Award",
        onConfirm: () => {
          const result = supply((p, ctx) => p.awardQuotation(ctx, summary.quotationId));
          toast(`Awarded; draft ${result.purchaseOrder.number} created`, "good");
          window.location.hash = poAddress(result.purchaseOrder.id).slice(1);
        },
      });
    };

    const comparisonCard = () => {
      const { summaries, lines: compared } = view.comparison;
      if (summaries.length === 0) return null;
      const quotationFor = (summary) => view.quotations.find((q) => q.id === summary.quotationId);
      const header = h(
        "tr",
        {},
        h("th", { scope: "col" }, "Material"),
        h("th", { scope: "col", class: "end" }, "Asked"),
        summaries.map((summary) =>
          h(
            "th",
            { scope: "col", class: "end" },
            h("div", {}, summary.supplierName ?? "—"),
            h("div", {}, statusBadge(quotationFor(summary)?.status ?? "quoted")),
            summary.expired ? h("div", {}, badge("Quotation expired", "warn")) : null
          )
        )
      );
      const body = compared.map((line) => {
        const asked = view.lines.find((entry) => entry.id === line.rfqLineId);
        return h(
          "tr",
          {},
          h("th", { scope: "row" }, `${line.materialCode} · ${line.materialName}`),
          h("td", { class: "end" }, asked ? withUnit(asked.quantity, asked.unit) : "—"),
          summaries.map((summary) => {
            const offer = line.offers.find((entry) => entry.quotationId === summary.quotationId);
            return h(
              "td",
              { class: "end" },
              offer
                ? h(
                    "div",
                    {},
                    h("div", {}, moneyText(offer.unitPrice, offer.currency)),
                    h(
                      "small",
                      { class: "muted" },
                      `${quantityText(offer.quantity)} offered · ${offer.leadDays} d`
                    ),
                    offer.lowest ? h("div", {}, badge("Lowest price", "good")) : null
                  )
                : h("span", { class: "muted" }, "Not quoted")
            );
          })
        );
      });
      const summaryRow = (label, cell) =>
        h(
          "tr",
          {},
          h("th", { scope: "row" }, label),
          h("td", {}),
          summaries.map((summary) => h("td", { class: "end" }, cell(summary)))
        );
      const mayAward = mayManage && view.canAward;
      const footer = [
        summaryRow("Total", (summary) => moneyText(summary.total, summary.currency)),
        summaryRow("Lines quoted", (summary) => `${summary.covered} of ${summary.asked}`),
        summaryRow("Longest lead time", (summary) => `${summary.longestLeadDays} days`),
        mayAward
          ? summaryRow("", (summary) =>
              quotationFor(summary)?.status === "quoted"
                ? button("Award", () => award(summary), { kind: "primary" })
                : null
            )
          : null,
      ];
      return card(
        "Comparison",
        h(
          "div",
          {},
          h(
            "p",
            { class: "muted" },
            "Information only: prices are compared per line within the same currency, and nothing is chosen for you."
          ),
          h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              { class: "table" },
              h("caption", { class: "sr-only" }, "Quotation comparison"),
              h("thead", {}, header),
              h("tbody", {}, body, footer)
            )
          )
        )
      );
    };

    return h(
      "div",
      {},
      pageHeader(
        rfq.number,
        text(rfq.factoryName),
        h("a", { class: "btn btn-secondary", href: "#/supply/rfqs" }, "All RFQs")
      ),
      session.supporting ? notice(READ_ONLY_NOTE, "warn") : null,
      rfq.status !== "draft"
        ? notice(`This RFQ is ${rfq.status}; its lines and suppliers are locked.`, "info")
        : null,
      header,
      lines,
      suppliers,
      comparisonCard()
    );
  });
  return root;
}
