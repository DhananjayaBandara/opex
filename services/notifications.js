// The notification centre (C131 to C134; decisions D61 to D65): a member's own notifications and
// preferences, an organization's templates and the delivery history.
//
// Nothing here creates a notification: only the notifier does, inside the transaction of the event
// that causes it (services/notifier.js). A member reads and marks their own, and no call accepts a
// user id, so one member can never reach another's. Support access has no centre of its own.
// Browser-safe: no Node imports.
import {
  CATEGORIES,
  CHANNELS,
  CHANNEL_LABELS,
  DELIVERY_STATUSES,
  FAILURE_TEXT,
  NOTIFICATION_TYPES,
  TYPE_KEYS,
  builtInTemplate,
  effectiveChannels,
  requireChannel,
  requireType,
  validateTemplate,
} from "../domain/notifications.js";
import { fail } from "./errors.js";

const MANAGE_TEMPLATES = "notification_template.manage";
const VIEW_DELIVERIES = "delivery.view";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const forbidden = () => fail("forbidden", "you do not have access to that");
const notFound = () => fail("not_found", "that notification was not found");

function readLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw fail("invalid_limit", `a page is 1 to ${MAX_LIMIT} items`);
  }
  return value;
}

function readCategory(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !Object.hasOwn(CATEGORIES, value)) {
    throw fail("invalid_filter", `category must be one of ${Object.keys(CATEGORIES).join(", ")}`);
  }
  return value;
}

export function createNotifications({ store, gate, clock }) {
  const tenantSession = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  // A member's own centre: a tenant context that is not a support one.
  function member(context) {
    const resolved = gate.requireTenant(context);
    if (resolved.support !== undefined) throw forbidden();
    return resolved;
  }

  // Own, in-app and from a factory the member's scope still covers (D61).
  const shownTo = (resolved, row) =>
    row.userId === resolved.user.id &&
    row.inApp === true &&
    (row.factoryId === null || gate.inFactoryScope(resolved, row.factoryId));

  const rowOf = (reader, resolved, notificationId) => {
    const row =
      typeof notificationId === "string" ? reader.get("notifications", notificationId) : null;
    if (row === null || !shownTo(resolved, row)) throw notFound();
    return row;
  };

  // Where a notification leads, returned only when the member could open the target now (D61). The
  // service describes the target; the screen decides how to draw its address.
  function linkOf(resolved, reader, row) {
    if (row.relatedType === null || row.relatedId === null) return null;
    const { access } = resolved;
    if (row.relatedType === "production_day") {
      const day = reader.get("productionDays", row.relatedId);
      if (
        day !== null &&
        gate.permits(access, "production.view", {
          factoryId: day.factoryId,
          sectionShiftId: day.sectionShiftId,
        })
      ) {
        return Object.freeze({ type: "production_day", id: day.id, label: "Open the day" });
      }
      return null;
    }
    if (row.relatedType === "export") {
      const job = reader.get("exportJobs", row.relatedId);
      const involved =
        job !== null &&
        (job.requesterId === resolved.user.id ||
          (job.recipientIds ?? []).includes(resolved.user.id));
      return involved && access.permissions.includes("export.create")
        ? Object.freeze({ type: "export", id: job.id, label: "Open the report" })
        : null;
    }
    if (row.relatedType === "report_schedule") {
      const schedule = reader.get("reportSchedules", row.relatedId);
      return schedule !== null && access.permissions.includes("report_schedule.manage")
        ? Object.freeze({ type: "report_schedule", id: schedule.id, label: "Open the schedule" })
        : null;
    }
    if (row.relatedType === "support_grant") {
      const wide =
        access.permissions.includes("support_access.approve") &&
        access.factoryScope.all &&
        !access.assignmentScoped;
      return wide
        ? Object.freeze({ type: "support_grant", id: row.relatedId, label: "Review the request" })
        : null;
    }
    return null;
  }

  function view(resolved, reader, row) {
    return Object.freeze({
      id: row.id,
      type: row.type,
      category: row.category,
      categoryLabel: CATEGORIES[row.category] ?? row.category,
      title: row.title,
      body: row.body,
      createdAt: row.createdAt,
      read: row.readAt !== null,
      readAt: row.readAt,
      link: linkOf(resolved, reader, row),
    });
  }

  const mine = (resolved, reader) => reader.list("notifications", (row) => shownTo(resolved, row));

  // ---- Preferences ---------------------------------------------------------------------------------

  function preferenceView(type, rows) {
    const spec = NOTIFICATION_TYPES[type];
    const effective = effectiveChannels(type, rows);
    return Object.freeze({
      type,
      label: spec.label,
      category: spec.category,
      categoryLabel: CATEGORIES[spec.category],
      mandatory: spec.mandatory,
      channels: Object.freeze(
        CHANNELS.map((channel) =>
          Object.freeze({
            channel,
            label: CHANNEL_LABELS[channel],
            enabled: effective[channel],
            custom: rows.some((row) => row.channel === channel),
            locked: spec.mandatory && channel === "in_app",
          })
        )
      ),
    });
  }

  // ---- Templates -----------------------------------------------------------------------------------

  function templateView(reader, type, channel) {
    const builtIn = builtInTemplate(type, channel);
    const override =
      reader.list(
        "notificationTemplates",
        (row) => row.type === type && row.channel === channel
      )[0] ?? null;
    const active = override !== null && override.enabled === true;
    return Object.freeze({
      type,
      channel,
      channelLabel: CHANNEL_LABELS[channel],
      builtIn: Object.freeze({ subject: builtIn.subject, body: builtIn.body }),
      override:
        override === null
          ? null
          : Object.freeze({
              subject: override.subject,
              body: override.body,
              enabled: override.enabled === true,
              version: override.version,
            }),
      effective: Object.freeze(
        active
          ? { subject: override.subject, body: override.body }
          : { subject: builtIn.subject, body: builtIn.body }
      ),
    });
  }

  function templateAdmin(context) {
    const resolved = gate.requireTenant(context, MANAGE_TEMPLATES);
    gate.authorizeTenantWide(resolved, MANAGE_TEMPLATES);
    return resolved;
  }

  // ---- Delivery history ----------------------------------------------------------------------------

  function deliveryAdmin(context) {
    const resolved = gate.requireTenant(context, VIEW_DELIVERIES);
    if (resolved.access.assignmentScoped) throw forbidden();
    return resolved;
  }

  return Object.freeze({
    // ---- The member's own centre (C131) ------------------------------------------------------------

    // Newest first. `asOf` is the cutoff to hand back to markAllRead, so a notification that arrives
    // after this list was drawn stays unread.
    list(context, filters = {}) {
      const resolved = member(context);
      const query = isObject(filters) ? filters : {};
      const category = readCategory(query.category);
      if (query.unread !== undefined && typeof query.unread !== "boolean") {
        throw fail("invalid_filter", "unread is true or false");
      }
      const limit = readLimit(query.limit);
      const reader = tenantSession(resolved);
      const all = mine(resolved, reader);
      const unread = all.filter((row) => row.readAt === null).length;
      const wanted = all
        .filter((row) => (category === null ? true : row.category === category))
        .filter((row) => (query.unread === true ? row.readAt === null : true));
      // Stable newest-first: later inserts come first among equal times.
      const ordered = wanted
        .map((row, index) => ({ row, index }))
        .sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt) || b.index - a.index)
        .map(({ row }) => row);
      return Object.freeze({
        asOf: clock(),
        unread,
        total: ordered.length,
        items: Object.freeze(ordered.slice(0, limit).map((row) => view(resolved, reader, row))),
      });
    },

    unreadCount(context) {
      const resolved = member(context);
      return mine(resolved, tenantSession(resolved)).filter((row) => row.readAt === null).length;
    },

    get(context, notificationId) {
      const resolved = member(context);
      const reader = tenantSession(resolved);
      return view(resolved, reader, rowOf(reader, resolved, notificationId));
    },

    // Idempotent: reading one again changes nothing and writes nothing.
    markRead(context, notificationId) {
      const resolved = member(context);
      return tenantSession(resolved).transaction((tx) => {
        const row = rowOf(tx, resolved, notificationId);
        const updated = tx.update("notifications", row.id, { readAt: row.readAt ?? clock() });
        return view(resolved, tx, updated ?? row);
      });
    },

    // Marks the member's unread notifications created up to the cutoff; later ones stay unread.
    markAllRead(context, input) {
      const resolved = member(context);
      const cutoffText = isObject(input) ? input.before : undefined;
      const parsed = typeof cutoffText === "string" ? Date.parse(cutoffText) : Number.NaN;
      if (Number.isNaN(parsed)) {
        throw fail("invalid_cutoff", "before must be the time the list was read (asOf)");
      }
      const now = clock();
      const cutoff = new Date(parsed).toISOString();
      const upTo = cutoff > now ? now : cutoff;
      return tenantSession(resolved).transaction((tx) => {
        const due = mine(resolved, tx).filter(
          (row) => row.readAt === null && row.createdAt <= upTo
        );
        for (const row of due) tx.update("notifications", row.id, { readAt: now });
        return Object.freeze({ marked: due.length });
      });
    },

    // ---- Preferences (C132) ------------------------------------------------------------------------

    preferences(context) {
      const resolved = member(context);
      const rows = tenantSession(resolved).list(
        "notificationPreferences",
        (row) => row.userId === resolved.user.id
      );
      return Object.freeze(
        TYPE_KEYS.map((type) =>
          preferenceView(
            type,
            rows.filter((row) => row.type === type)
          )
        )
      );
    },

    setPreference(context, input) {
      const resolved = member(context);
      const request = isObject(input) ? input : {};
      const spec = requireType(request.type);
      requireChannel(request.channel);
      if (typeof request.enabled !== "boolean") {
        throw fail("invalid_preference", "enabled is true or false");
      }
      if (spec.mandatory && request.channel === "in_app" && request.enabled === false) {
        throw fail("mandatory_channel", "this notification always appears in the app");
      }
      return tenantSession(resolved).transaction((tx) => {
        const own = tx.list(
          "notificationPreferences",
          (row) =>
            row.userId === resolved.user.id &&
            row.type === request.type &&
            row.channel === request.channel
        )[0];
        if (own === undefined) {
          tx.insert("notificationPreferences", {
            userId: resolved.user.id,
            type: request.type,
            channel: request.channel,
            enabled: request.enabled,
          });
        } else {
          tx.update("notificationPreferences", own.id, { enabled: request.enabled });
        }
        return preferenceView(
          request.type,
          tx.list(
            "notificationPreferences",
            (row) => row.userId === resolved.user.id && row.type === request.type
          )
        );
      });
    },

    // ---- Templates (C133) --------------------------------------------------------------------------

    templates(context) {
      const resolved = templateAdmin(context);
      const reader = tenantSession(resolved);
      return Object.freeze(
        TYPE_KEYS.map((type) => {
          const spec = NOTIFICATION_TYPES[type];
          return Object.freeze({
            type,
            label: spec.label,
            category: spec.category,
            categoryLabel: CATEGORIES[spec.category],
            placeholders: Object.freeze([...spec.placeholders]),
            channels: Object.freeze(CHANNELS.map((channel) => templateView(reader, type, channel))),
          });
        })
      );
    },

    // Saves the organization's text for a type and channel. Notifications already created keep the
    // text they were rendered with (D64).
    saveTemplate(context, input) {
      const resolved = templateAdmin(context);
      const request = isObject(input) ? input : {};
      requireType(request.type);
      requireChannel(request.channel);
      const text = validateTemplate(request.type, request);
      return tenantSession(resolved).transaction((tx) => {
        const existing = tx.list(
          "notificationTemplates",
          (row) => row.type === request.type && row.channel === request.channel
        )[0];
        if (existing === undefined) {
          tx.insert("notificationTemplates", {
            type: request.type,
            channel: request.channel,
            subject: text.subject,
            body: text.body,
            enabled: true,
            version: 1,
          });
        } else if (
          existing.subject !== text.subject ||
          existing.body !== text.body ||
          existing.enabled !== true
        ) {
          tx.update("notificationTemplates", existing.id, {
            subject: text.subject,
            body: text.body,
            enabled: true,
            version: existing.version + 1,
          });
        }
        return templateView(tx, request.type, request.channel);
      });
    },

    // Switches an override off (back to the built-in text) or on again.
    setTemplateEnabled(context, input) {
      const resolved = templateAdmin(context);
      const request = isObject(input) ? input : {};
      requireType(request.type);
      requireChannel(request.channel);
      if (typeof request.enabled !== "boolean") {
        throw fail("invalid_template", "enabled is true or false");
      }
      return tenantSession(resolved).transaction((tx) => {
        const existing = tx.list(
          "notificationTemplates",
          (row) => row.type === request.type && row.channel === request.channel
        )[0];
        if (existing === undefined) throw fail("not_found", "there is no override to switch");
        tx.update("notificationTemplates", existing.id, { enabled: request.enabled });
        return templateView(tx, request.type, request.channel);
      });
    },

    // ---- Delivery history (C134) -------------------------------------------------------------------

    deliveries(context, filters = {}) {
      const resolved = deliveryAdmin(context);
      const query = isObject(filters) ? filters : {};
      if (query.type !== undefined && query.type !== null && query.type !== "")
        requireType(query.type);
      if (query.channel !== undefined && query.channel !== null && query.channel !== "") {
        requireChannel(query.channel);
      }
      if (
        query.status !== undefined &&
        query.status !== null &&
        query.status !== "" &&
        !DELIVERY_STATUSES.includes(query.status)
      ) {
        throw fail("invalid_filter", `status must be one of ${DELIVERY_STATUSES.join(", ")}`);
      }
      const limit = readLimit(query.limit);
      const reader = tenantSession(resolved);
      const registry = store.platformSession({ actorId: resolved.user.id });
      const pick = (value) =>
        value === undefined || value === null || value === "" ? null : value;
      const [type, channel, status] = [pick(query.type), pick(query.channel), pick(query.status)];
      const rows = reader
        .list(
          "notificationDeliveries",
          (row) =>
            (row.factoryId === null || gate.inFactoryScope(resolved, row.factoryId)) &&
            (type === null || row.type === type) &&
            (channel === null || row.channel === channel) &&
            (status === null || row.status === status)
        )
        .map((row, index) => ({ row, index }))
        .sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt) || b.index - a.index)
        .map(({ row }) => row);
      return Object.freeze({
        asOf: clock(),
        total: rows.length,
        items: Object.freeze(
          rows.slice(0, limit).map((row) => {
            const notification = reader.get("notifications", row.notificationId);
            return Object.freeze({
              id: row.id,
              notificationId: row.notificationId,
              recipient: Object.freeze({
                id: row.userId,
                name: registry.get("users", row.userId)?.name ?? null,
              }),
              type: row.type,
              typeLabel: NOTIFICATION_TYPES[row.type]?.label ?? row.type,
              channel: row.channel,
              channelLabel: CHANNEL_LABELS[row.channel] ?? row.channel,
              destination: row.destination,
              status: row.status,
              failureCode: row.failureCode,
              failureText:
                row.failureCode === null ? null : (FAILURE_TEXT[row.failureCode] ?? null),
              title: row.subject ?? notification?.title ?? null,
              createdAt: row.createdAt,
            });
          })
        ),
      });
    },
  });
}
