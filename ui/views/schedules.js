// Scheduled reports (C129, C130; D69): a report that is produced on a repeating timetable and sent to
// named members. A schedule runs with its owner's authority at the time it runs. The prototype has no
// background scheduler, so "Run due schedules" does what one would; a missed run is not replayed.
import { h } from "../dom.js";
import { notificationsChanged } from "../download.js";
import {
  attempt,
  badge,
  button,
  card,
  emptyState,
  formatInstant,
  mount,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { confirmDialog, formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import {
  EXPORTS_PAGE,
  option,
  plural,
  queryValue,
  reportService,
  selectControl,
} from "./communication-common.js";
import { control } from "./production-common.js";

const RUN_TONES = { completed: "good", failed: "bad", skipped: "warn", partial: "warn" };

const pairs = (object, number = false) =>
  Object.entries(object).map(([value, label]) => ({
    value: number ? Number(value) : value,
    label,
  }));

const ERROR_FIELDS = {
  invalid_name: "name",
  invalid_period: "periodKind",
  invalid_recurrence: "time",
  invalid_recipients: "recipientIds",
  invalid_recipient: "recipientIds",
};

function fieldsFor(catalogue, recipients, { withRecipients }) {
  return [
    { name: "name", label: "Name", type: "text", required: true, maxlength: 80 },
    {
      name: "periodKind",
      label: "Period each report covers",
      type: "select",
      options: pairs(catalogue.periods),
    },
    { name: "cadence", label: "Repeats", type: "select", options: pairs(catalogue.cadences) },
    {
      name: "time",
      label: "Time of day",
      type: "time",
      required: true,
      hint: `In the tenant's time zone (${catalogue.timeZone}).`,
    },
    {
      name: "weekday",
      label: "Weekday (weekly reports)",
      type: "select",
      options: pairs(catalogue.weekdays, true),
    },
    {
      name: "dayOfMonth",
      label: "Day of the month (monthly reports, 1 to 28)",
      type: "number",
      min: 1,
      max: 28,
    },
    ...(withRecipients
      ? [
          {
            name: "recipientIds",
            label: "Send to",
            type: "checkboxes",
            options:
              recipients.length === 0
                ? [{ value: "", label: "No member can receive this report yet", disabled: true }]
                : recipients.map((member) => ({ value: member.id, label: member.name })),
            hint: "Only members who can use this report, in a factory it covers, can receive it.",
          },
        ]
      : []),
  ];
}

const recurrenceOf = (values) => ({
  cadence: values.cadence,
  time: values.time,
  weekday: values.weekday,
  dayOfMonth: values.dayOfMonth,
});

function create(catalogue, report, factoryId, redraw) {
  const filters = factoryId ? { factoryId } : {};
  const recipients = reportService((s, ctx) =>
    s.recipientOptions(ctx, { report: report.key, filters })
  );
  return formDialog({
    title: `New scheduled report: ${report.label}`,
    description: factoryId
      ? `For ${catalogue.factories.find((factory) => factory.id === factoryId)?.name ?? "the chosen factory"}.`
      : "For every factory you can see.",
    fields: fieldsFor(catalogue, recipients, { withRecipients: true }),
    initial: {
      name: "",
      periodKind: "last_7_days",
      cadence: "weekly",
      time: "07:00",
      weekday: 1,
      dayOfMonth: 1,
      recipientIds: [],
    },
    submitLabel: "Create schedule",
    errorFields: ERROR_FIELDS,
    onSubmit: (values) =>
      reportService((s, ctx) =>
        s.createSchedule(ctx, {
          name: values.name,
          report: report.key,
          filters,
          periodKind: values.periodKind,
          recurrence: recurrenceOf(values),
          recipientIds: values.recipientIds,
        })
      ),
  }).then((saved) => saved && redraw());
}

function edit(catalogue, schedule, redraw) {
  const recipients = schedule.mine
    ? reportService((s, ctx) =>
        s.recipientOptions(ctx, { report: schedule.report, filters: schedule.filters })
      )
    : [];
  return formDialog({
    title: `Edit scheduled report: ${schedule.name}`,
    description: schedule.mine
      ? "The report and the factory cannot be changed. Create another schedule for a different one."
      : "You can change the timetable. Only the owner changes who receives it.",
    fields: fieldsFor(catalogue, recipients, { withRecipients: schedule.mine }),
    initial: {
      name: schedule.name,
      periodKind: schedule.periodKind,
      cadence: schedule.recurrence.cadence,
      time: schedule.recurrence.time,
      weekday: schedule.recurrence.weekday ?? 1,
      dayOfMonth: schedule.recurrence.dayOfMonth ?? 1,
      recipientIds: schedule.recipients.map((member) => member.id),
    },
    submitLabel: "Save changes",
    errorFields: { ...ERROR_FIELDS, conflict: "name" },
    onSubmit: (values) =>
      reportService((s, ctx) =>
        s.updateSchedule(ctx, schedule.id, {
          expectedVersion: schedule.version,
          name: values.name,
          periodKind: values.periodKind,
          recurrence: recurrenceOf(values),
          ...(schedule.mine ? { recipientIds: values.recipientIds } : {}),
        })
      ),
  }).then((saved) => saved && redraw());
}

const ACTIONS = {
  enable: {
    title: "Switch this schedule on",
    label: "Switch on",
    message:
      "It will run at its next time. A run that was missed while it was off is not replayed.",
    done: "Schedule switched on",
  },
  disable: {
    title: "Switch this schedule off",
    label: "Switch off",
    message: "It stops running until someone switches it on again.",
    done: "Schedule switched off",
  },
  run_now: {
    title: "Run this schedule now",
    label: "Run now",
    message:
      "It produces the report for its period, as its owner, and sends it to the recipients. The next planned time does not change.",
    done: "Schedule run",
  },
};

function transition(schedule, action, redraw) {
  const spec = ACTIONS[action];
  return confirmDialog({
    title: `${spec.title}: ${schedule.name}`,
    message: spec.message,
    confirmLabel: spec.label,
    reason: true,
    onConfirm: (reason) => {
      reportService((s, ctx) =>
        s.transitionSchedule(ctx, schedule.id, {
          action,
          reason,
          expectedVersion: schedule.version,
        })
      );
      toast(spec.done, "good");
      notificationsChanged();
    },
  }).then((saved) => saved && redraw());
}

function runDue(redraw) {
  const result = attempt(() => reportService((s, ctx) => s.runDue(ctx)));
  if (result === undefined) return;
  const failed = result.outcomes.filter((outcome) => outcome.status === "failed").length;
  toast(
    result.ran === 0
      ? "No schedule is due"
      : `${plural(result.ran, "schedule")} ran${failed > 0 ? `, ${failed} failed` : ""}`,
    failed > 0 ? "warn" : "good"
  );
  notificationsChanged();
  redraw();
}

export function render() {
  const root = h("div");
  const highlighted = queryValue("id");
  const state = { report: "", factoryId: "" };
  mount(root, (redraw) => {
    const catalogue = reportService((s, ctx) => s.catalogue(ctx));
    const schedules = reportService((s, ctx) => s.schedules(ctx));
    const reports = catalogue.reports;
    const chosen = reports.find((report) => report.key === state.report) ?? reports[0] ?? null;
    state.report = chosen?.key ?? "";
    const due = schedules.filter((schedule) => schedule.due).length;
    const factoryName = (id) =>
      catalogue.factories.find((factory) => factory.id === id)?.name ?? id;
    return h(
      "div",
      {},
      pageHeader(
        "Scheduled reports",
        "Reports produced on a timetable and sent to the members you choose.",
        button(due > 0 ? `Run due schedules (${due})` : "Run due schedules", () => runDue(redraw), {
          kind: "secondary",
          title: "The prototype has no background scheduler; this runs every schedule that is due",
        })
      ),
      chosen === null
        ? emptyState({
            title: "No report available to you",
            body: "A schedule needs the permission to schedule reports and access to the figures in the report.",
          })
        : card(
            "New scheduled report",
            h(
              "div",
              { class: "table-tools" },
              control(
                "sc-report",
                "Report",
                h(
                  "select",
                  {
                    id: "sc-report",
                    onchange: (event) => {
                      state.report = event.target.value;
                      redraw();
                    },
                  },
                  reports.map((report) =>
                    option(report.key, report.label, report.key === chosen.key)
                  )
                )
              ),
              chosen.filters.includes("factoryId")
                ? selectControl(
                    "sc-factory",
                    "Factory",
                    catalogue.factories,
                    state.factoryId,
                    (value) => (state.factoryId = value),
                    "All my factories"
                  )
                : null,
              button("New schedule", () => create(catalogue, chosen, state.factoryId, redraw), {
                kind: "primary",
              })
            ),
            h("p", { class: "muted" }, chosen.description)
          ),
      card(
        "Schedules",
        schedules.length === 0
          ? emptyState({
              title: "No scheduled reports yet",
              body: "Create one above. It is produced at the times you set and sent to its recipients.",
            })
          : dataTable({
              caption: "Scheduled reports",
              pageSize: 10,
              rows: schedules,
              searchText: (schedule) =>
                `${schedule.name} ${schedule.reportLabel} ${schedule.owner.name}`,
              rowClass: (schedule) => (schedule.id === highlighted ? "row-highlight" : ""),
              columns: [
                {
                  key: "name",
                  label: "Schedule",
                  sort: (schedule) => schedule.name,
                  render: (schedule) =>
                    h(
                      "div",
                      {},
                      h("strong", {}, schedule.name),
                      h(
                        "div",
                        { class: "muted" },
                        `${schedule.reportLabel} · ${schedule.filters.factoryId ? factoryName(schedule.filters.factoryId) : "all factories"}`
                      ),
                      h(
                        "div",
                        { class: "muted" },
                        `${schedule.periodLabel} · owner ${schedule.mine ? "you" : (schedule.owner.name ?? "someone")}`
                      )
                    ),
                },
                {
                  key: "recurrence",
                  label: "Runs",
                  render: (schedule) =>
                    h(
                      "div",
                      {},
                      schedule.recurrenceText,
                      h("div", { class: "muted" }, schedule.timeZone)
                    ),
                },
                {
                  key: "recipients",
                  label: "Sent to",
                  render: (schedule) =>
                    schedule.recipients.map((member) => member.name ?? "someone").join(", "),
                },
                {
                  key: "status",
                  label: "Status",
                  sort: (schedule) => schedule.status,
                  render: (schedule) =>
                    h(
                      "div",
                      {},
                      statusBadge(schedule.status),
                      schedule.due ? badge("due", "warn") : null,
                      schedule.status === "enabled" && schedule.nextRunAt
                        ? h("div", { class: "muted" }, `Next ${formatInstant(schedule.nextRunAt)}`)
                        : null
                    ),
                },
                {
                  key: "last",
                  label: "Last run",
                  sort: (schedule) => schedule.lastRunAt ?? "",
                  render: (schedule) =>
                    schedule.lastRunAt === null
                      ? h("span", { class: "muted" }, "Not run yet")
                      : h(
                          "div",
                          {},
                          badge(
                            schedule.lastRunStatus ?? "run",
                            RUN_TONES[schedule.lastRunStatus] ?? "neutral"
                          ),
                          h("div", { class: "muted" }, formatInstant(schedule.lastRunAt)),
                          schedule.lastRunNote
                            ? h("div", { class: "muted" }, schedule.lastRunNote)
                            : null,
                          schedule.lastJobId
                            ? h(
                                "a",
                                {
                                  href: `${EXPORTS_PAGE}?job=${encodeURIComponent(schedule.lastJobId)}`,
                                },
                                "See the export"
                              )
                            : null
                        ),
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (schedule) =>
                    h(
                      "div",
                      { class: "actions" },
                      button("Edit", () => edit(catalogue, schedule, redraw)),
                      schedule.status === "enabled"
                        ? button("Switch off", () => transition(schedule, "disable", redraw))
                        : button("Switch on", () => transition(schedule, "enable", redraw)),
                      button("Run now", () => transition(schedule, "run_now", redraw))
                    ),
                },
              ],
            })
      )
    );
  });
  return root;
}
