// Daily records: production days in scope with their status, for approvers and readers. The queue
// of days waiting for approval is the default view (UC-MGT-01, FR-PROD-006, D39). A day opens on its
// own page, where it can be approved, returned or corrected.
import { h } from "../dom.js";
import { button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { confirmDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import {
  control,
  count,
  dayAddress,
  minutesText,
  percent,
  production,
  rateBadge,
  shiftDay,
} from "./production-common.js";

const STATUS_OPTIONS = [
  { value: "pending_approval", label: "Waiting for approval" },
  { value: "draft", label: "In progress or returned" },
  { value: "approved", label: "Approved" },
  { value: "", label: "All" },
];

export function render() {
  const root = h("div");
  const state = { status: "pending_approval", factoryId: "", from: null };
  mount(root, (redraw) => {
    const today = session.who.today;
    state.from ??= shiftDay(today, -14);
    const mayApprove =
      session.can("production.approve") && !session.supporting && !session.who.assignmentScoped;

    const areas = production((p, ctx) => p.workAreas(ctx, { for: "view" }));
    const factories = [...new Map(areas.map((a) => [a.factoryId, a.factoryName])).entries()];
    const rows = production((p, ctx) =>
      p.days(ctx, {
        from: state.from,
        ...(state.status ? { status: state.status } : {}),
        ...(state.factoryId ? { factoryId: state.factoryId } : {}),
      })
    );

    const approve = (row) =>
      confirmDialog({
        title: "Approve this day?",
        message: `${row.lineName} on ${row.date} will be approved.`,
        confirmLabel: "Approve",
        onConfirm: () => {
          production((p, ctx) => p.approve(ctx, row.id));
          toast("Day approved", "good");
          redraw();
        },
      });

    const giveBack = (row) =>
      confirmDialog({
        title: "Return to the supervisor?",
        message: `${row.lineName} on ${row.date} goes back to draft with your reason.`,
        confirmLabel: "Return",
        reason: true,
        reasonLabel: "What needs to be fixed",
        onConfirm: (reason) => {
          production((p, ctx) => p.returnDay(ctx, row.id, { reason }));
          toast("Day returned", "good");
          redraw();
        },
      });

    return h(
      "div",
      {},
      pageHeader("Daily records", "Production days and where each one stands."),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      h(
        "div",
        { class: "table-tools" },
        control(
          "records-status",
          "Show",
          h(
            "select",
            {
              id: "records-status",
              onchange: (event) => {
                state.status = event.target.value;
                redraw();
              },
            },
            STATUS_OPTIONS.map((option) =>
              h(
                "option",
                { value: option.value, selected: option.value === state.status },
                option.label
              )
            )
          )
        ),
        control(
          "records-factory",
          "Factory",
          h(
            "select",
            {
              id: "records-factory",
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
          "records-from",
          "Since",
          h("input", {
            id: "records-from",
            type: "date",
            value: state.from,
            max: today,
            onchange: (event) => {
              state.from = event.target.value || shiftDay(today, -14);
              redraw();
            },
          })
        )
      ),
      card(
        null,
        dataTable({
          caption: "Production days",
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
                  h("a", { href: dayAddress(r.id) }, h("strong", {}, r.lineName)),
                  h(
                    "div",
                    { class: "muted" },
                    `${r.factoryName} · ${r.sectionName} · ${r.shiftName}`
                  )
                ),
            },
            { key: "style", label: "Style", sort: (r) => r.styleCode, render: (r) => r.styleCode },
            {
              key: "status",
              label: "Status",
              sort: (r) => r.status,
              render: (r) =>
                h(
                  "div",
                  {},
                  statusBadge(r.status),
                  r.status === "draft" && r.returnReason
                    ? h("div", { class: "muted" }, "Returned")
                    : null
                ),
            },
            {
              key: "output",
              label: "Output",
              sort: (r) => r.totalProduction,
              render: (r) => `${count(r.totalProduction)} of ${count(r.plannedPieces)}`,
            },
            {
              key: "hit",
              label: "Against plan",
              sort: (r) => r.piecesHitRate ?? -1,
              render: (r) => rateBadge(r.piecesHitRate),
            },
            {
              key: "efficiency",
              label: "Efficiency",
              sort: (r) => r.achievedEfficiency ?? -1,
              render: (r) => percent(r.achievedEfficiency),
            },
            {
              key: "downtime",
              label: "Downtime",
              sort: (r) => r.downtimeMinutes,
              render: (r) => minutesText(r.downtimeMinutes),
            },
            {
              key: "submitted",
              label: "Submitted by",
              render: (r) => r.submittedByName ?? "—",
            },
            {
              key: "actions",
              label: "",
              align: "end",
              render: (r) =>
                h(
                  "div",
                  { class: "actions end" },
                  h("a", { href: dayAddress(r.id) }, "Open"),
                  mayApprove && r.status === "pending_approval"
                    ? [
                        button("Approve", () => approve(r), { kind: "link" }),
                        button("Return", () => giveBack(r), { kind: "link" }),
                      ]
                    : null
                ),
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) =>
            `${r.lineName} ${r.sectionName} ${r.factoryName} ${r.styleCode} ${r.supervisorName ?? ""}`,
          empty: {
            title: state.status === "pending_approval" ? "Nothing is waiting" : "No days found",
            body:
              state.status === "pending_approval"
                ? "No submitted day needs approval right now."
                : "Try a different status or an earlier date.",
          },
        })
      )
    );
  });
  return root;
}
