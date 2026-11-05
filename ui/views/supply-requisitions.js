// Material requisitions (D91): a request to take materials out of a factory's store. Drafted, submitted,
// then approved or rejected, and issued, which adds one Issue movement per line. The same person may
// raise and approve one in this prototype (D91). A requisition opens on its own page.
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
  inventory,
  mayWrite,
  queryOf,
  requisitionAddress,
  supply,
  text,
} from "./supply-common.js";

export const REQUISITION_STATUS_LABEL = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  issued: "Issued",
  cancelled: "Cancelled",
};

const ERRORS = { ...COMMON_ERRORS, invalid_date: "neededBy", not_found: "factoryId" };

export function render() {
  const root = h("div");
  const filter = { factoryId: "", status: "" };
  mount(root, (redraw) => {
    const mayCreate = mayWrite("requisition.manage");
    const factories = supply((p, ctx) => p.factories(ctx));
    const rows = inventory((i, ctx) => i.requisitions(ctx, queryOf(filter)));

    const create = () => {
      const placeable = supply((p, ctx) => p.factories(ctx, { for: "requisition" }));
      if (placeable.length === 0) {
        toast("You can raise requisitions in none of the factories", "warn");
        return undefined;
      }
      return formDialog({
        title: "New material requisition",
        description: "Add the materials on the next page, then submit it for approval.",
        fields: [
          {
            name: "factoryId",
            label: "Factory",
            type: "select",
            options: placeable.map((factory) => ({ value: factory.id, label: factory.name })),
            required: true,
          },
          { name: "neededBy", label: "Needed by", type: "date" },
          { name: "note", label: "Note", type: "textarea" },
        ],
        errorFields: ERRORS,
        submitLabel: "Create draft",
        onSubmit: (values) => {
          const created = inventory((i, ctx) =>
            i.createRequisition(ctx, {
              ...values,
              neededBy: values.neededBy || undefined,
              note: values.note || undefined,
              lines: [],
            })
          );
          toast("Draft requisition created", "good");
          window.location.hash = requisitionAddress(created.id).slice(1);
        },
      });
    };

    return h(
      "div",
      {},
      pageHeader(
        "Material requisitions",
        "Requests to take materials out of the store for production.",
        mayCreate ? button("New requisition", create, { kind: "primary" }) : null
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
            ...Object.entries(REQUISITION_STATUS_LABEL).map(([value, label]) => ({
              value,
              label,
            })),
          ],
          redraw
        )
      ),
      card(
        null,
        dataTable({
          caption: "Material requisitions",
          pageSize: 12,
          columns: [
            {
              key: "number",
              label: "Requisition",
              sort: (r) => r.number,
              render: (r) => h("a", { href: requisitionAddress(r.id) }, r.number),
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
              key: "needed",
              label: "Needed by",
              sort: (r) => r.neededBy ?? "",
              render: (r) => dateText(r.neededBy),
            },
            { key: "lines", label: "Lines", sort: (r) => r.lines, align: "end" },
            {
              key: "by",
              label: "Raised by",
              sort: (r) => r.requestedBy ?? "",
              render: (r) => text(r.requestedBy),
            },
            {
              key: "decided",
              label: "Decided by",
              sort: (r) => r.decidedBy ?? "",
              render: (r) => text(r.decidedBy),
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.number} ${r.factoryName ?? ""} ${r.requestedBy ?? ""}`,
          empty: {
            title: "No requisitions",
            body: mayCreate ? "Raise the first requisition." : "No requisitions match this view.",
          },
        })
      )
    );
  });
  return root;
}
