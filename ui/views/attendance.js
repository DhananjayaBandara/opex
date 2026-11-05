// Attendance: the daily register (record or correct one person's day on a shift) and the monthly
// timesheet with the attendance score (UC-PEO-03, FR-ATT-001/002, SRS 10.3, D30, D33).
import { h } from "../dom.js";
import { badge, button, card, formatInstant, mount, notice, pageHeader, toast } from "../kit.js";
import { formDialog, infoDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { org } from "../crud.js";
import { session } from "../session.js";

const STATUSES = {
  P: { label: "Present", tone: "good" },
  AB: { label: "Absent", tone: "bad" },
  LV: { label: "On leave", tone: "warn" },
};
const STATUS_OPTIONS = Object.entries(STATUSES).map(([value, { label }]) => ({ value, label }));
const LEAVE_OPTIONS = [
  { value: "", label: "—" },
  { value: "annual", label: "Annual" },
  { value: "casual", label: "Casual" },
  { value: "medical", label: "Medical" },
  { value: "other", label: "Other" },
];

const ERRORS = {
  invalid_status: "status",
  leave_type_required: "leaveType",
  invalid_time: "clockIn",
  invalid_clock: "clockOut",
  clock_times_incomplete: "clockOut",
  reason_required: "reason",
  invalid_field: "note",
};

const TABS = [
  { id: "daily", label: "Daily register" },
  { id: "monthly", label: "Monthly timesheet" },
];

const minutesText = (minutes) =>
  !minutes ? "—" : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

const statusBadge = (status) => badge(STATUSES[status].label, STATUSES[status].tone);

const changedFields = (before, after) =>
  Object.keys(after)
    .filter((field) => (before[field] ?? null) !== (after[field] ?? null))
    .map((field) => `${field}: ${before[field] ?? "—"} → ${after[field] ?? "—"}`);

export function render() {
  const root = h("div");
  const state = { tab: "daily", factoryId: null, shiftId: null, date: null, month: null };
  mount(root, (redraw) => {
    const app = session.app;
    const call = (action) => session.run((ctx) => action(app.attendance, ctx));
    const today = session.who.today;
    state.date ??= today;
    state.month ??= today.slice(0, 7);
    const factories = org((o, ctx) => o.list(ctx, "factory"));
    if (state.factoryId === null || !factories.some((factory) => factory.id === state.factoryId))
      state.factoryId = factories[0]?.id ?? null;
    const factoryId = state.factoryId;
    const shifts = factoryId ? org((o, ctx) => o.list(ctx, "shift", { factoryId })) : [];
    if (!shifts.some((shift) => shift.id === state.shiftId)) state.shiftId = shifts[0]?.id ?? null;
    const shift = shifts.find((row) => row.id === state.shiftId) ?? null;

    // ---- Dialogs ------------------------------------------------------------------------------

    const dayFields = (reasonRequired) => [
      { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
      {
        name: "leaveType",
        label: "Leave type",
        type: "select",
        options: LEAVE_OPTIONS,
        hint: "Used for leave days only",
      },
      { name: "clockIn", label: "Clock in", type: "time", hint: "Present days only" },
      { name: "clockOut", label: "Clock out", type: "time", hint: "Present days only" },
      { name: "note", label: "Note" },
      ...(reasonRequired
        ? [
            {
              name: "reason",
              label: "Reason for the correction",
              type: "textarea",
              required: true,
            },
          ]
        : []),
    ];
    // Only what applies to the chosen status is sent, so a stale time or leave type never blocks it.
    const dayInput = (values, clearing) => ({
      status: values.status,
      note: values.note,
      leaveType: values.status === "LV" ? values.leaveType : undefined,
      clockIn: values.status === "P" && (clearing || values.clockIn) ? values.clockIn : undefined,
      clockOut:
        values.status === "P" && (clearing || values.clockOut) ? values.clockOut : undefined,
    });

    const record = (row) =>
      formDialog({
        title: `Record ${row.employeeName}`,
        description: `${state.date} on ${shift.name} (${shift.startTime}–${shift.endTime}). Leave the clock times empty for a present day without them.`,
        fields: dayFields(false),
        initial: {
          status: "P",
          leaveType: "",
          clockIn: shift.startTime,
          clockOut: shift.endTime,
        },
        errorFields: ERRORS,
        submitLabel: "Record",
        onSubmit: (values) => {
          call((a, ctx) =>
            a.record(ctx, {
              employeeId: row.employeeId,
              shiftId: shift.id,
              date: state.date,
              ...dayInput(values, false),
            })
          );
          toast("Attendance recorded", "good");
          redraw();
        },
      });

    const correct = (row) => {
      const current = row.record;
      return formDialog({
        title: `Correct ${row.employeeName}`,
        description: `${state.date} on ${shift.name}. The earlier values are kept with your reason.`,
        fields: dayFields(true),
        initial: {
          status: current.status,
          leaveType: current.leaveType ?? "",
          clockIn: current.clockIn ?? "",
          clockOut: current.clockOut ?? "",
          note: current.note ?? "",
          reason: "",
        },
        errorFields: ERRORS,
        submitLabel: "Save correction",
        onSubmit: (values) => {
          call((a, ctx) =>
            a.correct(ctx, current.id, { ...dayInput(values, true), reason: values.reason })
          );
          toast("Correction saved", "good");
          redraw();
        },
      });
    };

    const showHistory = (row) => {
      const corrections = call((a, ctx) => a.history(ctx, row.record.id));
      infoDialog({
        title: `Corrections: ${row.employeeName}, ${state.date}`,
        body:
          corrections.length === 0
            ? h("p", { class: "muted" }, "This day has not been corrected.")
            : h(
                "ol",
                { class: "history" },
                corrections.map((entry) =>
                  h(
                    "li",
                    {},
                    h("strong", {}, entry.reason),
                    ` · ${formatInstant(entry.correctedAt)} · ${entry.correctedByName ?? "system"}`,
                    h(
                      "ul",
                      { class: "muted" },
                      changedFields(entry.before, entry.after).map((text) => h("li", {}, text))
                    )
                  )
                )
              ),
      });
    };

    // ---- Daily register -----------------------------------------------------------------------

    function daily() {
      if (!shift) {
        return card(null, h("p", { class: "muted" }, "This factory has no shift yet."));
      }
      const day = call((a, ctx) =>
        a.daily(ctx, { factoryId, shiftId: shift.id, date: state.date })
      );
      const count = (status) => day.rows.filter((row) => row.record?.status === status).length;
      const open = day.rows.filter((row) => row.record === null).length;
      return h(
        "div",
        {},
        !day.workingDay
          ? notice(
              "This date is not a working day in the factory calendar. You can still record work done.",
              "info"
            )
          : null,
        notice(
          "The register lists everyone in the sections that run this shift. Record only the people who worked it.",
          "info"
        ),
        card(
          null,
          h(
            "div",
            {},
            h(
              "p",
              { class: "muted" },
              `${day.rows.length} listed · ${count("P")} present · ${count("AB")} absent · ${count("LV")} on leave · ${open} not recorded`
            ),
            dataTable({
              caption: "Daily register",
              pageSize: 15,
              columns: [
                { key: "employeeCode", label: "Code", sort: (r) => r.employeeCode },
                {
                  key: "employeeName",
                  label: "Name",
                  sort: (r) => r.employeeName,
                  render: (r) =>
                    h(
                      "div",
                      {},
                      h("strong", {}, r.employeeName),
                      r.employeeStatus === "active"
                        ? null
                        : h("div", { class: "muted" }, r.employeeStatus.replaceAll("_", " "))
                    ),
                },
                { key: "sectionName", label: "Section", sort: (r) => r.sectionName },
                {
                  key: "status",
                  label: "Status",
                  sort: (r) => r.record?.status ?? "",
                  render: (r) =>
                    r.record === null
                      ? h("span", { class: "muted" }, "Not recorded")
                      : h(
                          "div",
                          {},
                          statusBadge(r.record.status),
                          r.record.leaveType
                            ? h("div", { class: "muted" }, r.record.leaveType)
                            : null
                        ),
                },
                {
                  key: "clock",
                  label: "In – out",
                  render: (r) =>
                    r.record?.clockIn ? `${r.record.clockIn} – ${r.record.clockOut}` : "—",
                },
                {
                  key: "worked",
                  label: "Worked",
                  render: (r) => minutesText(r.record?.workedMinutes),
                },
                {
                  key: "late",
                  label: "Late",
                  render: (r) => minutesText(r.record?.lateMinutes),
                },
                {
                  key: "overtime",
                  label: "Overtime",
                  render: (r) => minutesText(r.record?.overtimeMinutes),
                },
                {
                  key: "actions",
                  label: "",
                  align: "end",
                  render: (r) =>
                    h(
                      "div",
                      { class: "actions end" },
                      r.record === null
                        ? button("Record", () => record(r), { kind: "link" })
                        : [
                            button("Correct", () => correct(r), { kind: "link" }),
                            button("History", () => showHistory(r), { kind: "link" }),
                          ]
                    ),
                },
              ],
              rows: day.rows,
              rowKey: (r) => r.employeeId,
              searchText: (r) => `${r.employeeCode} ${r.employeeName} ${r.sectionName}`,
              empty: {
                title: "No one is listed",
                body: "No section runs this shift, or none of its people are in your scope.",
              },
            })
          )
        )
      );
    }

    // ---- Monthly timesheet --------------------------------------------------------------------

    function monthly() {
      const sheet = call((a, ctx) => a.timesheet(ctx, { factoryId, month: state.month }));
      return h(
        "div",
        {},
        notice(
          `Scheduled days follow the factory calendar from the later of the month start and the join date, up to ${sheet.to}. A scheduled day nobody recorded is shown as “Not recorded”; the attendance score counts it as present.`,
          "info"
        ),
        card(
          null,
          dataTable({
            caption: "Monthly timesheet",
            pageSize: 15,
            columns: [
              { key: "employeeCode", label: "Code", sort: (r) => r.employeeCode },
              { key: "employeeName", label: "Name", sort: (r) => r.employeeName },
              { key: "sectionName", label: "Section", sort: (r) => r.sectionName },
              { key: "scheduledDays", label: "Scheduled", sort: (r) => r.scheduledDays },
              { key: "presentDays", label: "Present", sort: (r) => r.presentDays },
              { key: "absentDays", label: "Absent", sort: (r) => r.absentDays },
              { key: "leaveDays", label: "Leave", sort: (r) => r.leaveDays },
              { key: "unrecordedDays", label: "Not recorded", sort: (r) => r.unrecordedDays },
              {
                key: "workedMinutes",
                label: "Worked",
                sort: (r) => r.workedMinutes,
                render: (r) => minutesText(r.workedMinutes),
              },
              {
                key: "lateMinutes",
                label: "Late",
                sort: (r) => r.lateMinutes,
                render: (r) => minutesText(r.lateMinutes),
              },
              {
                key: "overtimeMinutes",
                label: "Overtime",
                sort: (r) => r.overtimeMinutes,
                render: (r) => minutesText(r.overtimeMinutes),
              },
              {
                key: "attendanceScore",
                label: "Score",
                sort: (r) => r.attendanceScore ?? -1,
                render: (r) =>
                  r.attendanceScore === null ? "—" : `${Math.round(r.attendanceScore)}%`,
              },
            ],
            rows: sheet.rows,
            rowKey: (r) => r.employeeId,
            searchText: (r) => `${r.employeeCode} ${r.employeeName} ${r.sectionName}`,
            empty: { title: "No timesheet rows", body: "No one in this factory is in your scope." },
          })
        )
      );
    }

    // ---- Page ---------------------------------------------------------------------------------

    const control = (id, label, input) => h("span", {}, h("label", { for: id }, label), " ", input);
    const tools = [
      control(
        "attendance-factory",
        "Factory",
        h(
          "select",
          {
            id: "attendance-factory",
            onchange: (event) => {
              state.factoryId = event.target.value;
              state.shiftId = null;
              redraw();
            },
          },
          factories.map((factory) =>
            h("option", { value: factory.id, selected: factory.id === factoryId }, factory.name)
          )
        )
      ),
      ...(state.tab === "daily"
        ? [
            control(
              "attendance-shift",
              "Shift",
              h(
                "select",
                {
                  id: "attendance-shift",
                  onchange: (event) => {
                    state.shiftId = event.target.value;
                    redraw();
                  },
                },
                shifts.map((row) =>
                  h(
                    "option",
                    { value: row.id, selected: row.id === state.shiftId },
                    `${row.name} (${row.startTime}–${row.endTime})`
                  )
                )
              )
            ),
            control(
              "attendance-date",
              "Date",
              h("input", {
                id: "attendance-date",
                type: "date",
                value: state.date,
                max: today,
                onchange: (event) => {
                  state.date = event.target.value || today;
                  redraw();
                },
              })
            ),
          ]
        : [
            control(
              "attendance-month",
              "Month",
              h("input", {
                id: "attendance-month",
                type: "month",
                value: state.month,
                max: today.slice(0, 7),
                onchange: (event) => {
                  if (/^\d{4}-\d{2}$/.test(event.target.value)) state.month = event.target.value;
                  redraw();
                },
              })
            ),
          ]),
    ];

    return h(
      "div",
      {},
      pageHeader("Attendance", "Who worked, who was absent and who was on leave."),
      h(
        "nav",
        { class: "tabs", "aria-label": "Attendance views" },
        TABS.map((tab) =>
          h(
            "button",
            {
              type: "button",
              class: "tab",
              "aria-current": tab.id === state.tab ? "page" : null,
              onclick: () => {
                state.tab = tab.id;
                redraw();
              },
            },
            tab.label
          )
        )
      ),
      factoryId
        ? h("div", { class: "table-tools" }, tools)
        : h("p", { class: "muted" }, "Create a factory first; attendance belongs to a factory."),
      factoryId ? (state.tab === "daily" ? daily() : monthly()) : null
    );
  });
  return root;
}
