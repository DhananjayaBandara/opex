// Pieces shared by the notification, comment and report screens (S5.2, D61 to D70): the service
// calls, the address a notification leads to, and small form helpers.
import { h } from "../dom.js";
import { session } from "../session.js";
import { control, dayAddress } from "./production-common.js";

export const centre = (call) => session.run((ctx) => call(session.app.notifications, ctx));
export const commentService = (call) => session.run((ctx) => call(session.app.comments, ctx));
export const reportService = (call) => session.run((ctx) => call(session.app.reports, ctx));

export const EXPORTS_PAGE = "#/reports/exports";
export const SCHEDULES_PAGE = "#/reports/schedules";

// The service describes where a notification leads; the address is drawn here (D61).
export function linkAddress(link) {
  if (link === null || link === undefined) return null;
  if (link.type === "production_day") return dayAddress(link.id);
  if (link.type === "export") return `${EXPORTS_PAGE}?job=${encodeURIComponent(link.id)}`;
  if (link.type === "report_schedule") return `${SCHEDULES_PAGE}?id=${encodeURIComponent(link.id)}`;
  if (link.type === "support_grant") return "#/admin/users";
  return null;
}

// A value from the address query ("#/reports/exports?job=…").
export const queryValue = (name, hash = window.location.hash) =>
  new URLSearchParams(String(hash).split("?")[1] ?? "").get(name);

export const option = (value, label, selected) => h("option", { value, selected }, label);

export const selectControl = (id, label, rows, current, onChange, all = "All") =>
  control(
    id,
    label,
    h(
      "select",
      { id, onchange: (event) => onChange(event.target.value) },
      all === null ? null : option("", all, current === ""),
      rows.map((row) => option(row.id, row.name, row.id === current))
    )
  );

export const dateControl = (id, label, value, max, onChange) =>
  control(
    id,
    label,
    h("input", { id, type: "date", value, max, onchange: (event) => onChange(event.target.value) })
  );

export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// "2026-11-03T08:00:00.000Z" -> "2026-11-03 08:00 UTC" lives in kit.formatInstant; a short who-and-when
// line is common to comments and jobs.
export const byLine = (name, when, formatter) =>
  `${name ?? "someone"} · ${when === null ? "" : formatter(when)}`;
