// One buyer order: its header and status, lines with progress, milestones, buyer approvals and
// capacity bookings (D74 to D82). The service says which actions the caller may take (`may`) and
// which the order's status allows; the page draws only those, and every call checks again.
import { h } from "../dom.js";
import { FIELD_ERRORS } from "../crud.js";
import { confirmDialog, formDialog } from "../dialog.js";
import {
  attempt,
  badge,
  button,
  card,
  emptyState,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";
import { fullDate } from "../charts.js";
import {
  approvalHistoryDialog,
  decideApprovalDialog,
  requestApprovalDialog,
  resubmitApprovalDialog,
} from "./orders-approval-actions.js";
import {
  addressId,
  minutesText,
  moneyText,
  optionsOf,
  orders,
  percentText,
  quantityText,
  text,
  utilizationBar,
} from "./orders-common.js";

const ERRORS = {
  ...FIELD_ERRORS,
  invalid_dates: "endDate",
  invalid_currency: "currency",
  invalid_date: "plannedDate",
  invalid_number: "quantity",
  duplicate: "styleId",
  style_buyer_mismatch: "styleId",
  not_found: "styleId",
  reason_required: "reason",
  future_date: "actualDate",
};

const NEXT_LABEL = {
  confirmed: "Confirm order",
  in_production: "Start production",
  shipped: "Mark as shipped",
  closed: "Close order",
};

const MANUAL_STATUSES = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
];

const row = (...nodes) => h("div", { class: "actions end" }, nodes);
const link = (label, onClick) => button(label, onClick, { kind: "link" });

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const id = addressId();
    if (!id) {
      return emptyState({
        title: "No order chosen",
        body: "Open an order from the Buyer orders list.",
        action: h("a", { class: "btn btn-primary", href: "#/orders/list" }, "Buyer orders"),
      });
    }
    const view = orders((o, ctx) => o.order(ctx, id));
    const { order, may } = view;
    const mayManage = may.manage && !session.supporting;
    const mayPlan = may.planning && !session.supporting;
    const mayDecide = may.decide && !session.supporting;
    const mayBook = may.capacity && !session.supporting;
    const run = (call, success) => {
      const result = attempt(() => orders(call), success);
      redraw();
      return result;
    };

    // ---- Header and status --------------------------------------------------------------------

    const editOrder = () =>
      formDialog({
        title: `Edit ${order.reference}`,
        fields: [
          { name: "buyerPo", label: "Buyer's PO number", maxlength: 40 },
          { name: "orderDate", label: "Order date", type: "date", required: true },
          { name: "shipDate", label: "Ship date", type: "date", required: true },
          { name: "currency", label: "Currency", maxlength: 3, required: true },
          { name: "note", label: "Note", type: "textarea" },
        ],
        initial: {
          buyerPo: order.buyerPo ?? "",
          orderDate: order.orderDate,
          shipDate: order.shipDate,
          currency: order.currency,
          note: order.note ?? "",
        },
        errorFields: { ...ERRORS, invalid_dates: "shipDate", duplicate: "buyerPo" },
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.updateOrder(ctx, order.id, values));
          toast("Order saved", "good");
          redraw();
        },
      });

    const advance = () =>
      run(
        (o, ctx) => o.setOrderStatus(ctx, order.id, { status: view.next }),
        `Order ${view.next.replace("_", " ")}`
      );

    const cancelOrder = () =>
      confirmDialog({
        title: `Cancel ${order.reference}?`,
        message:
          "Its open lines and its planned or confirmed bookings are cancelled too. A cancelled order cannot be changed.",
        confirmLabel: "Cancel order",
        danger: true,
        reason: true,
        reasonLabel: "Reason for cancelling",
        onConfirm: (reason) => {
          orders((o, ctx) => o.setOrderStatus(ctx, order.id, { status: "cancelled", reason }));
          toast("Order cancelled", "good");
          redraw();
        },
      });

    const deleteOrder = () =>
      confirmDialog({
        title: `Delete ${order.reference}?`,
        message: "Only a draft order with no lines or planning can be deleted.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          orders((o, ctx) => o.removeOrder(ctx, order.id));
          toast("Order deleted", "good");
          window.location.hash = "/orders/list";
        },
      });

    const header = card(
      null,
      h(
        "div",
        {},
        h(
          "dl",
          { class: "facts" },
          ...[
            ["Status", statusBadge(order.status)],
            ["Buyer", text(order.buyerName)],
            ["Buyer PO", text(order.buyerPo)],
            ["Factory", text(order.factoryName)],
            ["Order date", fullDate(order.orderDate)],
            ["Ship date", fullDate(order.shipDate)],
            ["Pieces", quantityText(order.quantity)],
            ["Made", `${quantityText(order.produced)} (${percentText(order.percent)})`],
            ["Value", moneyText(order.value, order.currency)],
          ].flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])
        ),
        order.note ? h("p", {}, order.note) : null,
        order.cancelReason ? notice(`Cancelled: ${order.cancelReason}`, "warn") : null,
        mayManage
          ? row(
              view.editable ? button("Edit", editOrder) : null,
              view.next ? button(NEXT_LABEL[view.next], advance, { kind: "primary" }) : null,
              view.editable ? button("Cancel order", cancelOrder, { kind: "danger" }) : null,
              order.status === "draft" ? button("Delete", deleteOrder, { kind: "danger" }) : null
            )
          : null
      )
    );

    // ---- Lines --------------------------------------------------------------------------------

    const styles = mayManage && view.editable ? orders((o, ctx) => o.styles(ctx)) : [];

    const addLine = () => {
      const taken = new Set(view.lines.map((line) => line.styleId));
      // One line per style, and a style linked to a buyer only on that buyer's orders.
      const choices = styles.filter(
        (style) => !taken.has(style.id) && (!style.buyerId || style.buyerId === order.buyerId)
      );
      return formDialog({
        title: "Add a line",
        fields: [
          {
            name: "styleId",
            label: "Style",
            type: "select",
            options: optionsOf(
              choices.map((style) => ({ id: style.id, label: `${style.code} · ${style.name}` }))
            ),
            required: true,
            hint: "Styles linked to another buyer, and styles already on this order, are not offered",
          },
          {
            name: "quantity",
            label: "Quantity (pieces)",
            type: "number",
            min: 1,
            step: 1,
            required: true,
          },
          {
            name: "unitPrice",
            label: `Unit price (${order.currency})`,
            type: "number",
            min: 0,
            step: "0.01",
          },
        ],
        errorFields: { ...ERRORS, invalid_number: "quantity" },
        submitLabel: "Add line",
        onSubmit: (values) => {
          orders((o, ctx) => o.addLine(ctx, order.id, values));
          toast("Line added", "good");
          redraw();
        },
      });
    };

    const editLine = (line) =>
      formDialog({
        title: `Edit ${line.styleCode}`,
        fields: [
          {
            name: "quantity",
            label: "Quantity (pieces)",
            type: "number",
            min: 1,
            step: 1,
            required: true,
          },
          {
            name: "unitPrice",
            label: `Unit price (${order.currency})`,
            type: "number",
            min: 0,
            step: "0.01",
          },
        ],
        initial: { quantity: line.quantity, unitPrice: line.unitPrice ?? "" },
        errorFields: ERRORS,
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.updateLine(ctx, line.id, values));
          toast("Line saved", "good");
          redraw();
        },
      });

    const cancelLine = (line) =>
      confirmDialog({
        title: `Cancel the ${line.styleCode} line?`,
        message: "Its planned or confirmed bookings are cancelled too.",
        confirmLabel: "Cancel line",
        danger: true,
        reason: true,
        reasonLabel: "Reason for cancelling",
        onConfirm: (reason) => {
          orders((o, ctx) => o.setLineStatus(ctx, line.id, { status: "cancelled", reason }));
          toast("Line cancelled", "good");
          redraw();
        },
      });

    const lines = card(
      "Lines",
      dataTable({
        caption: "Order lines",
        pageSize: 10,
        columns: [
          {
            key: "style",
            label: "Style",
            sort: (r) => r.styleCode ?? "",
            render: (r) => `${text(r.styleCode)} · ${text(r.styleName)}`,
          },
          {
            key: "quantity",
            label: "Ordered",
            sort: (r) => r.quantity,
            align: "end",
            render: (r) => quantityText(r.quantity),
          },
          {
            key: "produced",
            label: "Made",
            sort: (r) => r.produced,
            align: "end",
            render: (r) => quantityText(r.produced),
          },
          {
            key: "remaining",
            label: "Remaining",
            sort: (r) => r.remaining,
            align: "end",
            render: (r) => quantityText(r.remaining),
          },
          {
            key: "percent",
            label: "Done",
            sort: (r) => r.percent ?? -1,
            align: "end",
            render: (r) => percentText(r.percent),
          },
          {
            key: "price",
            label: "Unit price",
            sort: (r) => r.unitPrice ?? -1,
            align: "end",
            render: (r) => moneyText(r.unitPrice),
          },
          {
            key: "status",
            label: "Status",
            sort: (r) => r.status,
            render: (r) => statusBadge(r.status),
          },
          {
            key: "actions",
            label: "",
            align: "end",
            render: (r) =>
              mayManage && view.editable && r.status === "open"
                ? row(
                    link("Edit", () => editLine(r)),
                    link("Complete", () =>
                      run(
                        (o, ctx) => o.setLineStatus(ctx, r.id, { status: "completed" }),
                        "Line completed"
                      )
                    ),
                    link("Cancel", () => cancelLine(r)),
                    order.status === "draft"
                      ? link("Remove", () =>
                          run((o, ctx) => o.removeLine(ctx, r.id), "Line removed")
                        )
                      : null
                  )
                : null,
          },
        ],
        rows: view.lines,
        rowKey: (r) => r.id,
        empty: { title: "No lines yet", body: "Add the styles and quantities the buyer ordered." },
      }),
      mayManage && view.editable ? button("Add a line", addLine) : null
    );

    // ---- Milestones ---------------------------------------------------------------------------

    const applyTemplate = () => {
      const templates = orders((o, ctx) => o.templates(ctx)).filter((template) => template.active);
      if (templates.length === 0) {
        toast("There is no active Time and Action template", "warn");
        return undefined;
      }
      return formDialog({
        title: "Apply a template",
        description:
          "Adds the milestones this order does not have yet, dated from the order date. Milestones it already has are left as they are.",
        fields: [
          {
            name: "templateId",
            label: "Template",
            type: "select",
            options: optionsOf(templates),
            required: true,
          },
        ],
        errorFields: { not_found: "templateId", inactive_parent: "templateId" },
        submitLabel: "Apply",
        onSubmit: (values) => {
          const result = orders((o, ctx) => o.applyTemplate(ctx, order.id, values.templateId));
          toast(`${result.created} added, ${result.skipped} already there`, "good");
          redraw();
        },
      });
    };

    const addMilestone = () =>
      formDialog({
        title: "Add a milestone",
        fields: [
          { name: "code", label: "Code", required: true, maxlength: 20 },
          { name: "name", label: "Name", required: true },
          { name: "plannedDate", label: "Planned date", type: "date", required: true },
          { name: "responsibleRole", label: "Responsible role" },
          { name: "blocking", label: "Blocks production", type: "checkbox" },
          { name: "note", label: "Note", type: "textarea" },
        ],
        errorFields: {
          ...ERRORS,
          duplicate: "code",
          invalid_code: "code",
          invalid_date: "plannedDate",
        },
        submitLabel: "Add milestone",
        onSubmit: (values) => {
          orders((o, ctx) => o.addMilestone(ctx, order.id, values));
          toast("Milestone added", "good");
          redraw();
        },
      });

    const completeMilestone = (milestone) =>
      formDialog({
        title: `Complete ${milestone.name}`,
        fields: [
          {
            name: "actualDate",
            label: "Completed on",
            type: "date",
            required: true,
            max: session.who.today,
          },
        ],
        initial: { actualDate: session.who.today },
        errorFields: { ...ERRORS, invalid_date: "actualDate" },
        submitLabel: "Complete",
        onSubmit: (values) => {
          orders((o, ctx) => o.completeMilestone(ctx, milestone.id, values));
          toast("Milestone completed", "good");
          redraw();
        },
      });

    const reviseMilestone = (milestone) =>
      formDialog({
        title: `New date for ${milestone.name}`,
        description: `Planned ${fullDate(milestone.plannedDate)}. The planned date stays on record.`,
        fields: [
          { name: "revisedDate", label: "New date", type: "date", required: true },
          { name: "reason", label: "Reason", type: "textarea", required: true },
        ],
        initial: { revisedDate: milestone.due },
        errorFields: { ...ERRORS, invalid_date: "revisedDate" },
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.reviseMilestone(ctx, milestone.id, values));
          toast("Date revised", "good");
          redraw();
        },
      });

    const statusMilestone = (milestone) =>
      formDialog({
        title: `Status of ${milestone.name}`,
        fields: [
          {
            name: "status",
            label: "Status",
            type: "select",
            options: MANUAL_STATUSES,
            required: true,
          },
        ],
        initial: { status: milestone.status },
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.setMilestoneStatus(ctx, milestone.id, values));
          toast("Status saved", "good");
          redraw();
        },
      });

    const milestones = card(
      "Milestones",
      dataTable({
        caption: "Milestones",
        pageSize: 12,
        columns: [
          {
            key: "name",
            label: "Milestone",
            sort: (r) => r.sequence,
            render: (r) => h("span", {}, r.name, " ", h("small", { class: "muted" }, r.code)),
          },
          {
            key: "role",
            label: "Responsible",
            sort: (r) => r.responsibleRole ?? "",
            render: (r) => text(r.responsibleRole),
          },
          {
            key: "blocking",
            label: "Blocks production",
            sort: (r) => (r.blocking ? 0 : 1),
            render: (r) => (r.blocking ? badge("blocking", "warn") : "—"),
          },
          {
            key: "due",
            label: "Due",
            sort: (r) => r.due,
            render: (r) =>
              r.revisedDate
                ? h(
                    "span",
                    { title: r.revisionReason ?? "" },
                    fullDate(r.revisedDate),
                    " ",
                    h("small", { class: "muted" }, `was ${fullDate(r.plannedDate)}`)
                  )
                : fullDate(r.plannedDate),
          },
          {
            key: "actual",
            label: "Completed",
            sort: (r) => r.actualDate ?? "",
            render: (r) => (r.actualDate ? fullDate(r.actualDate) : "—"),
          },
          {
            key: "state",
            label: "Status",
            sort: (r) => r.state,
            render: (r) => statusBadge(r.state),
          },
          {
            key: "actions",
            label: "",
            align: "end",
            render: (r) =>
              mayPlan && view.open && r.status !== "completed"
                ? row(
                    link("Complete", () => completeMilestone(r)),
                    link("New date", () => reviseMilestone(r)),
                    link("Status", () => statusMilestone(r)),
                    link("Remove", () =>
                      run((o, ctx) => o.removeMilestone(ctx, r.id), "Milestone removed")
                    )
                  )
                : null,
          },
        ],
        rows: view.milestones,
        rowKey: (r) => r.id,
        empty: {
          title: "No milestones",
          body: "Apply a Time and Action template or add a milestone.",
        },
      }),
      mayPlan && view.open
        ? row(button("Apply a template", applyTemplate), button("Add a milestone", addMilestone))
        : null
    );

    // ---- Buyer approvals ----------------------------------------------------------------------

    const requestApproval = () => requestApprovalDialog({ order, redraw });
    const decide = (approval) => decideApprovalDialog(approval, redraw);
    const resubmit = (approval) => resubmitApprovalDialog(approval, redraw);
    const history = (approval) => approvalHistoryDialog(approval);

    const approvals = card(
      "Buyer approvals",
      dataTable({
        caption: "Buyer approvals",
        pageSize: 10,
        columns: [
          {
            key: "type",
            label: "Approval",
            sort: (r) => r.typeName,
            render: (r) =>
              h("span", {}, r.typeName, " ", r.blocking ? badge("blocking", "warn") : null),
          },
          {
            key: "due",
            label: "Needed by",
            sort: (r) => r.dueDate,
            render: (r) =>
              h("span", {}, fullDate(r.dueDate), r.overdue ? [" ", badge("overdue", "bad")] : null),
          },
          {
            key: "status",
            label: "Status",
            sort: (r) => r.status,
            render: (r) => statusBadge(r.status),
          },
          { key: "by", label: "Requested by", render: (r) => text(r.requestedBy) },
          {
            key: "actions",
            label: "",
            align: "end",
            render: (r) =>
              row(
                link("History", () => history(r)),
                mayDecide && view.open && r.status === "pending"
                  ? link("Decide", () => decide(r))
                  : null,
                mayPlan && view.open && r.status === "revision_requested"
                  ? link("Resubmit", () => resubmit(r))
                  : null
              ),
          },
        ],
        rows: view.approvals,
        rowKey: (r) => r.id,
        empty: {
          title: "No approvals requested",
          body: "Ask the buyer to approve samples, fabric or trims.",
        },
      }),
      mayPlan && view.open ? button("Request an approval", requestApproval) : null
    );

    // ---- Capacity bookings --------------------------------------------------------------------

    const book = () => {
      const open = view.lines.filter((line) => line.status === "open");
      if (open.length === 0) {
        toast("Add an open line first", "warn");
        return undefined;
      }
      const choices = orders((o, ctx) => o.planningOptions(ctx, { factoryId: order.factoryId }));
      return formDialog({
        title: "Book capacity",
        description:
          "Reserves a production line for an open line of this order. Warnings never block a booking.",
        fields: [
          {
            name: "lineId",
            label: "Order line",
            type: "select",
            required: true,
            options: optionsOf(
              open.map((line) => ({
                id: line.id,
                label: `${line.styleCode} · ${quantityText(line.quantity)} pieces`,
              }))
            ),
          },
          {
            name: "productionLineId",
            label: "Production line",
            type: "select",
            required: true,
            options: optionsOf(
              choices.lines.map((line) => ({
                id: line.id,
                label: `${line.name}${line.sectionName ? ` · ${line.sectionName}` : ""}`,
              }))
            ),
          },
          {
            name: "shiftId",
            label: "Shift",
            type: "select",
            options: optionsOf(choices.shifts, { empty: "Any shift" }),
          },
          {
            name: "calendarId",
            label: "Working calendar",
            type: "select",
            required: true,
            options: optionsOf(choices.calendars),
          },
          { name: "startDate", label: "From", type: "date", required: true },
          { name: "endDate", label: "To", type: "date", required: true },
          {
            name: "operators",
            label: "Operators",
            type: "number",
            min: 1,
            step: 1,
            required: true,
          },
          {
            name: "efficiency",
            label: "Efficiency target (%)",
            type: "number",
            min: 1,
            max: 100,
            step: "any",
            hint: "80 when left empty",
          },
          {
            name: "hoursPerDay",
            label: "Hours per day",
            type: "number",
            min: 0.1,
            max: 24,
            step: "any",
            hint: "8 when left empty",
          },
          { name: "note", label: "Note", type: "textarea" },
        ],
        errorFields: { ...ERRORS, invalid_dates: "endDate", invalid_number: "operators" },
        submitLabel: "Book",
        onSubmit: (values) => {
          const booking = orders((o, ctx) =>
            o.createBooking(ctx, { ...values, orderId: order.id })
          );
          const warned = booking.warnings.overloaded || booking.warnings.conflicts.length > 0;
          toast(warned ? "Booked, with warnings" : "Capacity booked", warned ? "warn" : "good");
          redraw();
        },
      });
    };

    const reschedule = (booking) =>
      formDialog({
        title: `Reschedule ${booking.productionLineName}`,
        description: "Only the dates change; the operators, efficiency and SMV stay as booked.",
        fields: [
          { name: "startDate", label: "From", type: "date", required: true },
          { name: "endDate", label: "To", type: "date", required: true },
        ],
        initial: { startDate: booking.startDate, endDate: booking.endDate },
        errorFields: { ...ERRORS, invalid_dates: "endDate" },
        submitLabel: "Save",
        onSubmit: (values) => {
          orders((o, ctx) => o.rescheduleBooking(ctx, booking.id, values));
          toast("Booking rescheduled", "good");
          redraw();
        },
      });

    const setBooking = (booking, status, success) =>
      run((o, ctx) => o.setBookingStatus(ctx, booking.id, { status }), success);

    const warnings = (booking) =>
      h(
        "span",
        {},
        booking.warnings.overloaded ? badge("overloaded", "bad") : null,
        booking.warnings.conflicts.length > 0
          ? [
              " ",
              badge(
                `clashes with ${booking.warnings.conflicts.map((c) => c.orderReference).join(", ")}`,
                "warn"
              ),
            ]
          : null,
        !booking.warnings.overloaded && booking.warnings.conflicts.length === 0 ? "—" : null
      );

    const bookings = card(
      "Capacity bookings",
      dataTable({
        caption: "Capacity bookings",
        pageSize: 10,
        columns: [
          {
            key: "line",
            label: "Line",
            sort: (r) => r.productionLineName ?? "",
            render: (r) => `${text(r.productionLineName)}${r.shiftName ? ` · ${r.shiftName}` : ""}`,
          },
          {
            key: "style",
            label: "Style",
            sort: (r) => r.styleCode ?? "",
            render: (r) => text(r.styleCode),
          },
          {
            key: "dates",
            label: "Dates",
            sort: (r) => r.startDate,
            render: (r) => `${fullDate(r.startDate)} to ${fullDate(r.endDate)}`,
          },
          { key: "workingDays", label: "Working days", sort: (r) => r.workingDays, align: "end" },
          {
            key: "required",
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
          { key: "warnings", label: "Warnings", render: warnings },
          {
            key: "status",
            label: "Status",
            sort: (r) => r.status,
            render: (r) => statusBadge(r.status),
          },
          {
            key: "actions",
            label: "",
            align: "end",
            render: (r) => {
              if (
                !mayBook ||
                (r.status !== "planned" && r.status !== "confirmed" && r.status !== "cancelled")
              )
                return null;
              const live = r.status === "planned" || r.status === "confirmed";
              return row(
                live && view.editable ? link("Reschedule", () => reschedule(r)) : null,
                r.status === "planned" && view.editable
                  ? link("Confirm", () => setBooking(r, "confirmed", "Booking confirmed"))
                  : null,
                live
                  ? link("Complete", () => setBooking(r, "completed", "Booking completed"))
                  : null,
                live ? link("Cancel", () => setBooking(r, "cancelled", "Booking cancelled")) : null,
                r.status !== "confirmed"
                  ? link("Delete", () =>
                      run((o, ctx) => o.removeBooking(ctx, r.id), "Booking deleted")
                    )
                  : null
              );
            },
          },
        ],
        rows: view.bookings,
        rowKey: (r) => r.id,
        empty: {
          title: "No bookings",
          body: "Book a production line for the lines of this order.",
        },
      }),
      mayBook && view.editable ? button("Book capacity", book) : null
    );

    return h(
      "div",
      {},
      pageHeader(
        order.reference,
        `${text(order.buyerName)} · ${text(order.factoryName)}`,
        h("a", { class: "btn btn-secondary", href: "#/orders/list" }, "All orders")
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      view.locked
        ? notice(`This order is ${order.status}; its lines and bookings are locked.`, "info")
        : null,
      header,
      lines,
      milestones,
      approvals,
      bookings
    );
  });
  return root;
}
