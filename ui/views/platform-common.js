// Pieces shared by the audit log, integration, file, import and limits screens (S8; D97 to D109):
// the service calls, the address of a connection and how a stored value is written.
import { h } from "../dom.js";
import { session } from "../session.js";

export const auditService = (call) => session.run((ctx) => call(session.app.audit, ctx));
export const integrationService = (call) =>
  session.run((ctx) => call(session.app.integrations, ctx));
export const fileService = (call) => session.run((ctx) => call(session.app.files, ctx));
export const importService = (call) => session.run((ctx) => call(session.app.imports, ctx));

export const integrationAddress = (id) => `#/admin/integration?id=${encodeURIComponent(id)}`;
export const INTEGRATIONS_PAGE = "#/admin/integrations";

export const SIMULATED_NOTE =
  "Simulated. Nothing is sent to an outside system: a sync and a delivery are recorded here exactly as the real system would record them.";

// A stored value as a short piece of text: empty values are a dash, structures are JSON.
export function valueText(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

// A table of definitions, label and value, used in detail dialogs.
export const facts = (pairs) =>
  h(
    "dl",
    { class: "kv" },
    pairs
      .filter((pair) => Array.isArray(pair) && pair[1] !== undefined)
      .flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value ?? "—")])
  );

// Tabs rendered as buttons. `tabs` is [{id, label}]; `state.tab` is the chosen id.
export function tabBar(label, tabs, state, redraw) {
  return h(
    "nav",
    { class: "tabs", "aria-label": label },
    tabs.map((tab) =>
      h(
        "button",
        {
          type: "button",
          class: "tab",
          "aria-current": tab.id === state.tab ? "page" : null,
          onclick: () => {
            state.tab = tab.id;
            redraw();
          },
        },
        tab.label
      )
    )
  );
}
