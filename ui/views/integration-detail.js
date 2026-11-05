// One integration connection (D98 to D100): its settings and credential reference, the retry queue,
// the history of syncs and webhook deliveries, and the records mapped to the outside system.
// SIMULATED: a run is recorded exactly as a real one would be, and nothing leaves the browser.
import { h } from "../dom.js";
import { confirmDialog, infoDialog } from "../dialog.js";
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
import { session } from "../session.js";
import { dataTable } from "../table.js";
import { plural } from "./communication-common.js";
import { addressId } from "./production-common.js";
import {
  INTEGRATIONS_PAGE,
  SIMULATED_NOTE,
  facts,
  integrationService,
  valueText,
} from "./platform-common.js";
import { changeStatus, editConnection, mayManage, statusActions } from "./integrations.js";

const kindText = (run) => (run.kind === "webhook" ? "Delivery" : "Sync");

function showRun(run) {
  infoDialog({
    title: `${kindText(run)} · ${run.statusLabel}`,
    body: facts([
      ["Started", formatInstant(run.startedAt)],
      ["Ended", formatInstant(run.endedAt)],
      ["Outcome", run.statusLabel],
      run.kind === "sync" ? ["Attempt", `${run.attempt} of 3`] : undefined,
      ["Records processed", String(run.processed)],
      ["Records with a problem", String(run.errors)],
      ["Idempotency key", run.idempotencyKey ?? "—"],
      ["Delivery id", run.deliveryId ?? "—"],
      ["Retry of", run.retryOfId ?? "—"],
      ["Retried by", run.retriedBy ?? "—"],
      ["Duplicate of", run.duplicateOfId ?? "—"],
      ["Body fingerprint", run.fingerprint ?? "—"],
      ["Body excerpt", run.excerpt === null ? "—" : h("code", {}, run.excerpt)],
      ["Note", run.note ?? "—"],
      ["Error", run.error ?? "—"],
    ]),
  });
}

export function render() {
  const root = h("div");
  const id = addressId();
  const state = { fail: false };
  mount(root, (redraw) => {
    if (id === null) {
      return emptyState({
        title: "Choose a connection",
        action: h("a", { href: INTEGRATIONS_PAGE }, "Back to integrations"),
      });
    }
    const detail = integrationService((s, ctx) => s.get(ctx, id));
    const { connection: row } = detail;
    const manage = mayManage();
    const active = row.status === "active";

    const run = () => {
      const result = attempt(() =>
        integrationService((s, ctx) => s.runSync(ctx, row.id, { simulateFailure: state.fail }))
      );
      if (result !== undefined) {
        toast(
          result.status === "succeeded"
            ? `Sync succeeded: ${plural(result.processed, "record")} mapped`
            : `Sync ${result.statusLabel.toLowerCase()}: ${result.error}`,
          result.status === "succeeded" ? "good" : "warn"
        );
      }
      redraw();
    };
    const retry = (failed) => {
      const result = attempt(() =>
        integrationService((s, ctx) => s.retry(ctx, failed.id, { simulateFailure: state.fail }))
      );
      if (result !== undefined) {
        toast(
          result.status === "succeeded"
            ? "Retry succeeded"
            : `Retry ${result.statusLabel.toLowerCase()} (attempt ${result.attempt} of 3)`,
          result.status === "succeeded" ? "good" : "warn"
        );
      }
      redraw();
    };
    const sendTest = (tamper) => {
      const result = attempt(() =>
        integrationService((s, ctx) => s.sendTestWebhook(ctx, row.id, { tamper }))
      );
      if (result !== undefined) {
        toast(
          `Delivery ${result.statusLabel.toLowerCase()}${result.error ? `: ${result.error}` : ""}`,
          result.status === "accepted" ? "good" : "warn"
        );
      }
      redraw();
    };
    const rotate = () =>
      confirmDialog({
        title: "Rotate the credential?",
        message:
          "The connection moves to the next credential reference. The new secret is stored outside OPEX+; this page only ever shows the reference.",
        confirmLabel: "Rotate",
        onConfirm: () => {
          const next = integrationService((s, ctx) => s.rotateCredential(ctx, row.id));
          toast(`Credential rotated to version ${next.credentialVersion}`, "good");
          redraw();
        },
      });

    return h(
      "div",
      {},
      h("p", {}, h("a", { href: INTEGRATIONS_PAGE }, "← All integrations")),
      pageHeader(
        row.name,
        `${row.typeLabel} · ${row.directionLabel}`,
        statusBadge(row.status),
        badge("SIMULATED", "warn"),
        manage
          ? statusActions(row).map(([action, label]) =>
              button(label, () => changeStatus(row, action, redraw))
            )
          : null
      ),
      notice(SIMULATED_NOTE, "info"),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      row.status === "disabled" && row.statusReason
        ? notice(`Disabled: ${row.statusReason}`, "warn")
        : null,

      card(
        "Settings",
        facts([
          ["Exchanges", row.exchanges],
          ["Address", h("code", {}, row.endpoint)],
          ["Schedule note", row.schedule || "—"],
          [
            "Credential reference",
            h("span", {}, h("code", {}, row.credentialRef), ` (version ${row.credentialVersion})`),
          ],
          row.acceptsDeliveries
            ? ["Delivery address key", h("code", {}, row.endpointKey)]
            : undefined,
        ]),
        h(
          "p",
          { class: "muted" },
          "Only a reference to the secret is stored. No page, export or audit event ever shows the secret itself."
        ),
        manage
          ? h(
              "div",
              { class: "actions" },
              button("Edit", () => editConnection(row, redraw), {
                disabled: active,
                title: active ? "Pause the connection before editing it" : undefined,
              }),
              button("Rotate credential", rotate, {
                disabled: row.status === "disabled",
                title: row.status === "disabled" ? "Enable the connection first" : undefined,
              })
            )
          : null
      ),

      manage
        ? card(
            "Try it",
            h(
              "div",
              { class: "stack" },
              h(
                "div",
                { class: "field field-check" },
                h(
                  "label",
                  { for: "int-fail" },
                  h("input", {
                    id: "int-fail",
                    type: "checkbox",
                    checked: state.fail,
                    onchange: (event) => (state.fail = event.target.checked),
                  }),
                  " Make the next sync or retry fail"
                )
              ),
              h(
                "div",
                { class: "actions" },
                button("Run a sync now", run, {
                  kind: "primary",
                  disabled: !active,
                  title: active ? undefined : "Enable the connection first",
                }),
                row.acceptsDeliveries
                  ? [
                      button("Send a test delivery", () => sendTest(false), { disabled: !active }),
                      button("Send one with a wrong signature", () => sendTest(true), {
                        disabled: !active,
                      }),
                    ]
                  : null
              ),
              h(
                "p",
                { class: "muted" },
                `A sync reads up to 25 of your ${row.exchanges} and records the outside id each would get; it never changes them. A failed run can be retried twice more, then it is abandoned.`
              )
            )
          )
        : null,

      card(
        `Retry queue (${detail.queue.length})`,
        detail.queue.length === 0
          ? h("p", { class: "muted" }, "Nothing is waiting for a retry.")
          : dataTable({
              caption: "Runs waiting for a retry",
              pageSize: 10,
              columns: [
                { key: "when", label: "Failed", render: (r) => formatInstant(r.startedAt) },
                { key: "attempt", label: "Attempt", render: (r) => `${r.attempt} of 3` },
                { key: "error", label: "Reason", render: (r) => r.error ?? "—" },
                {
                  key: "action",
                  label: "",
                  align: "end",
                  render: (r) =>
                    r.status === "abandoned"
                      ? badge("Gave up", "bad")
                      : manage
                        ? button("Retry", () => retry(r), {
                            kind: "link",
                            disabled: !active,
                            title: active ? undefined : "Enable the connection first",
                          })
                        : null,
                },
              ],
              rows: detail.queue,
              rowKey: (r) => r.id,
            })
      ),

      card(
        `History (${plural(detail.runCount, "run")})`,
        dataTable({
          caption: "Syncs and deliveries",
          pageSize: 10,
          columns: [
            {
              key: "when",
              label: "Started",
              sort: (r) => r.startedAt,
              render: (r) => formatInstant(r.startedAt),
            },
            { key: "kind", label: "Kind", sort: (r) => kindText(r), render: kindText },
            {
              key: "status",
              label: "Outcome",
              sort: (r) => r.status,
              render: (r) => statusBadge(r.status),
            },
            {
              key: "records",
              label: "Records",
              align: "end",
              sort: (r) => r.processed,
              render: (r) =>
                r.errors > 0 ? `${r.processed} · ${r.errors} with a problem` : String(r.processed),
            },
            {
              key: "detail",
              label: "Detail",
              render: (r) => r.error ?? r.note ?? (r.deliveryId ? `Delivery ${r.deliveryId}` : "—"),
            },
            {
              key: "open",
              label: "",
              align: "end",
              render: (r) => button("Details", () => showRun(r), { kind: "link" }),
            },
          ],
          rows: detail.runs,
          rowKey: (r) => r.id,
          searchText: (r) =>
            `${r.statusLabel} ${r.error ?? ""} ${r.note ?? ""} ${r.deliveryId ?? ""}`,
          empty: {
            title: "Nothing has run yet",
            body: "Run a sync or send a test delivery to see it recorded here.",
          },
        }),
        detail.runCount > detail.runs.length
          ? h("p", { class: "muted" }, `Showing the newest ${detail.runs.length} runs.`)
          : null
      ),

      card(
        `Mapped records (${detail.mappingCount})`,
        dataTable({
          caption: "Records and the ids the outside system would assign",
          pageSize: 10,
          columns: [
            { key: "kind", label: "Record kind", render: (m) => valueText(m.entityType) },
            { key: "id", label: "OPEX+ id", render: (m) => h("code", {}, m.entityId) },
            {
              key: "ext",
              label: "Outside id",
              sort: (m) => m.externalId,
              render: (m) => h("code", {}, m.externalId),
            },
            {
              key: "status",
              label: "Status",
              render: (m) => statusBadge(m.status === "synced" ? "ok" : "rejected"),
            },
            {
              key: "last",
              label: "Last synced",
              sort: (m) => m.lastSyncAt,
              render: (m) => formatInstant(m.lastSyncAt),
            },
            { key: "error", label: "Problem", render: (m) => m.error ?? "—" },
          ],
          rows: detail.mappings,
          rowKey: (m) => m.id,
          searchText: (m) => `${m.externalId} ${m.entityId} ${m.error ?? ""}`,
          empty: {
            title: "No records mapped",
            body: "A successful sync maps the records it reads.",
          },
        })
      )
    );
  });
  return root;
}
