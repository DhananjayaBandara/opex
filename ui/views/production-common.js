// Small helpers shared by the production screens: number and percentage text, the address of a day,
// and the service calls (D34 to D41).
import { h } from "../dom.js";
import { session } from "../session.js";

export const production = (call) => session.run((ctx) => call(session.app.production, ctx));

export const dayAddress = (id) => `#/production/day?id=${encodeURIComponent(id)}`;

// The id in "#/production/day?id=…" (the router drops the query, so the view reads it itself).
export function addressId(hash = window.location.hash) {
  const query = String(hash).split("?")[1] ?? "";
  return new URLSearchParams(query).get("id");
}

export const count = (value) => (value === null || value === undefined ? "—" : String(value));

export const percent = (value, digits = 1) =>
  value === null || value === undefined ? "—" : `${value.toFixed(digits)}%`;

export const minutesText = (minutes) => {
  if (!minutes) return "—";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes} min` : `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
};

// A word and a tone for how close to the plan a rate is. The word is always shown with the number.
export function rateBadge(rate) {
  if (rate === null || rate === undefined) return h("span", { class: "muted" }, "—");
  const tone = rate >= 100 ? "good" : rate >= 90 ? "warn" : "bad";
  const word = rate >= 100 ? "on plan" : rate >= 90 ? "slightly behind" : "behind";
  return h("span", { class: `badge badge-${tone}`, title: word }, `${rate.toFixed(1)}% · ${word}`);
}

export const shiftDay = (date, offset) => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + offset);
  return next.toISOString().slice(0, 10);
};

// A labelled form control placed in a tools row.
export const control = (id, label, input) =>
  h("span", {}, h("label", { for: id }, label), " ", input);
