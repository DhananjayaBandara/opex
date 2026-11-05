// The notifier (D61 to D65): the one place that turns an event into notifications and deliveries.
// It is not a service a caller can reach; the composition root hands it to the services that own an
// event (production, support, reports) and each calls it inside its own transaction, so the event and
// its notifications succeed or fail together (AC-7.2).
//
// For every recipient it reads their preferences, renders the organization's template (or the
// built-in one) once, stores the text it rendered, and records one delivery per channel. Nothing is
// ever sent: email is `sandboxed` at best (D65).
// Browser-safe: no Node imports.
import {
  NOTIFICATION_TYPES,
  bounces,
  builtInTemplate,
  effectiveChannels,
  maskEmail,
  renderTemplate,
  requireType,
} from "../domain/notifications.js";
import { SYSTEM_ACTOR } from "./context.js";

const IN_APP_DESTINATION = "In-app";

export function createNotifier({ store, gate, clock }) {
  const registry = () => store.platformSession({ actorId: SYSTEM_ACTOR });

  // The template text for a type and channel: the organization's override while it is switched on,
  // otherwise the built-in text.
  function templateFor(tx, type, channel) {
    const override = tx.list(
      "notificationTemplates",
      (row) => row.type === type && row.channel === channel && row.enabled === true
    )[0];
    return override === undefined
      ? builtInTemplate(type, channel)
      : { subject: override.subject, body: override.body };
  }

  // One notification for one member and its deliveries. Returns nothing: callers never read these.
  function write(tx, { type, userId, factoryId, related, values }) {
    const spec = requireType(type);
    const member = registry().get("users", userId);
    if (member === null) return;

    const preferences = tx.list(
      "notificationPreferences",
      (row) => row.userId === userId && row.type === type
    );
    const on = effectiveChannels(type, preferences);
    const switchedOff = (channel) =>
      preferences.some((row) => row.channel === channel && row.enabled === false);
    const at = clock();

    const inApp = renderTemplate(type, templateFor(tx, type, "in_app"), values);
    const notification = tx.insert("notifications", {
      userId,
      type,
      category: spec.category,
      title: inApp.subject,
      body: inApp.body,
      factoryId: factoryId ?? null,
      relatedType: related?.type ?? null,
      relatedId: related?.id ?? null,
      inApp: on.in_app,
      createdAt: at,
      readAt: null,
    });

    const delivery = (channel, fields) =>
      tx.insert("notificationDeliveries", {
        notificationId: notification.id,
        userId,
        type,
        channel,
        factoryId: factoryId ?? null,
        failureCode: null,
        subject: null,
        createdAt: at,
        ...fields,
      });

    if (on.in_app) {
      delivery("in_app", { destination: IN_APP_DESTINATION, status: "delivered" });
    } else if (switchedOff("in_app")) {
      delivery("in_app", { destination: IN_APP_DESTINATION, status: "suppressed" });
    }

    if (on.email) {
      const email = renderTemplate(type, templateFor(tx, type, "email"), values);
      const destination = maskEmail(member.email);
      // Only the masked address is kept; the real one is read here, used once and dropped (D65).
      if (bounces(member.email)) {
        delivery("email", {
          destination,
          status: "failed",
          failureCode: "mailbox_unavailable",
          subject: email.subject,
        });
      } else {
        delivery("email", { destination, status: "sandboxed", subject: email.subject });
      }
    } else if (switchedOff("email")) {
      delivery("email", { destination: maskEmail(member.email), status: "suppressed" });
    }
  }

  function deliver(tx, { type, recipients, factoryId = null, related = null, values = {} }) {
    for (const userId of new Set(recipients)) {
      write(tx, { type, userId, factoryId, related, values });
    }
  }

  const nameOf = (userId) => registry().get("users", userId)?.name ?? "Someone";

  // The values a production notification shows, read in the caller's transaction.
  function dayValues(tx, day, extra = {}) {
    return {
      factory: tx.get("factories", day.factoryId)?.name,
      line: tx.get("lines", day.lineId)?.name,
      shift: tx.get("shifts", day.shiftId)?.name,
      date: day.date,
      ...extra,
    };
  }

  // Members who can approve this day: the permission, a factory scope that covers it, and not limited
  // to their own assignments (approving a day is a management act, D2).
  function approversOf(tenantId, day) {
    return gate
      .holders(tenantId, "production.approve")
      .filter(
        ({ access }) =>
          !access.assignmentScoped &&
          (access.factoryScope.all || access.factoryScope.factoryIds.includes(day.factoryId))
      )
      .map(({ userId }) => userId);
  }

  return Object.freeze({
    // A day moved through the approval flow. `event` is "submitted", "approved" or "returned"; the
    // actor is never told about their own action.
    productionDay(tx, { tenantId, actorId, event, day, reason = null }) {
      const type = `production_${event}`;
      if (!Object.hasOwn(NOTIFICATION_TYPES, type)) return;
      const recipients =
        event === "submitted"
          ? approversOf(tenantId, day)
          : day.submittedBy === null || day.submittedBy === undefined
            ? []
            : [day.submittedBy];
      deliver(tx, {
        type,
        recipients: recipients.filter((userId) => userId !== actorId),
        factoryId: day.factoryId,
        related: { type: "production_day", id: day.id },
        values: dayValues(tx, day, { person: nameOf(actorId), reason }),
      });
    },

    // Platform support asked for access: the holders of the approval permission are told.
    supportRequested(tx, { tenantId, grant, requesterName }) {
      deliver(tx, {
        type: "support_access_requested",
        recipients: gate.holders(tenantId, "support_access.approve").map(({ userId }) => userId),
        related: { type: "support_grant", id: grant.id },
        values: {
          person: requesterName,
          minutes: grant.durationMinutes,
          reason: grant.reason,
        },
      });
    },

    // A finished export or a scheduled report is a job's result: it goes to whoever asked for it, even
    // if they started the job themselves (the exclusion above is for acts on someone else's work).
    exportReady(tx, { userId, job, label, period, factoryId = null }) {
      deliver(tx, {
        type: "export_ready",
        recipients: [userId],
        factoryId,
        related: { type: "export", id: job.id },
        values: { report: label, period, file: job.fileName },
      });
    },

    reportDelivered(tx, { recipients, job, schedule, label, period, factoryId = null }) {
      deliver(tx, {
        type: "report_delivered",
        recipients,
        factoryId,
        related: { type: "export", id: job.id },
        values: { schedule: schedule.name, report: label, period, file: job.fileName },
      });
    },
  });
}
