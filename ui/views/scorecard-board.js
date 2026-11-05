// The Management Scorecard: one row per supervisor for the chosen factory, section, shift and period,
// each opening that supervisor's scorecard (UC-MGT-02, FR-PROD-012, FR-SCR-001, D45).
import { h } from "../dom.js";
import { card, mount, notice, pageHeader } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { count, percent } from "./production-common.js";
import {
  dateRange,
  emptyFilters,
  filterBar,
  filterQuery,
  scoreBadge,
  scorecards,
  signed,
  supervisorAddress,
  wholeSigned,
} from "./scorecard-common.js";

const stat = (label, value, detail) =>
  h(
    "div",
    { class: "stat" },
    h("strong", {}, value),
    h("span", {}, label),
    detail ? h("small", { class: "muted" }, detail) : null
  );

export function render() {
  const root = h("div");
  const state = emptyFilters();
  mount(root, (redraw) => {
    const board = scorecards((s, ctx) => s.board(ctx, filterQuery(state)));
    const { period, rows, all, excluded } = board;
    const withScore = rows.filter((row) => row.score !== null);
    const average =
      withScore.length === 0
        ? null
        : withScore.reduce((total, row) => total + row.score, 0) / withScore.length;
    const left = excluded.shared + excluded.unattributed;

    return h(
      "div",
      {},
      pageHeader(
        "Management scorecard",
        `${dateRange(period)} · ${board.config.label}, ${board.config.windowDays}-day window`
      ),
      filterBar({
        state,
        options: board.options,
        period,
        today: session.who.today,
        redraw,
      }),
      left > 0
        ? notice(
            `${left} approved day${left === 1 ? " is" : "s are"} not counted for any supervisor: ${excluded.shared} shared between two supervisors and ${excluded.unattributed} with nobody assigned. They are listed under Score exceptions.`,
            "warn"
          )
        : null,
      h(
        "div",
        { class: "stats" },
        stat("Supervisors", count(rows.length)),
        stat(
          "Average score",
          average === null ? "—" : average.toFixed(1),
          `${withScore.length} with a score`
        ),
        stat("Days counted", count(all.days)),
        stat(
          "Pieces against plan",
          percent(all.piecesHitRate),
          all.plannedPieces === null ? null : `${wholeSigned(all.piecesVariance)} pieces`
        ),
        stat(
          "Efficiency",
          percent(all.actualEfficiency),
          `Planned ${percent(all.plannedEfficiency)}`
        )
      ),
      card(
        null,
        dataTable({
          caption: "Supervisor scorecards",
          pageSize: 12,
          columns: [
            {
              key: "name",
              label: "Supervisor",
              sort: (r) => r.name,
              render: (r) =>
                h(
                  "div",
                  {},
                  h(
                    "a",
                    { href: supervisorAddress(r.employeeId, period) },
                    h("strong", {}, r.name)
                  ),
                  h("div", { class: "muted" }, `${r.employeeCode} · ${r.factoryName ?? "—"}`)
                ),
            },
            {
              key: "days",
              label: "Days",
              align: "end",
              sort: (r) => r.days,
              render: (r) => count(r.days),
            },
            {
              key: "pieces",
              label: "Pieces",
              align: "end",
              sort: (r) => r.actualPieces ?? -1,
              render: (r) =>
                r.plannedPieces === null
                  ? "—"
                  : h(
                      "div",
                      {},
                      `${count(r.actualPieces)} of ${count(r.plannedPieces)}`,
                      h(
                        "div",
                        { class: "muted" },
                        `${wholeSigned(r.piecesVariance)} · ${percent(r.piecesHitRate)}`
                      )
                    ),
            },
            {
              key: "efficiency",
              label: "Efficiency",
              align: "end",
              sort: (r) => r.actualEfficiency ?? -1,
              render: (r) =>
                r.actualEfficiency === null
                  ? "—"
                  : h(
                      "div",
                      {},
                      percent(r.actualEfficiency),
                      h(
                        "div",
                        { class: "muted" },
                        `plan ${percent(r.plannedEfficiency)} · ${signed(r.efficiencyVariance, 1, " pts")}`
                      )
                    ),
            },
            {
              key: "defect",
              label: "Defects",
              align: "end",
              sort: (r) => r.defectRate ?? -1,
              render: (r) => percent(r.defectRate),
            },
            {
              key: "firstHour",
              label: "First hour",
              align: "end",
              sort: (r) => r.firstHourHitRate ?? -1,
              render: (r) => percent(r.firstHourHitRate),
            },
            {
              key: "qco",
              label: "QCO",
              align: "end",
              sort: (r) => r.qcoHitRate ?? -1,
              render: (r) => percent(r.qcoHitRate),
            },
            {
              key: "attendance",
              label: "Attendance",
              align: "end",
              sort: (r) => r.attendanceScore ?? -1,
              render: (r) => percent(r.attendanceScore),
            },
            {
              key: "score",
              label: "Score",
              align: "end",
              sort: (r) => r.score ?? -1,
              render: (r) => scoreBadge(r.score),
            },
          ],
          rows,
          rowKey: (r) => r.employeeId,
          searchText: (r) => `${r.name} ${r.employeeCode} ${r.factoryName ?? ""}`,
          empty: {
            title: "No supervisors found",
            body: "No supervisor was assigned to these sections in this period.",
          },
        })
      )
    );
  });
  return root;
}
