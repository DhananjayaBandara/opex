// One production day: the plan it follows, present manpower and QCO, the hourly output grid, events
// and downtime, the computed results, the Daily Close check and the submit, approve, return and
// correct actions (UC-SUP-02..05, FR-PROD-002..010, D36 to D40). The day's id is in the address
// ("#/production/day?id=…"), never a tenant id.
import { h } from "../dom.js";
import {
  attempt,
  badge,
  button,
  card,
  emptyState,
  formatInstant,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { confirmDialog, formDialog } from "../dialog.js";
import { session } from "../session.js";
import {
  addressId,
  count,
  minutesText,
  percent,
  production,
  rateBadge,
} from "./production-common.js";

const EVENT_OPTIONS = [
  { value: "power_cut", label: "Power cut" },
  { value: "machine_breakdown", label: "Machine breakdown" },
  { value: "material_shortage", label: "Material shortage" },
  { value: "style_changeover", label: "Style changeover" },
  { value: "absenteeism", label: "Absenteeism" },
  { value: "quality_hold", label: "Quality hold" },
  { value: "waiting_instruction", label: "Waiting for instruction" },
  { value: "other", label: "Other (describe in the note)" },
];

const EVENT_ERRORS = {
  invalid_event: "code",
  invalid_number: "minutes",
  downtime_exceeds_day: "minutes",
  note_required: "note",
  invalid_field: "note",
};

const kv = (label, value) => h("div", { class: "kv" }, h("dt", {}, label), h("dd", {}, value));
const tile = (label, value, detail) =>
  h(
    "div",
    { class: "stat" },
    h("strong", {}, value),
    h("span", {}, label),
    detail ? h("small", { class: "muted" }, detail) : null
  );

export function render() {
  const root = h("div");
  // Typed but unsaved values survive a redraw (adding an event, for example).
  const state = { edits: {} };
  mount(root, (redraw) => {
    const id = addressId();
    if (!id) {
      return emptyState({
        title: "No production day chosen",
        body: "Open a day from the production dashboard.",
        action: h("a", { href: "#/production/dashboard" }, "Go to the production dashboard"),
      });
    }
    const day = production((p, ctx) => p.day(ctx, id));
    const editable = day.can.edit;

    const call = (action) => production((p, ctx) => action(p, ctx));
    const saved = (result) => {
      state.edits = {};
      return result;
    };

    // ---- Inputs ---------------------------------------------------------------------------

    const value = (name, server) => state.edits[name] ?? (server === null ? "" : String(server));
    const input = (name, server, label, attributes = {}) =>
      editable
        ? h("input", {
            type: "number",
            min: "0",
            step: "1",
            inputmode: "numeric",
            "aria-label": label,
            value: value(name, server),
            oninput: (event) => {
              state.edits[name] = event.target.value;
            },
            ...attributes,
          })
        : count(server);

    // Everything typed on the page, in the shape saveDay takes.
    const payload = () => ({
      presentMCOperators: value("mc", day.presentMCOperators),
      presentHelpers: value("helpers", day.presentHelpers),
      presentManual: value("manual", day.presentManual),
      qcoHitRate: value("qco", day.qcoHitRate),
      notes: state.edits.notes ?? day.notes ?? "",
      hours: day.hours.map((hour) => ({
        ordinalHour: hour.ordinalHour,
        actualPieces: value(`a${hour.ordinalHour}`, hour.actualPieces),
        damagePieces: value(`d${hour.ordinalHour}`, hour.damagePieces),
      })),
    });

    const save = () => {
      const result = attempt(() => call((p, ctx) => p.saveDay(ctx, day.id, payload())));
      if (result === undefined) return false;
      saved(result);
      toast("Day saved", "good");
      redraw();
      return true;
    };

    // ---- Actions --------------------------------------------------------------------------

    const submitNow = (confirmGaps) => call((p, ctx) => p.submit(ctx, day.id, { confirmGaps }));

    const submit = () => {
      if (!save()) return;
      try {
        submitNow(false);
        toast("Submitted for approval", "good");
        redraw();
      } catch (error) {
        if (error.code !== "confirmation_required") {
          session.handle(error);
          toast(error.message, "bad");
          return;
        }
        confirmDialog({
          title: "Submit with gaps?",
          message: error.message,
          confirmLabel: "Submit anyway",
          onConfirm: () => {
            submitNow(true);
            toast("Submitted for approval", "good");
            redraw();
          },
        });
      }
    };

    const approve = () =>
      confirmDialog({
        title: "Approve this day?",
        message: `${day.lineName} on ${day.date} will be approved. Further changes need a privileged correction.`,
        confirmLabel: "Approve",
        onConfirm: () => {
          call((p, ctx) => p.approve(ctx, day.id));
          toast("Day approved", "good");
          redraw();
        },
      });

    const giveBack = () =>
      confirmDialog({
        title: "Return to the supervisor?",
        message: "The day goes back to draft with your reason, so the supervisor can fix it.",
        confirmLabel: "Return",
        reason: true,
        reasonLabel: "What needs to be fixed",
        onConfirm: (reason) => {
          call((p, ctx) => p.returnDay(ctx, day.id, { reason }));
          toast("Day returned", "good");
          redraw();
        },
      });

    const adopt = () => {
      if (
        attempt(() => call((p, ctx) => p.adoptPlan(ctx, day.id)), "Latest plan revision adopted")
      ) {
        redraw();
      }
    };

    const addEvent = () =>
      formDialog({
        title: "Add an event",
        description: "Downtime and its cause. Minutes add up across the day's events.",
        fields: [
          { name: "code", label: "What happened", type: "select", options: EVENT_OPTIONS },
          { name: "minutes", label: "Minutes lost", type: "number", min: 1, required: true },
          {
            name: "ordinalHour",
            label: "Hour",
            type: "number",
            min: 1,
            max: day.workingHours,
            hint: "Optional: the hour it happened in",
          },
          { name: "note", label: "Note", hint: "Required when the event is “Other”" },
        ],
        initial: { code: "power_cut" },
        errorFields: EVENT_ERRORS,
        submitLabel: "Add event",
        onSubmit: (values) => {
          call((p, ctx) => p.addEvent(ctx, day.id, values));
          toast("Event added", "good");
          redraw();
        },
      });

    const removeEvent = (event) => {
      if (attempt(() => call((p, ctx) => p.removeEvent(ctx, day.id, event.id)), "Event removed")) {
        redraw();
      }
    };

    const correct = () =>
      formDialog({
        title: "Correct this approved day",
        description:
          "The day stays approved. The earlier figures are kept in its history with your reason.",
        fields: [
          { name: "reason", label: "Reason for the correction", type: "textarea", required: true },
          { name: "mc", label: "Present operators", type: "number", min: 0 },
          { name: "helpers", label: "Present helpers", type: "number", min: 0 },
          { name: "manual", label: "Present manual workers", type: "number", min: 0 },
          { name: "qco", label: "QCO hit rate (%)", type: "number", min: 0, max: 100, step: "any" },
          ...day.hours.flatMap((hour) => [
            {
              name: `a${hour.ordinalHour}`,
              label: `Hour ${hour.ordinalHour} output`,
              type: "number",
              min: 0,
            },
            {
              name: `d${hour.ordinalHour}`,
              label: `Hour ${hour.ordinalHour} damaged`,
              type: "number",
              min: 0,
            },
          ]),
        ],
        initial: {
          mc: day.presentMCOperators ?? undefined,
          helpers: day.presentHelpers ?? undefined,
          manual: day.presentManual ?? undefined,
          qco: day.qcoHitRate ?? undefined,
          ...Object.fromEntries(
            day.hours.flatMap((hour) => [
              [`a${hour.ordinalHour}`, hour.actualPieces ?? undefined],
              [`d${hour.ordinalHour}`, hour.damagePieces ?? undefined],
            ])
          ),
        },
        errorFields: { reason_required: "reason", no_change: "reason" },
        submitLabel: "Save correction",
        onSubmit: (values) => {
          call((p, ctx) =>
            p.correct(ctx, day.id, {
              reason: values.reason,
              presentMCOperators: values.mc,
              presentHelpers: values.helpers,
              presentManual: values.manual,
              qcoHitRate: values.qco,
              hours: day.hours.map((hour) => ({
                ordinalHour: hour.ordinalHour,
                actualPieces: values[`a${hour.ordinalHour}`],
                damagePieces: values[`d${hour.ordinalHour}`],
              })),
            })
          );
          toast("Correction saved", "good");
          redraw();
        },
      });

    // ---- Sections -------------------------------------------------------------------------

    const planCard = card(
      "Plan",
      h(
        "dl",
        {},
        kv("Style", `${day.styleCode} · ${day.styleName} (SMV ${day.smv})`),
        kv("Order", day.orderRef ?? "—"),
        kv("Plan revision", String(day.planRevision)),
        kv(
          "Target",
          `${day.hourlyTarget} pieces per hour × ${day.workingHours} hours = ${day.hourlyTarget * day.workingHours} pieces`
        ),
        kv("Planned efficiency", percent(day.plannedEfficiency)),
        kv("Planned manpower", `${day.plannedMCOperators} operators + ${day.plannedManual} manual`),
        kv(
          "Supervisor",
          day.supervisorName ??
            (day.currentSupervisors.length > 0
              ? day.currentSupervisors.join(", ")
              : "none assigned")
        )
      )
    );

    const manpowerCard = card(
      "Present manpower and quality",
      h(
        "div",
        { class: "form-grid" },
        h(
          "label",
          {},
          "Operators",
          input("mc", day.presentMCOperators, "Present machine operators")
        ),
        h("label", {}, "Helpers", input("helpers", day.presentHelpers, "Present helpers")),
        h(
          "label",
          {},
          "Manual workers",
          input("manual", day.presentManual, "Present manual workers")
        ),
        h(
          "label",
          {},
          "QCO hit rate (%)",
          input("qco", day.qcoHitRate, "QCO hit rate percent", { max: "100", step: "any" })
        ),
        h(
          "label",
          { class: "wide" },
          "Notes",
          editable
            ? h(
                "textarea",
                {
                  rows: 2,
                  maxlength: 500,
                  oninput: (event) => {
                    state.edits.notes = event.target.value;
                  },
                },
                state.edits.notes ?? day.notes ?? ""
              )
            : h("div", {}, day.notes ?? "—")
        )
      )
    );

    const hoursCard = card(
      "Hourly output",
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "table" },
          h("caption", { class: "sr-only" }, "Hourly output against target"),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              ["Hour", "Target", "Output", "Damaged", "Hit rate", "Cumulative"].map((label) =>
                h("th", { scope: "col" }, label)
              )
            )
          ),
          h(
            "tbody",
            {},
            day.hours.map((hour) =>
              h(
                "tr",
                {},
                h("th", { scope: "row" }, String(hour.ordinalHour)),
                h("td", { class: "num" }, count(hour.target)),
                h(
                  "td",
                  { class: "num" },
                  input(
                    `a${hour.ordinalHour}`,
                    hour.actualPieces,
                    `Output, hour ${hour.ordinalHour}`
                  )
                ),
                h(
                  "td",
                  { class: "num" },
                  input(
                    `d${hour.ordinalHour}`,
                    hour.damagePieces,
                    `Damaged pieces, hour ${hour.ordinalHour}`
                  )
                ),
                h("td", {}, rateBadge(hour.hitRate)),
                h(
                  "td",
                  { class: "num" },
                  hour.cumulativeActual === null
                    ? "—"
                    : `${hour.cumulativeActual} / ${hour.cumulativeTarget}`
                )
              )
            )
          )
        )
      ),
      editable ? button("Save", save, { kind: "primary" }) : null
    );

    const eventsCard = card(
      "Events and downtime",
      day.events.length === 0
        ? h("p", { class: "muted" }, "No events reported.")
        : h(
            "ul",
            { class: "plain events" },
            day.events.map((event) =>
              h(
                "li",
                {},
                h("strong", {}, event.label),
                ` · ${minutesText(event.minutes)}`,
                event.ordinalHour === null ? "" : ` · hour ${event.ordinalHour}`,
                event.note ? ` · ${event.note}` : "",
                editable
                  ? [" ", button("Remove", () => removeEvent(event), { kind: "link" })]
                  : null
              )
            )
          ),
      editable ? button("Add event", addEvent) : null
    );

    const m = day.metrics;
    const resultsCard = card(
      "Results",
      h(
        "div",
        { class: "stats" },
        tile(
          "Total production",
          count(m.totalProduction),
          `${m.hoursRun} of ${day.workingHours} hours entered`
        ),
        tile("Planned pieces", count(m.plannedPieces)),
        tile("Pieces hit rate", percent(m.piecesHitRate)),
        tile("Hourly hit rate", percent(m.hourlyHitRate)),
        tile("First-hour hit rate", percent(m.firstHourHitRate)),
        tile("Earned SAH", m.earnedSAH === null ? "—" : m.earnedSAH.toFixed(1)),
        tile("Present manpower", count(m.presentManpower), `${m.plannedManpower} planned`),
        tile("Efficiency", percent(m.achievedEfficiency), `plan ${percent(day.plannedEfficiency)}`),
        tile("Damage", percent(m.damagePercent)),
        tile("Downtime", minutesText(day.downtimeMinutes))
      )
    );

    const list = (items) =>
      h(
        "ul",
        {},
        items.map((text) => h("li", {}, text))
      );
    const closeCard = card(
      "Daily Close",
      h(
        "div",
        {},
        day.status !== "draft"
          ? h("p", { class: "muted" }, "The day has been closed.")
          : [
              day.close.blockers.length > 0 ? notice(list(day.close.blockers), "bad") : null,
              day.close.warnings.length > 0 ? notice(list(day.close.warnings), "warn") : null,
              day.close.ready && day.close.warnings.length === 0
                ? notice("Everything needed is entered. The day can be submitted.", "good")
                : null,
            ],
        day.status === "pending_approval"
          ? h(
              "p",
              {},
              `Submitted by ${day.submittedByName ?? "—"} on ${formatInstant(day.submittedAt)}.`
            )
          : null,
        day.status === "approved"
          ? h(
              "p",
              {},
              `Approved by ${day.approvedByName ?? "—"} on ${formatInstant(day.approvedAt)}.`
            )
          : null,
        h(
          "div",
          { class: "actions" },
          day.can.submit
            ? button("Save and submit for approval", submit, { kind: "primary" })
            : null,
          day.can.approve ? button("Approve", approve, { kind: "primary" }) : null,
          day.can.return ? button("Return to supervisor", giveBack) : null,
          day.can.correct ? button("Correct figures", correct) : null
        ),
        day.status === "pending_approval" && !day.can.approve && day.can.return
          ? h("p", { class: "muted" }, "You submitted this day, so someone else must approve it.")
          : null
      )
    );

    const historyCard = card(
      "History",
      day.history.length === 0
        ? h("p", { class: "muted" }, "No history yet.")
        : h(
            "ol",
            { class: "history" },
            day.history.map((entry) =>
              h(
                "li",
                {},
                h("strong", {}, entry.label),
                ` · ${formatInstant(entry.at)} · ${entry.byName ?? "system"}`,
                entry.reason ? h("div", { class: "muted" }, `Reason: ${entry.reason}`) : null
              )
            )
          )
    );

    return h(
      "div",
      {},
      pageHeader(
        `${day.lineName} · ${day.date}`,
        `${day.factoryName} · ${day.sectionName} · ${day.shiftName}`,
        statusBadge(day.status),
        h("a", { href: "#/production/dashboard" }, "Back to dashboard")
      ),
      session.supporting
        ? notice("Read-only support access: nothing here can be changed.", "warn")
        : null,
      day.returnReason && day.status === "draft"
        ? notice(`Returned for fixing: ${day.returnReason}`, "warn")
        : null,
      day.newerRevision !== null
        ? notice(
            h(
              "span",
              {},
              `Plan revision ${day.newerRevision} was published after this day opened. `,
              editable ? button("Use revision " + day.newerRevision, adopt, { kind: "link" }) : null
            ),
            "info"
          )
        : null,
      day.status === "approved"
        ? h(
            "p",
            {},
            badge("Approved", "good"),
            " ",
            "Figures are locked; corrections are recorded with a reason."
          )
        : null,
      planCard,
      manpowerCard,
      hoursCard,
      eventsCard,
      resultsCard,
      closeCard,
      historyCard
    );
  });
  return root;
}
