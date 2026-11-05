// Modal dialogs: a form dialog (fields, validation errors from the services, Esc to cancel) and a
// confirmation dialog. Uses the native <dialog> element for focus handling and falls back to the
// `open` attribute where showModal is unavailable.
import { activeElement, h, uid } from "./dom.js";
import { describe } from "./failure.js";

function open(dialog) {
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function close(dialog, returnTo) {
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  dialog.remove();
  if (returnTo && typeof returnTo.focus === "function" && returnTo.isConnected) returnTo.focus();
}

function buildField(field, values) {
  const id = uid("f");
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hint = field.hint ? h("small", { id: hintId, class: "muted" }, field.hint) : null;
  const error = h("small", { id: errorId, class: "field-error", role: "alert" });
  const describedby = [field.hint ? hintId : null, errorId].filter(Boolean).join(" ");
  const initial = values[field.name];
  let control;
  let read;
  let wrapper;

  if (field.type === "checkbox") {
    control = h("input", {
      id,
      type: "checkbox",
      checked: initial === true,
      "aria-describedby": describedby,
    });
    read = () => control.checked;
    wrapper = h(
      "div",
      { class: "field field-check" },
      h("label", { for: id }, control, " ", field.label),
      hint,
      error
    );
  } else if (field.type === "checkboxes") {
    const chosen = new Set(Array.isArray(initial) ? initial : []);
    const boxes = field.options.map((option, index) => {
      const box = h("input", {
        type: "checkbox",
        id: `${id}-${index}`,
        checked: chosen.has(option.value),
        disabled: option.disabled,
      });
      return {
        box,
        option,
        node: h(
          "label",
          { class: "check-option", for: `${id}-${index}` },
          box,
          h(
            "span",
            {},
            option.label,
            option.hint ? h("small", { class: "muted" }, ` ${option.hint}`) : null
          )
        ),
      };
    });
    read = () => boxes.filter((entry) => entry.box.checked).map((entry) => entry.option.value);
    wrapper = h(
      "fieldset",
      { class: "field", "aria-describedby": describedby },
      h("legend", {}, field.label),
      h(
        "div",
        { class: field.inline ? "check-row" : "check-list" },
        boxes.map((entry) => entry.node)
      ),
      hint,
      error
    );
  } else if (field.type === "select") {
    control = h(
      "select",
      { id, "aria-describedby": describedby },
      (field.options ?? []).map((option, index) =>
        h("option", { value: String(index), selected: option.value === initial }, option.label)
      )
    );
    read = () => field.options[Number(control.value)]?.value;
    wrapper = h(
      "div",
      { class: "field" },
      h("label", { for: id }, field.label),
      control,
      hint,
      error
    );
  } else if (field.type === "file") {
    // Reads the chosen image into a data URL; untouched means "no change" (undefined).
    let dataUrl;
    control = h("input", {
      id,
      type: "file",
      accept: field.accept,
      "aria-describedby": describedby,
    });
    control.addEventListener("change", () => {
      const file = control.files?.[0];
      if (!file) {
        dataUrl = undefined;
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        dataUrl = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
    read = () => dataUrl;
    wrapper = h(
      "div",
      { class: "field" },
      h("label", { for: id }, field.label),
      control,
      hint,
      error
    );
  } else if (field.type === "textarea") {
    control = h(
      "textarea",
      { id, rows: 3, placeholder: field.placeholder, "aria-describedby": describedby },
      initial ?? ""
    );
    read = () => control.value;
    wrapper = h(
      "div",
      { class: "field" },
      h("label", { for: id }, field.label),
      control,
      hint,
      error
    );
  } else {
    const type = field.type ?? "text";
    control = h("input", {
      id,
      type,
      value: initial ?? "",
      placeholder: field.placeholder,
      autocomplete: "off",
      min: field.min,
      max: field.max,
      step: field.step,
      maxlength: field.maxlength,
      "aria-describedby": describedby,
      readonly: field.readonly,
    });
    read = () =>
      type === "number"
        ? control.value === ""
          ? undefined
          : Number(control.value)
        : control.value;
    wrapper = h(
      "div",
      { class: "field" },
      h(
        "label",
        { for: id },
        field.label,
        field.required ? h("span", { class: "req", "aria-hidden": "true" }, " *") : null
      ),
      control,
      hint,
      error
    );
  }
  return { name: field.name, read, wrapper, error, control, field };
}

// Resolves true once onSubmit has succeeded, false when cancelled.
export function formDialog({
  title,
  description,
  fields = [],
  initial = {},
  submitLabel = "Save",
  danger = false,
  onSubmit,
  errorFields = {},
}) {
  return new Promise((resolve) => {
    const returnTo = activeElement();
    const built = fields.map((field) => buildField(field, initial));
    const banner = h("div", { class: "notice notice-bad", role: "alert", hidden: true });
    const titleId = uid("dlg");
    const submit = h(
      "button",
      { type: "submit", class: `btn ${danger ? "btn-danger" : "btn-primary"}` },
      submitLabel
    );
    const form = h(
      "form",
      { method: "dialog", novalidate: true },
      h("h2", { id: titleId }, title),
      description ? h("p", { class: "muted" }, description) : null,
      banner,
      built.map((entry) => entry.wrapper),
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          { type: "button", class: "btn btn-secondary", onclick: () => finish(false) },
          "Cancel"
        ),
        submit
      )
    );
    const dialog = h("dialog", { class: "dialog", "aria-labelledby": titleId }, form);
    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      close(dialog, returnTo);
      resolve(result);
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      banner.hidden = true;
      for (const entry of built) entry.error.textContent = "";
      const values = Object.fromEntries(built.map((entry) => [entry.name, entry.read()]));
      try {
        onSubmit(values);
        finish(true);
      } catch (error) {
        // A field named by the service wins, then the page's own code-to-field map; anything else
        // goes in the banner with its reference (D105).
        const { code, message, fields: named, reference } = describe(error);
        const byName = built.find((entry) => named[entry.name] !== undefined);
        const target = byName ?? built.find((entry) => entry.name === errorFields[code]);
        if (target) {
          target.error.textContent = byName ? named[target.name].join(" ") : message;
          target.control?.focus();
        } else {
          banner.textContent = reference === null ? message : `${message} (reference ${reference})`;
          banner.hidden = false;
        }
      }
    });
    open(dialog);
    (built.find((entry) => entry.control && !entry.field.readonly)?.control ?? submit).focus();
  });
}

// A yes/no question, optionally asking for a reason that is passed to onConfirm.
export function confirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  reason = false,
  reasonLabel = "Reason",
  onConfirm,
}) {
  return formDialog({
    title,
    description: message,
    fields: reason
      ? [{ name: "reason", label: reasonLabel, type: "textarea", required: true }]
      : [],
    submitLabel: confirmLabel,
    danger,
    onSubmit: (values) => onConfirm(values.reason?.trim()),
  });
}

// A dialog that only shows content.
export function infoDialog({ title, body, closeLabel = "Close" }) {
  return new Promise((resolve) => {
    const returnTo = activeElement();
    const titleId = uid("dlg");
    const dialog = h(
      "dialog",
      { class: "dialog dialog-wide", "aria-labelledby": titleId },
      h("h2", { id: titleId }, title),
      body,
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          { type: "button", class: "btn btn-primary", onclick: () => finish() },
          closeLabel
        )
      )
    );
    function finish() {
      close(dialog, returnTo);
      resolve();
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish();
    });
    open(dialog);
    dialog.querySelector("button")?.focus();
  });
}
