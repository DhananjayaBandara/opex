// Score exceptions: the days that fell short, stopped, produced defects or opened slowly, and the days
// that belong to nobody because two supervisors or none were assigned (UC-MGT-04, D49).
import { h } from "../dom.js";
import { EXCEPTION_KINDS } from "../../domain/scoring.js";
import { badge, card, mount, pageHeader } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { count, dayAddress } from "./production-common.js";
import { dateRange, emptyFilters, filterBar, filterQuery, scorecards } from "./scorecard-common.js";

const TONES = {
  shortfall: "bad",
  downtime: "warn",
  defects: "warn",
  low_first_hour: "warn",
  shared: "info",
  unattributed: "info",
};

export function render() {
  const root = h("div");
  const state = { ...emptyFilters(), kind: "" };
  mount(root, (redraw) => {
    const view = scorecards((s, ctx) =>
      s.exceptions(ctx, { ...filterQuery(state), ...(state.kind ? { kind: state.kind } : {}) })
    );
    return h(
      "div",
      {},
      pageHeader("Score exceptions", `${dateRange(view.period)} · approved days only`),
      filterBar({
        state,
        options: view.options,
        period: view.period,
        today: session.who.today,
        redraw,
        kinds: EXCEPTION_KINDS,
      }),
      h(
        "div",
        { class: "stats" },
        Object.entries(view.counts).map(([kind, total]) =>
          h(
            "div",
            { class: "stat" },
            h("strong", {}, count(total)),
            h("span", {}, EXCEPTION_KINDS[kind] ?? kind)
          )
        )
      ),
      card(
        null,
        dataTable({
          caption: "Exceptions",
          pageSize: 15,
          columns: [
            { key: "date", label: "Date", sort: (r) => r.date },
            {
              key: "kind",
              label: "Exception",
              sort: (r) => r.label,
              render: (r) => badge(r.label, TONES[r.kind] ?? "neutral"),
            },
            { key: "detail", label: "Detail", render: (r) => r.detail },
            {
              key: "where",
              label: "Where",
              sort: (r) => `${r.factoryName}/${r.sectionName}/${r.lineName}`,
              render: (r) =>
                h(
                  "div",
                  {},
                  h("a", { href: dayAddress(r.dayId) }, h("strong", {}, r.lineName ?? "—")),
                  h(
                    "div",
                    { class: "muted" },
                    `${r.factoryName} · ${r.sectionName} · ${r.shiftName}`
                  )
                ),
            },
            {
              key: "who",
              label: "Supervisor",
              render: (r) => (r.supervisorNames.length === 0 ? "—" : r.supervisorNames.join(", ")),
            },
          ],
          rows: view.rows,
          rowKey: (r) => r.key,
          searchText: (r) =>
            `${r.label} ${r.detail} ${r.lineName ?? ""} ${r.sectionName ?? ""} ${r.factoryName ?? ""} ${r.supervisorNames.join(" ")}`,
          empty: {
            title: "No exceptions",
            body: "Every approved day in this period is within the limits.",
          },
        })
      )
    );
  });
  return root;
}
