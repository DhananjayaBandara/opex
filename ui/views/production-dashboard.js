// The supervisor and production dashboard: for each section and shift in scope, its lines on one
// date with the plan, the day's status and figures, and the next step (UC-SUP-01, FR-PROD-001/005,
// D41). Which sections appear follows the person's factory scope or supervisor assignments.
import { h } from "../dom.js";
import {
  attempt,
  button,
  card,
  emptyState,
  mount,
  notice,
  pageHeader,
  statusBadge,
} from "../kit.js";
import { session } from "../session.js";
import {
  control,
  count,
  dayAddress,
  minutesText,
  percent,
  production,
  rateBadge,
} from "./production-common.js";

const TOTALS = [
  { key: "lines", label: "Lines" },
  { key: "planned", label: "Plans published" },
  { key: "open", label: "Days opened" },
  { key: "draft", label: "In progress" },
  { key: "pending_approval", label: "Waiting for approval" },
  { key: "approved", label: "Approved" },
];

export function render() {
  const root = h("div");
  const state = { date: null };
  mount(root, (redraw) => {
    const view = production((p, ctx) => p.dashboard(ctx, state.date ? { date: state.date } : {}));
    state.date = view.date;

    const go = (date) => {
      state.date = date;
      redraw();
    };
    const open = (line, section) => {
      const day = attempt(() =>
        production((p, ctx) =>
          p.openDay(ctx, { lineId: line.lineId, shiftId: section.shiftId, date: view.date })
        )
      );
      if (day) window.location.hash = dayAddress(day.id).slice(1);
    };

    const nextStep = (line, section) => {
      const { kind, label } = line.next;
      if (kind === "open") return button(label, () => open(line, section), { kind: "primary" });
      if (line.day !== null) {
        const urgent = kind === "enter" || kind === "fix" || kind === "submit";
        return h(
          "a",
          { href: dayAddress(line.day.id), class: urgent ? "next next-urgent" : "next" },
          label
        );
      }
      return h("span", { class: "muted" }, label);
    };

    const lineRow = (line, section) =>
      h(
        "tr",
        {},
        h("th", { scope: "row" }, line.lineName),
        h(
          "td",
          {},
          line.plan === null
            ? h("span", { class: "muted" }, "No plan")
            : [
                h("strong", {}, line.plan.styleCode ?? "—"),
                h(
                  "div",
                  { class: "muted" },
                  `${line.plan.hourlyTarget} / h × ${line.plan.workingHours} h = ${line.plan.plannedPieces}`,
                  line.plan.revision > 1 ? ` · revision ${line.plan.revision}` : ""
                ),
              ]
        ),
        h(
          "td",
          {},
          line.day === null
            ? h("span", { class: "muted" }, "Not open")
            : statusBadge(line.day.status)
        ),
        h(
          "td",
          { class: "num" },
          line.day === null
            ? "—"
            : `${count(line.day.totalProduction)} of ${count(line.day.plannedPieces)}`
        ),
        h("td", {}, line.day === null ? "—" : rateBadge(line.day.piecesHitRate)),
        h("td", { class: "num" }, line.day === null ? "—" : percent(line.day.achievedEfficiency)),
        h("td", { class: "num" }, line.day === null ? "—" : minutesText(line.day.downtimeMinutes)),
        h(
          "td",
          {},
          nextStep(line, section),
          line.day?.returnReason
            ? h("div", { class: "muted" }, `Reason: ${line.day.returnReason}`)
            : null
        )
      );

    const sectionCard = (section) =>
      card(
        `${section.sectionName} · ${section.shiftName}`,
        h(
          "div",
          {},
          h(
            "p",
            { class: "muted" },
            `${section.factoryName} · Supervisor: ${
              section.supervisors.length > 0
                ? section.supervisors.join(", ")
                : "none assigned on this date"
            }`
          ),
          h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              { class: "table" },
              h("caption", { class: "sr-only" }, `${section.sectionName}, ${section.shiftName}`),
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  [
                    "Line",
                    "Plan",
                    "Status",
                    "Output",
                    "Against plan",
                    "Efficiency",
                    "Downtime",
                    "Next step",
                  ].map((label) => h("th", { scope: "col" }, label))
                )
              ),
              h(
                "tbody",
                {},
                section.lines.map((line) => lineRow(line, section))
              )
            )
          )
        )
      );

    const isToday = view.date === view.today;
    return h(
      "div",
      {},
      pageHeader(
        "Production dashboard",
        view.scope === "assignments"
          ? "Your assigned sections and shifts."
          : "Every section and shift in your factory scope."
      ),
      h(
        "div",
        { class: "table-tools" },
        button("◀ Previous day", () => go(view.previous)),
        control(
          "production-date",
          "Date",
          h("input", {
            id: "production-date",
            type: "date",
            value: view.date,
            onchange: (event) => go(event.target.value || view.today),
          })
        ),
        button("Next day ▶", () => go(view.next)),
        button("Today", () => go(view.today), { disabled: isToday }),
        h("span", { class: "muted" }, isToday ? "Showing today" : `Today is ${view.today}`)
      ),
      session.supporting
        ? notice("Read-only support access: days cannot be opened or changed.", "warn")
        : null,
      h(
        "div",
        { class: "stats", role: "group", "aria-label": "Totals for the day" },
        TOTALS.map(({ key, label }) =>
          h(
            "div",
            { class: "stat" },
            h("strong", {}, String(view.totals[key])),
            h("span", {}, label)
          )
        )
      ),
      view.cards.length === 0
        ? card(
            null,
            emptyState({
              title: "No sections to show",
              body:
                view.scope === "assignments"
                  ? "You have no supervisor assignment on this date, or your section has no lines."
                  : "No active section and shift with lines is in your scope.",
            })
          )
        : view.cards.map(sectionCard)
    );
  });
  return root;
}
