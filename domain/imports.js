// CSV imports (SRS 14.3; architecture 16; decisions D104, D105). Pure functions: the file format, the
// templates and the failed-row report. The rules that decide whether a row is acceptable are the
// ones of the Add form, because staging runs the real create call in a rolled-back trial (see
// services/imports.js). Browser-safe: no Node imports.
import { neutralize } from "./reports.js";

function fail(code, message, fields) {
  const error = new Error(message);
  error.code = code;
  if (fields !== undefined) error.fields = fields;
  return error;
}

export const MAX_ROWS = 500;
export const MAX_BYTES = 1024 * 1024;
export const BATCH = 50;
export const NAME_MAX = 120;

export const STATUSES = Object.freeze({
  staged: "Staged",
  committed: "Committed",
  cancelled: "Cancelled",
});

const column = (key, label, example, required = false) =>
  Object.freeze({ key, label, example, required });

// `permission` is the write permission of the same Add form; import.manage is needed besides it.
export const KINDS = Object.freeze({
  buyers: Object.freeze({
    label: "Buyers",
    noun: "buyer",
    permission: "order.manage",
    columns: Object.freeze([
      column("code", "code", "NORD", true),
      column("name", "name", "Nordic Outdoor AB", true),
      column("country", "country", "Sweden"),
      column("contactName", "contact name", "Elin Berg"),
      column("contactEmail", "contact email", "elin@nordic.example"),
    ]),
  }),
  suppliers: Object.freeze({
    label: "Suppliers",
    noun: "supplier",
    permission: "material.manage",
    columns: Object.freeze([
      column("code", "code", "SUP-FAB", true),
      column("name", "name", "Fabric Mills Ltd", true),
      column("contactName", "contact name", "Nimal Perera"),
      column("email", "email", "sales@fabricmills.example"),
      column("phone", "phone", "+94 11 234 5678"),
      column("paymentTerms", "payment terms", "Net 30"),
    ]),
  }),
  materials: Object.freeze({
    label: "Materials",
    noun: "material",
    permission: "material.manage",
    columns: Object.freeze([
      column("code", "code", "FAB-100", true),
      column("name", "name", "Cotton jersey 180 gsm", true),
      column("category", "category", "Fabric"),
      column("unit", "unit (m, pcs, kg, roll, box)", "m", true),
      column("reorderLevel", "reorder level", "500"),
      column("dailyUse", "daily use", "120"),
      column("standardCost", "standard cost", "3.2500"),
      column("note", "note", ""),
    ]),
  }),
  employees: Object.freeze({
    label: "Employees",
    noun: "employee",
    permission: "employee.manage",
    columns: Object.freeze([
      column("employeeCode", "employee code", "E-1001", true),
      column("name", "name", "Kamal Silva", true),
      column("email", "email", "kamal@example.com"),
      column("phone", "phone", "+94 77 123 4567"),
      column("joinDate", "join date (YYYY-MM-DD)", "2026-01-15", true),
      column("factoryCode", "factory code", "F1", true),
      column("sectionCode", "section code", "SEW", true),
      column("designation", "designation", "Machine operator", true),
    ]),
  }),
});

export const KIND_KEYS = Object.freeze(Object.keys(KINDS));

export function requireKind(kind) {
  if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) {
    throw fail("unknown_import_kind", "Choose buyers, suppliers, materials or employees", {
      kind: ["Choose buyers, suppliers, materials or employees"],
    });
  }
  return KINDS[kind];
}

// Header text and column keys are compared without case, spaces or punctuation, so "Contact Name"
// and "contactName" are the same column. The text in brackets of a label is not part of it.
const simplify = (text) =>
  String(text)
    .replace(/\(.*?\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// Columns that would pick a tenant or a row are never read: tenancy comes from the signed-in
// session, and a new row always gets a new id (SRS 6.1).
const FORBIDDEN_COLUMNS = Object.freeze([
  "id",
  "tenant",
  "tenantid",
  "tenantslug",
  "organization",
  "organizationid",
]);

// ---- Templates ----------------------------------------------------------------------------------

const quote = (value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export function templateOf(kind) {
  const spec = requireKind(kind);
  const csv = `${[
    spec.columns.map((item) => quote(item.label)).join(","),
    spec.columns.map((item) => quote(item.example)).join(","),
  ].join("\r\n")}\r\n`;
  return Object.freeze({
    kind,
    fileName: `${kind}-template.csv`,
    columns: spec.columns,
    csv,
  });
}

// ---- Parsing ------------------------------------------------------------------------------------

// RFC 4180 records: quoted fields may hold commas, quotes ("") and line breaks; a byte-order mark and
// either kind of line ending are accepted. Returns the records as arrays of text, blank records
// kept as `null` so that a row number still matches the row in a spreadsheet (header is row 1).
export function parseCsv(text) {
  const source = String(text).replace(/^﻿/, "");
  const records = [];
  let record = [];
  let value = "";
  let quoted = false;
  let touched = false;
  const endRecord = () => {
    record.push(value);
    const blank = record.length === 1 && record[0].trim() === "" && !touched;
    records.push(blank ? null : record);
    record = [];
    value = "";
    touched = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += char;
      }
    } else if (char === '"' && value === "") {
      quoted = true;
      touched = true;
    } else if (char === ",") {
      record.push(value);
      value = "";
      touched = true;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      endRecord();
    } else {
      value += char;
    }
  }
  if (quoted) throw fail("invalid_csv", "A quoted value is never closed; the file ends inside it");
  if (value !== "" || record.length > 0 || touched) endRecord();
  return records;
}

// Reads a whole file against a kind: the columns it carries, and every data row as { number, values }
// (blank rows skipped). Throws `invalid_csv` for a file that cannot be used at all.
export function readCsv(kind, text) {
  const spec = requireKind(kind);
  if (typeof text !== "string" || text.trim() === "") {
    throw fail("invalid_csv", "The file is empty");
  }
  if (new TextEncoder().encode(text).length > MAX_BYTES) {
    throw fail("file_too_large", "An import file is at most 1 MB");
  }
  const records = parseCsv(text);
  const header = records[0];
  if (header === null || header === undefined)
    throw fail("invalid_csv", "The first row must be the column names");
  const known = new Map(
    spec.columns.flatMap((item) => [
      [simplify(item.key), item.key],
      [simplify(item.label), item.key],
    ])
  );
  const positions = new Map();
  const ignored = [];
  const refused = [];
  header.forEach((title, position) => {
    const name = simplify(title);
    if (FORBIDDEN_COLUMNS.includes(name)) {
      refused.push(title.trim());
    } else if (known.has(name)) {
      const key = known.get(name);
      if (positions.has(key)) throw fail("invalid_csv", `The column ${title.trim()} appears twice`);
      positions.set(key, position);
    } else if (title.trim() !== "") {
      ignored.push(title.trim());
    }
  });
  const missing = spec.columns.filter((item) => item.required && !positions.has(item.key));
  if (missing.length > 0) {
    throw fail(
      "invalid_csv",
      `The file is missing the column ${missing.map((item) => item.label).join(", ")}`
    );
  }
  const rows = [];
  records.slice(1).forEach((record, offset) => {
    if (record === null) return;
    const values = {};
    for (const [key, position] of positions) values[key] = (record[position] ?? "").trim();
    rows.push({ number: offset + 2, values });
  });
  if (rows.length === 0) throw fail("invalid_csv", "The file has no data rows");
  if (rows.length > MAX_ROWS) {
    throw fail(
      "too_many_rows",
      `An import file has at most ${MAX_ROWS} rows; this one has ${rows.length}`
    );
  }
  return Object.freeze({
    columns: Object.freeze([...positions.keys()]),
    ignoredColumns: Object.freeze(ignored),
    refusedColumns: Object.freeze(refused),
    rows: Object.freeze(rows),
  });
}

// ---- Naming ---------------------------------------------------------------------------------------

export function validateImportName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > NAME_MAX) {
    throw fail("invalid_name", `A file name is 1 to ${NAME_MAX} characters`, {
      name: [`A file name is 1 to ${NAME_MAX} characters`],
    });
  }
  return name;
}

// ---- Failed-row report -----------------------------------------------------------------------------

// The rows that did not pass, with the reason, so they can be corrected and loaded again. Text a
// spreadsheet would run as a formula is escaped (D68).
export function errorReportCsv(kind, rows) {
  const spec = requireKind(kind);
  const lines = [["row", ...spec.columns.map((item) => item.key), "problem"].map(quote).join(",")];
  for (const row of rows) {
    lines.push(
      [
        String(row.number),
        ...spec.columns.map((item) => neutralize(row.values[item.key] ?? "")),
        neutralize(row.problem ?? ""),
      ]
        .map(quote)
        .join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
