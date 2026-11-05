// Orders and planning (SRS 7.2, 9; decisions D72 to D82).
//
// Buyers, the styles they own, buyer orders with their lines and progress, time-and-action templates
// and milestones, buyer approvals and capacity bookings with the loading view.
//
// Every call resolves the tenant and the caller's access from the context, never from the payload.
// Buyers, styles, templates and approval types belong to the whole organization, so changing them
// needs a tenant-wide scope; orders, milestones, approvals and bookings belong to a factory and need
// a scope that covers it (WHERE), failing closed, so a member limited to own assignments has no
// access. Each write runs in one transaction with its audit event, so a refused call leaves neither a
// row nor an event. Progress, lateness and warnings are worked out here on every read and never
// accepted from the caller.
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";
import { validateDate } from "../domain/organization.js";
import {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_STATUSES,
  LOCKED_ORDER_STATUSES,
  MAX_BOOKING_DAYS,
  bookingFigures,
  buildApprovalType,
  buildBooking,
  buildBuyer,
  buildDefinition,
  buildLine,
  buildMilestone,
  buildOrder,
  buildRequest,
  buildTemplate,
  changeApprovalType,
  changeBuyer,
  changeDefinition,
  changeLine,
  changeOrder,
  changeTemplate,
  conflictsOf,
  dueOf,
  isActiveBooking,
  isActiveOrder,
  isOverloaded,
  lineProgress,
  loadIn,
  milestoneFromDefinition,
  milestoneState,
  nextOrderStatus,
  requireDecidable,
  requireLineStatus,
  requireManualMilestoneStatus,
  requireOrderTransition,
  requireResubmittable,
  reviseDate,
  sequenceOf,
  utilization,
  validateBookingRange,
  validateDecision,
  workingDatesBetween,
} from "../domain/orders.js";
import { buildStyle, changeStyle } from "../domain/production.js";
import { blank } from "../domain/workforce.js";
import { fail } from "./errors.js";

const VIEW = "order.view";
const MANAGE = "order.manage";
const PLANNING = "planning.manage";
const DECIDE = "approval.decide";
const CAPACITY = "capacity.manage";

const BUYERS = "buyers";
const STYLES = "styles";
const ORDERS = "buyerOrders";
const LINES = "buyerOrderLines";
const TEMPLATES = "tnaTemplates";
const DEFINITIONS = "milestoneDefinitions";
const MILESTONES = "orderMilestones";
const APPROVAL_TYPES = "buyerApprovalTypes";
const APPROVALS = "buyerApprovals";
const DECISIONS = "buyerApprovalDecisions";
const BOOKINGS = "capacityBookings";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const byName = (a, b) => a.name.localeCompare(b.name);
const idMap = (rows) => new Map(rows.map((row) => [row.id, row]));
const freeze = (row) => Object.freeze(row);

export function createOrders({ store, gate, clock }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  const allowed = (resolved, permission, factoryId) => {
    try {
      gate.authorize(resolved, permission, { factoryId });
      return true;
    } catch {
      return false;
    }
  };

  // Organization-wide data: the permission and a scope of every factory.
  function masterWrite(context, permission) {
    const resolved = gate.requireTenant(context, permission);
    gate.authorizeTenantWide(resolved, permission);
    return resolved;
  }

  function nameOf(resolved) {
    const reader = store.platformSession({ actorId: resolved.user.id });
    const names = new Map();
    return (id) => {
      if (id === null || id === undefined) return null;
      if (!names.has(id)) names.set(id, reader.get("users", id)?.name ?? null);
      return names.get(id);
    };
  }

  function requireRow(tx, collection, id, noun) {
    const row = typeof id === "string" ? tx.get(collection, id) : null;
    if (row === null) throw fail("not_found", `that ${noun} was not found`);
    return row;
  }

  function orderFor(tx, resolved, id, permission = VIEW) {
    const row = requireRow(tx, ORDERS, id, "order");
    gate.authorize(resolved, permission, { factoryId: row.factoryId });
    return row;
  }

  // ---- What may change ------------------------------------------------------------------------

  // Header, lines: only while the order is still being worked (D75).
  const requireActive = (order) => {
    if (!isActiveOrder(order.status)) {
      throw fail(
        "order_locked",
        `a ${order.status.replace("_", " ")} order can no longer be changed`
      );
    }
  };
  // Milestones and approvals stay open until the order is closed or cancelled.
  const requireOpen = (order) => {
    if (order.status === "closed" || order.status === "cancelled") {
      throw fail("order_locked", `a ${order.status} order can no longer be changed`);
    }
  };

  // ---- Looking things up ----------------------------------------------------------------------

  function lookups(reader) {
    return {
      factories: idMap(reader.list("factories")),
      buyers: idMap(reader.list(BUYERS)),
      styles: idMap(reader.list(STYLES)),
      productionLines: idMap(reader.list("lines")),
      sections: idMap(reader.list("sections")),
      shifts: idMap(reader.list("shifts")),
      calendars: idMap(reader.list("calendars")),
    };
  }

  // Pieces made per factory, order reference and style, from approved production days (D76).
  function producedIndex(reader) {
    const days = reader.list(
      "productionDays",
      (day) => day.status === "approved" && typeof day.orderRef === "string"
    );
    const keys = new Map(
      days.map((day) => [
        day.id,
        `${day.factoryId}|${day.orderRef.trim().toLowerCase()}|${day.styleId}`,
      ])
    );
    const totals = new Map();
    if (keys.size === 0) return totals;
    for (const hour of reader.list("hourlyOutputs", (row) => keys.has(row.productionDayId))) {
      const key = keys.get(hour.productionDayId);
      totals.set(key, (totals.get(key) ?? 0) + (hour.actualPieces ?? 0));
    }
    return totals;
  }

  const producedFor = (index, order, styleId) =>
    index.get(`${order.factoryId}|${order.reference.toLowerCase()}|${styleId}`) ?? 0;

  const companyCurrency = (reader) =>
    reader.list("settings", (row) => row.kind === "profile")[0]?.currency ?? "USD";

  // ---- Views ----------------------------------------------------------------------------------

  function lineView(line, order, look, index) {
    const style = look.styles.get(line.styleId);
    return freeze({
      id: line.id,
      orderId: line.orderId,
      styleId: line.styleId,
      styleCode: style?.code ?? null,
      styleName: style?.name ?? null,
      smv: style?.smv ?? null,
      quantity: line.quantity,
      unitPrice: line.unitPrice ?? null,
      status: line.status,
      cancelReason: line.cancelReason ?? null,
      ...lineProgress(line, producedFor(index, order, line.styleId)),
    });
  }

  function orderRow(order, lines, look, index) {
    const live = lines.filter((line) => line.status !== "cancelled");
    const quantity = live.reduce((sum, line) => sum + line.quantity, 0);
    const produced = live.reduce((sum, line) => sum + producedFor(index, order, line.styleId), 0);
    const priced = live.filter((line) => line.unitPrice !== null && line.unitPrice !== undefined);
    return freeze({
      id: order.id,
      reference: order.reference,
      buyerPo: order.buyerPo ?? null,
      factoryId: order.factoryId,
      factoryName: look.factories.get(order.factoryId)?.name ?? null,
      buyerId: order.buyerId,
      buyerName: look.buyers.get(order.buyerId)?.name ?? null,
      status: order.status,
      cancelReason: order.cancelReason ?? null,
      orderDate: order.orderDate,
      shipDate: order.shipDate,
      currency: order.currency,
      note: order.note ?? null,
      lines: live.length,
      quantity,
      produced,
      percent: quantity === 0 ? null : Math.round((produced / quantity) * 1000) / 10,
      value:
        priced.length === 0
          ? null
          : Math.round(
              priced.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) * 100
            ) / 100,
    });
  }

  function milestoneView(milestone, order, today) {
    return freeze({
      id: milestone.id,
      orderId: milestone.orderId,
      orderReference: order?.reference ?? null,
      orderStatus: order?.status ?? null,
      factoryId: milestone.factoryId,
      code: milestone.code,
      name: milestone.name,
      sequence: milestone.sequence,
      blocking: milestone.blocking === true,
      responsibleRole: milestone.responsibleRole ?? null,
      plannedDate: milestone.plannedDate,
      revisedDate: milestone.revisedDate ?? null,
      revisionReason: milestone.revisionReason ?? null,
      due: dueOf(milestone),
      actualDate: milestone.actualDate ?? null,
      status: milestone.status,
      state: milestoneState(milestone, today),
      note: milestone.note ?? null,
    });
  }

  // What the buyer still owes comes first (the one due soonest on top); decided requests follow, the
  // latest first.
  const waiting = (row) => row.status === "pending" || row.status === "revision_requested";
  function byWaiting(a, b) {
    if (waiting(a) !== waiting(b)) return waiting(a) ? -1 : 1;
    return waiting(a) ? a.dueDate.localeCompare(b.dueDate) : b.dueDate.localeCompare(a.dueDate);
  }

  function approvalView(approval, order, look, names, today) {
    return freeze({
      id: approval.id,
      orderId: approval.orderId,
      orderReference: order?.reference ?? null,
      orderStatus: order?.status ?? null,
      factoryId: approval.factoryId,
      typeId: approval.typeId,
      typeName: approval.typeName,
      blocking: approval.blocking === true,
      status: approval.status,
      dueDate: approval.dueDate,
      overdue: approval.status === "pending" && approval.dueDate < today,
      note: approval.note ?? null,
      requestedBy: names(approval.requestedBy),
      decidedAt: approval.decidedAt ?? null,
      buyerName: look.buyers.get(order?.buyerId)?.name ?? null,
    });
  }

  function bookingView(booking, all, look) {
    const order = look.orders?.get(booking.orderId);
    const conflicts = isActiveBooking(booking.status) ? conflictsOf(booking, all) : [];
    return freeze({
      id: booking.id,
      orderId: booking.orderId,
      orderReference: order?.reference ?? null,
      lineId: booking.lineId,
      styleCode: look.styles.get(booking.styleId)?.code ?? null,
      styleName: look.styles.get(booking.styleId)?.name ?? null,
      factoryId: booking.factoryId,
      factoryName: look.factories.get(booking.factoryId)?.name ?? null,
      productionLineId: booking.productionLineId,
      productionLineName: look.productionLines.get(booking.productionLineId)?.name ?? null,
      shiftId: booking.shiftId ?? null,
      shiftName: look.shifts.get(booking.shiftId)?.name ?? null,
      calendarId: booking.calendarId,
      calendarName: look.calendars.get(booking.calendarId)?.name ?? null,
      startDate: booking.startDate,
      endDate: booking.endDate,
      workingDays: booking.workingDates.length,
      quantity: booking.quantity,
      smv: booking.smv,
      operators: booking.operators,
      efficiency: booking.efficiency,
      hoursPerDay: booking.hoursPerDay,
      requiredMinutes: booking.requiredMinutes,
      dailyCapacityMinutes: booking.dailyCapacityMinutes,
      availableMinutes: booking.availableMinutes,
      utilization: utilization(booking.requiredMinutes, booking.availableMinutes),
      status: booking.status,
      note: booking.note ?? null,
      warnings: freeze({
        overloaded: isActiveBooking(booking.status) && isOverloaded(booking),
        conflicts: freeze(
          conflicts.map((other) =>
            freeze({
              id: other.id,
              orderReference: look.orders?.get(other.orderId)?.reference ?? null,
            })
          )
        ),
      }),
    });
  }

  const bookingsOf = (reader, factoryId) =>
    reader.list(BOOKINGS, (row) => factoryId === undefined || row.factoryId === factoryId);

  // ---- Styles ---------------------------------------------------------------------------------

  // The buyer a style is linked to, when one is given: an active buyer, whose name the style shows.
  function styleBuyer(tx, buyerId) {
    const buyer = requireRow(tx, BUYERS, buyerId, "buyer");
    if (buyer.active === false) throw fail("inactive_parent", "that buyer is inactive");
    return buyer;
  }

  // ---- Order checks ---------------------------------------------------------------------------

  // Moving into production needs every blocking milestone done and every blocking approval granted
  // (D74, D77, D78).
  function requireReadyForProduction(tx, order) {
    const open = tx
      .list(
        MILESTONES,
        (row) => row.orderId === order.id && row.blocking && row.status !== "completed"
      )
      .map((row) => row.name);
    if (open.length > 0) {
      throw fail(
        "blocked_by_milestones",
        `finish the blocking milestones first: ${open.join(", ")}`
      );
    }
    const requested = tx.list(APPROVALS, (row) => row.orderId === order.id && row.blocking);
    const unmet = [...new Set(requested.map((row) => row.typeId))]
      .filter(
        (typeId) => !requested.some((row) => row.typeId === typeId && row.status === "approved")
      )
      .map((typeId) => requested.find((row) => row.typeId === typeId).typeName);
    if (unmet.length > 0) {
      throw fail("blocked_by_approvals", `the buyer has not approved: ${unmet.join(", ")}`);
    }
  }

  return Object.freeze({
    // The factories the caller can see orders of, or (for "manage") place new orders in; the
    // organization service needs a factory permission this role may not hold.
    factories(context, input) {
      const permission = isObject(input) && input.for === "manage" ? MANAGE : VIEW;
      const resolved = gate.requireTenant(context, permission);
      return Object.freeze(
        sessionFor(resolved)
          .list(
            "factories",
            (row) =>
              allowed(resolved, permission, row.id) && (permission === VIEW || row.active !== false)
          )
          .sort(byName)
          .map((row) => freeze({ id: row.id, code: row.code, name: row.name }))
      );
    },

    // ---- Buyers (D73) -------------------------------------------------------------------------

    buyers(context) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const styles = session.list(STYLES);
      const orders = session.list(ORDERS, (row) => allowed(resolved, VIEW, row.factoryId));
      return Object.freeze(
        session
          .list(BUYERS)
          .sort(byName)
          .map((row) =>
            freeze({
              ...row,
              styles: styles.filter((style) => style.buyerId === row.id).length,
              orders: orders.filter((order) => order.buyerId === row.id).length,
            })
          )
      );
    },

    createBuyer(context, input) {
      const resolved = masterWrite(context, MANAGE);
      const values = buildBuyer(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => freeze(tx.insert(BUYERS, values)));
    },

    updateBuyer(context, id, patch) {
      const resolved = masterWrite(context, MANAGE);
      const values = changeBuyer(isObject(patch) ? patch : {});
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, BUYERS, id, "buyer");
        const updated = tx.update(BUYERS, row.id, values);
        // Styles linked to the buyer show its name.
        if (values.name !== undefined) {
          for (const style of tx.list(STYLES, (other) => other.buyerId === row.id)) {
            tx.update(STYLES, style.id, { buyer: values.name });
          }
        }
        return freeze(updated);
      });
    },

    setBuyerActive(context, id, active) {
      const resolved = masterWrite(context, MANAGE);
      if (typeof active !== "boolean") throw fail("invalid_field", "active must be true or false");
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, BUYERS, id, "buyer");
        return freeze(tx.update(BUYERS, row.id, { active }));
      });
    },

    removeBuyer(context, id) {
      const resolved = masterWrite(context, MANAGE);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, BUYERS, id, "buyer");
        const used =
          tx.list(STYLES, (other) => other.buyerId === row.id).length > 0 ||
          tx.list(ORDERS, (other) => other.buyerId === row.id).length > 0;
        if (used)
          throw fail("referenced", "styles or orders use this buyer; deactivate it instead");
        return freeze(tx.remove(BUYERS, row.id));
      });
    },

    // ---- Styles and SMV (D73) -----------------------------------------------------------------

    styles(context) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const look = { buyers: idMap(session.list(BUYERS)) };
      const lines = session.list(LINES);
      return Object.freeze(
        session
          .list(STYLES)
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((row) =>
            freeze({
              id: row.id,
              code: row.code,
              name: row.name,
              buyerId: row.buyerId ?? null,
              buyer: look.buyers.get(row.buyerId)?.name ?? row.buyer ?? null,
              smv: row.smv,
              plans: session.list("productionPlans", (plan) => plan.styleId === row.id).length,
              lines: lines.filter((line) => line.styleId === row.id).length,
            })
          )
      );
    },

    createStyle(context, input) {
      const resolved = masterWrite(context, MANAGE);
      const fields = isObject(input) ? input : {};
      const values = buildStyle(fields);
      return sessionFor(resolved).transaction((tx) => {
        let buyerId = null;
        if (!blank(fields.buyerId)) {
          const buyer = styleBuyer(tx, fields.buyerId);
          buyerId = buyer.id;
          values.buyer = buyer.name;
        }
        return freeze(tx.insert(STYLES, { ...values, buyerId }));
      });
    },

    updateStyle(context, id, patch) {
      const resolved = masterWrite(context, MANAGE);
      const fields = isObject(patch) ? patch : {};
      const values = changeStyle(fields);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, STYLES, id, "style");
        const linkedNow = row.buyerId ?? null;
        if (fields.buyerId !== undefined) {
          if (blank(fields.buyerId)) {
            values.buyerId = null;
          } else {
            const buyer = styleBuyer(tx, fields.buyerId);
            const used = tx
              .list(LINES, (line) => line.styleId === row.id)
              .some((line) => tx.get(ORDERS, line.orderId)?.buyerId !== buyer.id);
            if (used) {
              throw fail("buyer_in_use", "this style is on another buyer's order; it cannot move");
            }
            values.buyerId = buyer.id;
            values.buyer = buyer.name;
          }
        } else if (linkedNow !== null && values.buyer !== undefined && values.buyer !== row.buyer) {
          throw fail("buyer_linked", "change the buyer by choosing another buyer");
        }
        return freeze(tx.update(STYLES, row.id, values));
      });
    },

    // ---- Orders (D74, D75) --------------------------------------------------------------------

    orders(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { factoryId, buyerId, status } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const index = producedIndex(session);
      const lines = session.list(LINES);
      return Object.freeze(
        session
          .list(
            ORDERS,
            (row) =>
              allowed(resolved, VIEW, row.factoryId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (buyerId === undefined || row.buyerId === buyerId) &&
              (status === undefined || row.status === status)
          )
          .sort(
            (a, b) => a.shipDate.localeCompare(b.shipDate) || a.reference.localeCompare(b.reference)
          )
          .map((row) =>
            orderRow(
              row,
              lines.filter((line) => line.orderId === row.id),
              look,
              index
            )
          )
      );
    },

    // The order with its lines and progress, milestones, approvals and bookings, and what the
    // caller may do to it (the screens only offer these; every call checks again).
    order(context, id) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const order = orderFor(session, resolved, id);
      const look = { ...lookups(session), orders: new Map([[order.id, order]]) };
      const index = producedIndex(session);
      const names = nameOf(resolved);
      const lines = session.list(LINES, (row) => row.orderId === order.id);
      const milestones = session
        .list(MILESTONES, (row) => row.orderId === order.id)
        .sort((a, b) => a.sequence - b.sequence || a.code.localeCompare(b.code));
      const approvals = session
        .list(APPROVALS, (row) => row.orderId === order.id)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.typeName.localeCompare(b.typeName));
      const factoryBookings = bookingsOf(session, order.factoryId);
      const bookings = factoryBookings
        .filter((row) => row.orderId === order.id)
        .sort((a, b) => a.startDate.localeCompare(b.startDate));
      look.orders = idMap(session.list(ORDERS, (row) => row.factoryId === order.factoryId));
      const factory = order.factoryId;
      const may = (permission) => allowed(resolved, permission, factory);
      return freeze({
        order: orderRow(order, lines, look, index),
        lines: Object.freeze(
          lines
            .sort((a, b) =>
              (look.styles.get(a.styleId)?.code ?? "").localeCompare(
                look.styles.get(b.styleId)?.code ?? ""
              )
            )
            .map((line) => lineView(line, order, look, index))
        ),
        milestones: Object.freeze(
          milestones.map((row) => milestoneView(row, order, resolved.today))
        ),
        approvals: Object.freeze(
          approvals.map((row) => approvalView(row, order, look, names, resolved.today))
        ),
        bookings: Object.freeze(bookings.map((row) => bookingView(row, factoryBookings, look))),
        next: nextOrderStatus(order.status),
        editable: isActiveOrder(order.status),
        open: order.status !== "closed" && order.status !== "cancelled",
        locked: LOCKED_ORDER_STATUSES.includes(order.status),
        may: freeze({
          manage: may(MANAGE),
          planning: may(PLANNING),
          decide: may(DECIDE),
          capacity: may(CAPACITY),
        }),
      });
    },

    createOrder(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const factory = requireRow(tx, "factories", fields.factoryId, "factory");
        gate.authorize(resolved, MANAGE, { factoryId: factory.id });
        if (factory.active === false) throw fail("inactive_parent", "that factory is inactive");
        const buyer = requireRow(tx, BUYERS, fields.buyerId, "buyer");
        if (buyer.active === false) throw fail("inactive_parent", "that buyer is inactive");
        const values = buildOrder(fields, companyCurrency(tx));
        return freeze(
          tx.insert(ORDERS, {
            ...values,
            referenceKey: values.reference,
            buyerPoKey: values.buyerPo === null ? null : values.buyerPo.toLowerCase(),
            factoryId: factory.id,
            buyerId: buyer.id,
            status: "draft",
            cancelReason: null,
          })
        );
      });
    },

    updateOrder(context, id, patch) {
      const resolved = gate.requireTenant(context, MANAGE);
      const fields = isObject(patch) ? patch : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = orderFor(tx, resolved, id, MANAGE);
        for (const field of ["factoryId", "buyerId", "reference", "status", "cancelReason"]) {
          if (fields[field] !== undefined) {
            throw fail("immutable_field", `${field} cannot be edited here`);
          }
        }
        requireActive(row);
        const values = changeOrder(fields, row);
        if (values.buyerPo !== undefined) {
          values.buyerPoKey = values.buyerPo === null ? null : values.buyerPo.toLowerCase();
        }
        return freeze(tx.update(ORDERS, row.id, values));
      });
    },

    // One step along the chain, or cancel with a reason (D74). Cancelling also cancels the open
    // lines and the planned or confirmed bookings (D75).
    setOrderStatus(context, id, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = orderFor(tx, resolved, id, MANAGE);
        const next = requireOrderTransition(row.status, request.status, request.reason);
        if (next.status === "in_production") requireReadyForProduction(tx, row);
        if (
          next.status === "confirmed" &&
          tx.list(LINES, (line) => line.orderId === row.id && line.status !== "cancelled")
            .length === 0
        ) {
          throw fail("no_lines", "add at least one line before confirming the order");
        }
        tx.update(ORDERS, row.id, next);
        if (next.status === "cancelled") {
          for (const line of tx.list(
            LINES,
            (other) => other.orderId === row.id && other.status === "open"
          )) {
            tx.update(LINES, line.id, { status: "cancelled", cancelReason: "Order cancelled" });
          }
          for (const booking of tx.list(
            BOOKINGS,
            (other) => other.orderId === row.id && isActiveBooking(other.status)
          )) {
            tx.update(BOOKINGS, booking.id, { status: "cancelled" });
          }
        }
        tx.record({
          action: "order_status_changed",
          entityType: ORDERS,
          entityId: row.id,
          changes: { status: { before: row.status, after: next.status } },
        });
        return freeze(tx.get(ORDERS, row.id));
      });
    },

    removeOrder(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      return sessionFor(resolved).transaction((tx) => {
        const row = orderFor(tx, resolved, id, MANAGE);
        if (row.status !== "draft") {
          throw fail("order_locked", "only a draft order can be deleted; cancel it instead");
        }
        const used = [LINES, MILESTONES, APPROVALS, BOOKINGS].some(
          (collection) => tx.list(collection, (other) => other.orderId === row.id).length > 0
        );
        if (used) throw fail("referenced", "it has lines or planning; cancel it instead");
        return freeze(tx.remove(ORDERS, row.id));
      });
    },

    // ---- Order lines (D74) --------------------------------------------------------------------

    addLine(context, orderId, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const order = orderFor(tx, resolved, orderId, MANAGE);
        requireActive(order);
        const style = requireRow(tx, STYLES, fields.styleId, "style");
        if (
          style.buyerId !== undefined &&
          style.buyerId !== null &&
          style.buyerId !== order.buyerId
        ) {
          throw fail("style_buyer_mismatch", "that style belongs to another buyer");
        }
        const values = buildLine(fields);
        return freeze(
          tx.insert(LINES, {
            ...values,
            orderId: order.id,
            factoryId: order.factoryId,
            styleId: style.id,
            status: "open",
            cancelReason: null,
          })
        );
      });
    },

    updateLine(context, id, patch) {
      const resolved = gate.requireTenant(context, MANAGE);
      const fields = isObject(patch) ? patch : {};
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, LINES, id, "line");
        const order = orderFor(tx, resolved, line.orderId, MANAGE);
        for (const field of ["orderId", "styleId", "status", "cancelReason"]) {
          if (fields[field] !== undefined) {
            throw fail("immutable_field", `${field} cannot be edited here`);
          }
        }
        requireActive(order);
        if (line.status !== "open")
          throw fail("line_locked", "a completed or cancelled line is locked");
        return freeze(tx.update(LINES, line.id, changeLine(fields)));
      });
    },

    // Completed, or cancelled with a reason; both lock the line (D75).
    setLineStatus(context, id, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, LINES, id, "line");
        const order = orderFor(tx, resolved, line.orderId, MANAGE);
        requireActive(order);
        if (line.status !== "open")
          throw fail("line_locked", "a completed or cancelled line is locked");
        const next = requireLineStatus(request.status, request.reason);
        if (next.status === "open") throw fail("invalid_status", "the line is already open");
        tx.update(LINES, line.id, next);
        if (next.status === "cancelled") {
          for (const booking of tx.list(
            BOOKINGS,
            (other) => other.lineId === line.id && isActiveBooking(other.status)
          )) {
            tx.update(BOOKINGS, booking.id, { status: "cancelled" });
          }
        }
        return freeze(tx.get(LINES, line.id));
      });
    },

    removeLine(context, id) {
      const resolved = gate.requireTenant(context, MANAGE);
      return sessionFor(resolved).transaction((tx) => {
        const line = requireRow(tx, LINES, id, "line");
        const order = orderFor(tx, resolved, line.orderId, MANAGE);
        if (order.status !== "draft") {
          throw fail(
            "order_locked",
            "lines are removed only while the order is a draft; cancel the line instead"
          );
        }
        if (tx.list(BOOKINGS, (other) => other.lineId === line.id).length > 0) {
          throw fail("referenced", "a capacity booking uses this line");
        }
        return freeze(tx.remove(LINES, line.id));
      });
    },

    // ---- Time-and-action templates (D77) ------------------------------------------------------

    templates(context) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const definitions = session.list(DEFINITIONS);
      const milestones = session.list(MILESTONES);
      return Object.freeze(
        session
          .list(TEMPLATES)
          .sort(byName)
          .map((row) =>
            freeze({
              ...row,
              definitions: Object.freeze(
                definitions
                  .filter((definition) => definition.templateId === row.id)
                  .sort((a, b) => a.sequence - b.sequence || a.code.localeCompare(b.code))
                  .map((definition) =>
                    freeze({
                      ...definition,
                      uses: milestones.filter((m) => m.definitionId === definition.id).length,
                    })
                  )
              ),
            })
          )
      );
    },

    createTemplate(context, input) {
      const resolved = masterWrite(context, PLANNING);
      const values = buildTemplate(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => freeze(tx.insert(TEMPLATES, values)));
    },

    updateTemplate(context, id, patch) {
      const resolved = masterWrite(context, PLANNING);
      const values = changeTemplate(isObject(patch) ? patch : {});
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, TEMPLATES, id, "template");
        return freeze(tx.update(TEMPLATES, row.id, values));
      });
    },

    setTemplateActive(context, id, active) {
      const resolved = masterWrite(context, PLANNING);
      if (typeof active !== "boolean") throw fail("invalid_field", "active must be true or false");
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, TEMPLATES, id, "template");
        return freeze(tx.update(TEMPLATES, row.id, { active }));
      });
    },

    // A template and its lines go together, unless an order's milestone came from one of them.
    removeTemplate(context, id) {
      const resolved = masterWrite(context, PLANNING);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, TEMPLATES, id, "template");
        const definitions = tx.list(DEFINITIONS, (other) => other.templateId === row.id);
        const ids = new Set(definitions.map((definition) => definition.id));
        if (tx.list(MILESTONES, (other) => ids.has(other.definitionId)).length > 0) {
          throw fail("referenced", "orders use this template; deactivate it instead");
        }
        for (const definition of definitions) tx.remove(DEFINITIONS, definition.id);
        return freeze(tx.remove(TEMPLATES, row.id));
      });
    },

    addDefinition(context, templateId, input) {
      const resolved = masterWrite(context, PLANNING);
      const fields = isObject(input) ? input : {};
      const values = buildDefinition(fields);
      return sessionFor(resolved).transaction((tx) => {
        const template = requireRow(tx, TEMPLATES, templateId, "template");
        const siblings = tx.list(DEFINITIONS, (other) => other.templateId === template.id);
        const sequence = blank(fields.sequence)
          ? Math.max(0, ...siblings.map((other) => other.sequence)) + 10
          : sequenceOf(fields.sequence);
        return freeze(tx.insert(DEFINITIONS, { ...values, templateId: template.id, sequence }));
      });
    },

    updateDefinition(context, id, patch) {
      const resolved = masterWrite(context, PLANNING);
      const fields = isObject(patch) ? patch : {};
      const values = changeDefinition(fields);
      if (fields.sequence !== undefined) values.sequence = sequenceOf(fields.sequence);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, DEFINITIONS, id, "milestone line");
        if (fields.templateId !== undefined) {
          throw fail("immutable_field", "templateId cannot be edited here");
        }
        return freeze(tx.update(DEFINITIONS, row.id, values));
      });
    },

    setDefinitionActive(context, id, active) {
      const resolved = masterWrite(context, PLANNING);
      if (typeof active !== "boolean") throw fail("invalid_field", "active must be true or false");
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, DEFINITIONS, id, "milestone line");
        return freeze(tx.update(DEFINITIONS, row.id, { active }));
      });
    },

    removeDefinition(context, id) {
      const resolved = masterWrite(context, PLANNING);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, DEFINITIONS, id, "milestone line");
        if (tx.list(MILESTONES, (other) => other.definitionId === row.id).length > 0) {
          throw fail("referenced", "orders already use this line; make it inactive instead");
        }
        return freeze(tx.remove(DEFINITIONS, row.id));
      });
    },

    // ---- Milestones (D77) ---------------------------------------------------------------------

    // Open or late milestones across the orders in scope, for the Time and Action board.
    milestones(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { orderId, state, factoryId } = isObject(filter) ? filter : {};
      const orders = idMap(session.list(ORDERS));
      return Object.freeze(
        session
          .list(MILESTONES, (row) => {
            const order = orders.get(row.orderId);
            return (
              order !== undefined &&
              allowed(resolved, VIEW, row.factoryId) &&
              (orderId === undefined || row.orderId === orderId) &&
              (factoryId === undefined || row.factoryId === factoryId)
            );
          })
          .map((row) => milestoneView(row, orders.get(row.orderId), resolved.today))
          .filter((row) => state === undefined || row.state === state)
          .sort((a, b) => a.due.localeCompare(b.due) || a.sequence - b.sequence)
      );
    },

    // Creates the milestones the order is missing; never changes one that exists (D77).
    applyTemplate(context, orderId, templateId) {
      const resolved = gate.requireTenant(context, PLANNING);
      return sessionFor(resolved).transaction((tx) => {
        const order = orderFor(tx, resolved, orderId, PLANNING);
        requireOpen(order);
        const template = requireRow(tx, TEMPLATES, templateId, "template");
        if (template.active === false) throw fail("inactive_parent", "that template is inactive");
        const have = new Set(
          tx.list(MILESTONES, (row) => row.orderId === order.id).map((row) => row.code)
        );
        const created = [];
        let skipped = 0;
        const definitions = tx
          .list(DEFINITIONS, (row) => row.templateId === template.id && row.active !== false)
          .sort((a, b) => a.sequence - b.sequence);
        for (const definition of definitions) {
          if (have.has(definition.code)) {
            skipped += 1;
            continue;
          }
          created.push(
            tx.insert(MILESTONES, {
              ...milestoneFromDefinition(definition, order.orderDate),
              orderId: order.id,
              factoryId: order.factoryId,
              revisedDate: null,
              revisionReason: null,
              actualDate: null,
              status: "not_started",
              note: null,
            })
          );
        }
        tx.record({
          action: "tna_template_applied",
          entityType: ORDERS,
          entityId: order.id,
          changes: { template: { before: null, after: template.name } },
        });
        return freeze({ created: created.length, skipped });
      });
    },

    addMilestone(context, orderId, input) {
      const resolved = gate.requireTenant(context, PLANNING);
      const fields = isObject(input) ? input : {};
      const values = buildMilestone(fields);
      return sessionFor(resolved).transaction((tx) => {
        const order = orderFor(tx, resolved, orderId, PLANNING);
        requireOpen(order);
        const siblings = tx.list(MILESTONES, (row) => row.orderId === order.id);
        return freeze(
          tx.insert(MILESTONES, {
            ...values,
            definitionId: null,
            sequence: Math.max(0, ...siblings.map((row) => row.sequence)) + 10,
            orderId: order.id,
            factoryId: order.factoryId,
            revisedDate: null,
            revisionReason: null,
            actualDate: null,
            status: "not_started",
          })
        );
      });
    },

    // A new date for the milestone, with the reason; the planned date stays as history (D77).
    reviseMilestone(context, id, input) {
      const resolved = gate.requireTenant(context, PLANNING);
      const values = reviseDate(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, MILESTONES, id, "milestone");
        const order = orderFor(tx, resolved, row.orderId, PLANNING);
        requireOpen(order);
        if (row.status === "completed") {
          throw fail("milestone_locked", "a completed milestone cannot be changed");
        }
        return freeze(tx.update(MILESTONES, row.id, values));
      });
    },

    setMilestoneStatus(context, id, input) {
      const resolved = gate.requireTenant(context, PLANNING);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, MILESTONES, id, "milestone");
        const order = orderFor(tx, resolved, row.orderId, PLANNING);
        requireOpen(order);
        if (row.status === "completed") {
          throw fail("milestone_locked", "a completed milestone cannot be changed");
        }
        const status = requireManualMilestoneStatus(request.status);
        return freeze(tx.update(MILESTONES, row.id, { status }));
      });
    },

    // Completing needs every earlier blocking milestone of the order done (D77).
    completeMilestone(context, id, input) {
      const resolved = gate.requireTenant(context, PLANNING);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, MILESTONES, id, "milestone");
        const order = orderFor(tx, resolved, row.orderId, PLANNING);
        requireOpen(order);
        if (row.status === "completed") {
          throw fail("milestone_locked", "that milestone is already complete");
        }
        const actualDate = blank(request.actualDate)
          ? resolved.today
          : validateDate(request.actualDate);
        if (actualDate > resolved.today) {
          throw fail("future_date", `it cannot be completed after today (${resolved.today})`);
        }
        if (actualDate < order.orderDate) {
          throw fail("invalid_date", "it cannot be completed before the order date");
        }
        const earlier = tx
          .list(
            MILESTONES,
            (other) =>
              other.orderId === order.id &&
              other.id !== row.id &&
              other.blocking &&
              other.status !== "completed" &&
              other.sequence < row.sequence
          )
          .map((other) => other.name);
        if (earlier.length > 0) {
          throw fail("blocked_by_milestones", `finish these first: ${earlier.join(", ")}`);
        }
        tx.update(MILESTONES, row.id, { status: "completed", actualDate });
        tx.record({
          action: "milestone_completed",
          entityType: MILESTONES,
          entityId: row.id,
          changes: { actualDate: { before: null, after: actualDate } },
        });
        return freeze(tx.get(MILESTONES, row.id));
      });
    },

    removeMilestone(context, id) {
      const resolved = gate.requireTenant(context, PLANNING);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, MILESTONES, id, "milestone");
        const order = orderFor(tx, resolved, row.orderId, PLANNING);
        requireOpen(order);
        if (row.status === "completed") {
          throw fail("milestone_locked", "a completed milestone cannot be removed");
        }
        return freeze(tx.remove(MILESTONES, row.id));
      });
    },

    // ---- Buyer approvals (D78) ----------------------------------------------------------------

    approvalTypes(context) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const approvals = session.list(APPROVALS);
      return Object.freeze(
        session
          .list(APPROVAL_TYPES)
          .sort(byName)
          .map((row) =>
            freeze({ ...row, requests: approvals.filter((a) => a.typeId === row.id).length })
          )
      );
    },

    createApprovalType(context, input) {
      const resolved = masterWrite(context, PLANNING);
      const values = buildApprovalType(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => freeze(tx.insert(APPROVAL_TYPES, values)));
    },

    updateApprovalType(context, id, patch) {
      const resolved = masterWrite(context, PLANNING);
      const values = changeApprovalType(isObject(patch) ? patch : {});
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, APPROVAL_TYPES, id, "approval type");
        return freeze(tx.update(APPROVAL_TYPES, row.id, values));
      });
    },

    setApprovalTypeActive(context, id, active) {
      const resolved = masterWrite(context, PLANNING);
      if (typeof active !== "boolean") throw fail("invalid_field", "active must be true or false");
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, APPROVAL_TYPES, id, "approval type");
        return freeze(tx.update(APPROVAL_TYPES, row.id, { active }));
      });
    },

    removeApprovalType(context, id) {
      const resolved = masterWrite(context, PLANNING);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, APPROVAL_TYPES, id, "approval type");
        if (tx.list(APPROVALS, (other) => other.typeId === row.id).length > 0) {
          throw fail("referenced", "orders use this approval; deactivate it instead");
        }
        return freeze(tx.remove(APPROVAL_TYPES, row.id));
      });
    },

    approvals(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { orderId, status, factoryId } = isObject(filter) ? filter : {};
      const look = lookups(session);
      const orders = idMap(session.list(ORDERS));
      const names = nameOf(resolved);
      return Object.freeze(
        session
          .list(
            APPROVALS,
            (row) =>
              orders.has(row.orderId) &&
              allowed(resolved, VIEW, row.factoryId) &&
              (orderId === undefined || row.orderId === orderId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (status === undefined || row.status === status)
          )
          .map((row) => approvalView(row, orders.get(row.orderId), look, names, resolved.today))
          .sort(byWaiting)
      );
    },

    requestApproval(context, orderId, input) {
      const resolved = gate.requireTenant(context, PLANNING);
      const fields = isObject(input) ? input : {};
      const values = buildRequest(fields);
      return sessionFor(resolved).transaction((tx) => {
        const order = orderFor(tx, resolved, orderId, PLANNING);
        requireOpen(order);
        const type = requireRow(tx, APPROVAL_TYPES, fields.typeId, "approval type");
        if (type.active === false) throw fail("inactive_parent", "that approval type is inactive");
        const standing = tx.list(
          APPROVALS,
          (row) => row.orderId === order.id && row.typeId === type.id && row.status !== "rejected"
        );
        if (standing.length > 0) {
          throw fail("duplicate", "that approval is already requested for this order");
        }
        const approval = tx.insert(APPROVALS, {
          ...values,
          orderId: order.id,
          factoryId: order.factoryId,
          typeId: type.id,
          typeName: type.name,
          blocking: type.blocking === true,
          status: "pending",
          requestedBy: resolved.user.id,
          decidedAt: null,
        });
        tx.insert(DECISIONS, {
          approvalId: approval.id,
          orderId: order.id,
          sequence: 1,
          decision: "requested",
          remarks: values.note,
          actorId: resolved.user.id,
          at: clock(),
        });
        return freeze(approval);
      });
    },

    // After the buyer asked for a revision: back to pending with a new due date.
    resubmitApproval(context, id, input) {
      const resolved = gate.requireTenant(context, PLANNING);
      const values = buildRequest(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, APPROVALS, id, "approval");
        const order = orderFor(tx, resolved, row.orderId, PLANNING);
        requireOpen(order);
        requireResubmittable(row);
        tx.update(APPROVALS, row.id, {
          status: "pending",
          dueDate: values.dueDate,
          decidedAt: null,
        });
        tx.insert(DECISIONS, {
          approvalId: row.id,
          orderId: order.id,
          sequence: tx.list(DECISIONS, (d) => d.approvalId === row.id).length + 1,
          decision: "resubmitted",
          remarks: values.note,
          actorId: resolved.user.id,
          at: clock(),
        });
        return freeze(tx.get(APPROVALS, row.id));
      });
    },

    // The buyer's decision, entered by someone allowed to; never edited afterwards (D78).
    decideApproval(context, id, input) {
      const resolved = gate.requireTenant(context, DECIDE);
      const values = validateDecision(isObject(input) ? input : {});
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, APPROVALS, id, "approval");
        const order = orderFor(tx, resolved, row.orderId, DECIDE);
        requireOpen(order);
        requireDecidable(row);
        tx.update(APPROVALS, row.id, { status: values.decision, decidedAt: clock() });
        tx.insert(DECISIONS, {
          approvalId: row.id,
          orderId: order.id,
          sequence: tx.list(DECISIONS, (d) => d.approvalId === row.id).length + 1,
          decision: values.decision,
          remarks: values.remarks,
          actorId: resolved.user.id,
          at: clock(),
        });
        tx.record({
          action: "approval_decided",
          entityType: APPROVALS,
          entityId: row.id,
          changes: { status: { before: row.status, after: values.decision } },
        });
        return freeze(tx.get(APPROVALS, row.id));
      });
    },

    approvalHistory(context, id) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const row = requireRow(session, APPROVALS, id, "approval");
      gate.authorize(resolved, VIEW, { factoryId: row.factoryId });
      const names = nameOf(resolved);
      return Object.freeze(
        session
          .list(DECISIONS, (entry) => entry.approvalId === row.id)
          .sort((a, b) => a.sequence - b.sequence)
          .map((entry) =>
            freeze({
              sequence: entry.sequence,
              decision: entry.decision,
              remarks: entry.remarks ?? null,
              by: names(entry.actorId),
              at: entry.at,
            })
          )
      );
    },

    // ---- Capacity bookings (D79, D80) ---------------------------------------------------------

    // The production lines, shifts and calendars of a factory that a booking can use.
    planningOptions(context, input) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const factoryId = isObject(input) ? input.factoryId : undefined;
      const factory = requireRow(session, "factories", factoryId, "factory");
      gate.authorize(resolved, VIEW, { factoryId: factory.id });
      const sections = idMap(session.list("sections", (row) => row.factoryId === factory.id));
      const pick = (rows) => rows.filter((row) => row.active !== false);
      return freeze({
        lines: Object.freeze(
          pick(session.list("lines", (row) => row.factoryId === factory.id))
            .sort(byName)
            .map((row) =>
              freeze({
                id: row.id,
                name: row.name,
                sectionName: sections.get(row.sectionId)?.name ?? null,
              })
            )
        ),
        shifts: Object.freeze(
          pick(session.list("shifts", (row) => row.factoryId === factory.id))
            .sort(byName)
            .map((row) => freeze({ id: row.id, name: row.name }))
        ),
        calendars: Object.freeze(
          pick(session.list("calendars", (row) => row.factoryId === factory.id))
            .sort(byName)
            .map((row) => freeze({ id: row.id, name: row.name }))
        ),
      });
    },

    bookings(context, filter) {
      const resolved = gate.requireTenant(context, VIEW);
      const session = sessionFor(resolved);
      const { orderId, factoryId, status } = isObject(filter) ? filter : {};
      const look = { ...lookups(session), orders: idMap(session.list(ORDERS)) };
      const all = session.list(BOOKINGS);
      return Object.freeze(
        all
          .filter(
            (row) =>
              allowed(resolved, VIEW, row.factoryId) &&
              (orderId === undefined || row.orderId === orderId) &&
              (factoryId === undefined || row.factoryId === factoryId) &&
              (status === undefined || row.status === status)
          )
          .sort((a, b) => a.startDate.localeCompare(b.startDate))
          .map((row) => bookingView(row, all, look))
      );
    },

    createBooking(context, input) {
      const resolved = gate.requireTenant(context, CAPACITY);
      const fields = isObject(input) ? input : {};
      const own = buildBooking(fields);
      return sessionFor(resolved).transaction((tx) => {
        const order = orderFor(tx, resolved, fields.orderId, CAPACITY);
        requireActive(order);
        const line = requireRow(tx, LINES, fields.lineId, "order line");
        if (line.orderId !== order.id) throw fail("not_found", "that line is not on this order");
        if (line.status !== "open")
          throw fail("line_locked", "a completed or cancelled line cannot be booked");
        const style = requireRow(tx, STYLES, line.styleId, "style");
        const productionLine = requireRow(tx, "lines", fields.productionLineId, "production line");
        if (productionLine.factoryId !== order.factoryId || productionLine.active === false) {
          throw fail("cross_factory", "choose an active line of the order's factory");
        }
        let shiftId = null;
        if (!blank(fields.shiftId)) {
          const shift = requireRow(tx, "shifts", fields.shiftId, "shift");
          if (shift.factoryId !== order.factoryId || shift.active === false) {
            throw fail("cross_factory", "choose an active shift of the order's factory");
          }
          shiftId = shift.id;
        }
        const calendar = requireRow(tx, "calendars", fields.calendarId, "calendar");
        if (calendar.factoryId !== order.factoryId || calendar.active === false) {
          throw fail("cross_factory", "choose an active calendar of the order's factory");
        }
        const exceptions = tx.list("calendarExceptions", (row) => row.calendarId === calendar.id);
        const workingDates = workingDatesBetween(calendar, exceptions, own.startDate, own.endDate);
        const snapshot = {
          quantity: line.quantity,
          smv: style.smv,
          operators: own.operators,
          efficiency: own.efficiency,
          hoursPerDay: own.hoursPerDay,
        };
        const booking = tx.insert(BOOKINGS, {
          ...own,
          orderId: order.id,
          lineId: line.id,
          styleId: style.id,
          factoryId: order.factoryId,
          productionLineId: productionLine.id,
          shiftId,
          calendarId: calendar.id,
          workingDates,
          ...snapshot,
          ...bookingFigures({ ...snapshot, workingDates }),
          status: "planned",
        });
        const look = { ...lookups(tx), orders: idMap(tx.list(ORDERS)) };
        return bookingView(booking, bookingsOf(tx, order.factoryId), look);
      });
    },

    // Only the dates change; the assumptions captured at creation stay (D79).
    rescheduleBooking(context, id, input) {
      const resolved = gate.requireTenant(context, CAPACITY);
      const fields = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, BOOKINGS, id, "booking");
        const order = orderFor(tx, resolved, row.orderId, CAPACITY);
        requireActive(order);
        if (!isActiveBooking(row.status)) {
          throw fail("booking_locked", "a completed or cancelled booking is locked");
        }
        validateBookingRange(fields.startDate, fields.endDate);
        const calendar = requireRow(tx, "calendars", row.calendarId, "calendar");
        const exceptions = tx.list(
          "calendarExceptions",
          (other) => other.calendarId === calendar.id
        );
        const workingDates = workingDatesBetween(
          calendar,
          exceptions,
          fields.startDate,
          fields.endDate
        );
        const updated = tx.update(BOOKINGS, row.id, {
          startDate: fields.startDate,
          endDate: fields.endDate,
          workingDates,
          ...bookingFigures({ ...row, workingDates }),
        });
        const look = { ...lookups(tx), orders: idMap(tx.list(ORDERS)) };
        return bookingView(updated, bookingsOf(tx, order.factoryId), look);
      });
    },

    // planned -> confirmed -> completed, or cancelled from planned or confirmed (D79).
    setBookingStatus(context, id, input) {
      const resolved = gate.requireTenant(context, CAPACITY);
      const status = isObject(input) ? input.status : undefined;
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, BOOKINGS, id, "booking");
        const order = orderFor(tx, resolved, row.orderId, CAPACITY);
        if (!BOOKING_STATUSES.includes(status)) {
          throw fail("invalid_status", `${String(status)} is not a booking status`);
        }
        if (!isActiveBooking(row.status)) {
          throw fail("booking_locked", "a completed or cancelled booking is locked");
        }
        const legal =
          status === "cancelled" ||
          status === "completed" ||
          (status === "confirmed" && row.status === "planned");
        if (!legal || status === row.status) {
          throw fail("invalid_transition", `a ${row.status} booking cannot become ${status}`);
        }
        // Only an order still being worked takes a new commitment; finishing or cancelling is always fine.
        if (status === "confirmed") requireActive(order);
        tx.update(BOOKINGS, row.id, { status });
        tx.record({
          action: "capacity_booking_status_changed",
          entityType: BOOKINGS,
          entityId: row.id,
          changes: { status: { before: row.status, after: status } },
        });
        return freeze(tx.get(BOOKINGS, row.id));
      });
    },

    removeBooking(context, id) {
      const resolved = gate.requireTenant(context, CAPACITY);
      return sessionFor(resolved).transaction((tx) => {
        const row = requireRow(tx, BOOKINGS, id, "booking");
        orderFor(tx, resolved, row.orderId, CAPACITY);
        if (row.status !== "planned" && row.status !== "cancelled") {
          throw fail("booking_locked", "only a planned or cancelled booking can be deleted");
        }
        return freeze(tx.remove(BOOKINGS, row.id));
      });
    },

    // The loading of each production line for a period: the active bookings that touch it, the
    // minutes they need and have in it, and the warnings (D80).
    loading(context, input) {
      const resolved = gate.requireTenant(context, VIEW);
      const request = isObject(input) ? input : {};
      const from = blank(request.from) ? resolved.today : validateDate(request.from);
      const to = blank(request.to) ? addDays(from, 27) : validateDate(request.to);
      if (to < from) throw fail("invalid_dates", "the period ends before it starts");
      if (addDays(from, MAX_BOOKING_DAYS - 1) < to) {
        throw fail("invalid_dates", `a period covers at most ${MAX_BOOKING_DAYS} days`);
      }
      const session = sessionFor(resolved);
      const look = { ...lookups(session), orders: idMap(session.list(ORDERS)) };
      const all = session.list(BOOKINGS);
      const groups = new Map();
      for (const booking of all) {
        if (
          !isActiveBooking(booking.status) ||
          !allowed(resolved, VIEW, booking.factoryId) ||
          (request.factoryId !== undefined && booking.factoryId !== request.factoryId)
        ) {
          continue;
        }
        const load = loadIn(booking, from, to);
        if (load.days === 0) continue;
        if (!groups.has(booking.productionLineId)) groups.set(booking.productionLineId, []);
        groups.get(booking.productionLineId).push({ booking, load });
      }
      const rows = [...groups.entries()].map(([lineId, entries]) => {
        const line = look.productionLines.get(lineId);
        const requiredMinutes =
          Math.round(entries.reduce((s, e) => s + e.load.requiredMinutes, 0) * 100) / 100;
        const availableMinutes =
          Math.round(entries.reduce((s, e) => s + e.load.availableMinutes, 0) * 100) / 100;
        const items = entries
          .map(({ booking, load }) => {
            const view = bookingView(booking, all, look);
            return freeze({
              id: booking.id,
              orderId: booking.orderId,
              orderReference: view.orderReference,
              styleCode: view.styleCode,
              shiftName: view.shiftName,
              status: booking.status,
              days: load.days,
              requiredMinutes: load.requiredMinutes,
              availableMinutes: load.availableMinutes,
              utilization: utilization(load.requiredMinutes, load.availableMinutes),
              overloaded: load.requiredMinutes > load.availableMinutes,
              conflicts: view.warnings.conflicts.length,
            });
          })
          .sort((a, b) => a.orderReference.localeCompare(b.orderReference));
        return freeze({
          lineId,
          lineName: line?.name ?? null,
          sectionName: look.sections.get(line?.sectionId)?.name ?? null,
          factoryId: line?.factoryId ?? null,
          factoryName: look.factories.get(line?.factoryId)?.name ?? null,
          bookings: Object.freeze(items),
          requiredMinutes,
          availableMinutes,
          utilization: utilization(requiredMinutes, availableMinutes),
          overloaded: requiredMinutes > availableMinutes,
          conflicts: items.filter((item) => item.conflicts > 0).length,
        });
      });
      rows.sort(
        (a, b) =>
          (a.factoryName ?? "").localeCompare(b.factoryName ?? "") ||
          (a.lineName ?? "").localeCompare(b.lineName ?? "")
      );
      return freeze({
        from,
        to,
        rows: Object.freeze(rows),
        activeStatuses: ACTIVE_BOOKING_STATUSES,
      });
    },
  });
}
