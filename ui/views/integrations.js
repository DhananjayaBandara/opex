// Integrations (SRS 14.4; architecture 17; D98 to D100). SIMULATED: a connection holds an address, a
// credential reference and a status, and its syncs and deliveries are recorded here; nothing is sent
// to an outside system. A connection never holds a secret, only the reference to one.
import { DIRECTIONS, INTEGRATION_TYPES } from "../../domain/integrations.js";
import { h } from "../dom.js";
import { confirmDialog, formDialog } from "../dialog.js";
import {
  attempt,
  badge,
  button,
  card,
  formatInstant,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { session } from "../session.js";
import { dataTable } from "../table.js";
import { SIMULATED_NOTE, integrationAddress, integrationService } from "./platform-common.js";

const typeOptions = Object.entries(INTEGRATION_TYPES).map(([value, spec]) => ({
  value,
  label: `${spec.label} (${spec.records})`,
}));
const directionOptions = Object.entries(DIRECTIONS).map(([value, label]) => ({ value, label }));

export const CONNECTION_ERRORS = {
  invalid_name: "name",
  invalid_type: "type",
  invalid_direction: "direction",
  invalid_endpoint: "endpoint",
  invalid_schedule: "schedule",
};

const ENDPOINT_FIELD = {
  name: "endpoint",
  label: "Address",
  required: true,
  placeholder: "https://erp.example.com/api/v2",
  hint: "A full https address. No user name, password or query string: credentials are kept by reference.",
};
const SCHEDULE_FIELD = {
  name: "schedule",
  label: "Schedule note",
  hint: "For example Every night at 02:00. The prototype records it but does not run on a timer.",
};

export const mayManage = () => session.can("integration.manage") && !session.supporting;

export function addConnection(onDone) {
  return formDialog({
    title: "Add a connection",
    description: "A new connection starts paused. Enable it when it is ready.",
    fields: [
      { name: "name", label: "Name", required: true, maxlength: 80 },
      { name: "type", label: "Kind of system", type: "select", options: typeOptions },
      { name: "direction", label: "Direction", type: "select", options: directionOptions },
      ENDPOINT_FIELD,
      SCHEDULE_FIELD,
    ],
    initial: { type: "accounting_erp", direction: "outbound" },
    errorFields: CONNECTION_ERRORS,
    submitLabel: "Add connection",
    onSubmit: (values) => {
      const made = integrationService((s, ctx) => s.create(ctx, values));
      toast(`${made.name} added (paused)`, "good");
      onDone(made);
    },
  });
}

export function editConnection(row, onDone) {
  return formDialog({
    title: `Edit ${row.name}`,
    description: `The kind of system (${row.typeLabel}) cannot change; add a new connection for a different kind.`,
    fields: [
      { name: "name", label: "Name", required: true, maxlength: 80 },
      { name: "direction", label: "Direction", type: "select", options: directionOptions },
      ENDPOINT_FIELD,
      SCHEDULE_FIELD,
    ],
    initial: {
      name: row.name,
      direction: row.direction,
      endpoint: row.endpoint,
      schedule: row.schedule,
    },
    errorFields: CONNECTION_ERRORS,
    submitLabel: "Save",
    onSubmit: (values) => {
      integrationService((s, ctx) => s.update(ctx, row.id, values));
      toast("Connection saved", "good");
      onDone();
    },
  });
}

// Enable and pause go straight through; disabling asks why, and the reason stays on the connection.
export function changeStatus(row, action, onDone) {
  if (action === "disable") {
    return confirmDialog({
      title: `Disable ${row.name}?`,
      message:
        "A disabled connection runs no syncs and refuses deliveries until it is enabled again.",
      confirmLabel: "Disable",
      danger: true,
      reason: true,
      onConfirm: (reason) => {
        integrationService((s, ctx) => s.transition(ctx, row.id, "disable", { reason }));
        toast(`${row.name} disabled`, "good");
        onDone();
      },
    });
  }
  attempt(
    () => integrationService((s, ctx) => s.transition(ctx, row.id, action)),
    action === "enable" ? `${row.name} enabled` : `${row.name} paused`
  );
  onDone();
  return Promise.resolve(true);
}

// The status actions a connection offers right now.
export const statusActions = (row) =>
  row.status === "active"
    ? [
        ["pause", "Pause"],
        ["disable", "Disable"],
      ]
    : row.status === "paused"
      ? [
          ["enable", "Enable"],
          ["disable", "Disable"],
        ]
      : [["enable", "Enable"]];

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const rows = integrationService((s, ctx) => s.list(ctx));
    const manage = mayManage();
    return h(
      "div",
      {},
      pageHeader(
        "Integrations",
        "Connections to the accounting, supplier, payroll, shop-floor and email systems an organization works with.",
        manage ? button("Add a connection", () => addConnection(redraw), { kind: "primary" }) : null
      ),
      notice(SIMULATED_NOTE, "info"),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      !manage && !session.supporting
        ? notice("Connections are changed by people who manage integrations.", "info")
        : null,
      card(
        null,
        dataTable({
          caption: "Integration connections",
          pageSize: 10,
          columns: [
            {
              key: "name",
              label: "Connection",
              sort: (r) => r.name,
              render: (r) => h("a", { href: integrationAddress(r.id) }, r.name),
            },
            { key: "type", label: "Kind", sort: (r) => r.typeLabel, render: (r) => r.typeLabel },
            {
              key: "direction",
              label: "Direction",
              sort: (r) => r.directionLabel,
              render: (r) => r.directionLabel,
            },
            {
              key: "status",
              label: "Status",
              sort: (r) => r.status,
              render: (r) =>
                h(
                  "div",
                  {},
                  statusBadge(r.status),
                  r.statusReason ? h("div", { class: "muted" }, r.statusReason) : null
                ),
            },
            {
              key: "last",
              label: "Last run",
              sort: (r) => r.lastRun?.startedAt ?? "",
              render: (r) =>
                r.lastRun === null
                  ? h("span", { class: "muted" }, "Never run")
                  : h(
                      "div",
                      {},
                      statusBadge(r.lastRun.status),
                      h("div", { class: "muted" }, formatInstant(r.lastRun.startedAt))
                    ),
            },
            {
              key: "queue",
              label: "Retry queue",
              align: "end",
              sort: (r) => r.queued,
              render: (r) => (r.queued > 0 ? badge(String(r.queued), "warn") : "0"),
            },
            {
              key: "actions",
              label: "",
              align: "end",
              render: (r) =>
                h(
                  "div",
                  { class: "actions end" },
                  button("Open", () => (window.location.hash = integrationAddress(r.id).slice(1)), {
                    kind: "link",
                  }),
                  manage
                    ? statusActions(r).map(([action, label]) =>
                        button(label, () => changeStatus(r, action, redraw), { kind: "link" })
                      )
                    : null
                ),
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.name} ${r.typeLabel} ${r.endpoint}`,
          empty: {
            title: "No connections yet",
            body: manage
              ? "Add a connection to see how syncs, retries and deliveries are recorded."
              : "No connections have been added.",
          },
        })
      )
    );
  });
  return root;
}
