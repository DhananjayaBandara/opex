// Shared helpers for the organization pages: error code to field mapping and row actions.
import { confirmDialog } from "./dialog.js";
import { attempt, button } from "./kit.js";
import { session } from "./session.js";

// Which form field a service refusal belongs to (field-level messages, AC-2.4).
export const FIELD_ERRORS = {
  invalid_code: "code",
  duplicate: "code",
  invalid_name: "name",
  invalid_time: "startTime",
  invalid_shift_times: "endTime",
  invalid_machine_count: "machineCount",
  invalid_weekdays: "nonWorkingWeekdays",
  invalid_date: "date",
  invalid_email: "email",
};

export const org = (call) => session.run((ctx) => call(session.app.organization, ctx));

// Deactivate/reactivate/delete buttons for one row of an organization kind.
export function rowActions({ kind, row, noun, redraw, extra = [] }) {
  const label = row.name ?? noun;
  const buttons = [...extra];
  if (row.active !== undefined) {
    buttons.push(
      button(
        row.active ? "Deactivate" : "Reactivate",
        () => {
          attempt(
            () => org((o, ctx) => o.setActive(ctx, kind, row.id, !row.active)),
            row.active ? `${label} deactivated` : `${label} reactivated`
          );
          redraw();
        },
        { kind: "link" }
      )
    );
  }
  buttons.push(
    button(
      "Delete",
      () =>
        confirmDialog({
          title: `Delete ${noun}?`,
          message: `${label} will be removed. A record that is in use cannot be deleted; deactivate it instead.`,
          confirmLabel: "Delete",
          danger: true,
          onConfirm: () => {
            org((o, ctx) => o.remove(ctx, kind, row.id));
            redraw();
          },
        }),
      { kind: "link" }
    )
  );
  return buttons;
}
