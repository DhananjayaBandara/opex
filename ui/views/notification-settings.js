// Notification settings for administrators (C133, C134; D62 to D65): the wording of each notification
// and the history of what was sent. A template changes the text of notifications created afterwards;
// earlier ones keep the text they were written with. The prototype never contacts an email provider:
// an email is recorded as a sandboxed delivery attempt.
import { h } from "../dom.js";
import {
  BODY_MAX,
  CHANNELS,
  CHANNEL_LABELS,
  DELIVERY_STATUSES,
  NOTIFICATION_TYPES,
  SUBJECT_MAX,
  TYPE_KEYS,
} from "../../domain/notifications.js";
import {
  attempt,
  badge,
  button,
  card,
  emptyState,
  formatInstant,
  mount,
  pageHeader,
} from "../kit.js";
import { formDialog } from "../dialog.js";
import { session } from "../session.js";
import { dataTable } from "../table.js";
import { centre, option, plural } from "./communication-common.js";
import { control } from "./production-common.js";

const STATUS_TONES = { delivered: "good", sandboxed: "info", failed: "bad", suppressed: "muted" };

const placeholderText = (names) => names.map((name) => `{{${name}}}`).join("  ");

function editTemplate(template, channel, redraw) {
  return formDialog({
    title: `${template.label}: ${channel.channelLabel} text`,
    description: `Placeholders you can use: ${placeholderText(template.placeholders)}. Notifications already created keep their text.`,
    fields: [
      { name: "subject", label: "Subject", type: "text", required: true, maxlength: SUBJECT_MAX },
      {
        name: "body",
        label: "Message",
        type: "textarea",
        required: true,
        hint: `Up to ${BODY_MAX} characters.`,
      },
    ],
    initial: { subject: channel.effective.subject, body: channel.effective.body },
    submitLabel: "Save text",
    onSubmit: (values) =>
      centre((s, ctx) =>
        s.saveTemplate(ctx, {
          type: template.type,
          channel: channel.channel,
          subject: values.subject,
          body: values.body,
        })
      ),
  }).then((saved) => saved && redraw());
}

function switchTemplate(template, channel, enabled, redraw) {
  attempt(
    () =>
      centre((s, ctx) =>
        s.setTemplateEnabled(ctx, { type: template.type, channel: channel.channel, enabled })
      ),
    enabled ? "Your text is in use again" : "Back to the built-in text"
  );
  redraw();
}

function channelRow(template, channel, redraw) {
  const custom = channel.override !== null && channel.override.enabled;
  return h(
    "tr",
    {},
    h("th", { scope: "row" }, channel.channelLabel),
    h(
      "td",
      {},
      h("strong", {}, channel.effective.subject),
      h("div", { class: "template-body" }, channel.effective.body)
    ),
    h(
      "td",
      {},
      custom
        ? badge(`Customised (version ${channel.override.version})`, "info")
        : channel.override === null
          ? badge("Built-in", "muted")
          : badge("Built-in (your text is switched off)", "warn")
    ),
    h(
      "td",
      {},
      h(
        "div",
        { class: "actions" },
        button("Edit text", () => editTemplate(template, channel, redraw)),
        custom
          ? button("Use built-in text", () => switchTemplate(template, channel, false, redraw), {
              kind: "link",
            })
          : channel.override !== null
            ? button("Use my text", () => switchTemplate(template, channel, true, redraw), {
                kind: "link",
              })
            : null
      )
    )
  );
}

function templates(redraw) {
  const rows = centre((s, ctx) => s.templates(ctx));
  return card(
    "Message templates",
    h(
      "div",
      {},
      h(
        "p",
        { class: "muted" },
        "The wording of each notification, by channel. The built-in text is used until you save your own."
      ),
      rows.map((template) =>
        h(
          "details",
          { class: "template" },
          h(
            "summary",
            {},
            h("strong", {}, template.label),
            " ",
            badge(template.categoryLabel, "neutral")
          ),
          h("p", { class: "muted" }, `Placeholders: ${placeholderText(template.placeholders)}`),
          h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              { class: "table" },
              h("caption", { class: "sr-only" }, `${template.label} templates`),
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  ["Channel", "Text", "Source", "Actions"].map((label) =>
                    h("th", { scope: "col" }, label)
                  )
                )
              ),
              h(
                "tbody",
                {},
                template.channels.map((channel) => channelRow(template, channel, redraw))
              )
            )
          )
        )
      )
    )
  );
}

function history(state, redraw) {
  const view = centre((s, ctx) =>
    s.deliveries(ctx, {
      type: state.type,
      channel: state.channel,
      status: state.status,
      limit: 200,
    })
  );
  const filter = (key) => (event) => {
    state[key] = event.target.value;
    redraw();
  };
  const select = (id, label, key, rows, all) =>
    control(
      id,
      label,
      h(
        "select",
        { id, onchange: filter(key) },
        option("", all, state[key] === ""),
        rows.map(([value, text]) => option(value, text, value === state[key]))
      )
    );
  return card(
    "Delivery history",
    h(
      "div",
      {},
      h(
        "p",
        { class: "muted" },
        "Every notification and the attempt to send it by each channel. In the prototype an email is recorded as sandboxed; nothing leaves the browser."
      ),
      h(
        "div",
        { class: "table-tools" },
        select(
          "dh-type",
          "Notification",
          "type",
          TYPE_KEYS.map((key) => [key, NOTIFICATION_TYPES[key].label]),
          "All"
        ),
        select(
          "dh-channel",
          "Channel",
          "channel",
          CHANNELS.map((key) => [key, CHANNEL_LABELS[key]]),
          "All"
        ),
        select(
          "dh-status",
          "Result",
          "status",
          DELIVERY_STATUSES.map((key) => [key, key]),
          "All"
        ),
        h(
          "span",
          { class: "muted" },
          view.total > view.items.length
            ? `Showing the latest ${view.items.length} of ${view.total}`
            : plural(view.total, "delivery", "deliveries")
        )
      ),
      view.items.length === 0
        ? emptyState({
            title: "No deliveries match",
            body: "A delivery is recorded each time a notification is created.",
          })
        : dataTable({
            caption: "Delivery history",
            pageSize: 10,
            rows: view.items,
            searchText: (row) =>
              `${row.recipient.name} ${row.typeLabel} ${row.destination ?? ""} ${row.title ?? ""}`,
            columns: [
              {
                key: "createdAt",
                label: "When",
                sort: (row) => row.createdAt,
                render: (row) => formatInstant(row.createdAt),
              },
              {
                key: "recipient",
                label: "Recipient",
                sort: (row) => row.recipient.name ?? "",
                render: (row) => row.recipient.name ?? "Someone",
              },
              {
                key: "type",
                label: "Notification",
                sort: (row) => row.typeLabel,
                render: (row) =>
                  h(
                    "div",
                    {},
                    row.typeLabel,
                    row.title ? h("div", { class: "muted" }, row.title) : null
                  ),
              },
              {
                key: "channel",
                label: "Channel",
                sort: (row) => row.channelLabel,
                render: (row) =>
                  h(
                    "div",
                    {},
                    row.channelLabel,
                    row.destination ? h("div", { class: "muted" }, row.destination) : null
                  ),
              },
              {
                key: "status",
                label: "Result",
                sort: (row) => row.status,
                render: (row) =>
                  h(
                    "div",
                    {},
                    badge(row.status, STATUS_TONES[row.status] ?? "neutral"),
                    row.failureText ? h("div", { class: "muted" }, row.failureText) : null
                  ),
              },
            ],
          })
    )
  );
}

export function render() {
  const root = h("div");
  const state = { type: "", channel: "", status: "" };
  mount(root, (redraw) =>
    h(
      "div",
      {},
      pageHeader(
        "Notification settings",
        "How notifications are worded, and a record of what was sent and to whom."
      ),
      session.can("notification_template.manage") ? templates(redraw) : null,
      session.can("delivery.view") ? history(state, redraw) : null
    )
  );
  return root;
}
