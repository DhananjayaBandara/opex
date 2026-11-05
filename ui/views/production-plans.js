// Production plans: publish a plan for a line, shift and date, revise it with a reason, and read the
// history of its revisions (UC-IEN-01, FR-PROD-001, D35). A day opened later follows the latest
// revision at that moment.
import { h } from "../dom.js";
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
import { formDialog, infoDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { control, dayAddress, percent, production, shiftDay } from "./production-common.js";

const ERRORS = {
  invalid_efficiency: "plannedEfficiency",
  reason_required: "reason",
  no_change: "reason",
  past_date: "date",
  invalid_date: "date",
  shift_not_run: "area",
};

export function render() {
  const root = h("div");
  const state = { factoryId: "", from: null, to: null };
  mount(root, (redraw) => {
    const today = session.who.today;
    state.from ??= shiftDay(today, -3);
    state.to ??= shiftDay(today, 14);
    const mayPlan =
      session.can("production.enter") && !session.supporting && !session.who.assignmentScoped;

    const areas = production((p, ctx) => p.workAreas(ctx, { for: "view" }));
    const styles = production((p, ctx) => p.styles(ctx));
    const factories = [...new Map(areas.map((a) => [a.factoryId, a.factoryName])).entries()];
    const rows = production((p, ctx) =>
      p.plans(ctx, {
        from: state.from,
        to: state.to,
        ...(state.factoryId ? { factoryId: state.factoryId } : {}),
      })
    );

    // ---- Dialogs --------------------------------------------------------------------------

    const planFields = (revising) => [
      ...(revising
        ? []
        : [
            {
              name: "area",
              label: "Line and shift",
              type: "select",
              options: production((p, ctx) => p.workAreas(ctx, { for: "enter" })).flatMap((a) =>
                a.lines.map((line) => ({
                  value: { lineId: line.id, shiftId: a.shiftId },
                  label: `${a.factoryName} · ${a.sectionName} · ${a.shiftName} · ${line.name}`,
                }))
              ),
            },
            { name: "date", label: "Date", type: "date", min: today, required: true },
          ]),
      {
        name: "styleId",
        label: "Style",
        type: "select",
        options: styles.map((style) => ({
          value: style.id,
          label: `${style.code} · ${style.name} (SMV ${style.smv})`,
        })),
      },
      { name: "orderRef", label: "Order reference" },
      {
        name: "hourlyTarget",
        label: "Hourly target (pieces)",
        type: "number",
        min: 1,
        required: true,
        hint: "Planned efficiency × planned manpower × 60 ÷ SMV, rounded",
      },
      {
        name: "workingHours",
        label: "Working hours",
        type: "number",
        min: 1,
        max: 16,
        required: true,
      },
      {
        name: "plannedEfficiency",
        label: "Planned efficiency (%)",
        type: "number",
        min: 1,
        max: 100,
        step: "any",
        required: true,
      },
      { name: "plannedMCOperators", label: "Planned operators", type: "number", min: 0 },
      { name: "plannedManual", label: "Planned manual workers", type: "number", min: 0 },
      ...(revising
        ? [
            {
              name: "reason",
              label: "Reason for the new revision",
              type: "textarea",
              required: true,
            },
          ]
        : []),
    ];

    const publish = () =>
      formDialog({
        title: "Publish a plan",
        description:
          "A plan is for today or a later day. Publish again to revise it with a reason.",
        fields: planFields(false),
        initial: { date: today, workingHours: 8, plannedMCOperators: 0, plannedManual: 0 },
        errorFields: ERRORS,
        submitLabel: "Publish",
        onSubmit: ({ area, ...values }) => {
          production((p, ctx) => p.publishPlan(ctx, { ...area, ...values }));
          toast("Plan published", "good");
          redraw();
        },
      });

    const revise = (row) =>
      formDialog({
        title: `Revise plan: ${row.lineName}, ${row.date}`,
        description: `${row.factoryName} · ${row.sectionName} · ${row.shiftName}. This becomes revision ${row.revision + 1}; the earlier revisions are kept.`,
        fields: planFields(true),
        initial: {
          styleId: row.styleId,
          orderRef: row.orderRef ?? "",
          hourlyTarget: row.hourlyTarget,
          workingHours: row.workingHours,
          plannedEfficiency: row.plannedEfficiency,
          plannedMCOperators: row.plannedMCOperators,
          plannedManual: row.plannedManual,
          reason: "",
        },
        errorFields: ERRORS,
        submitLabel: "Publish revision",
        onSubmit: (values) => {
          production((p, ctx) =>
            p.publishPlan(ctx, {
              lineId: row.lineId,
              shiftId: row.shiftId,
              date: row.date,
              ...values,
            })
          );
          toast("Revision published", "good");
          redraw();
        },
      });

    const history = (row) => {
      const revisions = production((p, ctx) =>
        p.planHistory(ctx, { lineId: row.lineId, shiftId: row.shiftId, date: row.date })
      );
      infoDialog({
        title: `Plan history: ${row.lineName}, ${row.date}`,
        body: h(
          "ol",
          { class: "history" },
          revisions.map((revision) =>
            h(
              "li",
              {},
              h("strong", {}, `Revision ${revision.revision}`),
              ` · ${revision.styleCode} · ${revision.hourlyTarget} / h × ${revision.workingHours} h · ${percent(revision.plannedEfficiency)} planned efficiency`,
              h(
                "div",
                { class: "muted" },
                `${formatInstant(revision.publishedAt)} · ${revision.publishedByName ?? "system"}`,
                revision.reason ? ` · Reason: ${revision.reason}` : ""
              )
            )
          )
        ),
      });
    };

    // ---- Page -----------------------------------------------------------------------------

    return h(
      "div",
      {},
      pageHeader(
        "Production plans",
        "What each line plans to make, per shift and day.",
        mayPlan ? button("Publish a plan", publish, { kind: "primary" }) : null
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      session.who.assignmentScoped
        ? notice("Plans are published by planners and managers; you can read them here.", "info")
        : null,
      h(
        "div",
        { class: "table-tools" },
        control(
          "plans-factory",
          "Factory",
          h(
            "select",
            {
              id: "plans-factory",
              onchange: (event) => {
                state.factoryId = event.target.value;
                redraw();
              },
            },
            h("option", { value: "" }, "All"),
            factories.map(([id, name]) =>
              h("option", { value: id, selected: id === state.factoryId }, name)
            )
          )
        ),
        control(
          "plans-from",
          "From",
          h("input", {
            id: "plans-from",
            type: "date",
            value: state.from,
            onchange: (event) => {
              state.from = event.target.value || shiftDay(today, -3);
              redraw();
            },
          })
        ),
        control(
          "plans-to",
          "To",
          h("input", {
            id: "plans-to",
            type: "date",
            value: state.to,
            onchange: (event) => {
              state.to = event.target.value || shiftDay(today, 14);
              redraw();
            },
          })
        )
      ),
      card(
        null,
        dataTable({
          caption: "Production plans",
          pageSize: 12,
          columns: [
            { key: "date", label: "Date", sort: (r) => r.date },
            {
              key: "line",
              label: "Line",
              sort: (r) => `${r.factoryName}/${r.sectionName}/${r.lineName}`,
              render: (r) =>
                h(
                  "div",
                  {},
                  h("strong", {}, r.lineName),
                  h(
                    "div",
                    { class: "muted" },
                    `${r.factoryName} · ${r.sectionName} · ${r.shiftName}`
                  )
                ),
            },
            {
              key: "style",
              label: "Style",
              sort: (r) => r.styleCode,
              render: (r) =>
                h(
                  "div",
                  {},
                  r.styleCode,
                  r.orderRef ? h("div", { class: "muted" }, r.orderRef) : null
                ),
            },
            {
              key: "target",
              label: "Target",
              sort: (r) => r.plannedPieces,
              render: (r) => `${r.hourlyTarget} / h × ${r.workingHours} h = ${r.plannedPieces}`,
            },
            {
              key: "efficiency",
              label: "Planned efficiency",
              sort: (r) => r.plannedEfficiency,
              render: (r) => percent(r.plannedEfficiency),
            },
            {
              key: "revision",
              label: "Revision",
              sort: (r) => r.revision,
              render: (r) => String(r.revision),
            },
            {
              key: "day",
              label: "Day",
              sort: (r) => r.dayStatus ?? "",
              render: (r) =>
                r.dayId === null
                  ? h("span", { class: "muted" }, "Not opened")
                  : h("a", { href: dayAddress(r.dayId) }, statusBadge(r.dayStatus)),
            },
            {
              key: "actions",
              label: "",
              align: "end",
              render: (r) =>
                h(
                  "div",
                  { class: "actions end" },
                  mayPlan && r.date >= today
                    ? button("Revise", () => revise(r), { kind: "link" })
                    : null,
                  button("History", () => history(r), { kind: "link" })
                ),
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) =>
            `${r.lineName} ${r.sectionName} ${r.factoryName} ${r.styleCode} ${r.orderRef ?? ""}`,
          empty: {
            title: "No plans in this period",
            body: mayPlan
              ? "Publish a plan, or widen the dates."
              : "Nothing is published in your scope for these dates.",
          },
        })
      )
    );
  });
  return root;
}
