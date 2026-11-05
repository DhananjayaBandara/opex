// Score configuration: the weights and window the score uses, with every version that has applied or
// is scheduled, and the KPI target history the score reads (FR-SCR-002..004, D47, D51, D52). Targets
// are changed under Company settings; this page only shows them.
import { h } from "../dom.js";
import { COMPONENT_LABELS, SCORE_COMPONENTS } from "../../domain/scoring.js";
import { attempt, button, card, mount, notice, pageHeader, toast } from "../kit.js";
import { formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { control, percent } from "./production-common.js";
import { scorecards } from "./scorecard-common.js";

const ERRORS = {
  invalid_weights: "efficiency",
  invalid_window: "windowDays",
  reason_required: "reason",
  invalid_date: "effectiveFrom",
  past_effective_date: "effectiveFrom",
  overlap: "effectiveFrom",
  version_in_effect: "effectiveFrom",
};

const TARGETS = [
  ["efficiency", "Efficiency"],
  ["firstHour", "First-hour hit rate"],
  ["defectRate", "Defect rate"],
  ["qco", "QCO hit rate"],
];

const weightsText = (weights) =>
  SCORE_COMPONENTS.map((key) => `${COMPONENT_LABELS[key]} ${weights[key]}%`).join(" · ");

export function render() {
  const root = h("div");
  const state = { level: "" };
  mount(root, (redraw) => {
    const app = session.app;
    const view = scorecards((s, ctx) => s.config(ctx));
    const today = session.who.today;
    const targetVersions = session.run((ctx) =>
      app.settings.targetVersions(ctx, state.level ? { factoryId: state.level } : {})
    );

    const edit = () =>
      formDialog({
        title: "Save a new score configuration",
        fields: [
          ...SCORE_COMPONENTS.map((key, index) => ({
            name: key,
            label: `${COMPONENT_LABELS[key]} weight (%)`,
            type: "number",
            min: 0,
            max: 100,
            step: "any",
            required: true,
            hint: index === 0 ? "The five weights must add up to 100" : undefined,
          })),
          {
            name: "windowDays",
            label: "Window (days)",
            type: "number",
            min: 1,
            max: 366,
            step: 1,
            required: true,
            hint: "How far back the rolling score looks",
          },
          {
            name: "effectiveFrom",
            label: "Starts on",
            type: "date",
            min: today,
            required: true,
            hint: "Today or later; earlier scores keep the configuration they were taken with",
          },
          { name: "reason", label: "Reason for the change", type: "textarea", required: true },
        ],
        initial: {
          ...view.current.weights,
          windowDays: view.current.windowDays,
          effectiveFrom: today,
        },
        errorFields: ERRORS,
        submitLabel: "Save configuration",
        onSubmit: (values) => {
          const weights = Object.fromEntries(SCORE_COMPONENTS.map((key) => [key, values[key]]));
          scorecards((s, ctx) =>
            s.saveConfig(ctx, {
              weights,
              windowDays: values.windowDays,
              effectiveFrom: values.effectiveFrom,
              reason: values.reason,
            })
          );
          redraw();
        },
      });

    const snapshot = () => {
      const result = attempt(() => scorecards((s, ctx) => s.takeSnapshots(ctx, {})));
      if (result === undefined) return;
      const created = `${result.created} snapshot${result.created === 1 ? "" : "s"} taken`;
      const existing = result.existing > 0 ? `, ${result.existing} already existed` : "";
      const skipped = result.skipped > 0 ? `, ${result.skipped} without a score` : "";
      toast(`${created}${existing}${skipped} for ${result.asOf}`, "good");
      redraw();
    };

    return h(
      "div",
      {},
      pageHeader(
        "Score configuration",
        "How a supervisor's score is weighted, and the targets it is measured against.",
        view.mayManage ? button("Take today's snapshots", snapshot) : null,
        view.mayManage ? button("Change the configuration", edit, { kind: "primary" }) : null
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      !view.mayManage && !session.supporting
        ? notice("Only people with tenant-wide score configuration rights can change this.", "info")
        : null,
      card(
        `In force today: ${view.current.label}`,
        h(
          "div",
          {},
          dataTable({
            caption: "Weights in force",
            columns: [
              { key: "part", label: "Part", render: (r) => r.label },
              { key: "weight", label: "Weight", align: "end", render: (r) => `${r.weight}%` },
              {
                key: "default",
                label: "Felix default",
                align: "end",
                render: (r) => `${r.defaultWeight}%`,
              },
            ],
            rows: SCORE_COMPONENTS.map((key) => ({
              key,
              label: COMPONENT_LABELS[key],
              weight: view.current.weights[key],
              defaultWeight: view.defaults.weights[key],
            })),
            rowKey: (r) => r.key,
          }),
          h(
            "p",
            { class: "muted" },
            `Window: ${view.current.windowDays} days. `,
            view.current.reason
              ? `Reason: ${view.current.reason}.`
              : "Nobody has changed these yet."
          )
        )
      ),
      card(
        "Versions",
        dataTable({
          caption: "Score configuration versions",
          columns: [
            { key: "version", label: "Version", sort: (r) => r.version, render: (r) => r.label },
            {
              key: "from",
              label: "From",
              sort: (r) => r.effectiveFrom ?? "",
              render: (r) => r.effectiveFrom ?? "—",
            },
            { key: "to", label: "To", render: (r) => r.effectiveTo ?? "open" },
            { key: "weights", label: "Weights", render: (r) => weightsText(r.weights) },
            { key: "window", label: "Window", align: "end", render: (r) => `${r.windowDays} days` },
            { key: "reason", label: "Reason", render: (r) => r.reason ?? "—" },
            { key: "by", label: "Saved by", render: (r) => r.savedByName ?? "—" },
          ],
          rows: view.versions,
          rowKey: (r) => r.version,
          empty: {
            title: "No version has been saved",
            body: "The Felix defaults apply until a version is saved.",
          },
        })
      ),
      card(
        "KPI target history",
        h(
          "div",
          {},
          h(
            "div",
            { class: "table-tools" },
            control(
              "sc-level",
              "Level",
              h(
                "select",
                {
                  id: "sc-level",
                  onchange: (event) => {
                    state.level = event.target.value;
                    redraw();
                  },
                },
                h("option", { value: "", selected: state.level === "" }, "Organization"),
                view.factories.map((factory) =>
                  h(
                    "option",
                    { value: factory.id, selected: factory.id === state.level },
                    factory.name
                  )
                )
              )
            ),
            h("a", { href: "#/admin/company" }, "Change targets under Company settings")
          ),
          dataTable({
            caption: "Target versions",
            columns: [
              { key: "version", label: "Version", sort: (r) => r.version },
              { key: "effectiveFrom", label: "From", sort: (r) => r.effectiveFrom },
              { key: "to", label: "To", render: (r) => r.effectiveTo ?? "open" },
              {
                key: "values",
                label: "Values",
                render: (r) =>
                  TARGETS.filter(([key]) => r.values[key] !== undefined)
                    .map(([key, label]) => `${label} ${percent(r.values[key], 0)}`)
                    .join(" · "),
              },
            ],
            rows: [...targetVersions].reverse(),
            rowKey: (r) => r.id,
            empty: {
              title: "No versions at this level",
              body: state.level
                ? "This factory inherits the organization targets."
                : "The system defaults apply.",
            },
          })
        )
      )
    );
  });
  return root;
}
