// Notification rules (C131 to C134; decisions D61 to D65): the type catalogue, the channels and their
// defaults, the built-in text, placeholder-safe rendering and the masking of a destination.
// Pure functions. Orchestration (who is notified, scope, storage) lives in services/notifier.js and
// services/notifications.js. Browser-safe: no Node imports.

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const CHANNELS = Object.freeze(["in_app", "email"]);
export const CHANNEL_LABELS = Object.freeze({ in_app: "In-app", email: "Email" });
export const CATEGORIES = Object.freeze({
  production: "Production",
  reports: "Reports",
  administration: "Administration",
});

// Where a notification leads. The service decides whether the caller may open it now (D61).
export const RELATED = Object.freeze([
  "production_day",
  "export",
  "report_schedule",
  "support_grant",
]);

// `placeholders` is the allowlist a template may use (D64). `mandatory` types cannot have their
// in-app channel switched off (D62).
export const NOTIFICATION_TYPES = Object.freeze({
  production_submitted: {
    label: "A production day is waiting for approval",
    category: "production",
    mandatory: false,
    placeholders: ["factory", "line", "shift", "date", "person"],
    builtIn: {
      in_app: {
        subject: "Production day waiting for approval",
        body: "{{person}} submitted {{line}} · {{shift}} on {{date}} at {{factory}} for approval.",
      },
      email: {
        subject: "Approval needed: {{line}} on {{date}}",
        body: "{{person}} submitted {{line}} · {{shift}} on {{date}} at {{factory}}. Open OPEX+ to approve or return it.",
      },
    },
  },
  production_approved: {
    label: "Your production day was approved",
    category: "production",
    mandatory: false,
    placeholders: ["factory", "line", "shift", "date", "person"],
    builtIn: {
      in_app: {
        subject: "Production day approved",
        body: "{{person}} approved {{line}} · {{shift}} on {{date}} at {{factory}}.",
      },
      email: {
        subject: "Approved: {{line}} on {{date}}",
        body: "{{person}} approved {{line}} · {{shift}} on {{date}} at {{factory}}.",
      },
    },
  },
  production_returned: {
    label: "Your production day was returned",
    category: "production",
    mandatory: false,
    placeholders: ["factory", "line", "shift", "date", "person", "reason"],
    builtIn: {
      in_app: {
        subject: "Production day returned",
        body: "{{person}} returned {{line}} · {{shift}} on {{date}} at {{factory}}: {{reason}}",
      },
      email: {
        subject: "Returned: {{line}} on {{date}}",
        body: "{{person}} returned {{line}} · {{shift}} on {{date}} at {{factory}}. Reason: {{reason}}",
      },
    },
  },
  export_ready: {
    label: "Your export is ready",
    category: "reports",
    mandatory: false,
    placeholders: ["report", "period", "file"],
    builtIn: {
      in_app: {
        subject: "Export ready",
        body: "Your {{report}} export for {{period}} is ready to download ({{file}}).",
      },
      email: {
        subject: "Export ready: {{report}}",
        body: "Your {{report}} export for {{period}} is ready to download in OPEX+ ({{file}}).",
      },
    },
  },
  report_delivered: {
    label: "A scheduled report was delivered",
    category: "reports",
    mandatory: false,
    placeholders: ["schedule", "report", "period", "file"],
    builtIn: {
      in_app: {
        subject: "Scheduled report: {{schedule}}",
        body: "{{report}} for {{period}} is ready to download ({{file}}).",
      },
      email: {
        subject: "Scheduled report: {{schedule}}",
        body: "{{report}} for {{period}} is ready to download in OPEX+ ({{file}}).",
      },
    },
  },
  support_access_requested: {
    label: "Platform support asked for access",
    category: "administration",
    mandatory: true,
    placeholders: ["person", "minutes", "reason"],
    builtIn: {
      in_app: {
        subject: "Support access requested",
        body: "{{person}} asked for read-only access for {{minutes}} minutes: {{reason}}",
      },
      email: {
        subject: "Support access requested",
        body: "{{person}} asked for read-only access for {{minutes}} minutes. Reason: {{reason}} Review it under Administration.",
      },
    },
  },
});

export const TYPE_KEYS = Object.freeze(Object.keys(NOTIFICATION_TYPES));

export function requireType(type) {
  if (typeof type !== "string" || !Object.hasOwn(NOTIFICATION_TYPES, type)) {
    throw fail("unknown_type", `${String(type)} is not a notification type`);
  }
  return NOTIFICATION_TYPES[type];
}

export function requireChannel(channel) {
  if (!CHANNELS.includes(channel)) {
    throw fail("unknown_channel", `channel must be one of ${CHANNELS.join(", ")}`);
  }
  return channel;
}

// The default of a channel: in-app on, email off (D62).
export const defaultEnabled = (channel) => channel === "in_app";

// Whether each channel is on for a member: their own setting, else the default; a mandatory type
// always keeps in-app. `preferences` are the member's rows { type, channel, enabled }.
export function effectiveChannels(type, preferences) {
  const spec = requireType(type);
  const result = {};
  for (const channel of CHANNELS) {
    const own = preferences.find((row) => row.type === type && row.channel === channel);
    result[channel] = own === undefined ? defaultEnabled(channel) : own.enabled === true;
  }
  if (spec.mandatory) result.in_app = true;
  return result;
}

// ---- Templates (D64) ------------------------------------------------------------------------------

export const SUBJECT_MAX = 120;
export const BODY_MAX = 500;
const VALUE_MAX = 200;
const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g;
// Everything but tab and line feed in the C0 range, plus DEL, is dropped from inserted values.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function builtInTemplate(type, channel) {
  requireType(type);
  requireChannel(channel);
  return NOTIFICATION_TYPES[type].builtIn[channel];
}

// A template as a person saves it: subject and body, plain text, bounded, with only the type's
// placeholders.
export function validateTemplate(type, input) {
  const spec = requireType(type);
  const read = (value, label, max) => {
    const text = typeof value === "string" ? value.replace(CONTROL, "").trim() : "";
    if (text.length === 0 || text.length > max) {
      throw fail("invalid_template", `${label} must be 1 to ${max} characters`);
    }
    return text;
  };
  const subject = read(input?.subject, "the subject", SUBJECT_MAX);
  const body = read(input?.body, "the body", BODY_MAX);
  for (const text of [subject, body]) {
    for (const match of text.matchAll(TOKEN)) {
      if (!spec.placeholders.includes(match[1])) {
        throw fail(
          "unknown_placeholder",
          `{{${match[1]}}} is not available for this notification; use ${spec.placeholders
            .map((name) => `{{${name}}}`)
            .join(", ")}`
        );
      }
    }
    if (/\{\{|\}\}/.test(text.replace(TOKEN, ""))) {
      throw fail("invalid_template", "a placeholder is written {{name}}");
    }
  }
  return { subject, body };
}

const safeValue = (value) => {
  const text = value === null || value === undefined ? "—" : String(value);
  const clean = text.replace(CONTROL, " ").trim();
  return clean.length > VALUE_MAX ? `${clean.slice(0, VALUE_MAX - 1)}…` : clean || "—";
};

// Fills a template. Only allowlisted placeholders are replaced and an inserted value is never read
// as a placeholder itself, so text from a person cannot add one.
export function renderTemplate(type, template, values) {
  const spec = requireType(type);
  const fill = (text) =>
    text.replace(TOKEN, (_, name) =>
      spec.placeholders.includes(name) ? safeValue(values[name]) : "—"
    );
  return { subject: fill(template.subject), body: fill(template.body) };
}

// ---- Destinations and simulated delivery (D65) ----------------------------------------------------

// "farah@felix.example" -> "f***@felix.example". Nothing else of the address is kept or shown.
export function maskEmail(address) {
  const text = typeof address === "string" ? address : "";
  const at = text.lastIndexOf("@");
  if (at < 1) return "***";
  return `${text[0]}***${text.slice(at)}`;
}

export const BOUNCE_DOMAIN = "@bounce.example";

// The simulated provider accepts every address except one that ends @bounce.example, which stands
// in for a mailbox that does not exist. Nothing is ever sent.
export const bounces = (address) =>
  typeof address === "string" && address.toLowerCase().endsWith(BOUNCE_DOMAIN);

export const DELIVERY_STATUSES = Object.freeze(["delivered", "sandboxed", "failed", "suppressed"]);
export const FAILURE_TEXT = Object.freeze({
  mailbox_unavailable: "The simulated provider rejected the address.",
});
