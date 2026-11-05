// Invoice and payment rules (SRS 3.1, 7.4; architecture 12; decisions D92 to D94; constraints C12, P20).
// Pure validation and arithmetic. An invoice's subtotal, tax, total, paid amount and balance are
// always worked out from its lines and its payments; none is stored or accepted from the caller.
// Payments are append-only. Orchestration lives in services/finance.js. Browser-safe: no Node imports.
import { validateDate } from "./organization.js";
import {
  amountOf,
  currencyOf,
  dateNotAfter,
  lineAmount,
  priceOf,
  quantityOf,
  round2,
} from "./procurement.js";
import { blank, optionalText } from "./workforce.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const present = (patch, field) => patch[field] !== undefined;

export const INVOICE_KINDS = Object.freeze(["customer", "supplier"]);
export const INVOICE_STATUSES = Object.freeze(["draft", "issued", "cancelled"]);
export const PAYMENT_METHODS = Object.freeze(["bank_transfer", "cheque", "cash", "card"]);

export const METHOD_LABELS = Object.freeze({
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  cash: "Cash",
  card: "Card",
});

export function kindOf(value) {
  if (!INVOICE_KINDS.includes(value)) {
    throw fail("invalid_kind", "an invoice is for a customer or from a supplier");
  }
  return value;
}

function datePair(invoiceDate, dueDate) {
  validateDate(invoiceDate);
  validateDate(dueDate);
  if (dueDate < invoiceDate) {
    throw fail("invalid_dates", "the due date cannot be before the invoice date");
  }
}

// The header fields every invoice has (AC-9.12). The party and the links are set by the service.
export function buildInvoice(input, defaultCurrency) {
  datePair(input.invoiceDate, input.dueDate);
  return {
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    currency: currencyOf(blank(input.currency) ? defaultCurrency : input.currency),
    taxAmount: blank(input.taxAmount) ? 0 : amountOf(input.taxAmount, "the tax amount"),
    note: optionalText(input.note, "the note", 300),
  };
}

export function changeInvoice(patch, current) {
  const values = {
    ...(present(patch, "invoiceDate") && { invoiceDate: validateDate(patch.invoiceDate) }),
    ...(present(patch, "dueDate") && { dueDate: validateDate(patch.dueDate) }),
    ...(present(patch, "currency") && { currency: currencyOf(patch.currency) }),
    ...(present(patch, "taxAmount") && { taxAmount: amountOf(patch.taxAmount, "the tax amount") }),
    ...(present(patch, "note") && { note: optionalText(patch.note, "the note", 300) }),
  };
  datePair(values.invoiceDate ?? current.invoiceDate, values.dueDate ?? current.dueDate);
  return values;
}

// A supplier's own invoice number: required, unique per supplier (the key is lower-case).
export function supplierNumberOf(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0 || text.length > 40) {
    throw fail("invalid_field", "the supplier's invoice number is 1 to 40 characters");
  }
  return { supplierNumber: text, supplierKey: text.toLowerCase() };
}

export function buildInvoiceLine(input) {
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length === 0 || description.length > 200) {
    throw fail("invalid_field", "a line description is 1 to 200 characters");
  }
  return {
    description,
    quantity: quantityOf(input.quantity),
    unitPrice: priceOf(input.unitPrice),
  };
}

export const invoiceLineTotal = (line) => lineAmount(line.quantity, line.unitPrice);

export function invoiceTotals(lines, taxAmount) {
  const subtotal = round2(lines.reduce((sum, line) => sum + invoiceLineTotal(line), 0));
  const tax = round2(taxAmount ?? 0);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

export const paidOf = (payments) =>
  round2(payments.reduce((sum, payment) => sum + payment.amount, 0));

// Settlement is derived (AC-9.12): Unpaid, Part paid or Paid always shows; Overdue is separate and
// only for an issued invoice with a balance after its due date.
export function settlementOf({ status, total, paid, dueDate }, today) {
  const balance = Math.max(0, round2(total - paid));
  const settlement = paid <= 0 ? "unpaid" : balance <= 0 ? "paid" : "part_paid";
  return {
    paid,
    balance,
    settlement,
    overdue: status === "issued" && balance > 0 && dueDate < today,
  };
}

export function requireIssuable(lines, totals) {
  if (lines.length === 0)
    throw fail("no_lines", "add at least one line before issuing the invoice");
  if (!(totals.total > 0)) throw fail("zero_total", "an invoice needs a total above 0");
}

// A payment (AC-9.13, D93): above 0, not above the balance, dated between the invoice date and today.
export function buildPayment(input, invoice, balance, today) {
  const amount = amountOf(input.amount, "the amount");
  if (!(amount > 0)) throw fail("invalid_number", "the amount must be above 0");
  if (amount > balance) {
    throw fail("overpayment", `the amount cannot be above the balance of ${balance.toFixed(2)}`);
  }
  const date = dateNotAfter(input.date, today, "the payment date");
  if (date < invoice.invoiceDate) {
    throw fail("invalid_date", "the payment date cannot be before the invoice date");
  }
  if (!PAYMENT_METHODS.includes(input.method)) {
    throw fail(
      "invalid_method",
      `a method is one of ${PAYMENT_METHODS.join(", ").replaceAll("_", " ")}`
    );
  }
  const key = blank(input.idempotencyKey) ? null : String(input.idempotencyKey).trim();
  if (key !== null && (key.length === 0 || key.length > 80)) {
    throw fail("invalid_field", "the Idempotency-Key is 1 to 80 characters");
  }
  return {
    amount,
    date,
    method: input.method,
    reference: optionalText(input.reference, "the reference", 80),
    idempotencyKey: key,
  };
}

// The review statement for traceability (D94): information only, nothing blocks.
export function matchStatement({ ordered, accepted, invoiced }) {
  const difference = round2(invoiced - accepted);
  return {
    ordered: round2(ordered),
    accepted: round2(accepted),
    invoiced: round2(invoiced),
    difference,
    matches: difference === 0,
    statement:
      difference === 0
        ? "The invoiced value matches the accepted goods."
        : `The invoiced value differs from the accepted goods by ${Math.abs(difference).toFixed(2)} (${
            difference > 0 ? "more" : "less"
          } invoiced).`,
  };
}
