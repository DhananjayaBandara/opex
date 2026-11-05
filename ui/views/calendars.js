// Working calendars: the weekly pattern per factory and dated exceptions (FR-ORG-006).
import { h } from "../dom.js";
import {
  attempt,
  badge,
  button,
  card,
  mount,
  pageHeader,
  statusBadge,
  toast,
  WEEKDAYS,
} from "../kit.js";
import { formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { FIELD_ERRORS, org, rowActions } from "../crud.js";
import { session } from "../session.js";

export function render() {
  const root = h("div");
  const state = { factoryId: null };
  mount(root, (redraw) => {
    const factories = org((o, ctx) => o.list(ctx, "factory"));
    if (state.factoryId === null || !factories.some((factory) => factory.id === state.factoryId))
      state.factoryId = factories[0]?.id ?? null;
    const manage = session.can("structure.manage");
    const calendars = state.factoryId
      ? org((o, ctx) =>
          o.list(ctx, "calendar", { factoryId: state.factoryId, includeInactive: true })
        )
      : [];
    const exceptions = state.factoryId
      ? org((o, ctx) => o.list(ctx, "calendarException", { factoryId: state.factoryId }))
      : [];
    const weekdayOptions = WEEKDAYS.map((label, value) => ({ value, label }));

    const editCalendar = (calendar) =>
      formDialog({
        title: calendar ? `Edit ${calendar.name}` : "New calendar",
        fields: [
          { name: "name", label: "Name", required: true },
          {
            name: "nonWorkingWeekdays",
            label: "Non-working weekdays",
            type: "checkboxes",
            options: weekdayOptions,
            inline: true,
          },
        ],
        initial: calendar ?? { nonWorkingWeekdays: [0] },
        errorFields: FIELD_ERRORS,
        onSubmit: (values) => {
          if (calendar) org((o, ctx) => o.update(ctx, "calendar", calendar.id, values));
          else
            org((o, ctx) => o.create(ctx, "calendar", { ...values, factoryId: state.factoryId }));
          toast("Calendar saved", "good");
          redraw();
        },
      });
    const addException = (calendar) =>
      formDialog({
        title: `Add an exception to ${calendar.name}`,
        fields: [
          { name: "date", label: "Date", type: "date", required: true },
          { name: "working", label: "This date is a working day", type: "checkbox" },
          { name: "reason", label: "Reason", hint: "For example Poya day, or Saturday overtime" },
        ],
        initial: { working: false },
        errorFields: FIELD_ERRORS,
        onSubmit: (values) => {
          org((o, ctx) =>
            o.create(ctx, "calendarException", { ...values, calendarId: calendar.id })
          );
          toast("Exception added", "good");
          redraw();
        },
      });

    const select = h(
      "select",
      {
        id: "calendar-factory",
        onchange: (event) => {
          state.factoryId = event.target.value;
          redraw();
        },
      },
      factories.map((factory) =>
        h("option", { value: factory.id, selected: factory.id === state.factoryId }, factory.name)
      )
    );

    return h(
      "div",
      {},
      pageHeader(
        "Calendars",
        "Working days per factory. Exceptions override the weekly pattern.",
        manage && state.factoryId
          ? button("New calendar", () => editCalendar(null), { kind: "primary" })
          : null
      ),
      h(
        "div",
        { class: "table-tools" },
        h("label", { for: "calendar-factory" }, "Factory"),
        select
      ),
      !state.factoryId
        ? card(
            null,
            h("p", { class: "muted" }, "Create a factory first; calendars belong to a factory.")
          )
        : calendars.length === 0
          ? card(null, h("p", { class: "muted" }, "This factory has no calendar yet."))
          : calendars.map((calendar) =>
              card(
                calendar.name,
                h(
                  "div",
                  {},
                  h(
                    "p",
                    {},
                    statusBadge(calendar.active ? "active" : "inactive"),
                    " ",
                    "Non-working: ",
                    calendar.nonWorkingWeekdays.length
                      ? calendar.nonWorkingWeekdays.map((day) => badge(WEEKDAYS[day]))
                      : "none (every day is a working day)"
                  ),
                  dataTable({
                    caption: `Exceptions of ${calendar.name}`,
                    columns: [
                      { key: "date", label: "Date", sort: (r) => r.date },
                      {
                        key: "working",
                        label: "Day type",
                        render: (r) =>
                          r.working
                            ? badge("Working day", "good")
                            : badge("Non-working day", "muted"),
                      },
                      { key: "reason", label: "Reason", render: (r) => r.reason ?? "—" },
                      ...(manage
                        ? [
                            {
                              key: "x",
                              label: "",
                              align: "end",
                              render: (r) =>
                                button(
                                  "Remove",
                                  () => {
                                    attempt(
                                      () =>
                                        org((o, ctx) => o.remove(ctx, "calendarException", r.id)),
                                      "Exception removed"
                                    );
                                    redraw();
                                  },
                                  { kind: "link" }
                                ),
                            },
                          ]
                        : []),
                    ],
                    rows: exceptions.filter((exception) => exception.calendarId === calendar.id),
                    pageSize: 8,
                    empty: {
                      title: "No exceptions",
                      body: "The weekly pattern applies to every date.",
                    },
                  })
                ),
                ...(manage
                  ? [
                      button("Add exception", () => addException(calendar), { kind: "secondary" }),
                      button("Edit", () => editCalendar(calendar), { kind: "secondary" }),
                      ...rowActions({ kind: "calendar", row: calendar, noun: "calendar", redraw }),
                    ]
                  : [])
              )
            )
    );
  });
  return root;
}
