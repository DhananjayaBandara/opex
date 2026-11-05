// Pieces shared by the three dashboards (S5.1, D53 to D60): the service call, the one filter row above
// the charts (date presets first, then factory, section, shift and, where it applies, line) and the
// block that says what the approved-only figures leave out.
import { h } from "../dom.js";
import {
  cartesianChart,
  chartCard,
  formatCount,
  fullDate,
  shortDate,
  statTile,
} from "../charts.js";
import { card, emptyState, notice } from "../kit.js";
import { session } from "../session.js";
import { control, count, minutesText, percent, rateBadge, shiftDay } from "./production-common.js";
import { wholeSigned } from "./scorecard-common.js";

export const dashboards = (call) => session.run((ctx) => call(session.app.dashboards, ctx));

export const PRESETS = Object.freeze([
  { id: "today", label: "Today" },
  { id: "last7", label: "Last 7 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "month", label: "Month to date" },
  { id: "custom", label: "Custom" },
]);

export const emptyFilters = () => ({
  preset: "last7",
  from: "",
  to: "",
  factoryId: "",
  sectionId: "",
  shiftId: "",
  lineId: "",
});

// The first and last day a preset covers, ending today.
export function presetRange(preset, today) {
  if (preset === "today") return { from: today, to: today };
  if (preset === "last30") return { from: shiftDay(today, -29), to: today };
  if (preset === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: shiftDay(today, -6), to: today };
}

// What to ask the service for: the period of the chosen preset (or the typed dates) and the filters
// that are set.
export function filterQuery(state, today = session.who?.today) {
  const range =
    state.preset === "custom"
      ? { from: state.from, to: state.to }
      : today
        ? presetRange(state.preset, today)
        : {};
  return {
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...(state.factoryId ? { factoryId: state.factoryId } : {}),
    ...(state.sectionId ? { sectionId: state.sectionId } : {}),
    ...(state.shiftId ? { shiftId: state.shiftId } : {}),
    ...(state.lineId ? { lineId: state.lineId } : {}),
  };
}

export const periodText = (period) =>
  period.from === period.to ? period.from : `${period.from} to ${period.to}`;

// Sections, shifts and lines repeat by name across factories; show each id once.
const unique = (rows) => {
  const seen = new Set();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
};

export function filterRow({ state, options, period, today, redraw, withLine = false }) {
  const inFactory = (rows) =>
    rows.filter((row) => state.factoryId === "" || row.factoryId === state.factoryId);
  const inSection = (rows) =>
    rows.filter((row) => state.sectionId === "" || row.sectionId === state.sectionId);

  const preset = (item) =>
    h(
      "button",
      {
        type: "button",
        class: `btn ${state.preset === item.id ? "btn-primary" : "btn-secondary"}`,
        "aria-pressed": String(state.preset === item.id),
        onclick: () => {
          if (item.id === "custom") {
            state.from = period.from;
            state.to = period.to;
          }
          state.preset = item.id;
          redraw();
        },
      },
      item.label
    );

  const date = (id, label, key, fallback) =>
    control(
      id,
      label,
      h("input", {
        id,
        type: "date",
        value: state[key] || fallback,
        max: today,
        onchange: (event) => {
          state[key] = event.target.value;
          redraw();
        },
      })
    );

  // Names repeat across factories ("Day", "Sewing", "Line 1"): when no factory is chosen, say whose it is.
  const factoryName = (id) => options.factories.find((row) => row.id === id)?.name;
  const named = (row) => {
    const inLine = row.sectionName ? `${row.name} · ${row.sectionName}` : row.name;
    return row.factoryId && state.factoryId === "" && options.factories.length > 1
      ? `${inLine} (${factoryName(row.factoryId) ?? "—"})`
      : inLine;
  };

  const select = (id, label, key, rows) =>
    control(
      id,
      label,
      h(
        "select",
        {
          id,
          onchange: (event) => {
            state[key] = event.target.value;
            if (key === "factoryId")
              Object.assign(state, { sectionId: "", shiftId: "", lineId: "" });
            if (key === "sectionId") state.lineId = "";
            redraw();
          },
        },
        h("option", { value: "", selected: state[key] === "" }, "All"),
        rows.map((row) =>
          h("option", { value: row.id, selected: row.id === state[key] }, named(row))
        )
      )
    );

  return h(
    "div",
    { class: "dash-filters", role: "group", "aria-label": "Filters" },
    h("div", { class: "dash-presets", role: "group", "aria-label": "Period" }, PRESETS.map(preset)),
    state.preset === "custom"
      ? [date("dash-from", "From", "from", period.from), date("dash-to", "To", "to", period.to)]
      : null,
    select("dash-factory", "Factory", "factoryId", options.factories),
    select("dash-section", "Section", "sectionId", unique(inFactory(options.sections))),
    select("dash-shift", "Shift", "shiftId", unique(inFactory(options.shifts))),
    withLine ? select("dash-line", "Line", "lineId", inSection(inFactory(options.lines))) : null
  );
}

// Figures count approved days only; the days still being entered or waiting for approval are shown
// here, labelled as provisional, so a gap in the charts is explained (D56).
export function notApprovedNotice(notApproved) {
  const parts = [];
  for (const [key, word] of [
    ["pending_approval", "waiting for approval"],
    ["draft", "still being entered"],
  ]) {
    const row = notApproved[key];
    if (row.days > 0) {
      parts.push(
        `${row.days} day${row.days === 1 ? "" : "s"} ${word} (${row.provisionalPieces} pieces so far, not counted)`
      );
    }
  }
  return parts.length === 0 ? null : notice(`Not in these figures: ${parts.join("; ")}.`, "info");
}

export const healthTone = (band) => ({ strong: "good", fair: "warn", low: "bad" })[band] ?? "muted";

// A word with the number, never colour alone.
export function healthBadge(rate, band) {
  if (rate === null || rate === undefined || band === "none") {
    return h("span", { class: "muted" }, "—");
  }
  return h("span", { class: `badge badge-${healthTone(band)}` }, `${rate.toFixed(1)}% · ${band}`);
}

// The headline figures of a period as stat tiles (the same figures on the overview and the
// production dashboard, so the two agree).
export const headlineStats = (figures) =>
  h(
    "div",
    { class: "stats" },
    statTile(
      "Pieces made",
      formatCount(figures.actualPieces),
      figures.plannedPieces === null
        ? "no plan in this period"
        : `of ${formatCount(figures.plannedPieces)} planned`
    ),
    statTile("Pieces against plan", percent(figures.piecesHitRate)),
    statTile(
      "Efficiency",
      percent(figures.actualEfficiency),
      figures.plannedEfficiency === null ? null : `plan ${percent(figures.plannedEfficiency)}`
    ),
    statTile("Defect rate", percent(figures.defectRate)),
    statTile("First-hour hit rate", percent(figures.firstHourHitRate)),
    statTile("QCO hit rate", percent(figures.qcoHitRate)),
    statTile("Downtime", minutesText(figures.downtimeMinutes)),
    statTile("Approved days", count(figures.days))
  );

// Planned and actual pieces on each approved day. Days with no approved record are not on the axis.
export function outputCard(rows, title = "Output against plan") {
  if (rows.length === 0) {
    return card(
      title,
      emptyState({
        title: "No approved production in this period",
        body: "A day appears here once it is approved.",
      })
    );
  }
  const categories = rows.map((row) => ({
    key: row.key,
    label: shortDate(row.key),
    full: fullDate(row.key),
  }));
  const legendItems = [
    { label: "Actual pieces", tone: 1 },
    { label: "Planned pieces", tone: "plan", dashed: true },
  ];
  return chartCard({
    title,
    note: h(
      "span",
      {},
      "Approved days only; days without an approved record are not shown. ",
      h("a", { href: "#/production/records" }, "Open daily records")
    ),
    legendItems,
    chart: cartesianChart({
      kind: "line",
      categories,
      series: [
        { id: "actual", label: "Actual pieces", tone: 1, values: rows.map((r) => r.actualPieces) },
        {
          id: "plan",
          label: "Planned pieces",
          tone: "plan",
          dashed: true,
          values: rows.map((r) => r.plannedPieces),
        },
      ],
      ariaLabel: "Actual and planned pieces on each approved day",
    }),
    table: {
      caption: "Output against plan by approved day",
      rowKey: (row) => row.key,
      columns: [
        { key: "date", label: "Date", sort: (r) => r.key, render: (r) => fullDate(r.key) },
        {
          key: "planned",
          label: "Planned",
          align: "end",
          sort: (r) => r.plannedPieces ?? -1,
          render: (r) => formatCount(r.plannedPieces),
        },
        {
          key: "actual",
          label: "Actual",
          align: "end",
          sort: (r) => r.actualPieces ?? -1,
          render: (r) => formatCount(r.actualPieces),
        },
        {
          key: "variance",
          label: "Variance",
          align: "end",
          sort: (r) => r.piecesVariance ?? 0,
          render: (r) => wholeSigned(r.piecesVariance),
        },
        {
          key: "hit",
          label: "Against plan",
          sort: (r) => r.piecesHitRate ?? -1,
          render: (r) => rateBadge(r.piecesHitRate),
        },
      ],
      rows,
    },
  });
}
