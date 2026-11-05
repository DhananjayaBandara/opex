// How a refusal is described to a person (D105): the code, the message, the fields the service named
// and a reference. The envelope comes from the services (`app.errors`), so a defect with no stable
// code is shown with a generic message and the reference only, never its technical text.
// Browser-only (reads the signed-in page state).
import { session } from "./session.js";

const FALLBACK = Object.freeze({
  code: "internal_error",
  message: "Something went wrong on our side. Nothing was saved.",
  fields: {},
  reference: null,
});

export function describe(error) {
  try {
    const { error: body } = session.app.errors.envelope(error);
    return {
      code: body.code,
      message: body.message,
      fields: body.fields,
      reference: body.correlation_id,
    };
  } catch {
    return FALLBACK;
  }
}

// "message (reference req_...)" for toasts and banners.
export function withReference(error) {
  const { message, reference } = describe(error);
  return reference === null ? message : `${message} (reference ${reference})`;
}
