// My notifications (C131, C132; D61 to D65): the member's own in-app notifications, newest first, and
// the channels they want each kind of notification on. Mandatory notices cannot be switched off in
// the app. Nothing here reaches another member's notifications.
import { h } from "../dom.js";
import { CATEGORIES } from "../../domain/notifications.js";
import { notificationsChanged } from "../download.js";
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
import { control } from "./production-common.js";
import { centre, linkAddress, option } from "./communication-common.js";

const TONES = { production: "info", reports: "good", administration: "warn" };

function item(entry, redraw) {
  const address = linkAddress(entry.link);
  const read = () =>
    attempt(() => {
      centre((s, ctx) => s.markRead(ctx, entry.id));
      notificationsChanged();
    });
  return h(
    "li",
    { class: `notification${entry.read ? "" : " notification-unread"}`, dataset: { id: entry.id } },
    h(
      "div",
      { class: "notification-head" },
      h("strong", {}, entry.title),
      badge(entry.categoryLabel, TONES[entry.category] ?? "neutral"),
      entry.read ? null : badge("unread", "info")
    ),
    h("p", {}, entry.body),
    h(
      "div",
      { class: "notification-foot" },
      h("span", { class: "muted" }, formatInstant(entry.createdAt)),
      address === null
        ? null
        : h(
            "a",
            { href: address, onclick: () => (entry.read ? undefined : read()) },
            entry.link.label
          ),
      entry.read
        ? null
        : button(
            "Mark as read",
            () => {
              read();
              redraw();
            },
            { kind: "link" }
          )
    )
  );
}

function preferences(redraw) {
  const rows = centre((s, ctx) => s.preferences(ctx));
  const channels = rows[0]?.channels ?? [];
  const toggle = (row, channel, enabled) => {
    attempt(
      () => centre((s, ctx) => s.setPreference(ctx, { type: row.type, channel, enabled })),
      "Preference saved"
    );
    redraw();
  };
  return card(
    "Notification preferences",
    h(
      "div",
      {},
      h(
        "p",
        { class: "muted" },
        "Choose where each kind of notification reaches you. The prototype records an email or a message as a delivery attempt; it does not send one. Notices marked required always appear in the app."
      ),
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "table" },
          h("caption", { class: "sr-only" }, "Notification preferences"),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col" }, "Notification"),
              channels.map((channel) => h("th", { scope: "col" }, channel.label))
            )
          ),
          h(
            "tbody",
            {},
            rows.map((row) =>
              h(
                "tr",
                {},
                h(
                  "th",
                  { scope: "row" },
                  row.label,
                  row.mandatory ? h("small", { class: "muted" }, " (required in the app)") : null
                ),
                row.channels.map((channel) =>
                  h(
                    "td",
                    {},
                    h("input", {
                      type: "checkbox",
                      checked: channel.enabled,
                      disabled: channel.locked,
                      "aria-label": `${row.label} by ${channel.label}`,
                      onchange: (event) => toggle(row, channel.channel, event.target.checked),
                    })
                  )
                )
              )
            )
          )
        )
      )
    )
  );
}

export function render() {
  const root = h("div");
  const state = { category: "", unread: false };
  mount(root, (redraw) => {
    const view = centre((s, ctx) =>
      s.list(ctx, {
        ...(state.category ? { category: state.category } : {}),
        ...(state.unread ? { unread: true } : {}),
      })
    );
    notificationsChanged();
    return h(
      "div",
      {},
      pageHeader(
        "Notifications",
        view.unread === 0 ? "You are up to date." : `${view.unread} unread`,
        button(
          "Mark all as read",
          () => {
            attempt(
              () => centre((s, ctx) => s.markAllRead(ctx, { before: view.asOf })),
              "All notifications marked as read"
            );
            notificationsChanged();
            redraw();
          },
          { kind: "secondary", disabled: view.unread === 0 }
        )
      ),
      h(
        "div",
        { class: "table-tools" },
        control(
          "nt-category",
          "Kind",
          h(
            "select",
            {
              id: "nt-category",
              onchange: (event) => {
                state.category = event.target.value;
                redraw();
              },
            },
            option("", "All", state.category === ""),
            Object.entries(CATEGORIES).map(([value, label]) =>
              option(value, label, value === state.category)
            )
          )
        ),
        h(
          "label",
          { class: "inline-check" },
          h("input", {
            type: "checkbox",
            checked: state.unread,
            onchange: (event) => {
              state.unread = event.target.checked;
              redraw();
            },
          }),
          " Unread only"
        ),
        h("span", { class: "muted" }, `${view.total} shown`)
      ),
      card(
        null,
        view.items.length === 0
          ? emptyState({
              title:
                state.unread || state.category ? "No notifications match" : "No notifications yet",
              body: "Notifications about production days sent for approval, returned or approved, and about your reports, appear here.",
            })
          : h(
              "ul",
              { class: "notification-list" },
              view.items.map((entry) => item(entry, redraw))
            )
      ),
      preferences(redraw)
    );
  });
  return root;
}
