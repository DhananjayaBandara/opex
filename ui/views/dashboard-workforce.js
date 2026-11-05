// Supervisor and workforce: who is expected and present today, the attendance rate over the period and
// which section-shifts have a supervisor today (UC-MGT-05, UC-MGT-01, FR-ATT-001, D54, D60).
// Attendance needs the attendance permission, so support access (read-only) does not reach this page.
import { h } from "../dom.js";
import {
  cartesianChart,
  chartCard,
  formatCount,
  formatPercent,
  fullDate,
  rankedBars,
  segmentedBar,
  shortDate,
  statTile,
} from "../charts.js";
import { badge, card, emptyState, mount, pageHeader } from "../kit.js";
import { session } from "../session.js";
import {
  dashboards,
  emptyFilters,
  filterQuery,
  filterRow,
  periodText,
} from "./dashboard-common.js";
import { count, percent } from "./production-common.js";

const wide = (node) => {
  node.classList.add("dash-wide");
  return node;
};

const attendanceSegments = (tally) => [
  { label: "Present", value: tally.present, tone: 1 },
  { label: "On leave", value: tally.leave, tone: 3 },
  { label: "Absent", value: tally.absent, tone: 2 },
  { label: "Not recorded", value: tally.unrecorded, tone: "plan" },
];

const tallyColumns = [
  {
    key: "expected",
    label: "Expected",
    align: "end",
    sort: (r) => r.expected,
    render: (r) => count(r.expected),
  },
  {
    key: "present",
    label: "Present",
    align: "end",
    sort: (r) => r.present,
    render: (r) => count(r.present),
  },
  {
    key: "leave",
    label: "On leave",
    align: "end",
    sort: (r) => r.leave,
    render: (r) => count(r.leave),
  },
  {
    key: "absent",
    label: "Absent",
    align: "end",
    sort: (r) => r.absent,
    render: (r) => count(r.absent),
  },
  {
    key: "unrecorded",
    label: "Not recorded",
    align: "end",
    sort: (r) => r.unrecorded,
    render: (r) => count(r.unrecorded),
  },
  {
    key: "rate",
    label: "Attendance rate",
    align: "end",
    sort: (r) => r.attendanceRate ?? -1,
    render: (r) => percent(r.attendanceRate),
  },
];

function todayCard(figures) {
  const total = figures.total;
  const closed =
    figures.closed.length === 0 ? null : `Not a working day today: ${figures.closed.join(", ")}.`;
  return wide(
    card(
      `Attendance today · ${figures.date}`,
      total.expected === 0
        ? h("p", { class: "muted" }, closed ?? "No employees are expected today in this view.")
        : h(
            "div",
            {},
            h(
              "div",
              { class: "stats" },
              statTile("Expected", count(total.expected)),
              statTile("Present", count(total.present)),
              statTile("Attendance rate", percent(total.attendanceRate), "of the days recorded")
            ),
            segmentedBar({ ariaLabel: "Attendance today", segments: attendanceSegments(total) }),
            closed ? h("p", { class: "muted" }, closed) : null,
            h("p", {}, h("a", { href: "#/workforce/attendance" }, "Open the attendance register"))
          )
    )
  );
}

function sectionCard(figures) {
  const rows = figures.factories.flatMap((factory) => [
    { ...factory, key: factory.factoryId, name: factory.factoryName, level: "Factory" },
    ...factory.sections.map((section) => ({
      ...section,
      key: `${factory.factoryId}|${section.sectionId}`,
      name: `${section.sectionName} · ${factory.factoryName}`,
      level: "Section",
    })),
  ]);
  if (figures.factories.length === 0) {
    return card(
      "Attendance by section today",
      emptyState({ title: "Nothing to show today", body: "No factory in this view works today." })
    );
  }
  const sections = rows
    .filter((row) => row.level === "Section" && row.attendanceRate !== null)
    .sort((a, b) => b.attendanceRate - a.attendanceRate || a.name.localeCompare(b.name));
  return chartCard({
    title: "Attendance by section today",
    note: "The share of recorded days that were present. A section with nothing recorded shows a dash.",
    chart: rankedBars({
      ariaLabel: "Attendance rate",
      rows: sections.map((row) => ({
        label: row.name,
        value: row.attendanceRate,
        detail: [
          { label: "Expected", value: count(row.expected) },
          { label: "Present", value: count(row.present) },
          { label: "On leave", value: count(row.leave) },
          { label: "Absent", value: count(row.absent) },
          { label: "Not recorded", value: count(row.unrecorded) },
        ],
      })),
      format: (value) => formatPercent(value),
      max: 100,
    }),
    table: {
      caption: "Attendance by factory and section today",
      rowKey: (row) => row.key,
      columns: [
        { key: "name", label: "Name", sort: (r) => r.name, render: (r) => r.name },
        { key: "level", label: "Level", sort: (r) => r.level, render: (r) => r.level },
        ...tallyColumns,
      ],
      rows,
    },
  });
}

function trendCard(figures) {
  const rows = figures.byDate;
  if (rows.length === 0) {
    return card(
      "Attendance over the period",
      emptyState({
        title: "No working days in this period",
        body: "Pick a period that includes a working day.",
      })
    );
  }
  return chartCard({
    title: "Attendance over the period",
    note: "Attendance rate on each working day, from the days recorded. A day with nothing recorded is a gap.",
    chart: cartesianChart({
      kind: "line",
      categories: rows.map((row) => ({
        key: row.key,
        label: shortDate(row.key),
        full: fullDate(row.key),
      })),
      series: [
        {
          id: "rate",
          label: "Attendance rate",
          tone: 1,
          values: rows.map((r) => r.attendanceRate),
        },
      ],
      yFormat: (value) => `${value}%`,
      valueFormat: (value) => formatPercent(value),
      ariaLabel: "Attendance rate on each working day",
    }),
    table: {
      caption: "Attendance by working day",
      rowKey: (row) => row.key,
      columns: [
        { key: "date", label: "Date", sort: (r) => r.key, render: (r) => fullDate(r.key) },
        ...tallyColumns,
      ],
      rows,
    },
  });
}

const COVERAGE = {
  covered: { tone: "good", label: "covered" },
  none: { tone: "bad", label: "no supervisor" },
  conflict: { tone: "warn", label: "more than one supervisor" },
};

function coverageCard(coverage) {
  const { counts, rows } = coverage;
  return wide(
    card(
      "Supervisor coverage today",
      rows.length === 0
        ? emptyState({ title: "No section-shifts run today in this view" })
        : h(
            "div",
            {},
            h(
              "div",
              { class: "stats" },
              statTile("Covered", formatCount(counts.covered)),
              statTile("No supervisor", formatCount(counts.none)),
              statTile("More than one", formatCount(counts.conflict))
            ),
            h(
              "div",
              { class: "table-scroll" },
              h(
                "table",
                { class: "table" },
                h("caption", { class: "sr-only" }, "Supervisor coverage by section and shift"),
                h(
                  "thead",
                  {},
                  h(
                    "tr",
                    {},
                    ["Factory", "Section", "Shift", "Supervisors", "Coverage"].map((label) =>
                      h("th", { scope: "col" }, label)
                    )
                  )
                ),
                h(
                  "tbody",
                  {},
                  rows.map((row) =>
                    h(
                      "tr",
                      {},
                      h("td", {}, row.factoryName),
                      h("td", {}, row.sectionName),
                      h("td", {}, row.shiftName),
                      h("td", {}, row.supervisors.length === 0 ? "—" : row.supervisors.join(", ")),
                      h("td", {}, badge(COVERAGE[row.coverage].label, COVERAGE[row.coverage].tone))
                    )
                  )
                )
              )
            ),
            session.can("supervisor_assignment.manage")
              ? h(
                  "p",
                  {},
                  h("a", { href: "#/workforce/assignments" }, "Open supervisor assignments")
                )
              : null
          )
    )
  );
}

export function render() {
  const root = h("div");
  const state = emptyFilters();
  mount(root, (redraw) => {
    const view = dashboards((s, ctx) => s.workforce(ctx, filterQuery(state)));
    return h(
      "div",
      {},
      pageHeader("Supervisor and workforce", `${periodText(view.period)} · attendance as recorded`),
      filterRow({
        state,
        options: view.options,
        period: view.period,
        today: view.today,
        redraw,
      }),
      h(
        "div",
        { class: "dash-grid" },
        todayCard(view.figures),
        sectionCard(view.figures),
        trendCard(view.figures),
        coverageCard(view.coverage)
      )
    );
  });
  return root;
}
