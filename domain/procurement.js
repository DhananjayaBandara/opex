// Procurement rules (SRS 3.1, 7.4, 9.5; architecture 9; decisions D83 to D94).
// Pure validation and arithmetic for materials, suppliers, requests for quotation (RFQ), quotations,
// purchase orders (PO) and goods receipts (GRN). Orchestration (authorization, lookups, transactions,
// audit) lives in services/procurement.js. Browser-safe: no Node imports.
import { normalizeCode, validateDate } from "./organization.js";
import { normalizeEmail, validateName } from "./tenancy.js";
import { blank, optionalText, requireReason } from "./workforce.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function toNumber(value, label) {
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (isNumber(value)) return value;
  throw fail("invalid_number", `${label} must be a number`);
}

const places = (value, count) =>
  Math.abs(value * 10 ** count - Math.round(value * 10 ** count)) < 1e-6;
export const round2 = (value) => Math.round(value * 100) / 100;
export const round3 = (value) => Math.round(value * 1000) / 1000;
const present = (patch, field) => patch[field] !== undefined;
const nameFields = (value, label) => {
  const name = validateName(value, label);
  return { name, nameKey: name.toLowerCase() };
};

export const MAX_QUANTITY = 10_000_000;
export const MAX_PRICE = 1_000_000;
export const MAX_AMOUNT = 1_000_000_000;

// A quantity is above 0, at most 10,000,000 and has at most three decimals (AC-9.5).
export function quantityOf(value, label = "the quantity") {
  const number = toNumber(value, label);
  if (!(number > 0) || number > MAX_QUANTITY || !places(number, 3)) {
    throw fail(
      "invalid_number",
      `${label} must be above 0 and at most ${MAX_QUANTITY.toLocaleString("en-US")}, with up to three decimals`
    );
  }
  return round3(number);
}

// A unit price is 0 or more with at most four decimals (AC-9.6, AC-9.7).
export function priceOf(value, label = "the unit price") {
  const number = toNumber(value, label);
  if (!(number >= 0) || number > MAX_PRICE || !places(number, 4)) {
    throw fail(
      "invalid_number",
      `${label} must be from 0 to ${MAX_PRICE}, with up to four decimals`
    );
  }
  return Math.round(number * 10000) / 10000;
}

// A money amount (tax) is 0 or more with at most two decimals.
export function amountOf(value, label = "the amount") {
  const number = toNumber(value, label);
  if (!(number >= 0) || number > MAX_AMOUNT || !places(number, 2)) {
    throw fail("invalid_number", `${label} must be 0 or more, with up to two decimals`);
  }
  return round2(number);
}

function nonNegative(value, label, max = MAX_AMOUNT) {
  const number = toNumber(value, label);
  if (!(number >= 0) || number > max || !places(number, 3)) {
    throw fail("invalid_number", `${label} must be 0 or more, with up to three decimals`);
  }
  return round3(number);
}

export function currencyOf(value) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) {
    throw fail("invalid_currency", "a currency is a three-letter code such as USD");
  }
  return code;
}

export function dateNotAfter(value, today, label) {
  validateDate(value);
  if (value > today) throw fail("invalid_date", `${label} cannot be in the future`);
  return value;
}

// ---- Document numbers (D85, open decision O15) ---------------------------------------------------

export const PREFIXES = Object.freeze({
  rfq: "RFQ",
  po: "PO",
  grn: "GRN",
  requisition: "REQ",
  invoice: "INV",
});

// The next number is one above the highest issued, so a number is never reused, even when the row
// that held it was cancelled. Rows are never deleted.
export function nextNumber(prefix, existing) {
  let highest = 0;
  for (const number of existing) {
    const match = /^[A-Z]+-(\d+)$/.exec(number ?? "");
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}

// ---- Materials (D84) ----------------------------------------------------------------------------

export const UNITS = Object.freeze(["m", "pcs", "kg", "roll", "box"]);

function unitOf(value) {
  if (!UNITS.includes(value)) {
    throw fail("invalid_unit", `a unit is one of ${UNITS.join(", ")}`);
  }
  return value;
}

const optionalNonNegative = (value, label) =>
  blank(value) ? null : nonNegative(value, label, MAX_QUANTITY);

export function buildMaterial(input) {
  return {
    code: normalizeCode(input.code),
    ...nameFields(input.name, "the material name"),
    category: optionalText(input.category, "the category", 60),
    unit: unitOf(input.unit),
    reorderLevel: blank(input.reorderLevel)
      ? 0
      : nonNegative(input.reorderLevel, "the reorder level", MAX_QUANTITY),
    dailyUse: optionalNonNegative(input.dailyUse, "the daily use estimate"),
    standardCost: blank(input.standardCost)
      ? null
      : priceOf(input.standardCost, "the standard cost"),
    note: optionalText(input.note, "the note", 300),
    active: true,
  };
}

// The unit is fixed once a material exists (every quantity is counted in it); the service refuses it.
export function changeMaterial(patch) {
  return {
    ...(present(patch, "code") && { code: normalizeCode(patch.code) }),
    ...(present(patch, "name") && nameFields(patch.name, "the material name")),
    ...(present(patch, "category") && {
      category: optionalText(patch.category, "the category", 60),
    }),
    ...(present(patch, "reorderLevel") && {
      reorderLevel: nonNegative(patch.reorderLevel, "the reorder level", MAX_QUANTITY),
    }),
    ...(present(patch, "dailyUse") && {
      dailyUse: optionalNonNegative(patch.dailyUse, "the daily use estimate"),
    }),
    ...(present(patch, "standardCost") && {
      standardCost: blank(patch.standardCost)
        ? null
        : priceOf(patch.standardCost, "the standard cost"),
    }),
    ...(present(patch, "note") && { note: optionalText(patch.note, "the note", 300) }),
  };
}

// ---- Suppliers (D84) ----------------------------------------------------------------------------

const PHONE = /^[0-9+()\- ]{5,30}$/;

function optionalPhone(value) {
  if (blank(value)) return null;
  const text = typeof value === "string" ? value.trim() : "";
  if (!PHONE.test(text))
    throw fail("invalid_phone", "a phone number has 5 to 30 digits and symbols");
  return text;
}

export function buildSupplier(input) {
  return {
    code: normalizeCode(input.code),
    ...nameFields(input.name, "the supplier name"),
    contactName: optionalText(input.contactName, "the contact name", 80),
    email: blank(input.email) ? null : normalizeEmail(input.email),
    phone: optionalPhone(input.phone),
    paymentTerms: optionalText(input.paymentTerms, "the payment terms", 80),
    active: true,
  };
}

export function changeSupplier(patch) {
  return {
    ...(present(patch, "code") && { code: normalizeCode(patch.code) }),
    ...(present(patch, "name") && nameFields(patch.name, "the supplier name")),
    ...(present(patch, "contactName") && {
      contactName: optionalText(patch.contactName, "the contact name", 80),
    }),
    ...(present(patch, "email") && {
      email: blank(patch.email) ? null : normalizeEmail(patch.email),
    }),
    ...(present(patch, "phone") && { phone: optionalPhone(patch.phone) }),
    ...(present(patch, "paymentTerms") && {
      paymentTerms: optionalText(patch.paymentTerms, "the payment terms", 80),
    }),
  };
}

// ---- RFQs (D86) ---------------------------------------------------------------------------------

export const RFQ_STATUSES = Object.freeze(["draft", "sent", "awarded", "cancelled"]);

function datePair(first, second, firstLabel, secondLabel) {
  validateDate(first);
  validateDate(second);
  if (second < first) throw fail("invalid_dates", `${secondLabel} cannot be before ${firstLabel}`);
}

export function buildRfq(input) {
  datePair(input.requestDate, input.dueDate, "the request date", "the due date");
  return {
    requestDate: input.requestDate,
    dueDate: input.dueDate,
    note: optionalText(input.note, "the note", 300),
  };
}

export function changeRfq(patch, current) {
  const values = {
    ...(present(patch, "requestDate") && { requestDate: validateDate(patch.requestDate) }),
    ...(present(patch, "dueDate") && { dueDate: validateDate(patch.dueDate) }),
    ...(present(patch, "note") && { note: optionalText(patch.note, "the note", 300) }),
  };
  datePair(
    values.requestDate ?? current.requestDate,
    values.dueDate ?? current.dueDate,
    "the request date",
    "the due date"
  );
  return values;
}

// The suppliers invited: a list of ids, each once.
export function candidateList(value) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id === "")) {
    throw fail("invalid_suppliers", "the suppliers are a list of supplier ids");
  }
  return [...new Set(value)];
}

export function buildRfqLine(input, requestDate) {
  const requiredDate = blank(input.requiredDate) ? null : validateDate(input.requiredDate);
  if (requiredDate !== null && requiredDate < requestDate) {
    throw fail("invalid_dates", "the required date cannot be before the request date");
  }
  return { quantity: quantityOf(input.quantity), requiredDate };
}

export function changeRfqLine(patch, requestDate) {
  const values = {};
  if (present(patch, "quantity")) values.quantity = quantityOf(patch.quantity);
  if (present(patch, "requiredDate")) {
    const requiredDate = blank(patch.requiredDate) ? null : validateDate(patch.requiredDate);
    if (requiredDate !== null && requiredDate < requestDate) {
      throw fail("invalid_dates", "the required date cannot be before the request date");
    }
    values.requiredDate = requiredDate;
  }
  return values;
}

export function requireDraft(status, noun) {
  if (status !== "draft") {
    throw fail(
      `${noun}_locked`,
      `only a draft ${noun === "po" ? "purchase order" : noun} can be changed`
    );
  }
}

export function requireCancellable(status, allowed, noun, reason) {
  if (!allowed.includes(status)) {
    throw fail("invalid_transition", `a ${status} ${noun} cannot be cancelled`);
  }
  return requireReason(reason, "a reason for cancelling");
}

// ---- Quotations (D86) ---------------------------------------------------------------------------

export const QUOTATION_STATUSES = Object.freeze(["quoted", "awarded", "not_awarded"]);
export const MAX_LEAD_DAYS = 365;

export function buildQuotation(input, defaultCurrency) {
  const date = validateDate(input.date);
  const validUntil = blank(input.validUntil) ? null : validateDate(input.validUntil);
  if (validUntil !== null && validUntil < date) {
    throw fail("invalid_dates", "a quotation cannot be valid until before its date");
  }
  return {
    supplierRef: optionalText(input.supplierRef, "the supplier's reference", 40),
    date,
    validUntil,
    currency: currencyOf(blank(input.currency) ? defaultCurrency : input.currency),
  };
}

export function buildQuotationLine(input) {
  const lead = toNumber(blank(input.leadDays) ? 0 : input.leadDays, "the lead time");
  if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_DAYS) {
    throw fail(
      "invalid_number",
      `the lead time is a whole number of days from 0 to ${MAX_LEAD_DAYS}`
    );
  }
  return {
    quantity: quantityOf(input.quantity, "the quoted quantity"),
    unitPrice: priceOf(input.unitPrice),
    leadDays: lead,
  };
}

export const lineAmount = (quantity, unitPrice) => round2(quantity * unitPrice);

export function quotationTotal(lines) {
  return round2(lines.reduce((sum, line) => sum + lineAmount(line.quantity, line.unitPrice), 0));
}

// The comparison (AC-9.6): for each RFQ line every quotation's price and lead time, the lowest price
// marked where two or more quotations in the same currency offer the line, and per quotation the
// total, the coverage, the longest lead time and whether it has expired. Information only.
export function compareQuotations(rfqLines, quotations, today) {
  const lines = rfqLines.map((line) => {
    const offers = quotations
      .map((quotation) => {
        const quoted = quotation.lines.find((row) => row.rfqLineId === line.id);
        return quoted === undefined
          ? null
          : {
              quotationId: quotation.id,
              supplierId: quotation.supplierId,
              currency: quotation.currency,
              quantity: quoted.quantity,
              unitPrice: quoted.unitPrice,
              leadDays: quoted.leadDays,
              lowest: false,
            };
      })
      .filter((offer) => offer !== null);
    for (const currency of new Set(offers.map((offer) => offer.currency))) {
      const same = offers.filter((offer) => offer.currency === currency);
      if (same.length < 2) continue;
      const least = Math.min(...same.map((offer) => offer.unitPrice));
      for (const offer of same) if (offer.unitPrice === least) offer.lowest = true;
    }
    return { rfqLineId: line.id, materialId: line.materialId, offers };
  });
  const summaries = quotations.map((quotation) => ({
    quotationId: quotation.id,
    supplierId: quotation.supplierId,
    currency: quotation.currency,
    total: quotationTotal(quotation.lines),
    covered: quotation.lines.length,
    asked: rfqLines.length,
    longestLeadDays: quotation.lines.reduce((most, line) => Math.max(most, line.leadDays), 0),
    expired: quotation.validUntil !== null && quotation.validUntil < today,
  }));
  return { lines, summaries };
}

// ---- Purchase orders (D87) ----------------------------------------------------------------------

export const PO_STATUSES = Object.freeze(["draft", "issued", "cancelled"]);

export function buildPo(input, defaultCurrency) {
  datePair(input.orderDate, input.expectedDate, "the order date", "the expected date");
  return {
    orderDate: input.orderDate,
    expectedDate: input.expectedDate,
    currency: currencyOf(blank(input.currency) ? defaultCurrency : input.currency),
    note: optionalText(input.note, "the note", 300),
  };
}

export function changePo(patch, current) {
  const values = {
    ...(present(patch, "orderDate") && { orderDate: validateDate(patch.orderDate) }),
    ...(present(patch, "expectedDate") && { expectedDate: validateDate(patch.expectedDate) }),
    ...(present(patch, "currency") && { currency: currencyOf(patch.currency) }),
    ...(present(patch, "note") && { note: optionalText(patch.note, "the note", 300) }),
  };
  datePair(
    values.orderDate ?? current.orderDate,
    values.expectedDate ?? current.expectedDate,
    "the order date",
    "the expected date"
  );
  return values;
}

export function buildPoLine(input) {
  return {
    quantity: quantityOf(input.quantity),
    unitPrice: priceOf(input.unitPrice),
    taxAmount: blank(input.taxAmount) ? 0 : amountOf(input.taxAmount, "the tax amount"),
  };
}

export function changePoLine(patch) {
  return {
    ...(present(patch, "quantity") && { quantity: quantityOf(patch.quantity) }),
    ...(present(patch, "unitPrice") && { unitPrice: priceOf(patch.unitPrice) }),
    ...(present(patch, "taxAmount") && { taxAmount: amountOf(patch.taxAmount, "the tax amount") }),
  };
}

export function poValue(lines) {
  const subtotal = round2(
    lines.reduce((sum, line) => sum + lineAmount(line.quantity, line.unitPrice), 0)
  );
  const tax = round2(lines.reduce((sum, line) => sum + (line.taxAmount ?? 0), 0));
  return { subtotal, tax, total: round2(subtotal + tax) };
}

// Delivery is derived, never stored (D87): the accepted quantity is that of Posted receipts, so a
// reversed receipt no longer counts.
export function deliveryOf(lines, acceptedByLine, expectedDate, today, status) {
  const rows = lines.map((line) => {
    const accepted = round3(acceptedByLine.get(line.id) ?? 0);
    return {
      lineId: line.id,
      ordered: line.quantity,
      accepted,
      pending: Math.max(0, round3(line.quantity - accepted)),
    };
  });
  const accepted = rows.reduce((sum, row) => sum + row.accepted, 0);
  const pending = rows.reduce((sum, row) => sum + row.pending, 0);
  const delivery = accepted <= 0 ? "not_received" : pending <= 0 ? "complete" : "partly_received";
  return {
    rows,
    delivery,
    pending: round3(pending),
    late: status === "issued" && pending > 0 && expectedDate < today,
  };
}

// ---- Goods receipts (D88) -----------------------------------------------------------------------

export const GRN_STATUSES = Object.freeze(["draft", "received", "posted", "reversed", "cancelled"]);

export function buildReceipt(input, today) {
  return {
    receiptDate: dateNotAfter(input.receiptDate, today, "the receipt date"),
    challan: optionalText(input.challan, "the challan number", 40),
    note: optionalText(input.note, "the note", 300),
  };
}

export function changeReceipt(patch, today) {
  return {
    ...(present(patch, "receiptDate") && {
      receiptDate: dateNotAfter(patch.receiptDate, today, "the receipt date"),
    }),
    ...(present(patch, "challan") && {
      challan: optionalText(patch.challan, "the challan number", 40),
    }),
    ...(present(patch, "note") && { note: optionalText(patch.note, "the note", 300) }),
  };
}

// Received equals accepted plus rejected; a rejection needs a reason (AC-9.8).
export function buildReceiptLine(input) {
  const received = quantityOf(input.received, "the received quantity");
  const rejected = blank(input.rejected) ? 0 : nonNegative(input.rejected, "the rejected quantity");
  const accepted = blank(input.accepted)
    ? round3(received - rejected)
    : nonNegative(input.accepted, "the accepted quantity");
  if (round3(accepted + rejected) !== received) {
    throw fail("invalid_inspection", "accepted plus rejected must equal the received quantity");
  }
  const rejectionReason = optionalText(input.rejectionReason, "the rejection reason", 200);
  if (rejected > 0 && rejectionReason === null) {
    throw fail("reason_required", "a reason is required when any quantity is rejected");
  }
  return { received, accepted, rejected, rejectionReason: rejected > 0 ? rejectionReason : null };
}
