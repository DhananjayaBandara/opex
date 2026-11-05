// Audit log (SRS 15.4; D97): who did what to which record, newest first. Read-only: nothing on this
// page can change or remove an event. Sensitive fields arrive already replaced by the service.
import { h } from "../dom.js";
import { infoDialog } from "../dialog.js";
import { attempt, badge, button, card, formatInstant, mount, notice, pageHeader } from "../kit.js";
import { session } from "../session.js";
import { dataTable } from "../table.js";
import { dateControl, option, plural, selectControl } from "./communication-common.js";
import { auditService, facts, valueText } from "./platform-common.js";

const PAGE = 50;
const EMPTY = { actorId: "", action: "", entityType: "", from: "", to: "" };

const queryOf = (filter) =>
  Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== ""));

function showEvent(row) {
  const event = attempt(() => auditService((s, ctx) => s.get(ctx, row.id)));
  if (event === undefined) return;
  infoDialog({
    title: event.summary,
    body: h(
      "div",
      {},
      facts([
        ["When", formatInstant(event.timestamp)],
        ["Who", event.actorName],
        ["Action", event.actionLabel],
        ["Record", `${event.entityLabel} · ${event.entityId}`],
        ["Reference", event.correlationId === null ? "—" : h("code", {}, event.correlationId)],
      ]),
      event.changes.length === 0
        ? h("p", { class: "muted" }, "This event recorded no field values.")
        : h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              { class: "table" },
              h("caption", { class: "sr-only" }, "Fields changed by this event"),
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  ["Field", "Before", "After"].map((label) => h("th", { scope: "col" }, label))
                )
              ),
              h(
                "tbody",
                {},
                event.changes.map((change) =>
                  h(
                    "tr",
                    {},
                    h("th", { scope: "row" }, change.label),
                    h("td", {}, valueText(change.before)),
                    h("td", {}, valueText(change.after))
                  )
                )
              )
            )
          ),
      h(
        "p",
        { class: "muted" },
        "Values of secrets, tokens and passwords are never recorded; they show as [redacted]."
      )
    ),
  });
}

export function render() {
  const root = h("div");
  const state = { filter: { ...EMPTY }, items: null, next: null, total: 0 };

  const load = (more) => {
    const page = auditService((s, ctx) =>
      s.list(ctx, {
        ...queryOf(state.filter),
        limit: PAGE,
        ...(more && state.next !== null ? { before: state.next } : {}),
      })
    );
    state.items = more ? [...state.items, ...page.items] : [...page.items];
    state.next = page.next;
    state.total = page.total;
  };

  mount(root, (redraw) => {
    const facets = auditService((s, ctx) => s.facets(ctx));
    if (state.items === null) {
      try {
        load(false);
      } catch (error) {
        // A date range the service refuses is shown as a message, and the filter is cleared.
        state.items = [];
        state.total = 0;
        state.next = null;
        attempt(() => {
          throw error;
        });
      }
    }
    const change = (name) => (value) => {
      state.filter[name] = value;
      state.items = null;
      redraw();
    };
    const zone = session.who?.timeZone ?? "UTC";
    const filtering = Object.values(state.filter).some((value) => value !== "");

    return h(
      "div",
      {},
      pageHeader(
        "Audit log",
        "Who did what to which record, newest first. This log is read-only: events cannot be edited or deleted."
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      card(
        "Filter",
        h(
          "div",
          { class: "table-tools" },
          selectControl(
            "audit-actor",
            "Who",
            facets.actors,
            state.filter.actorId,
            change("actorId"),
            "Anyone"
          ),
          h(
            "span",
            {},
            h("label", { for: "audit-action" }, "Action"),
            " ",
            h(
              "select",
              { id: "audit-action", onchange: (event) => change("action")(event.target.value) },
              option("", "Any action", state.filter.action === ""),
              facets.actions.map((entry) =>
                option(entry.value, entry.label, entry.value === state.filter.action)
              )
            )
          ),
          h(
            "span",
            {},
            h("label", { for: "audit-kind" }, "Record kind"),
            " ",
            h(
              "select",
              {
                id: "audit-kind",
                onchange: (event) => change("entityType")(event.target.value),
              },
              option("", "Any record", state.filter.entityType === ""),
              facets.entityTypes.map((entry) =>
                option(entry.value, entry.label, entry.value === state.filter.entityType)
              )
            )
          ),
          dateControl(
            "audit-from",
            "From",
            state.filter.from,
            state.filter.to || undefined,
            change("from")
          ),
          dateControl("audit-to", "To", state.filter.to, undefined, change("to")),
          filtering
            ? button("Clear filters", () => {
                state.filter = { ...EMPTY };
                state.items = null;
                redraw();
              })
            : null
        ),
        h("p", { class: "muted" }, `Dates are days in the organization's time zone (${zone}).`)
      ),
      card(
        null,
        h(
          "div",
          {},
          h(
            "p",
            { role: "status", "aria-live": "polite" },
            `${plural(state.total, "event")} match${state.total === 1 ? "es" : ""}${
              state.items.length < state.total ? `; showing the newest ${state.items.length}` : ""
            }.`
          ),
          dataTable({
            caption: "Audit events",
            pageSize: 25,
            columns: [
              {
                key: "when",
                label: "When",
                sort: (r) => r.timestamp,
                render: (r) => formatInstant(r.timestamp),
              },
              { key: "actorName", label: "Who", sort: (r) => r.actorName },
              { key: "what", label: "What happened", render: (r) => r.summary },
              {
                key: "action",
                label: "Action",
                sort: (r) => r.actionLabel,
                render: (r) => badge(r.actionLabel, "neutral"),
              },
              {
                key: "kind",
                label: "Record",
                sort: (r) => r.entityLabel,
                render: (r) => r.entityLabel,
              },
              {
                key: "open",
                label: "",
                align: "end",
                render: (r) => button("Details", () => showEvent(r), { kind: "link" }),
              },
            ],
            rows: state.items,
            rowKey: (r) => r.id,
            searchText: (r) => `${r.summary} ${r.actorName} ${r.entityId}`,
            empty: {
              title: filtering ? "No event matches these filters" : "No events yet",
              body: filtering
                ? "Widen the dates or clear a filter."
                : "Events appear here as people change records.",
            },
          }),
          state.next === null
            ? null
            : h(
                "div",
                { class: "actions end" },
                button(
                  "Load older events",
                  () => {
                    attempt(() => load(true));
                    redraw();
                  },
                  { kind: "secondary" }
                )
              )
        )
      )
    );
  });
  return root;
}
