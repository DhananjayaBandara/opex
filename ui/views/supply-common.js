// Small helpers shared by the supply chain, stock and finance screens (D83 to D96): the service calls,
// the address of each document, filters, and how dates, quantities and statuses are written.
import { h } from "../dom.js";
import { session } from "../session.js";
import { fullDate } from "../charts.js";

export {
  addressId,
  mayChangeShared,
  mayWrite,
  moneyText,
  optionsOf,
  quantityText,
  text,
} from "./orders-common.js";

export const supply = (call) => session.run((ctx) => call(session.app.procurement, ctx));
export const inventory = (call) => session.run((ctx) => call(session.app.inventory, ctx));
export const finance = (call) => session.run((ctx) => call(session.app.finance, ctx));

const address = (path) => (id) => `#/${path}?id=${encodeURIComponent(id)}`;
export const rfqAddress = address("supply/rfq");
export const poAddress = address("supply/purchase-order");
export const receiptAddress = address("supply/receipt");
export const requisitionAddress = address("supply/requisition");
export const invoiceAddress = address("finance/invoice");

export const dateText = (key) => (key ? fullDate(key) : "—");

// A link to a document, or a dash when there is none.
export const linkTo = (label, href) => (label && href ? h("a", { href }, label) : label || "—");

// Filter values the person left empty are not sent to the services.
export const queryOf = (filter) =>
  Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== ""));

// A labelled select that writes its choice into `filter` and redraws the page.
export function filterSelect(filter, name, label, options, redraw) {
  const id = `filter-${name}`;
  const control = h(
    "select",
    {
      id,
      onchange: () => {
        filter[name] = control.value;
        redraw();
      },
    },
    options.map((option) =>
      h("option", { value: option.value, selected: option.value === filter[name] }, option.label)
    )
  );
  return h("span", {}, h("label", { for: id }, label), " ", control);
}

// Text boxes for a date range, redrawn when a date is chosen.
export function filterDate(filter, name, label, redraw) {
  const id = `filter-${name}`;
  const control = h("input", {
    id,
    type: "date",
    value: filter[name],
    onchange: () => {
      filter[name] = control.value;
      redraw();
    },
  });
  return h("span", {}, h("label", { for: id }, label), " ", control);
}

// Row of buttons at the end of a card or table cell.
export const row = (...nodes) => h("div", { class: "actions end" }, nodes);

// Shown on every page that a support session can open.
export const READ_ONLY_NOTE = "Read-only support access.";

// The refusals the supply forms can show on a field (anything else shows in the dialog banner).
export const COMMON_ERRORS = {
  invalid_date: "date",
  invalid_dates: "dueDate",
  invalid_currency: "currency",
  invalid_number: "quantity",
  invalid_field: "quantity",
  reason_required: "reason",
  duplicate: "code",
  invalid_code: "code",
  invalid_name: "name",
  invalid_email: "email",
  invalid_phone: "phone",
};

export const MOVEMENT_LABELS = {
  opening: "Opening balance",
  receipt: "Goods receipt",
  issue: "Issue",
  return: "Return",
  adjustment_in: "Adjustment in",
  adjustment_out: "Adjustment out",
  reversal: "Reversal",
};

export const UNIT_LABELS = {
  m: "Metres (m)",
  pcs: "Pieces (pcs)",
  kg: "Kilograms (kg)",
  roll: "Rolls (roll)",
  box: "Boxes (box)",
};

// A quantity with its unit: "120 m".
export const withUnit = (quantity, unit) =>
  `${Number(quantity ?? 0).toLocaleString("en-US")}${unit ? ` ${unit}` : ""}`;
