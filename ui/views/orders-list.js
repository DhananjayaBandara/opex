// Buyer orders: the list with progress, and a new order (D74 to D76, D82). An order opens on its own
// page, which holds the lines, milestones, approvals and bookings.
import { h } from "../dom.js";
import { FIELD_ERRORS } from "../crud.js";
import { formDialog } from "../dialog.js";
import { badge, button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { fullDate } from "../charts.js";
import {
  mayWrite,
  moneyText,
  optionsOf,
  orderAddress,
  orders,
  percentText,
  quantityText,
  text,
} from "./orders-common.js";

const ERRORS = {
  ...FIELD_ERRORS,
  invalid_code: "reference",
  duplicate: "reference",
  invalid_dates: "shipDate",
  invalid_date: "shipDate",
  invalid_currency: "currency",
  not_found: "buyerId",
  inactive_parent: "buyerId",
};

const STATUS_LABEL = {
  draft: "Draft",
  confirmed: "Confirmed",
  in_production: "In production",
  shipped: "Shipped",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function render() {
  const root = h("div");
  const filter = { factoryId: "", buyerId: "", status: "" };
  mount(root, (redraw) => {
    const mayCreate = mayWrite("order.manage");
    const buyers = orders((o, ctx) => o.buyers(ctx));
    const factories = orders((o, ctx) => o.factories(ctx));
    const query = Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== ""));
    const rows = orders((o, ctx) => o.orders(ctx, query));

    const create = () => {
      const placeable = orders((o, ctx) => o.factories(ctx, { for: "manage" }));
      const open = buyers.filter((buyer) => buyer.active);
      if (placeable.length === 0 || open.length === 0) {
        toast(
          open.length === 0 ? "Add a buyer first" : "You can place orders in none of the factories",
          "warn"
        );
        return undefined;
      }
      return formDialog({
        title: "New buyer order",
        fields: [
          { name: "reference", label: "Our order reference", required: true, maxlength: 20 },
          {
            name: "factoryId",
            label: "Factory",
            type: "select",
            options: optionsOf(placeable),
            required: true,
          },
          {
            name: "buyerId",
            label: "Buyer",
            type: "select",
            options: optionsOf(open),
            required: true,
          },
          { name: "buyerPo", label: "Buyer's PO number", maxlength: 40 },
          { name: "orderDate", label: "Order date", type: "date", required: true },
          { name: "shipDate", label: "Ship date", type: "date", required: true },
          {
            name: "currency",
            label: "Currency",
            maxlength: 3,
            hint: "Three letters; the company currency when left empty",
          },
          { name: "note", label: "Note", type: "textarea" },
        ],
        initial: { orderDate: session.who.today },
        errorFields: ERRORS,
        submitLabel: "Create order",
        onSubmit: (values) => {
          const order = orders((o, ctx) => o.createOrder(ctx, values));
          toast("Order created", "good");
          window.location.hash = orderAddress(order.id).slice(1);
        },
      });
    };

    const select = (name, label, options) => {
      const control = h(
        "select",
        {
          id: `filter-${name}`,
          onchange: () => {
            filter[name] = control.value;
            redraw();
          },
        },
        options.map((option) =>
          h(
            "option",
            { value: option.value, selected: option.value === filter[name] },
            option.label
          )
        )
      );
      return h("span", {}, h("label", { for: `filter-${name}` }, label), " ", control);
    };

    return h(
      "div",
      {},
      pageHeader(
        "Buyer orders",
        "Orders from buyers, their lines and how much has been made.",
        mayCreate ? button("New order", create, { kind: "primary" }) : null
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      h(
        "div",
        { class: "tools" },
        select("factoryId", "Factory", [
          { value: "", label: "All factories" },
          ...factories.map((row) => ({ value: row.id, label: row.name })),
        ]),
        select("buyerId", "Buyer", [
          { value: "", label: "All buyers" },
          ...buyers.map((row) => ({ value: row.id, label: row.name })),
        ]),
        select("status", "Status", [
          { value: "", label: "Any status" },
          ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
        ])
      ),
      card(
        null,
        dataTable({
          caption: "Buyer orders",
          pageSize: 12,
          columns: [
            {
              key: "reference",
              label: "Order",
              sort: (r) => r.reference,
              render: (r) => h("a", { href: orderAddress(r.id) }, r.reference),
            },
            {
              key: "buyer",
              label: "Buyer",
              sort: (r) => r.buyerName ?? "",
              render: (r) => text(r.buyerName),
            },
            {
              key: "po",
              label: "Buyer PO",
              sort: (r) => r.buyerPo ?? "",
              render: (r) => text(r.buyerPo),
            },
            {
              key: "factory",
              label: "Factory",
              sort: (r) => r.factoryName ?? "",
              render: (r) => text(r.factoryName),
            },
            {
              key: "status",
              label: "Status",
              sort: (r) => r.status,
              render: (r) => statusBadge(r.status),
            },
            {
              key: "ship",
              label: "Ship date",
              sort: (r) => r.shipDate,
              render: (r) => fullDate(r.shipDate),
            },
            {
              key: "quantity",
              label: "Pieces",
              sort: (r) => r.quantity,
              align: "end",
              render: (r) => quantityText(r.quantity),
            },
            {
              key: "progress",
              label: "Made",
              sort: (r) => r.percent ?? -1,
              align: "end",
              render: (r) =>
                r.percent === null
                  ? "—"
                  : h(
                      "span",
                      {},
                      `${quantityText(r.produced)} · `,
                      badge(percentText(r.percent, 0), r.percent >= 100 ? "good" : "neutral")
                    ),
            },
            {
              key: "value",
              label: "Value",
              sort: (r) => r.value ?? -1,
              align: "end",
              render: (r) => moneyText(r.value, r.currency),
            },
          ],
          rows,
          rowKey: (r) => r.id,
          searchText: (r) =>
            `${r.reference} ${r.buyerName ?? ""} ${r.buyerPo ?? ""} ${r.factoryName ?? ""}`,
          empty: {
            title: "No orders",
            body: mayCreate ? "Create the first order for a buyer." : "No orders match this view.",
          },
        })
      )
    );
  });
  return root;
}
