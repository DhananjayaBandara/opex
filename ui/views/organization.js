// Organization structure: sections, shifts, section-shift links, lines and designations
// (FR-ORG-002..005, UC-ORG-01..05). A factory filter applies to everything but designations.
import { h } from "../dom.js";
import { attempt, badge, button, card, mount, pageHeader, statusBadge, toast } from "../kit.js";
import { formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { FIELD_ERRORS, org, rowActions } from "../crud.js";
import { session } from "../session.js";

const TABS = [
  { id: "sections", label: "Sections", needs: "structure.manage" },
  { id: "shifts", label: "Shifts", needs: "structure.manage" },
  { id: "links", label: "Section shifts", needs: "section_shift.manage" },
  { id: "lines", label: "Lines", needs: "structure.manage" },
  { id: "designations", label: "Designations", needs: "employee.manage" },
];

export function render() {
  const root = h("div");
  const state = { tab: "sections", factoryId: null };
  mount(root, (redraw) => {
    const factories = org((o, ctx) => o.list(ctx, "factory"));
    if (state.factoryId === null || !factories.some((factory) => factory.id === state.factoryId))
      state.factoryId = factories[0]?.id ?? null;
    const factoryId = state.factoryId;
    const list = (kind, extra = {}) =>
      factoryId
        ? org((o, ctx) => o.list(ctx, kind, { factoryId, includeInactive: true, ...extra }))
        : [];
    const manage = (tab) => session.can(TABS.find((entry) => entry.id === tab).needs);
    const save =
      (kind, existing, extraFields = {}) =>
      (values) => {
        if (existing) org((o, ctx) => o.update(ctx, kind, existing.id, values));
        else org((o, ctx) => o.create(ctx, kind, { ...values, ...extraFields }));
        toast("Saved", "good");
        redraw();
      };
    const form = (title, fields, initial, kind, existing, extraFields) =>
      formDialog({
        title,
        fields,
        initial,
        errorFields: FIELD_ERRORS,
        onSubmit: save(kind, existing, extraFields),
      });
    const mover = (kind, rows, options) => (index, step) => {
      const ids = rows.map((row) => row.id);
      [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
      attempt(() => org((o, ctx) => o.reorder(ctx, kind, ids, options)));
      redraw();
    };
    const arrows = (rows, move) => (r) => {
      const index = rows.findIndex((row) => row.id === r.id);
      return [
        button("↑", () => move(index, -1), {
          kind: "link",
          title: "Move up",
          disabled: index === 0,
        }),
        button("↓", () => move(index, 1), {
          kind: "link",
          title: "Move down",
          disabled: index === rows.length - 1,
        }),
      ];
    };
    const actionColumn = (render) => ({
      key: "actions",
      label: "",
      align: "end",
      render: (r) => h("div", { class: "actions end" }, render(r)),
    });

    const sections = list("section");
    const shifts = list("shift");
    const nameOf = (rows, id) => rows.find((row) => row.id === id)?.name ?? "—";

    function sectionsTab() {
      const can = manage("sections");
      const move = mover("section", sections, { factoryId });
      const fields = [
        { name: "code", label: "Code", required: true },
        { name: "name", label: "Name", required: true },
      ];
      const up = arrows(sections, move);
      return panel(
        "Sections",
        can && factoryId
          ? button(
              "New section",
              () => form("New section", fields, {}, "section", null, { factoryId }),
              { kind: "primary" }
            )
          : null,
        dataTable({
          caption: "Sections",
          columns: [
            { key: "code", label: "Code" },
            { key: "name", label: "Name" },
            {
              key: "active",
              label: "Status",
              render: (r) => statusBadge(r.active ? "active" : "inactive"),
            },
            ...(can
              ? [
                  actionColumn((r) => [
                    up(r),
                    button("Edit", () => form(`Edit ${r.name}`, fields, r, "section", r), {
                      kind: "link",
                    }),
                    rowActions({ kind: "section", row: r, noun: "section", redraw }),
                  ]),
                ]
              : []),
          ],
          rows: sections,
          rowClass: (r) => (r.active ? null : "is-inactive"),
          searchText: (r) => `${r.code} ${r.name}`,
          empty: { title: "No sections in this factory" },
        })
      );
    }

    function shiftsTab() {
      const can = manage("shifts");
      const move = mover("shift", shifts, { factoryId });
      const fields = [
        { name: "code", label: "Code", required: true },
        { name: "name", label: "Name", required: true },
        { name: "startTime", label: "Starts", type: "time", required: true },
        {
          name: "endTime",
          label: "Ends",
          type: "time",
          required: true,
          hint: "A shift that ends earlier than it starts runs overnight",
        },
      ];
      const up = arrows(shifts, move);
      return panel(
        "Shifts",
        can && factoryId
          ? button("New shift", () => form("New shift", fields, {}, "shift", null, { factoryId }), {
              kind: "primary",
            })
          : null,
        dataTable({
          caption: "Shifts",
          columns: [
            { key: "code", label: "Code" },
            { key: "name", label: "Name" },
            { key: "time", label: "Time", render: (r) => `${r.startTime}–${r.endTime}` },
            {
              key: "duration",
              label: "Duration",
              render: (r) =>
                h(
                  "span",
                  {},
                  `${Math.floor(r.durationMinutes / 60)}h ${r.durationMinutes % 60}m `,
                  r.overnight ? badge("overnight", "info") : null
                ),
            },
            {
              key: "active",
              label: "Status",
              render: (r) => statusBadge(r.active ? "active" : "inactive"),
            },
            ...(can
              ? [
                  actionColumn((r) => [
                    up(r),
                    button("Edit", () => form(`Edit ${r.name}`, fields, r, "shift", r), {
                      kind: "link",
                    }),
                    rowActions({ kind: "shift", row: r, noun: "shift", redraw }),
                  ]),
                ]
              : []),
          ],
          rows: shifts,
          rowClass: (r) => (r.active ? null : "is-inactive"),
          searchText: (r) => `${r.code} ${r.name}`,
          empty: { title: "No shifts in this factory" },
        })
      );
    }

    function linksTab() {
      const can = manage("links");
      const links = list("sectionShift");
      const live = (rows) => rows.filter((row) => row.active);
      const add = () =>
        formDialog({
          title: "Run a section on a shift",
          fields: [
            {
              name: "sectionId",
              label: "Section",
              type: "select",
              options: live(sections).map((s) => ({ value: s.id, label: s.name })),
            },
            {
              name: "shiftId",
              label: "Shift",
              type: "select",
              options: live(shifts).map((s) => ({
                value: s.id,
                label: `${s.name} (${s.startTime}–${s.endTime})`,
              })),
            },
          ],
          initial: {},
          onSubmit: (values) => {
            org((o, ctx) => o.create(ctx, "sectionShift", values));
            toast("Section shift added", "good");
            redraw();
          },
        });
      return panel(
        "Section shifts",
        can && live(sections).length && live(shifts).length
          ? button("Add section shift", add, { kind: "primary" })
          : null,
        dataTable({
          caption: "Section shifts",
          columns: [
            {
              key: "section",
              label: "Section",
              sort: (r) => nameOf(sections, r.sectionId),
              render: (r) => nameOf(sections, r.sectionId),
            },
            {
              key: "shift",
              label: "Shift",
              sort: (r) => nameOf(shifts, r.shiftId),
              render: (r) => nameOf(shifts, r.shiftId),
            },
            {
              key: "active",
              label: "Status",
              render: (r) => statusBadge(r.active ? "active" : "inactive"),
            },
            ...(can
              ? [
                  actionColumn((r) =>
                    rowActions({
                      kind: "sectionShift",
                      row: {
                        ...r,
                        name: `${nameOf(sections, r.sectionId)} on ${nameOf(shifts, r.shiftId)}`,
                      },
                      noun: "section shift",
                      redraw,
                    })
                  ),
                ]
              : []),
          ],
          rows: links,
          rowClass: (r) => (r.active ? null : "is-inactive"),
          searchText: (r) => `${nameOf(sections, r.sectionId)} ${nameOf(shifts, r.shiftId)}`,
          empty: {
            title: "No section is linked to a shift yet",
            body: "A section needs a link to a shift before people can be planned on it.",
          },
        })
      );
    }

    function linesTab() {
      const can = manage("lines");
      const lines = list("line");
      const fields = [
        { name: "name", label: "Name", required: true },
        {
          name: "machineCount",
          label: "Machines",
          type: "number",
          min: 0,
          step: 1,
          required: true,
        },
      ];
      const add = () =>
        formDialog({
          title: "New line",
          fields: [
            {
              name: "sectionId",
              label: "Section",
              type: "select",
              options: sections
                .filter((s) => s.active)
                .map((s) => ({ value: s.id, label: s.name })),
            },
            ...fields,
          ],
          initial: { machineCount: 0 },
          errorFields: FIELD_ERRORS,
          onSubmit: (values) => {
            org((o, ctx) => o.create(ctx, "line", values));
            toast("Line created", "good");
            redraw();
          },
        });
      return panel(
        "Lines",
        can && sections.some((s) => s.active) ? button("New line", add, { kind: "primary" }) : null,
        dataTable({
          caption: "Lines",
          columns: [
            { key: "name", label: "Line", sort: (r) => r.name },
            {
              key: "section",
              label: "Section",
              sort: (r) => nameOf(sections, r.sectionId),
              render: (r) => nameOf(sections, r.sectionId),
            },
            { key: "machineCount", label: "Machines", sort: (r) => r.machineCount },
            {
              key: "active",
              label: "Status",
              render: (r) => statusBadge(r.active ? "active" : "inactive"),
            },
            ...(can
              ? [
                  actionColumn((r) => [
                    button("Edit", () => form(`Edit ${r.name}`, fields, r, "line", r), {
                      kind: "link",
                    }),
                    rowActions({ kind: "line", row: r, noun: "line", redraw }),
                  ]),
                ]
              : []),
          ],
          rows: lines,
          rowClass: (r) => (r.active ? null : "is-inactive"),
          searchText: (r) => `${r.name} ${nameOf(sections, r.sectionId)}`,
          empty: { title: "No lines in this factory" },
        })
      );
    }

    function designationsTab() {
      const can = manage("designations");
      const designations = org((o, ctx) => o.list(ctx, "designation", { includeInactive: true }));
      const fields = [
        { name: "name", label: "Name", required: true },
        { name: "supervisorEligible", label: "Can be assigned as a supervisor", type: "checkbox" },
      ];
      return panel(
        "Designations",
        can
          ? button(
              "New designation",
              () =>
                form("New designation", fields, { supervisorEligible: false }, "designation", null),
              { kind: "primary" }
            )
          : null,
        dataTable({
          caption: "Designations",
          columns: [
            { key: "name", label: "Name", sort: (r) => r.name },
            {
              key: "supervisorEligible",
              label: "Supervisor eligible",
              render: (r) => (r.supervisorEligible ? badge("Yes", "good") : "No"),
            },
            {
              key: "active",
              label: "Status",
              render: (r) => statusBadge(r.active ? "active" : "inactive"),
            },
            ...(can
              ? [
                  actionColumn((r) => [
                    button("Edit", () => form(`Edit ${r.name}`, fields, r, "designation", r), {
                      kind: "link",
                    }),
                    rowActions({ kind: "designation", row: r, noun: "designation", redraw }),
                  ]),
                ]
              : []),
          ],
          rows: designations,
          rowClass: (r) => (r.active ? null : "is-inactive"),
          searchText: (r) => r.name,
          empty: { title: "No designations yet" },
        })
      );
    }

    const panel = (title, action, body) => card(title, body, action);
    const body = {
      sections: sectionsTab,
      shifts: shiftsTab,
      links: linksTab,
      lines: linesTab,
      designations: designationsTab,
    }[state.tab]();
    const select = h(
      "select",
      {
        id: "org-factory",
        onchange: (event) => {
          state.factoryId = event.target.value;
          redraw();
        },
      },
      factories.map((factory) =>
        h("option", { value: factory.id, selected: factory.id === factoryId }, factory.name)
      )
    );

    return h(
      "div",
      {},
      pageHeader("Organization", "Sections, shifts, lines and designations."),
      h(
        "nav",
        { class: "tabs", "aria-label": "Organization sections" },
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
      state.tab === "designations"
        ? null
        : factories.length
          ? h(
              "div",
              { class: "table-tools" },
              h("label", { for: "org-factory" }, "Factory"),
              select
            )
          : h(
              "p",
              { class: "muted" },
              "Create a factory first; sections, shifts and lines belong to a factory."
            ),
      body
    );
  });
  return root;
}
