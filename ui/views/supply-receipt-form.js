// The goods receipt form, used to record a new receipt against an issued purchase order and to
// correct a draft one (D88). The form has one block of fields per order line because the dialog has no
// repeating group: received and rejected quantities and the reason for a rejection. Accepted is what
// is left (received less rejected), so the two can never disagree.
import { formDialog } from "../dialog.js";
import { session } from "../session.js";
import { COMMON_ERRORS, supply, withUnit } from "./supply-common.js";

const ERRORS = { ...COMMON_ERRORS, invalid_date: "receiptDate", invalid_number: "received0" };

// `po` is the purchase order read; `receipt` is the receipt read when a draft is being corrected.
export function receiptDialog({ po, receipt, onSaved }) {
  const existing = receipt?.lines ?? [];
  const lines = po.lines.filter(
    (line) => line.pending > 0 || existing.some((entry) => entry.poLineId === line.id)
  );
  const fields = [
    { name: "receiptDate", label: "Receipt date", type: "date", required: true },
    { name: "challan", label: "Delivery challan number", maxlength: 40 },
    { name: "note", label: "Note", type: "textarea" },
  ];
  const initial = {
    receiptDate: receipt?.receipt.receiptDate ?? session.who.today,
    challan: receipt?.receipt.challan ?? "",
    note: receipt?.receipt.note ?? "",
  };
  lines.forEach((line, index) => {
    const entered = existing.find((entry) => entry.poLineId === line.id);
    fields.push(
      {
        name: `received${index}`,
        label: `${line.materialName}: received (${line.unit})`,
        type: "number",
        min: 0,
        step: "any",
        hint: `${withUnit(line.pending, line.unit)} still to arrive; leave empty if none came`,
      },
      {
        name: `rejected${index}`,
        label: `${line.materialName}: rejected (${line.unit})`,
        type: "number",
        min: 0,
        step: "any",
        hint: "Failed inspection; the rest is accepted into stock",
      },
      {
        name: `reason${index}`,
        label: `${line.materialName}: reason for rejecting`,
        maxlength: 200,
      }
    );
    initial[`received${index}`] = entered?.received ?? line.pending;
    initial[`rejected${index}`] = entered?.rejected ?? 0;
    initial[`reason${index}`] = entered?.rejectionReason ?? "";
  });
  return formDialog({
    title: receipt ? `Edit ${receipt.receipt.number}` : `Record goods received for ${po.po.number}`,
    description:
      "Accepted goods enter the store only when the receipt is posted, after it is received.",
    fields,
    initial,
    errorFields: ERRORS,
    submitLabel: receipt ? "Save" : "Create draft receipt",
    onSubmit: (values) => {
      const entered = lines
        .map((line, index) => ({
          poLineId: line.id,
          received: values[`received${index}`],
          rejected: values[`rejected${index}`] ?? 0,
          rejectionReason: values[`reason${index}`] || undefined,
        }))
        .filter((line) => line.received !== undefined && line.received !== 0);
      const header = {
        receiptDate: values.receiptDate,
        challan: values.challan || null,
        note: values.note || null,
      };
      const saved = receipt
        ? supply((p, ctx) =>
            p.updateReceipt(ctx, receipt.receipt.id, { ...header, lines: entered })
          )
        : supply((p, ctx) =>
            p.createReceipt(ctx, {
              ...header,
              challan: header.challan ?? undefined,
              note: header.note ?? undefined,
              poId: po.po.id,
              lines: entered,
            })
          );
      onSaved(saved);
    },
  });
}
