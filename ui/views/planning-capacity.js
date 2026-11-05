// Capacity and loading: how full each production line is over a period, from the active capacity
// bookings that touch it (D79, D80). The minutes a booking needs are spread evenly over its working
// dates, so a booking that starts before the period counts only for the part inside it. Warnings are
// information: an overloaded line or two bookings on the same line and dates never block a booking.
// Bookings are made and changed on the order page.
import { h } from "../dom.js";
import { addDays } from "../../domain/effective-dating.js";
import { badge, card, emptyState, mount, notice, pageHeader, statusBadge } from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { fullDate, statTile } from "../charts.js";
import {
  minutesText,
  orderAddress,
  orders,
  quantityText,
  text,
  utilizationBar,
} from "./orders-common.js";

export function render() {
  const root = h("div");
  const period = { from: null, to: null, factoryId: "" };
  mount(root, (redraw) => {
    const today = session.who.today;
    period.from ??= today;
    period.to ??= addDays(today, 27);
    const factories = orders((o, ctx) => o.factories(ctx));

    let loading = null;
    let failure = null;
    try {
      loading = orders((o, ctx) =>
        o.loading(ctx, {
          from: period.from,
          to: period.to,
          ...(period.factoryId === "" ? {} : { factoryId: period.factoryId }),
        })
      );
    } catch (error) {
      if (error?.code === "forbidden") throw error;
      failure = error;
    }

    const date = (label, id, name) => {
      const control = h("input", {
        id,
        type: "date",
        value: period[name],
        onchange: () => {
          if (control.value) period[name] = control.value;
          redraw();
        },
      });
      return h("span", {}, h("label", { for: id }, label), " ", control);
    };

    const factoryFilter = (() => {
      const control = h(
        "select",
        {
          id: "cap-factory",
          onchange: () => {
            period.factoryId = control.value;
            redraw();
          },
        },
        [
          { value: "", label: "All factories" },
          ...factories.map((row) => ({ value: row.id, label: row.name })),
        ].map((option) =>
          h(
            "option",
            { value: option.value, selected: option.value === period.factoryId },
            option.label
          )
        )
      );
      return h("span", {}, h("label", { for: "cap-factory" }, "Factory"), " ", control);
    })();

    const tools = h(
      "div",
      { class: "tools" },
      date("From", "cap-from", "from"),
      date("To", "cap-to", "to"),
      factoryFilter
    );

    if (failure) {
      return h(
        "div",
        {},
        pageHeader("Capacity & loading", "How full each production line is over a period."),
        tools,
        notice(failure.message, "bad")
      );
    }

    const lines = loading.rows;
    const overloaded = lines.filter((line) => line.overloaded).length;
    const clashes = lines.reduce((sum, line) => sum + line.conflicts, 0);
    const needed = lines.reduce((sum, line) => sum + line.requiredMinutes, 0);
    const available = lines.reduce((sum, line) => sum + line.availableMinutes, 0);
    const items = lines.flatMap((line) =>
      line.bookings.map((booking) => ({
        ...booking,
        lineName: line.lineName,
        factoryName: line.factoryName,
      }))
    );

    return h(
      "div",
      {},
      pageHeader(
        "Capacity & loading",
        `${fullDate(loading.from)} to ${fullDate(loading.to)}. Only planned and confirmed bookings count.`
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      tools,
      h(
        "div",
        { class: "stats" },
        statTile("Lines loaded", String(lines.length), "with a booking in the period"),
        statTile(
          "Overloaded",
          String(overloaded),
          overloaded === 1 ? "line over capacity" : "lines over capacity"
        ),
        statTile(
          "Clashing bookings",
          String(clashes),
          "sharing a line and a working date with another"
        ),
        statTile(
          "Overall load",
          available > 0 ? `${((needed / available) * 100).toFixed(0)}%` : "—",
          `${minutesText(needed)} of ${minutesText(available)}`
        )
      ),
      card(
        "Production lines",
        lines.length === 0
          ? emptyState({
              title: "No bookings in this period",
              body: "Book capacity for an order line on the order page.",
            })
          : dataTable({
              caption: "Loading by production line",
              pageSize: 12,
              columns: [
                {
                  key: "line",
                  label: "Line",
                  sort: (r) => r.lineName ?? "",
                  render: (r) => text(r.lineName),
                },
                {
                  key: "section",
                  label: "Section",
                  sort: (r) => r.sectionName ?? "",
                  render: (r) => text(r.sectionName),
                },
                {
                  key: "factory",
                  label: "Factory",
                  sort: (r) => r.factoryName ?? "",
                  render: (r) => text(r.factoryName),
                },
                {
                  key: "count",
                  label: "Bookings",
                  sort: (r) => r.bookings.length,
                  align: "end",
                  render: (r) => r.bookings.length,
                },
                {
                  key: "needed",
                  label: "Needed",
                  sort: (r) => r.requiredMinutes,
                  align: "end",
                  render: (r) => minutesText(r.requiredMinutes),
                },
                {
                  key: "available",
                  label: "Available",
                  sort: (r) => r.availableMinutes,
                  align: "end",
                  render: (r) => minutesText(r.availableMinutes),
                },
                {
                  key: "load",
                  label: "Loaded",
                  sort: (r) => r.utilization ?? -1,
                  render: (r) => utilizationBar(r.utilization),
                },
                {
                  key: "warnings",
                  label: "Warnings",
                  render: (r) =>
                    r.overloaded || r.conflicts > 0
                      ? h(
                          "span",
                          {},
                          r.overloaded ? badge("overloaded", "bad") : null,
                          r.conflicts > 0 ? [" ", badge(`${r.conflicts} clashing`, "warn")] : null
                        )
                      : "—",
                },
              ],
              rows: lines,
              rowKey: (r) => r.lineId,
              searchText: (r) =>
                `${r.lineName ?? ""} ${r.sectionName ?? ""} ${r.factoryName ?? ""}`,
            })
      ),
      items.length === 0
        ? null
        : card(
            "Bookings in the period",
            dataTable({
              caption: "Bookings in the period",
              pageSize: 12,
              columns: [
                {
                  key: "line",
                  label: "Line",
                  sort: (r) => r.lineName ?? "",
                  render: (r) => text(r.lineName),
                },
                {
                  key: "order",
                  label: "Order",
                  sort: (r) => r.orderReference ?? "",
                  render: (r) => h("a", { href: orderAddress(r.orderId) }, text(r.orderReference)),
                },
                {
                  key: "style",
                  label: "Style",
                  sort: (r) => r.styleCode ?? "",
                  render: (r) => text(r.styleCode),
                },
                { key: "shift", label: "Shift", render: (r) => text(r.shiftName) },
                {
                  key: "days",
                  label: "Days in period",
                  sort: (r) => r.days,
                  align: "end",
                  render: (r) => quantityText(r.days),
                },
                {
                  key: "needed",
                  label: "Needed",
                  sort: (r) => r.requiredMinutes,
                  align: "end",
                  render: (r) => minutesText(r.requiredMinutes),
                },
                {
                  key: "available",
                  label: "Available",
                  sort: (r) => r.availableMinutes,
                  align: "end",
                  render: (r) => minutesText(r.availableMinutes),
                },
                {
                  key: "load",
                  label: "Loaded",
                  sort: (r) => r.utilization ?? -1,
                  render: (r) => utilizationBar(r.utilization),
                },
                {
                  key: "warnings",
                  label: "Warnings",
                  render: (r) =>
                    r.overloaded || r.conflicts > 0
                      ? h(
                          "span",
                          {},
                          r.overloaded ? badge("overloaded", "bad") : null,
                          r.conflicts > 0 ? [" ", badge("clashes", "warn")] : null
                        )
                      : "—",
                },
                {
                  key: "status",
                  label: "Status",
                  sort: (r) => r.status,
                  render: (r) => statusBadge(r.status),
                },
              ],
              rows: items,
              rowKey: (r) => r.id,
              searchText: (r) =>
                `${r.lineName ?? ""} ${r.orderReference ?? ""} ${r.styleCode ?? ""}`,
            })
          )
    );
  });
  return root;
}
