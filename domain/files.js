// File metadata (SRS 14.3; architecture 16; decision D101). The prototype keeps what a file IS, never
// what it contains: no binary is retained. Pure functions. Browser-safe: no Node imports.

function fail(code, message, fields) {
  const error = new Error(message);
  error.code = code;
  if (fields !== undefined) error.fields = fields;
  return error;
}

export const MAX_BYTES = 5 * 1024 * 1024;
export const NAME_MAX = 120;

export const CONTENT_TYPES = Object.freeze({
  "text/csv": Object.freeze({ label: "CSV", extensions: Object.freeze([".csv"]) }),
  "text/plain": Object.freeze({ label: "Plain text", extensions: Object.freeze([".txt"]) }),
  "image/png": Object.freeze({ label: "PNG image", extensions: Object.freeze([".png"]) }),
  "image/jpeg": Object.freeze({
    label: "JPEG image",
    extensions: Object.freeze([".jpg", ".jpeg"]),
  }),
  "application/pdf": Object.freeze({ label: "PDF", extensions: Object.freeze([".pdf"]) }),
});

// `types` are the content types a category accepts; `folder` is the storage folder.
export const CATEGORIES = Object.freeze({
  attachment: Object.freeze({
    label: "Attachment",
    folder: "attachments",
    types: Object.keys(CONTENT_TYPES),
  }),
  branding: Object.freeze({
    label: "Branding",
    folder: "branding",
    types: ["image/png", "image/jpeg"],
  }),
  import: Object.freeze({ label: "Import source", folder: "imports", types: ["text/csv"] }),
  export: Object.freeze({ label: "Export", folder: "exports", types: ["text/csv"] }),
});

const field = (name, message) => fail(`invalid_${name}`, message, { [name]: [message] });

export function validateFileName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > NAME_MAX) {
    throw field("name", `A file name is 1 to ${NAME_MAX} characters`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f]/.test(name) || name.includes("..") || name.startsWith(".")) {
    throw field("name", "A file name has no folders, control characters or '..'");
  }
  return name;
}

export function validateFile(input) {
  const source = typeof input === "object" && input !== null ? input : {};
  const name = validateFileName(source.name);
  const contentType = source.contentType;
  if (typeof contentType !== "string" || !Object.hasOwn(CONTENT_TYPES, contentType)) {
    throw field("contentType", "Choose CSV, plain text, PNG, JPEG or PDF");
  }
  const lower = name.toLowerCase();
  if (!CONTENT_TYPES[contentType].extensions.some((extension) => lower.endsWith(extension))) {
    throw field(
      "name",
      `A ${CONTENT_TYPES[contentType].label} file ends in ${CONTENT_TYPES[contentType].extensions.join(" or ")}`
    );
  }
  const category = source.category;
  if (typeof category !== "string" || !Object.hasOwn(CATEGORIES, category)) {
    throw field("category", "Choose attachment, branding, import or export");
  }
  if (!CATEGORIES[category].types.includes(contentType)) {
    const accepted = CATEGORIES[category].types
      .map((type) => CONTENT_TYPES[type].label)
      .join(" or ");
    throw field("contentType", `${CATEGORIES[category].label} files must be ${accepted}`);
  }
  const size = source.size;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BYTES) {
    throw field("size", "A file is 1 byte to 5 MB");
  }
  const print = source.fingerprint;
  if (
    print !== undefined &&
    print !== null &&
    (typeof print !== "string" || !/^[0-9a-f]{16}$/.test(print))
  ) {
    throw field("fingerprint", "A fingerprint is 16 lowercase hex characters");
  }
  return { name, contentType, category, size, fingerprint: print ?? null };
}

const safeName = (name) =>
  name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 80) || "file";

// `tenants/{tenant}/{folder}/{yyyy}/{mm}/{id}-{safe name}`; never built from a caller's path.
export function storageKeyOf(tenantId, category, fileId, name, at) {
  const month = String(at).slice(0, 7).replace("-", "/");
  return `tenants/${tenantId}/${CATEGORIES[category].folder}/${month}/${fileId}-${safeName(name)}`;
}

// A key a caller proposes must stay inside the organization's own prefix.
export function requireOwnKey(tenantId, key) {
  const prefix = `tenants/${tenantId}/`;
  if (
    typeof key !== "string" ||
    !key.startsWith(prefix) ||
    key.includes("..") ||
    key.includes("//") ||
    key.length > 300
  ) {
    throw field("storageKey", "A storage key stays inside this organization's own folder");
  }
  return key;
}

export function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
