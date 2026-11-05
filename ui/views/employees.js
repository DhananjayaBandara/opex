// Employees: the register of people who work in a factory section, their designation, status and
// optional link to a user account (UC-PEO-01, FR-SUPA-005, D27, D29).
import { h } from "../dom.js";
import { badge, button, card, mount, pageHeader, statusBadge, toast } from "../kit.js";
import { confirmDialog, formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { org } from "../crud.js";
import { session } from "../session.js";

const ERRORS = {
  invalid_code: "employeeCode",
  duplicate: "employeeCode",
  invalid_name: "name",
  invalid_email: "email",
  invalid_phone: "phone",
  invalid_date: "joinDate",
  join_date_after_attendance: "joinDate",
  unknown_user: "userId",
  designation_in_use: "designationId",
};

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "on_leave", label: "On leave" },
  { value: "inactive", label: "Inactive" },
];

const nameOf = (rows, id) => rows.find((row) => row.id === id)?.name ?? "removed";

export function render() {
  const root = h("div");
  const state = { factoryId: "", status: "" };
  mount(root, (redraw) => {
    const app = session.app;
    const factories = org((o, ctx) => o.list(ctx, "factory"));
    if (state.factoryId !== "" && !factories.some((factory) => factory.id === state.factoryId))
      state.factoryId = "";
    const sections = org((o, ctx) => o.list(ctx, "section", { includeInactive: true }));
    const designations = org((o, ctx) => o.list(ctx, "designation", { includeInactive: true }));
    // Linking a user needs the user list, which not every employee manager may read.
    let members = [];
    try {
      members = session.run((ctx) => app.administration.members(ctx));
    } catch {
      members = [];
    }
    const canLink = members.length > 0;
    const employees = session.run((ctx) =>
      app.employees.list(ctx, {
        ...(state.factoryId ? { factoryId: state.factoryId } : {}),
        ...(state.status ? { status: state.status } : {}),
      })
    );
    const call = (action) => session.run((ctx) => action(app.employees, ctx));
    const today = session.who.today;

    const userOptions = [
      { value: "", label: "No linked user" },
      ...members.map((member) => ({
        value: member.userId,
        label: `${member.name} (${member.email})`,
      })),
    ];
    const userName = (userId) => members.find((member) => member.userId === userId)?.name ?? null;

    const sectionOptions = sections
      .filter((section) => section.active)
      .map((section) => ({
        value: section.id,
        label: `${nameOf(factories, section.factoryId)} · ${section.name}`,
      }));
    // An inactive designation is offered only to the employee who already holds it.
    const designationOptions = (currentId) =>
      designations
        .filter((designation) => designation.active || designation.id === currentId)
        .map((designation) => ({
          value: designation.id,
          label: designation.supervisorEligible
            ? `${designation.name} (can supervise)`
            : designation.name,
        }));

    const commonFields = (currentDesignationId) => [
      { name: "employeeCode", label: "Employee code", required: true, hint: "For example E-1010" },
      { name: "name", label: "Name", required: true },
      { name: "email", label: "Email", type: "email" },
      { name: "phone", label: "Phone" },
      { name: "joinDate", label: "Join date", type: "date", required: true },
      {
        name: "designationId",
        label: "Designation",
        type: "select",
        options: designationOptions(currentDesignationId),
      },
      ...(canLink
        ? [
            {
              name: "userId",
              label: "Linked user",
              type: "select",
              options: userOptions,
              hint: "A supervisor who signs in is linked to their employee record",
            },
          ]
        : []),
    ];

    const add = () =>
      formDialog({
        title: "Add an employee",
        fields: [
          ...commonFields(null).slice(0, 5),
          { name: "sectionId", label: "Section", type: "select", options: sectionOptions },
          ...commonFields(null).slice(5),
        ],
        initial: { joinDate: today, userId: "" },
        errorFields: { ...ERRORS, inactive_parent: "sectionId" },
        onSubmit: (values) => {
          call((e, ctx) => e.create(ctx, values));
          toast("Employee added", "good");
          redraw();
        },
      });

    const edit = (employee) =>
      formDialog({
        title: `Change ${employee.name}`,
        description: "The section cannot be changed here; add a new record if they move factory.",
        fields: commonFields(employee.designationId),
        initial: { ...employee, userId: employee.userId ?? "", email: employee.email ?? "" },
        errorFields: ERRORS,
        onSubmit: (values) => {
          call((e, ctx) => e.update(ctx, employee.id, values));
          toast("Employee updated", "good");
          redraw();
        },
      });

    const setStatus = (employee) =>
      formDialog({
        title: `Status of ${employee.name}`,
        description: "Inactive people keep their history. A reason is required for inactive.",
        fields: [
          { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
          { name: "reason", label: "Reason", type: "textarea" },
        ],
        initial: { status: employee.status, reason: employee.statusReason ?? "" },
        errorFields: { reason_required: "reason", invalid_status: "status" },
        onSubmit: (values) => {
          call((e, ctx) => e.setStatus(ctx, employee.id, values));
          toast("Status saved", "good");
          redraw();
        },
      });

    const remove = (employee) =>
      confirmDialog({
        title: `Delete ${employee.name}?`,
        message:
          "Only a record nothing refers to can be deleted. Anyone with assignments or attendance is made inactive instead.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          call((e, ctx) => e.remove(ctx, employee.id));
          toast("Employee deleted", "good");
          redraw();
        },
      });

    const filterSelect = (id, label, value, options, onChange) =>
      h(
        "span",
        {},
        h("label", { for: id }, label),
        " ",
        h(
          "select",
          { id, onchange: (event) => onChange(event.target.value) },
          options.map((option) =>
            h("option", { value: option.value, selected: option.value === value }, option.label)
          )
        )
      );

    return h(
      "div",
      {},
      pageHeader(
        "Employees",
        "Everyone who works in a section, including supervisors.",
        sectionOptions.length > 0 && designationOptions(null).length > 0
          ? button("Add employee", add, { kind: "primary" })
          : null
      ),
      h(
        "div",
        { class: "table-tools" },
        filterSelect(
          "employee-factory",
          "Factory",
          state.factoryId,
          [
            { value: "", label: "All factories" },
            ...factories.map((factory) => ({ value: factory.id, label: factory.name })),
          ],
          (value) => {
            state.factoryId = value;
            redraw();
          }
        ),
        filterSelect(
          "employee-status",
          "Status",
          state.status,
          [{ value: "", label: "Any status" }, ...STATUS_OPTIONS],
          (value) => {
            state.status = value;
            redraw();
          }
        )
      ),
      card(
        null,
        dataTable({
          caption: "Employees",
          columns: [
            { key: "employeeCode", label: "Code", sort: (r) => r.employeeCode },
            {
              key: "name",
              label: "Name",
              sort: (r) => r.name,
              render: (r) =>
                h(
                  "div",
                  {},
                  h("strong", {}, r.name),
                  r.email ? h("div", { class: "muted" }, r.email) : null
                ),
            },
            {
              key: "section",
              label: "Section",
              sort: (r) => nameOf(sections, r.sectionId),
              render: (r) =>
                h(
                  "div",
                  {},
                  nameOf(sections, r.sectionId),
                  h("div", { class: "muted" }, nameOf(factories, r.factoryId))
                ),
            },
            {
              key: "designation",
              label: "Designation",
              sort: (r) => nameOf(designations, r.designationId),
              render: (r) => nameOf(designations, r.designationId),
            },
            { key: "joinDate", label: "Joined", sort: (r) => r.joinDate },
            {
              key: "status",
              label: "Status",
              sort: (r) => r.status,
              render: (r) =>
                h(
                  "div",
                  {},
                  statusBadge(r.status),
                  r.statusReason ? h("div", { class: "muted" }, r.statusReason) : null
                ),
            },
            {
              key: "user",
              label: "Linked user",
              render: (r) =>
                r.userId === null
                  ? h("span", { class: "muted" }, "—")
                  : badge(userName(r.userId) ?? "linked", "info"),
            },
            {
              key: "actions",
              label: "",
              align: "end",
              render: (r) =>
                h(
                  "div",
                  { class: "actions end" },
                  button("Change", () => edit(r), { kind: "link" }),
                  button("Status", () => setStatus(r), { kind: "link" }),
                  button("Delete", () => remove(r), { kind: "link" })
                ),
            },
          ],
          rows: employees,
          rowKey: (r) => r.id,
          rowClass: (r) => (r.status === "inactive" ? "is-inactive" : null),
          searchText: (r) =>
            `${r.employeeCode} ${r.name} ${r.email ?? ""} ${nameOf(sections, r.sectionId)} ${nameOf(designations, r.designationId)}`,
          empty: {
            title: "No employees",
            body: "Add the people who work in each section. Supervisors need a designation that can supervise.",
          },
        })
      )
    );
  });
  return root;
}
