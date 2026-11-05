// Services signal every refusal with an Error carrying a stable `code`, so callers and tests branch on
// the code and never on message text. Browser-safe: no Node imports.
//
// `fields` is optional: a service that knows which input a refusal is about names it
// ({ field: ["message"] }), the shape of the API error envelope (architecture 11.3).
export function fail(code, message, fields) {
  const error = new Error(message);
  error.code = code;
  if (fields !== undefined) error.fields = fields;
  return error;
}

const STABLE_CODE = /^[a-z][a-z0-9_]*$/;
const INTERNAL_MESSAGE =
  "Something went wrong on our side. Quote the reference if you ask for help; nothing was saved.";

// Only a plain object of non-empty message lists is passed on as field errors.
function fieldsOf(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const clean = {};
  for (const [name, messages] of Object.entries(value)) {
    const list = (Array.isArray(messages) ? messages : [messages]).filter(
      (message) => typeof message === "string" && message.length > 0
    );
    if (list.length > 0) clean[name] = list;
  }
  return clean;
}

// The error envelope (architecture 11.3, D105): `{ error: { code, message, fields, correlation_id } }`.
// A refusal with a stable code keeps its message. Anything else (a bug, a storage fault) is reported
// as `internal_error` with a generic message and the reference only, so technical text and data from
// another tenant never reach a page (SRS 15.5). The same error always gets the same reference.
export function createErrorReporter({ newId }) {
  const references = new WeakMap();
  const referenceFor = (error) => {
    if (typeof error !== "object" || error === null) return `req_${newId()}`;
    if (!references.has(error)) references.set(error, `req_${newId()}`);
    return references.get(error);
  };
  return Object.freeze({
    envelope(error) {
      const coded = typeof error?.code === "string" && STABLE_CODE.test(error.code);
      return Object.freeze({
        error: Object.freeze({
          code: coded ? error.code : "internal_error",
          message: coded && typeof error.message === "string" ? error.message : INTERNAL_MESSAGE,
          fields: coded ? fieldsOf(error.fields) : {},
          correlation_id: referenceFor(error),
        }),
      });
    },
  });
}
