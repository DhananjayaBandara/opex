// Production and line performance: approved production against plan by day, hour, line, section and
// style, and the minutes lost by reason (UC-MGT-05, FR-PROD-011, D55, D56, D58). Approved days only;
// the days not yet approved are named in a block, never mixed into the figures.
import { h } from "../dom.js";
import { cartesianChart, chartCard, formatCount, formatPercent, rankedBars } from "../charts.js";
import { card, emptyState, mount, pageHeader } from "../kit.js";
import {
  dashboards,
  emptyFilters,
  filterQuery,
  filterRow,
  headlineStats,
  healthBadge,
  notApprovedNotice,
  outputCard,
  periodText,
} from "./dashboard-common.js";
import { count, minutesText, percent } from "./production-common.js";

const none = (title) =>
  card(
    title,
    emptyState({
      title: "No approved production in this period",
      body: "A day appears here once it is approved.",
    })
  );

const wide = (node) => {
  node.classList.add("dash-wide");
  return node;
};

// A name that two factories share ("Line 1 · Sewing") gets the factory added, so no two bars read alike.
const whose = (rows, base) => {
  const seen = new Map();
  for (const row of rows) seen.set(base(row), (seen.get(base(row)) ?? 0) + 1);
  return (row) => (seen.get(base(row)) > 1 ? `${base(row)} (${row.factoryName})` : base(row));
};

// Highest first, rows with no figure last.
const ranked = (rows, key) =>
  [...rows].sort(
    (a, b) => (b[key] ?? -1) - (a[key] ?? -1) || String(a.label).localeCompare(String(b.label))
  );

function hourCard(rows) {
  if (rows.length === 0) return none("Hit rate by shift hour");
  return chartCard({
    title: "Hit rate by shift hour",
    note: "Pieces made against the hourly target, over every approved day that entered the hour.",
    chart: cartesianChart({
      kind: "column",
      categories: rows.map((row) => ({
        key: String(row.ordinalHour),
        label: `H${row.ordinalHour}`,
        full: `${row.label} (${row.days} day-records)`,
      })),
      series: [{ id: "hit", label: "Hit rate", tone: 1, values: rows.map((r) => r.hitRate) }],
      reference: { value: 100, label: "Target 100%" },
      yFormat: (value) => `${value}%`,
      valueFormat: (value) => formatPercent(value),
      ariaLabel: "Hourly hit rate against the 100% target",
    }),
    table: {
      caption: "Hit rate by shift hour",
      rowKey: (row) => String(row.ordinalHour),
      columns: [
        { key: "hour", label: "Hour", sort: (r) => r.ordinalHour, render: (r) => r.label },
        {
          key: "days",
          label: "Day-records",
          align: "end",
          sort: (r) => r.days,
          render: (r) => count(r.days),
        },
        {
          key: "target",
          label: "Target pieces",
          align: "end",
          sort: (r) => r.targetPieces,
          render: (r) => formatCount(r.targetPieces),
        },
        {
          key: "actual",
          label: "Pieces made",
          align: "end",
          sort: (r) => r.actualPieces,
          render: (r) => formatCount(r.actualPieces),
        },
        {
          key: "hit",
          label: "Hit rate",
          align: "end",
          sort: (r) => r.hitRate ?? -1,
          render: (r) => formatPercent(r.hitRate),
        },
      ],
      rows,
    },
  });
}

// Lines or sections against plan: ranked bars by pieces against plan, with the figures in the table.
function groupCard({ title, note, rows, name, extraColumns = [] }) {
  if (rows.length === 0) return none(title);
  const order = ranked(rows, "piecesHitRate");
  return chartCard({
    title,
    note,
    chart: rankedBars({
      ariaLabel: "Pieces against plan",
      rows: order.map((row) => ({
        label: name(row),
        value: row.piecesHitRate,
        detail: [
          { label: "Pieces made", value: formatCount(row.actualPieces) },
          { label: "Planned", value: formatCount(row.plannedPieces) },
          { label: "Approved days", value: count(row.days) },
          { label: "Efficiency", value: percent(row.actualEfficiency) },
        ],
      })),
      format: (value) => formatPercent(value),
      max: Math.max(100, ...order.map((row) => row.piecesHitRate ?? 0)),
    }),
    table: {
      caption: title,
      rowKey: (row) => row.key,
      columns: [
        { key: "name", label: "Name", sort: (r) => name(r), render: (r) => name(r) },
        ...extraColumns,
        {
          key: "days",
          label: "Approved days",
          align: "end",
          sort: (r) => r.days,
          render: (r) => count(r.days),
        },
        {
          key: "planned",
          label: "Planned",
          align: "end",
          sort: (r) => r.plannedPieces ?? -1,
          render: (r) => formatCount(r.plannedPieces),
        },
        {
          key: "actual",
          label: "Made",
          align: "end",
          sort: (r) => r.actualPieces ?? -1,
          render: (r) => formatCount(r.actualPieces),
        },
        {
          key: "hit",
          label: "Against plan",
          sort: (r) => r.piecesHitRate ?? -1,
          render: (r) => healthBadge(r.piecesHitRate, r.band),
        },
        {
          key: "eff",
          label: "Efficiency",
          align: "end",
          sort: (r) => r.actualEfficiency ?? -1,
          render: (r) => percent(r.actualEfficiency),
        },
        {
          key: "defect",
          label: "Defect rate",
          align: "end",
          sort: (r) => r.defectRate ?? -1,
          render: (r) => percent(r.defectRate),
        },
        {
          key: "down",
          label: "Downtime",
          align: "end",
          sort: (r) => r.downtimeMinutes,
          render: (r) => minutesText(r.downtimeMinutes),
        },
      ],
      rows,
    },
  });
}

function styleCard(rows) {
  if (rows.length === 0) return none("Output by style");
  const order = ranked(rows, "actualPieces");
  return chartCard({
    title: "Output by style",
    note: "Pieces made on approved days, by style.",
    chart: rankedBars({
      ariaLabel: "Pieces made",
      rows: order.map((row) => ({
        label: row.styleName ? `${row.label} · ${row.styleName}` : row.label,
        value: row.actualPieces,
        detail: [
          { label: "Planned", value: formatCount(row.plannedPieces) },
          { label: "Against plan", value: formatPercent(row.piecesHitRate) },
          { label: "Approved days", value: count(row.days) },
        ],
      })),
      format: formatCount,
    }),
    table: {
      caption: "Output by style",
      rowKey: (row) => row.key,
      columns: [
        { key: "code", label: "Style", sort: (r) => r.label, render: (r) => r.label },
        {
          key: "name",
          label: "Name",
          sort: (r) => r.styleName ?? "",
          render: (r) => r.styleName ?? "—",
        },
        {
          key: "days",
          label: "Approved days",
          align: "end",
          sort: (r) => r.days,
          render: (r) => count(r.days),
        },
        {
          key: "actual",
          label: "Made",
          align: "end",
          sort: (r) => r.actualPieces ?? -1,
          render: (r) => formatCount(r.actualPieces),
        },
        {
          key: "hit",
          label: "Against plan",
          sort: (r) => r.piecesHitRate ?? -1,
          render: (r) => healthBadge(r.piecesHitRate, r.band),
        },
        {
          key: "defect",
          label: "Defect rate",
          align: "end",
          sort: (r) => r.defectRate ?? -1,
          render: (r) => percent(r.defectRate),
        },
      ],
      rows,
    },
  });
}

function downtimeCard(rows) {
  if (rows.length === 0) {
    return card(
      "Downtime by reason",
      emptyState({
        title: "No downtime recorded",
        body: "No approved day in this period lost minutes.",
      })
    );
  }
  return chartCard({
    title: "Downtime by reason",
    note: h(
      "span",
      {},
      "Minutes lost on approved days. ",
      h("a", { href: "#/scorecard/exceptions" }, "Open score exceptions")
    ),
    chart: rankedBars({
      ariaLabel: "Minutes lost",
      rows: rows.map((row) => ({
        label: row.label,
        value: row.minutes,
        detail: [{ label: "Events", value: count(row.events) }],
      })),
      format: minutesText,
      tone: 2,
    }),
    table: {
      caption: "Downtime by reason",
      rowKey: (row) => row.code,
      columns: [
        { key: "reason", label: "Reason", sort: (r) => r.label, render: (r) => r.label },
        {
          key: "events",
          label: "Events",
          align: "end",
          sort: (r) => r.events,
          render: (r) => count(r.events),
        },
        {
          key: "minutes",
          label: "Minutes lost",
          align: "end",
          sort: (r) => r.minutes,
          render: (r) => minutesText(r.minutes),
        },
      ],
      rows,
    },
  });
}

export function render() {
  const root = h("div");
  const state = emptyFilters();
  mount(root, (redraw) => {
    const view = dashboards((s, ctx) => s.production(ctx, filterQuery(state)));
    return h(
      "div",
      {},
      pageHeader(
        "Production and line performance",
        `${periodText(view.period)} · approved days only`
      ),
      filterRow({
        state,
        options: view.options,
        period: view.period,
        today: view.today,
        redraw,
        withLine: true,
      }),
      h(
        "div",
        { class: "dash-grid" },
        wide(
          card(
            "Headline figures",
            h("div", {}, headlineStats(view.figures), notApprovedNotice(view.notApproved))
          )
        ),
        wide(outputCard(view.byDate)),
        hourCard(view.byHour),
        groupCard({
          title: "Lines against plan",
          note: "Each line's pieces made against plan on approved days.",
          rows: view.byLine,
          name: whose(view.byLine, (row) => `${row.label} · ${row.sectionName}`),
          extraColumns: [
            {
              key: "where",
              label: "Factory",
              sort: (r) => r.factoryName ?? "",
              render: (r) => r.factoryName ?? "—",
            },
          ],
        }),
        groupCard({
          title: "Sections against plan",
          note: "A section's lines together.",
          rows: view.bySection,
          name: (row) => `${row.label} · ${row.factoryName}`,
        }),
        styleCard(view.byStyle),
        downtimeCard(view.downtime)
      )
    );
  });
  return root;
}
