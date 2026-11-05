// Time and Action: the milestone board across the orders a person can see, and the templates that
// give a new order its milestones (D77). Templates belong to the whole organization, so changing them
// needs planning management over every factory. A template edit never rewrites milestones that an
// order already copied from it.
import { h } from "../dom.js";
import { FIELD_ERRORS } from "../crud.js";
import { confirmDialog, formDialog } from "../dialog.js";
import {
  attempt,
  badge,
  button,
  card,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { fullDate } from "../charts.js";
import { mayChangeShared, orderAddress, orders, text } from "./orders-common.js";

const TEMPLATE_ERRORS = { ...FIELD_ERRORS, duplicate: "name", invalid_name: "name" };
const LINE_ERRORS = {
  ...FIELD_ERRORS,
  invalid_code: "code",
  duplicate: "code",
  invalid_name: "name",
  invalid_number: "offsetDays",
};

const STATES = [
  { value: "open", label: "Not completed" },
  { value: "late", label: "Late" },
  { value: "blocked", label: "Blocked" },
  { value: "in_progress", label: "In progress" },
  { value: "not_started", label: "Not started" },
  { value: "completed", label: "Completed" },
  { value: "any", label: "Any state" },
];

const offsetText = (days) =>
  days === 0 ? "On the order date" : days > 0 ? `${days} days after` : `${-days} days before`;

export function render() {
  const root = h("div");
  const board = { state: "open", factoryId: "" };
  let selected = null;
  mount(root, (redraw) => {
    const mayEdit = mayChangeShared("planning.manage");
    const factories = orders((o, ctx) => o.factories(ctx));
    const templates = orders((o, ctx) => o.templates(ctx));
    const current = templates.find((template) => template.id === selected) ?? templates[0] ?? null;
    selected = current?.id ?? null;

    const query = board.factoryId === "" ? {} : { factoryId: board.factoryId };
    const milestones = orders((o, ctx) => o.milestones(ctx, query)).filter((row) => {
      if (board.state === "any") return true;
      if (board.state === "open") return row.state !== "completed";
      return row.state === board.state;
    });

    const select = (label, id, value, options, onChange) => {
      const control = h(
        "select",
        {
          id,
          onchange: () => {
            onChange(control.value);
            redraw();
          },
        },
        options.map((option) =>
          h("option", { value: option.value, selected: option.value === value }, option.label)
        )
      );
      return h("span", {}, h("label", { for: id }, label), " ", control);
    };

    // ---- Templates ----------------------------------------------------------------------------

    const createTemplate = () =>
      formDialog({
        title: "Add a template",
        fields: [
          { name: "name", label: "Template name", required: true },
          { name: "description", label: "Description", type: "textarea" },
        ],
        errorFields: TEMPLATE_ERRORS,
        submitLabel: "Add template",
        onSubmit: (values) => {
          const row = orders((o, ctx) => o.createTemplate(ctx, values));
          selected = row.id;
          toast("Template added", "good");
          redraw();
        },
      });

    const editTemplate = (row) =>
      formDialog({
        title: `Edit ${row.name}`,
        fields: [
          { name: "name", label: "Template name", required: true },
          { name: "description", label: "Description", type: "textarea" },
        ],
        initial: { name: row.name, description: row.description ?? "" },
        errorFields: TEMPLATE_ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.updateTemplate(ctx, row.id, values));
          toast("Template saved", "good");
          redraw();
        },
      });

    const toggleTemplate = (row) => {
      attempt(
        () => orders((o, ctx) => o.setTemplateActive(ctx, row.id, !row.active)),
        row.active ? `${row.name} deactivated` : `${row.name} reactivated`
      );
      redraw();
    };

    const removeTemplate = (row) =>
      confirmDialog({
        title: `Delete ${row.name}?`,
        message:
          "The template and its milestone lines are deleted. A template whose milestones are on orders cannot be deleted; deactivate it instead.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          orders((o, ctx) => o.removeTemplate(ctx, row.id));
          toast("Template deleted", "good");
          redraw();
        },
      });

    const templateTable = dataTable({
      caption: "Time and Action templates",
      pageSize: 8,
      columns: [
        {
          key: "name",
          label: "Template",
          sort: (r) => r.name,
          render: (r) =>
            button(
              r.name,
              () => {
                selected = r.id;
                redraw();
              },
              { kind: "link", title: "Show its milestone lines" }
            ),
        },
        { key: "description", label: "Description", render: (r) => text(r.description) },
        {
          key: "lines",
          label: "Lines",
          sort: (r) => r.definitions.length,
          align: "end",
          render: (r) => r.definitions.length,
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
                  button("Edit", () => editTemplate(r), { kind: "link" }),
                  button(r.active ? "Deactivate" : "Reactivate", () => toggleTemplate(r), {
                    kind: "link",
                  }),
                  button("Delete", () => removeTemplate(r), { kind: "link" })
                )
              : null,
        },
      ],
      rows: templates,
      rowKey: (r) => r.id,
      rowClass: (r) => (r.id === selected ? "selected" : ""),
      empty: {
        title: "No templates yet",
        body: "A template lists the milestones every new order of a kind needs.",
      },
    });

    // ---- The lines of the chosen template -----------------------------------------------------

    const lineFields = [
      {
        name: "code",
        label: "Code",
        required: true,
        maxlength: 20,
        hint: "Letters, digits, - and _",
      },
      { name: "name", label: "Milestone", required: true },
      {
        name: "offsetDays",
        label: "Days from the order date",
        type: "number",
        step: 1,
        required: true,
        hint: "Negative before the order date, positive after it; 0 when left empty",
      },
      { name: "responsibleRole", label: "Responsible role" },
      { name: "blocking", label: "Blocks production until completed", type: "checkbox" },
      {
        name: "sequence",
        label: "Order in the list",
        type: "number",
        min: 1,
        max: 999,
        step: 1,
        hint: "Added after the last line when left empty",
      },
    ];

    const addLine = () =>
      formDialog({
        title: `Add a milestone to ${current.name}`,
        fields: lineFields,
        initial: { blocking: false },
        errorFields: LINE_ERRORS,
        submitLabel: "Add milestone",
        onSubmit: (values) => {
          orders((o, ctx) => o.addDefinition(ctx, current.id, values));
          toast("Milestone added", "good");
          redraw();
        },
      });

    const editLine = (row) =>
      formDialog({
        title: `Edit ${row.name}`,
        fields: lineFields,
        initial: {
          code: row.code,
          name: row.name,
          offsetDays: row.offsetDays,
          responsibleRole: row.responsibleRole ?? "",
          blocking: row.blocking === true,
          sequence: row.sequence,
        },
        errorFields: LINE_ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.updateDefinition(ctx, row.id, values));
          toast("Milestone saved", "good");
          redraw();
        },
      });

    const toggleLine = (row) => {
      attempt(
        () => orders((o, ctx) => o.setDefinitionActive(ctx, row.id, !row.active)),
        row.active ? "Milestone deactivated" : "Milestone reactivated"
      );
      redraw();
    };

    const removeLine = (row) =>
      confirmDialog({
        title: `Delete ${row.name}?`,
        message: "A line that orders already used cannot be deleted; make it inactive instead.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          orders((o, ctx) => o.removeDefinition(ctx, row.id));
          toast("Milestone deleted", "good");
          redraw();
        },
      });

    const lineTable = current
      ? dataTable({
          caption: `Milestones of ${current.name}`,
          pageSize: 15,
          columns: [
            { key: "sequence", label: "#", sort: (r) => r.sequence, align: "end" },
            {
              key: "name",
              label: "Milestone",
              sort: (r) => r.sequence,
              render: (r) => h("span", {}, r.name, " ", h("small", { class: "muted" }, r.code)),
            },
            {
              key: "offset",
              label: "When",
              sort: (r) => r.offsetDays,
              render: (r) => offsetText(r.offsetDays),
            },
            { key: "role", label: "Responsible", render: (r) => text(r.responsibleRole) },
            {
              key: "blocking",
              label: "Blocks production",
              sort: (r) => (r.blocking ? 0 : 1),
              render: (r) => (r.blocking ? badge("blocking", "warn") : "—"),
            },
            { key: "uses", label: "Used on orders", sort: (r) => r.uses, align: "end" },
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
                      button("Edit", () => editLine(r), { kind: "link" }),
                      button(r.active ? "Deactivate" : "Reactivate", () => toggleLine(r), {
                        kind: "link",
                      }),
                      button("Delete", () => removeLine(r), { kind: "link" })
                    )
                  : null,
            },
          ],
          rows: current.definitions,
          rowKey: (r) => r.id,
          empty: {
            title: "No milestones in this template",
            body: "Add the steps an order of this kind goes through.",
          },
        })
      : null;

    // ---- The board ----------------------------------------------------------------------------

    const boardTable = dataTable({
      caption: "Milestones",
      pageSize: 12,
      columns: [
        {
          key: "order",
          label: "Order",
          sort: (r) => r.orderReference ?? "",
          render: (r) => h("a", { href: orderAddress(r.orderId) }, text(r.orderReference)),
        },
        {
          key: "name",
          label: "Milestone",
          sort: (r) => r.name,
          render: (r) => h("span", {}, r.name, " ", h("small", { class: "muted" }, r.code)),
        },
        {
          key: "role",
          label: "Responsible",
          sort: (r) => r.responsibleRole ?? "",
          render: (r) => text(r.responsibleRole),
        },
        {
          key: "blocking",
          label: "Blocks production",
          sort: (r) => (r.blocking ? 0 : 1),
          render: (r) => (r.blocking ? badge("blocking", "warn") : "—"),
        },
        {
          key: "due",
          label: "Due",
          sort: (r) => r.due,
          render: (r) =>
            r.revisedDate
              ? h(
                  "span",
                  { title: r.revisionReason ?? "" },
                  fullDate(r.revisedDate),
                  " ",
                  h("small", { class: "muted" }, `was ${fullDate(r.plannedDate)}`)
                )
              : fullDate(r.plannedDate),
        },
        {
          key: "state",
          label: "Status",
          sort: (r) => r.state,
          render: (r) => statusBadge(r.state),
        },
      ],
      rows: milestones,
      rowKey: (r) => r.id,
      searchText: (r) => `${r.orderReference ?? ""} ${r.name} ${r.code} ${r.responsibleRole ?? ""}`,
      empty: {
        title: "No milestones",
        body: "Apply a template to an order to give it milestones.",
      },
    });

    return h(
      "div",
      {},
      pageHeader(
        "Time & Action",
        "The milestones every order goes through, and the templates that create them."
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      card(
        "Milestone board",
        h(
          "div",
          {},
          h(
            "div",
            { class: "tools" },
            select("Status", "tna-state", board.state, STATES, (value) => {
              board.state = value;
            }),
            select(
              "Factory",
              "tna-factory",
              board.factoryId,
              [
                { value: "", label: "All factories" },
                ...factories.map((row) => ({ value: row.id, label: row.name })),
              ],
              (value) => {
                board.factoryId = value;
              }
            )
          ),
          boardTable
        )
      ),
      card(
        "Templates",
        h(
          "div",
          {},
          !mayEdit && !session.supporting
            ? notice(
                "Templates are changed by people who manage planning in every factory.",
                "info"
              )
            : null,
          templateTable
        ),
        mayEdit ? button("Add a template", createTemplate) : null
      ),
      current
        ? card(
            `Milestones of ${current.name}`,
            lineTable,
            mayEdit ? button("Add a milestone", addLine) : null
          )
        : null
    );
  });
  return root;
}
