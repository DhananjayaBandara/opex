// Supervisor assignments: who supervises which section on which shift, from when to when. History is
// kept: an assignment is ended or reassigned, never overwritten (UC-PEO-02, FR-SUPA-001..005, D31, D32).
import { h } from "../dom.js";
import { addDays } from "../../domain/effective-dating.js";
import {
  button,
  card,
  formatInstant,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { confirmDialog, formDialog, infoDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { org } from "../crud.js";
import { session } from "../session.js";

const POLICIES = {
  warn: {
    label: "Warn",
    text: "An overlapping assignment is allowed only after the person confirms it.",
  },
  block: { label: "Block", text: "An overlapping assignment is refused." },
  allow: { label: "Allow", text: "Overlapping assignments are allowed without a warning." },
};

const ERRORS = {
  overlap_warning: "acknowledge",
  duplicate_assignment: "employeeId",
  employee_not_active: "employeeId",
  not_supervisor_eligible: "employeeId",
  cross_factory: "sectionShiftId",
  inactive_parent: "sectionShiftId",
  no_change: "sectionShiftId",
  past_effective_date: "effectiveFrom",
  invalid_range: "effectiveFrom",
  invalid_replacement: "effectiveFrom",
  assignment_ended: "effectiveFrom",
};

const OPEN_END = "no end date";

export function render() {
  const root = h("div");
  const state = { factoryId: null, status: "" };
  mount(root, (redraw) => {
    const app = session.app;
    const call = (action) => session.run((ctx) => action(app.assignments, ctx));
    const factories = org((o, ctx) => o.list(ctx, "factory"));
    if (state.factoryId === null || !factories.some((factory) => factory.id === state.factoryId))
      state.factoryId = factories[0]?.id ?? null;
    const factoryId = state.factoryId;
    const today = session.who.today;
    const policy = call((a, ctx) => a.policy(ctx)).policy;
    const tenantWide = session.who.factoryScope?.all === true && !session.who.assignmentScoped;

    const rows = factoryId
      ? call((a, ctx) =>
          a.list(ctx, { factoryId, ...(state.status ? { status: state.status } : {}) })
        )
      : [];
    const supervisors = factoryId ? call((a, ctx) => a.supervisors(ctx, { factoryId })) : [];
    const sections = factoryId ? org((o, ctx) => o.list(ctx, "section", { factoryId })) : [];
    const shifts = factoryId ? org((o, ctx) => o.list(ctx, "shift", { factoryId })) : [];
    const links = factoryId ? org((o, ctx) => o.list(ctx, "sectionShift", { factoryId })) : [];

    const supervisorOptions = supervisors.map((person) => ({
      value: person.id,
      label: `${person.name} (${person.employeeCode})`,
    }));
    // A reassignment keeps the current supervisor selectable even if they can no longer be assigned,
    // so the service explains the refusal instead of the form silently picking someone else.
    const supervisorChoices = (row) =>
      supervisorOptions.some((option) => option.value === row.employeeId)
        ? supervisorOptions
        : [
            { value: row.employeeId, label: `${row.employeeName} (${row.employeeCode})` },
            ...supervisorOptions,
          ];
    const sectionShiftOptions = links.map((link) => {
      const section = sections.find((row) => row.id === link.sectionId);
      const shift = shifts.find((row) => row.id === link.shiftId);
      return {
        value: link.id,
        label: `${section?.name ?? "section"} on ${shift?.name ?? "shift"} (${shift?.startTime}–${shift?.endTime})`,
      };
    });

    // When an overlap is refused, say which assignments it meets (the service names them in a preview).
    const explain = (error, input) => {
      if (!error.conflicts?.length) return error;
      try {
        const { conflicts } = call((a, ctx) => a.preview(ctx, input));
        const named = conflicts
          .map(
            ({ assignment: a }) =>
              `${a.employeeName} on ${a.sectionName} / ${a.shiftName}, ${a.effectiveFrom} to ${a.effectiveTo ?? OPEN_END}`
          )
          .join("; ");
        return Object.assign(new Error(`${error.message}: ${named}`), { code: error.code });
      } catch {
        return error;
      }
    };
    const submitWith = (input, action, done) => {
      try {
        action();
      } catch (error) {
        throw explain(error, input);
      }
      toast(done, "good");
      redraw();
    };

    const acknowledge = {
      name: "acknowledge",
      label: "I understand this may overlap another assignment and want to continue",
      type: "checkbox",
      hint: `The organization's policy is “${POLICIES[policy].label}”. ${POLICIES[policy].text}`,
    };
    const dateFields = [
      { name: "effectiveFrom", label: "Starts on", type: "date", required: true },
      { name: "effectiveTo", label: "Ends on (optional)", type: "date" },
      { name: "note", label: "Note" },
    ];

    const assign = () =>
      formDialog({
        title: "Assign a supervisor",
        description:
          "An assignment cannot start before today. Only active employees whose designation can supervise are listed.",
        fields: [
          { name: "employeeId", label: "Supervisor", type: "select", options: supervisorOptions },
          {
            name: "sectionShiftId",
            label: "Section and shift",
            type: "select",
            options: sectionShiftOptions,
          },
          ...dateFields,
          acknowledge,
        ],
        initial: { effectiveFrom: today, acknowledge: false },
        errorFields: ERRORS,
        onSubmit: (values) => {
          const input = { ...values, effectiveTo: values.effectiveTo || undefined };
          submitWith(input, () => call((a, ctx) => a.assign(ctx, input)), "Supervisor assigned");
        },
      });

    const reassign = (row) =>
      formDialog({
        title: `Reassign ${row.sectionName} on ${row.shiftName}`,
        description: `${row.employeeName} stays on record until the day before the new assignment starts. Keep a choice as it is to change only the other.`,
        fields: [
          {
            name: "employeeId",
            label: "Supervisor",
            type: "select",
            options: supervisorChoices(row),
          },
          {
            name: "sectionShiftId",
            label: "Section and shift",
            type: "select",
            options: sectionShiftOptions,
          },
          ...dateFields,
          acknowledge,
        ],
        initial: {
          employeeId: row.employeeId,
          sectionShiftId: row.sectionShiftId,
          effectiveFrom: row.effectiveFrom < today ? today : addDays(today, 1),
          acknowledge: false,
        },
        errorFields: ERRORS,
        onSubmit: (values) => {
          const input = { ...values, effectiveTo: values.effectiveTo || undefined };
          submitWith(
            { ...input, replaces: row.id },
            () => call((a, ctx) => a.reassign(ctx, row.id, input)),
            "Assignment moved"
          );
        },
      });

    const end = (row) =>
      formDialog({
        title: `End ${row.employeeName}'s assignment`,
        description: `${row.sectionName} on ${row.shiftName}, since ${row.effectiveFrom}. The last day can be yesterday at the earliest.`,
        fields: [
          { name: "effectiveTo", label: "Last day", type: "date", required: true },
          { name: "reason", label: "Reason (optional)", type: "textarea" },
        ],
        initial: { effectiveTo: today },
        errorFields: {
          past_effective_date: "effectiveTo",
          invalid_range: "effectiveTo",
          no_change: "effectiveTo",
        },
        submitLabel: "End assignment",
        danger: true,
        onSubmit: (values) =>
          submitWith(
            values,
            () => call((a, ctx) => a.end(ctx, row.id, values)),
            "Assignment ended"
          ),
      });

    const cancel = (row) =>
      confirmDialog({
        title: "Cancel this assignment?",
        message: `${row.employeeName} would no longer start on ${row.sectionName} / ${row.shiftName} on ${row.effectiveFrom}.${
          row.replacesId ? " The assignment it replaced is restored." : ""
        }`,
        confirmLabel: "Cancel assignment",
        danger: true,
        onConfirm: () => {
          call((a, ctx) => a.cancel(ctx, row.id));
          toast("Assignment cancelled", "good");
          redraw();
        },
      });

    const showHistory = (row) => {
      const events = call((a, ctx) => a.history(ctx, row.id));
      infoDialog({
        title: `History: ${row.employeeName}, ${row.sectionName} on ${row.shiftName}`,
        body:
          events.length === 0
            ? h("p", { class: "muted" }, "Nothing has been recorded yet.")
            : h(
                "ol",
                { class: "history" },
                events.map((event) =>
                  h(
                    "li",
                    {},
                    h("strong", {}, event.action.replaceAll("_", " ")),
                    ` · ${formatInstant(event.at)} · ${event.actorName ?? "system"}`,
                    Object.keys(event.changes ?? {}).length > 0
                      ? h(
                          "ul",
                          { class: "muted" },
                          Object.entries(event.changes).map(([field, change]) =>
                            h(
                              "li",
                              {},
                              `${field}: ${change.before ?? "—"} → ${change.after ?? "—"}`
                            )
                          )
                        )
                      : null
                  )
                )
              ),
      });
    };

    const changePolicy = () =>
      formDialog({
        title: "Overlap policy",
        description:
          "What happens when someone is assigned to a section-shift that already has a supervisor in the same dates. The same person on the same section-shift twice is always refused.",
        fields: [
          {
            name: "policy",
            label: "Policy",
            type: "select",
            options: Object.entries(POLICIES).map(([value, { label, text }]) => ({
              value,
              label: `${label}: ${text}`,
            })),
          },
        ],
        initial: { policy },
        errorFields: { invalid_policy: "policy" },
        onSubmit: (values) => {
          call((a, ctx) => a.setPolicy(ctx, values));
          toast("Policy saved", "good");
          redraw();
        },
      });

    const actionsFor = (row) => {
      const buttons = [];
      if (row.status === "current") {
        buttons.push(
          button("Reassign", () => reassign(row), { kind: "link" }),
          button("End", () => end(row), { kind: "link" })
        );
      } else if (row.status === "scheduled") {
        buttons.push(button("Cancel", () => cancel(row), { kind: "link" }));
      }
      buttons.push(button("History", () => showHistory(row), { kind: "link" }));
      return h("div", { class: "actions end" }, buttons);
    };

    return h(
      "div",
      {},
      pageHeader(
        "Supervisor assignments",
        "Who supervises each section and shift, and for how long.",
        factoryId && supervisorOptions.length > 0 && sectionShiftOptions.length > 0
          ? button("Assign supervisor", assign, { kind: "primary" })
          : null
      ),
      card(
        "Overlap policy",
        h(
          "div",
          { class: "split" },
          h("p", {}, h("strong", {}, POLICIES[policy].label), ` · ${POLICIES[policy].text}`),
          tenantWide
            ? button("Change policy", changePolicy, { kind: "secondary" })
            : h(
                "p",
                { class: "muted" },
                "Only a person with access to every factory can change the policy."
              )
        )
      ),
      !factoryId
        ? card(
            null,
            h("p", { class: "muted" }, "Create a factory first; assignments belong to one.")
          )
        : h(
            "div",
            {},
            h(
              "div",
              { class: "table-tools" },
              h("label", { for: "assignment-factory" }, "Factory"),
              h(
                "select",
                {
                  id: "assignment-factory",
                  onchange: (event) => {
                    state.factoryId = event.target.value;
                    redraw();
                  },
                },
                factories.map((factory) =>
                  h(
                    "option",
                    { value: factory.id, selected: factory.id === factoryId },
                    factory.name
                  )
                )
              ),
              h("label", { for: "assignment-status" }, "Status"),
              h(
                "select",
                {
                  id: "assignment-status",
                  onchange: (event) => {
                    state.status = event.target.value;
                    redraw();
                  },
                },
                [
                  ["", "Any status"],
                  ["current", "Current"],
                  ["scheduled", "Scheduled"],
                  ["ended", "Ended"],
                ].map(([value, label]) =>
                  h("option", { value, selected: value === state.status }, label)
                )
              )
            ),
            supervisorOptions.length === 0
              ? notice(
                  "This factory has no employee who can supervise. Add one under Employees with a designation that can supervise.",
                  "info"
                )
              : null,
            card(
              null,
              dataTable({
                caption: "Supervisor assignments",
                columns: [
                  {
                    key: "employee",
                    label: "Supervisor",
                    sort: (r) => r.employeeName,
                    render: (r) =>
                      h(
                        "div",
                        {},
                        h("strong", {}, r.employeeName),
                        h("div", { class: "muted" }, r.employeeCode)
                      ),
                  },
                  { key: "sectionName", label: "Section", sort: (r) => r.sectionName },
                  { key: "shiftName", label: "Shift", sort: (r) => r.shiftName },
                  { key: "effectiveFrom", label: "From", sort: (r) => r.effectiveFrom },
                  {
                    key: "effectiveTo",
                    label: "To",
                    sort: (r) => r.effectiveTo ?? "9999-12-31",
                    render: (r) => r.effectiveTo ?? h("span", { class: "muted" }, "open"),
                  },
                  {
                    key: "status",
                    label: "Status",
                    sort: (r) => r.status,
                    render: (r) =>
                      h(
                        "div",
                        {},
                        statusBadge(r.status),
                        r.endReason ? h("div", { class: "muted" }, r.endReason) : null,
                        r.note ? h("div", { class: "muted" }, r.note) : null
                      ),
                  },
                  { key: "actions", label: "", align: "end", render: actionsFor },
                ],
                rows,
                rowClass: (r) => (r.status === "ended" ? "is-inactive" : null),
                searchText: (r) =>
                  `${r.employeeName} ${r.employeeCode} ${r.sectionName} ${r.shiftName} ${r.status}`,
                empty: {
                  title: "No assignments in this factory",
                  body: "Assign a supervisor to a section and shift to start.",
                },
              })
            )
          )
    );
  });
  return root;
}
