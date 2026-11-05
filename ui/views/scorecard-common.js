// Pieces shared by the scorecard screens: the service call, number text, the filter bar and the body
// of one supervisor's scorecard, which My Scorecard and the supervisor page both draw (S4, D43 to D52).
import { h } from "../dom.js";
import { card, formatInstant, notice, statusBadge } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { control, count, dayAddress, minutesText, percent } from "./production-common.js";

export const scorecards = (call) => session.run((ctx) => call(session.app.scorecards, ctx));

// A value from the address query ("#/scorecard/supervisor?id=…&from=…").
export const addressValue = (name, hash = window.location.hash) =>
  new URLSearchParams(String(hash).split("?")[1] ?? "").get(name);

export function supervisorAddress(id, period) {
  const query = new URLSearchParams({ id });
  if (period) {
    query.set("from", period.from);
    query.set("to", period.to);
  }
  return `#/scorecard/supervisor?${query}`;
}

export const dateRange = (period) => `${period.from} to ${period.to}`;

// A signed difference such as +3.2 or −1.0 (the sign is always written, never colour alone).
export function signed(value, digits = 1, suffix = "") {
  if (value === null || value === undefined) return "—";
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return `${text}${suffix}`;
  return `${value > 0 ? "+" : "−"}${text}${suffix}`;
}

export const wholeSigned = (value) =>
  value === null || value === undefined
    ? "—"
    : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value))}`;

// The score bands are a reading aid only; they carry no business rule.
export function scoreBadge(score) {
  if (score === null || score === undefined) return h("span", { class: "muted" }, "No score");
  const tone = score >= 90 ? "good" : score >= 75 ? "warn" : "bad";
  const word = score >= 90 ? "strong" : score >= 75 ? "fair" : "low";
  return h("span", { class: `badge badge-${tone}`, title: word }, `${score.toFixed(1)} · ${word}`);
}

const stat = (label, value, detail) =>
  h(
    "div",
    { class: "stat" },
    h("strong", {}, value),
    h("span", {}, label),
    detail ? h("small", { class: "muted" }, detail) : null
  );

const option = (value, label, selected) => h("option", { value, selected }, label);

// Factory, section, shift and period controls. `state` keeps what was typed between redraws; an empty
// date means the rolling window.
export function filterBar({ state, options, period, today, redraw, kinds = null }) {
  const sections = options.sections.filter(
    (row) => state.factoryId === "" || row.factoryId === state.factoryId
  );
  const shifts = options.shifts.filter(
    (row) => state.factoryId === "" || row.factoryId === state.factoryId
  );
  const select = (id, label, key, rows, extra = []) =>
    control(
      id,
      label,
      h(
        "select",
        {
          id,
          onchange: (event) => {
            state[key] = event.target.value;
            if (key === "factoryId") {
              state.sectionId = "";
              state.shiftId = "";
            }
            redraw();
          },
        },
        option("", "All", state[key] === ""),
        extra,
        rows.map((row) => option(row.id, row.name, row.id === state[key]))
      )
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
  return h(
    "div",
    { class: "table-tools" },
    select("sc-factory", "Factory", "factoryId", options.factories),
    select("sc-section", "Section", "sectionId", dedupe(sections)),
    select("sc-shift", "Shift", "shiftId", dedupe(shifts)),
    date("sc-from", "From", "from", period.from),
    date("sc-to", "To", "to", period.to),
    kinds === null
      ? null
      : control(
          "sc-kind",
          "Kind",
          h(
            "select",
            {
              id: "sc-kind",
              onchange: (event) => {
                state.kind = event.target.value;
                redraw();
              },
            },
            option("", "All", state.kind === ""),
            Object.entries(kinds).map(([value, label]) =>
              option(value, label, value === state.kind)
            )
          )
        ),
    h(
      "button",
      {
        type: "button",
        class: "btn btn-link",
        onclick: () => {
          state.from = "";
          state.to = "";
          redraw();
        },
      },
      "Use the rolling window"
    )
  );
}

// Sections and shifts repeat by name across factories; show each name once when no factory is chosen.
function dedupe(rows) {
  const seen = new Set();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

export const filterQuery = (state) => ({
  ...(state.factoryId ? { factoryId: state.factoryId } : {}),
  ...(state.sectionId ? { sectionId: state.sectionId } : {}),
  ...(state.shiftId ? { shiftId: state.shiftId } : {}),
  ...(state.from ? { from: state.from } : {}),
  ...(state.to ? { to: state.to } : {}),
});

export const emptyFilters = () => ({ factoryId: "", sectionId: "", shiftId: "", from: "", to: "" });

// ---- One supervisor's scorecard ------------------------------------------------------------------

const planCell = (actual, planned) =>
  planned === null || planned === undefined
    ? count(actual)
    : `${count(actual)} of ${count(planned)}`;

export function scorecardBody(detail, { linkDays }) {
  const { figures, attendance, config } = detail;
  const components = detail.components;
  const noDays = figures.days === 0;
  return h(
    "div",
    {},
    noDays
      ? notice(
          "No approved production day in this period, so there is nothing to score. Attendance is shown below.",
          "info"
        )
      : null,
    detail.sharedDays > 0
      ? notice(
          `${detail.sharedDays} day${detail.sharedDays === 1 ? " was" : "s were"} shared with another supervisor and ${detail.sharedDays === 1 ? "is" : "are"} not counted for anyone.`,
          "warn"
        )
      : null,
    h(
      "div",
      { class: "stats" },
      h(
        "div",
        { class: "stat" },
        h("strong", {}, detail.score === null ? "—" : detail.score.toFixed(1)),
        h("span", {}, "Score"),
        h("small", {}, scoreBadge(detail.score))
      ),
      stat("Days scored", count(figures.days), "Approved production days"),
      stat("Period", dateRange(detail.period), `${config.label} · ${config.windowDays}-day window`),
      stat("Downtime", minutesText(figures.downtimeMinutes))
    ),

    card(
      "Score breakdown",
      h(
        "div",
        {},
        h(
          "p",
          { class: "muted" },
          `Weights come from ${config.label}${config.isDefault ? "" : ` (from ${config.effectiveFrom})`}. A part without a reading is left out and the other weights are scaled up to 100.`
        ),
        dataTable({
          caption: "Score components",
          columns: [
            { key: "label", label: "Part", sort: (r) => r.label },
            {
              key: "reading",
              label: "Reading",
              align: "end",
              sort: (r) => r.reading ?? -1,
              render: (r) => percent(r.reading),
            },
            {
              key: "target",
              label: "Target",
              align: "end",
              render: (r) =>
                r.target === null
                  ? "—"
                  : h(
                      "span",
                      {},
                      `${r.target}%`,
                      r.targetSource
                        ? h("small", { class: "muted" }, ` ${sourceText(r.targetSource)}`)
                        : null
                    ),
            },
            {
              key: "score",
              label: "Part score",
              align: "end",
              sort: (r) => r.score ?? -1,
              render: (r) => (r.score === null ? "—" : r.score.toFixed(1)),
            },
            { key: "weight", label: "Weight", align: "end", render: (r) => `${r.weight}%` },
            {
              key: "effective",
              label: "Counted at",
              align: "end",
              render: (r) =>
                r.effectiveWeight === null ? "left out" : `${r.effectiveWeight.toFixed(1)}%`,
            },
          ],
          rows: components,
          rowKey: (r) => r.key,
        })
      )
    ),

    card(
      "Against plan",
      h(
        "div",
        { class: "stats" },
        stat(
          "Pieces",
          planCell(figures.actualPieces, figures.plannedPieces),
          figures.piecesVariance === null
            ? null
            : `${wholeSigned(figures.piecesVariance)} against plan · ${percent(figures.piecesHitRate)}`
        ),
        stat(
          "Efficiency",
          percent(figures.actualEfficiency),
          figures.plannedEfficiency === null
            ? null
            : `Planned ${percent(figures.plannedEfficiency)} · ${signed(figures.efficiencyVariance, 1, " pts")}`
        ),
        stat("Defect rate", percent(figures.defectRate)),
        stat("First-hour hit rate", percent(figures.firstHourHitRate)),
        stat("QCO hit rate", percent(figures.qcoHitRate))
      )
    ),

    card(
      "Attendance",
      h(
        "div",
        { class: "stats" },
        stat("Attendance score", percent(attendance.attendanceScore)),
        stat("Working days", count(attendance.scheduledDays)),
        stat("Present", count(attendance.presentDays)),
        stat("Absent", count(attendance.absentDays)),
        stat("On leave", count(attendance.leaveDays)),
        stat("Not recorded", count(attendance.unrecordedDays), "Counted as present")
      )
    ),

    card(
      "Where the days were worked",
      h(
        "div",
        {},
        breakdown("Lines", detail.byLine, "No approved day yet."),
        breakdown("Sections", detail.bySection, "No approved day yet.")
      )
    ),

    card(
      "Day by day",
      dataTable({
        caption: "Scored days",
        pageSize: 10,
        columns: [
          { key: "date", label: "Date", sort: (r) => r.date },
          {
            key: "line",
            label: "Line",
            sort: (r) => r.lineName,
            render: (r) =>
              linkDays ? h("a", { href: dayAddress(r.dayId) }, r.lineName) : r.lineName,
          },
          { key: "shift", label: "Shift", render: (r) => r.shiftName },
          {
            key: "pieces",
            label: "Pieces",
            align: "end",
            sort: (r) => r.totalProduction ?? -1,
            render: (r) => planCell(r.totalProduction, r.plannedPieces),
          },
          {
            key: "hit",
            label: "Against plan",
            align: "end",
            sort: (r) => r.piecesHitRate ?? -1,
            render: (r) => percent(r.piecesHitRate),
          },
          {
            key: "efficiency",
            label: "Efficiency",
            align: "end",
            sort: (r) => r.efficiency ?? -1,
            render: (r) => percent(r.efficiency),
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
            key: "downtime",
            label: "Downtime",
            align: "end",
            sort: (r) => r.downtimeMinutes,
            render: (r) => minutesText(r.downtimeMinutes),
          },
        ],
        rows: [...detail.trend].reverse(),
        rowKey: (r) => r.dayId,
        empty: {
          title: "No scored days",
          body: "No approved production day falls in this period.",
        },
      })
    ),

    card(
      "Assignments",
      dataTable({
        caption: "Supervisor assignments",
        columns: [
          { key: "factory", label: "Factory", render: (r) => r.factoryName ?? "—" },
          { key: "section", label: "Section", render: (r) => r.sectionName ?? "—" },
          { key: "shift", label: "Shift", render: (r) => r.shiftName ?? "—" },
          { key: "effectiveFrom", label: "From", sort: (r) => r.effectiveFrom },
          { key: "to", label: "To", render: (r) => r.effectiveTo ?? "open" },
          { key: "state", label: "State", render: (r) => statusBadge(r.state) },
        ],
        rows: detail.assignments,
        rowKey: (r) => r.id,
        empty: { title: "No assignments", body: "This person has never been assigned." },
      })
    ),

    card(
      "Snapshots",
      detail.snapshots.length === 0
        ? h("p", { class: "muted" }, "No snapshot has been taken for this supervisor yet.")
        : dataTable({
            caption: "Score snapshots",
            columns: [
              { key: "asOf", label: "As of", sort: (r) => r.asOf },
              { key: "period", label: "Period", render: (r) => dateRange(r) },
              {
                key: "score",
                label: "Score",
                align: "end",
                sort: (r) => r.score ?? -1,
                render: (r) => scoreBadge(r.score),
              },
              {
                key: "config",
                label: "Configuration",
                render: (r) =>
                  r.configVersion === 0 ? "Felix defaults" : `Version ${r.configVersion}`,
              },
              { key: "days", label: "Days", align: "end", render: (r) => count(r.days) },
              {
                key: "taken",
                label: "Taken",
                render: (r) => `${formatInstant(r.takenAt)} by ${r.takenByName ?? "—"}`,
              },
            ],
            rows: detail.snapshots,
            rowKey: (r) => r.id,
          })
    )
  );
}

const SOURCES = {
  system: "(Felix default)",
  tenant: "(organization)",
  factory: "(factory)",
};
const sourceText = (source) =>
  typeof source === "string" ? (SOURCES[source] ?? `(${source})`) : (SOURCES[source?.level] ?? "");

function breakdown(title, rows, emptyText) {
  return h(
    "div",
    {},
    h("h3", {}, title),
    rows.length === 0
      ? h("p", { class: "muted" }, emptyText)
      : dataTable({
          caption: title,
          columns: [
            {
              key: "name",
              label: title.slice(0, -1),
              sort: (r) => r.name,
              render: (r) =>
                h("div", {}, h("strong", {}, r.name), h("div", { class: "muted" }, r.context)),
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
              render: (r) => planCell(r.actualPieces, r.plannedPieces),
            },
            {
              key: "hit",
              label: "Against plan",
              align: "end",
              sort: (r) => r.piecesHitRate ?? -1,
              render: (r) => percent(r.piecesHitRate),
            },
            {
              key: "efficiency",
              label: "Efficiency",
              align: "end",
              sort: (r) => r.actualEfficiency ?? -1,
              render: (r) => percent(r.actualEfficiency),
            },
            {
              key: "defect",
              label: "Defects",
              align: "end",
              render: (r) => percent(r.defectRate),
            },
          ],
          rows,
          rowKey: (r) => r.id,
        })
  );
}
