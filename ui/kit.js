// Small shared pieces: page header, card, badge, empty state, notices, toasts and the "mount a view"
// helper that turns a service refusal into a readable state instead of a broken page.
import { h } from "./dom.js";
import { describe, withReference } from "./failure.js";
import { session } from "./session.js";

export const pageHeader = (title, subtitle, ...actions) =>
  h(
    "header",
    { class: "page-header" },
    h("div", {}, h("h1", {}, title), subtitle ? h("p", { class: "muted" }, subtitle) : null),
    actions.length ? h("div", { class: "actions" }, actions) : null
  );

export const card = (title, body, ...actions) =>
  h(
    "section",
    { class: "card" },
    title || actions.length
      ? h(
          "div",
          { class: "card-head" },
          h("h2", {}, title ?? ""),
          actions.length ? h("div", { class: "actions" }, actions) : null
        )
      : null,
    body
  );

export const badge = (label, tone = "neutral") =>
  h("span", { class: `badge badge-${tone}` }, label);

export const statusBadge = (status) =>
  badge(
    String(status).replaceAll("_", " "),
    {
      active: "good",
      approved: "good",
      enabled: "good",
      current: "good",
      scheduled: "info",
      pending: "warn",
      pending_approval: "warn",
      draft: "info",
      published: "good",
      returned: "bad",
      provisioned: "warn",
      suspended: "warn",
      on_leave: "warn",
      expired: "muted",
      ended: "muted",
      inactive: "muted",
      deactivated: "muted",
      revoked: "bad",
      denied: "bad",
      disabled: "muted",
      confirmed: "info",
      in_production: "good",
      shipped: "info",
      closed: "muted",
      cancelled: "bad",
      open: "info",
      completed: "good",
      not_started: "muted",
      in_progress: "info",
      blocked: "bad",
      late: "bad",
      rejected: "bad",
      revision_requested: "warn",
      planned: "info",
      requested: "info",
      resubmitted: "info",
      sent: "info",
      awarded: "good",
      not_awarded: "muted",
      quoted: "info",
      issued: "info",
      received: "warn",
      posted: "good",
      reversed: "bad",
      submitted: "warn",
      not_received: "info",
      partly_received: "warn",
      complete: "good",
      unpaid: "info",
      part_paid: "warn",
      paid: "good",
      overdue: "bad",
      out_of_stock: "bad",
      below_reorder: "warn",
      no_estimate: "muted",
      ok: "good",
      succeeded: "good",
      accepted: "good",
      synced: "good",
      valid: "good",
      created: "good",
      committed: "good",
      failed: "bad",
      not_created: "bad",
      error: "bad",
      abandoned: "bad",
      duplicate: "warn",
      staged: "info",
      paused: "warn",
    }[status] ?? "neutral"
  );

export const notice = (message, tone = "info") =>
  h("div", { class: `notice notice-${tone}`, role: tone === "bad" ? "alert" : "status" }, message);

export const emptyState = ({ title, body, action }) =>
  h(
    "div",
    { class: "empty" },
    h("h3", {}, title),
    body ? h("p", { class: "muted" }, body) : null,
    action ?? null
  );

export const button = (
  label,
  onClick,
  { kind = "secondary", title, disabled, type = "button" } = {}
) => h("button", { type, class: `btn btn-${kind}`, onclick: onClick, title, disabled }, label);

// Slow work from a button click (the demo world takes a few seconds): shows a busy label, lets the
// browser paint it, then runs the work and restores the button.
export function busy(event, label, work) {
  const target = event.currentTarget;
  const original = target.textContent;
  target.disabled = true;
  target.textContent = label;
  setTimeout(() => {
    try {
      work();
    } finally {
      target.disabled = false;
      target.textContent = original;
    }
  }, 30);
}

let live = null;
export function toast(message, tone = "info") {
  if (live === null || !live.isConnected) {
    live = h("div", { class: "toasts", "aria-live": "polite" });
    document.body.append(live);
  }
  const item = h(
    "div",
    { class: `toast toast-${tone}`, role: tone === "bad" ? "alert" : "status" },
    message
  );
  live.append(item);
  setTimeout(() => item.remove(), tone === "bad" ? 7000 : 3500);
}

// Runs a button action: shows the service's own message when it is refused.
export function attempt(action, success) {
  try {
    const result = action();
    if (success) toast(success, "good");
    return result;
  } catch (error) {
    session.handle(error);
    toast(withReference(error), "bad");
    return undefined;
  }
}

export function problem(error) {
  const denied = error?.code === "forbidden";
  const { code, message, reference } = describe(error);
  return emptyState({
    title: denied ? "You do not have access to this" : "This could not be shown",
    body: denied
      ? "Your role or factory scope does not include this page. Ask an administrator if you need it."
      : message,
    action:
      reference === null
        ? null
        : h(
            "p",
            { class: "muted error-reference" },
            "Reference ",
            h("code", {}, reference),
            ` · ${code}`
          ),
  });
}

// Draws a view and redraws it on request. A refused read becomes a readable state.
export function mount(root, build) {
  const draw = () => {
    try {
      root.replaceChildren(build(draw));
    } catch (error) {
      session.handle(error);
      root.replaceChildren(problem(error));
    }
  };
  draw();
}

// An instant as "2026-11-03 13:30 Asia/Colombo" in the organization's time zone, named in full (UTC when
// the person is outside an organization or the zone is not known, and then it says UTC). Stored
// instants stay UTC; only the display moves. Pass instants only, never a business date (D106).
const formatters = new Map();
function zoned(zone) {
  if (!formatters.has(zone)) {
    let made;
    try {
      made = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      made = zone === "UTC" ? null : zoned("UTC");
    }
    formatters.set(zone, made);
  }
  return formatters.get(zone);
}

export const formatInstant = (iso, zone = session.who?.timeZone ?? "UTC") => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const formatter = zoned(zone);
  if (formatter === null) return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const part = Object.fromEntries(
    formatter.formatToParts(date).map((item) => [item.type, item.value])
  );
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute} ${formatter.resolvedOptions().timeZone}`;
};

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
