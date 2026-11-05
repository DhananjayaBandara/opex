// Small helpers shared by the orders and planning screens (D81, D82): the service call, the address of
// an order, and how amounts, dates and read-only access are shown.
import { h } from "../dom.js";
import { session } from "../session.js";

export const orders = (call) => session.run((ctx) => call(session.app.orders, ctx));

export const orderAddress = (id) => `#/orders/detail?id=${encodeURIComponent(id)}`;

// The id in "#/orders/detail?id=…" (the router drops the query, so the view reads it itself).
export function addressId(hash = window.location.hash) {
  const query = String(hash).split("?")[1] ?? "";
  return new URLSearchParams(query).get("id");
}

export const text = (value) =>
  value === null || value === undefined || value === "" ? "—" : value;

export const quantityText = (value) =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US");

export const moneyText = (value, currency) =>
  value === null || value === undefined
    ? "—"
    : `${currency ? `${currency} ` : ""}${Number(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

export const percentText = (value, digits = 1) =>
  value === null || value === undefined ? "—" : `${Number(value).toFixed(digits)}%`;

export const minutesText = (minutes) =>
  minutes === null || minutes === undefined
    ? "—"
    : `${Math.round(minutes).toLocaleString("en-US")} min`;

// Whether the signed-in person can change organization-wide data here: the permission and a scope of
// every factory (the services check again).
export const mayChangeShared = (permission) =>
  session.can(permission) &&
  !session.supporting &&
  !session.who.assignmentScoped &&
  session.who.factoryScope.all;

export const mayWrite = (permission) => session.can(permission) && !session.supporting;

// A bar with the utilization written beside it; the number is always shown, never only the colour.
export function utilizationBar(value) {
  if (value === null || value === undefined) return h("span", { class: "muted" }, "—");
  const tone = value > 100 ? "bad" : value >= 90 ? "warn" : "good";
  return h(
    "span",
    { class: "load" },
    h(
      "span",
      { class: "load-track", role: "img", "aria-label": `${value.toFixed(0)} percent loaded` },
      h("span", {
        class: `load-fill load-${tone}`,
        style: `width:${Math.min(100, Math.max(0, value))}%`,
      })
    ),
    h("span", { class: "load-text" }, `${value.toFixed(0)}%`)
  );
}

// The select options for a list of rows, with an optional empty first choice.
export const optionsOf = (rows, { empty } = {}) => [
  ...(empty ? [{ value: "", label: empty }] : []),
  ...rows.map((row) => ({ value: row.id, label: row.label ?? row.name })),
];
