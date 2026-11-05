// Operational comments (C070, C071; D66, D67): short notes on a factory, optionally a line and shift,
// with employees tagged. A comment is never deleted; its author can correct it with a reason and the
// earlier text stays in its history. A tag is a reference, not a notification.
import { h } from "../dom.js";
import { badge, button, card, emptyState, formatInstant, mount, pageHeader } from "../kit.js";
import { formDialog, infoDialog } from "../dialog.js";
import { commentService, dateControl, plural, selectControl } from "./communication-common.js";
import { control } from "./production-common.js";

const WHOLE_FACTORY = "";

const employeeOptions = (employees, keep = []) => {
  const known = new Set(employees.map((employee) => employee.id));
  return [...employees, ...keep.filter((mention) => !known.has(mention.id))].map((employee) => ({
    value: employee.id,
    label: `${employee.employeeCode} · ${employee.name}`,
  }));
};

const where = (entry) =>
  [entry.factoryName, entry.lineName, entry.shiftName].filter((part) => part).join(" · ");

function compose(options, redraw) {
  return formDialog({
    title: "Add a comment",
    description:
      "A short note for the people who run this factory. Tagging an employee refers to them; it does not send a notification.",
    fields: [
      {
        name: "lineId",
        label: "Line",
        type: "select",
        options: [
          { value: WHOLE_FACTORY, label: "Whole factory" },
          ...options.lines.map((line) => ({
            value: line.id,
            label: line.sectionName ? `${line.name} (${line.sectionName})` : line.name,
          })),
        ],
        hint: "Choose a line and a shift together, or leave both for a factory-wide note.",
      },
      {
        name: "shiftId",
        label: "Shift",
        type: "select",
        options: [
          { value: WHOLE_FACTORY, label: "No shift" },
          ...options.shifts.map((shift) => ({ value: shift.id, label: shift.name })),
        ],
      },
      { name: "onDate", label: "Day it is about", type: "date", max: options.today },
      { name: "body", label: "Comment", type: "textarea", required: true },
      {
        name: "mentionIds",
        label: "Tag employees",
        type: "checkboxes",
        options: employeeOptions(options.employees),
      },
    ],
    initial: { onDate: options.today, body: "", mentionIds: [] },
    submitLabel: "Add comment",
    errorFields: {
      invalid_comment: "body",
      future_date: "onDate",
      line_and_shift_together: "shiftId",
      shift_not_run: "shiftId",
    },
    onSubmit: (values) =>
      commentService((s, ctx) =>
        s.create(ctx, {
          factoryId: options.factoryId,
          lineId: values.lineId || undefined,
          shiftId: values.shiftId || undefined,
          onDate: values.onDate || undefined,
          body: values.body,
          mentionIds: values.mentionIds,
        })
      ),
  }).then((saved) => saved && redraw());
}

function edit(entry, redraw) {
  const options = commentService((s, ctx) => s.options(ctx, { factoryId: entry.factoryId }));
  return formDialog({
    title: "Edit comment",
    description: "The text you replace stays in the comment's history, with your reason.",
    fields: [
      { name: "body", label: "Comment", type: "textarea", required: true },
      {
        name: "mentionIds",
        label: "Tag employees",
        type: "checkboxes",
        options: employeeOptions(options.employees, entry.mentions),
      },
      {
        name: "reason",
        label: "Reason for the change",
        type: "text",
        required: true,
        maxlength: 200,
      },
    ],
    initial: {
      body: entry.body,
      mentionIds: entry.mentions.map((mention) => mention.id),
      reason: "",
    },
    submitLabel: "Save change",
    errorFields: {
      invalid_comment: "body",
      reason_required: "reason",
    },
    onSubmit: (values) =>
      commentService((s, ctx) =>
        s.edit(ctx, entry.id, {
          body: values.body,
          mentionIds: values.mentionIds,
          reason: values.reason,
          expectedRevision: entry.revision,
        })
      ),
  }).then((saved) => saved && redraw());
}

function history(entry) {
  const full = commentService((s, ctx) => s.get(ctx, entry.id));
  const tagged = (mentions) =>
    mentions.length === 0
      ? null
      : h(
          "p",
          { class: "muted" },
          `Tagged: ${mentions.map((m) => `${m.employeeCode} ${m.name}`).join(", ")}`
        );
  return infoDialog({
    title: "History of this comment",
    body: h(
      "ol",
      { class: "revision-list" },
      h(
        "li",
        {},
        h("strong", {}, `Current text (version ${full.revision})`),
        h("p", { class: "comment-body" }, full.body),
        tagged(full.mentions)
      ),
      full.revisions.map((revision) =>
        h(
          "li",
          {},
          h(
            "strong",
            {},
            `Version ${revision.revision}, written ${formatInstant(revision.writtenAt)}`
          ),
          h("p", { class: "comment-body" }, revision.body),
          tagged(revision.mentions),
          h(
            "p",
            { class: "muted" },
            `Replaced ${formatInstant(revision.supersededAt)}. Reason: ${revision.reason}`
          )
        )
      )
    ),
  });
}

function commentCard(entry, redraw) {
  return h(
    "li",
    { class: `comment${entry.mine ? " comment-mine" : ""}`, dataset: { id: entry.id } },
    h(
      "div",
      { class: "comment-head" },
      h("strong", {}, entry.author.name ?? "Someone"),
      h("span", { class: "muted" }, ` · ${formatInstant(entry.createdAt)}`),
      entry.mine ? badge("yours", "info") : null,
      entry.revisionCount > 0 ? badge("edited", "muted") : null
    ),
    h("p", { class: "muted" }, `${where(entry)} · day ${entry.onDate}`),
    h("p", { class: "comment-body" }, entry.body),
    entry.mentions.length === 0
      ? null
      : h(
          "p",
          { class: "comment-tags" },
          "Tagged: ",
          entry.mentions.map((mention) =>
            badge(`${mention.employeeCode} · ${mention.name}`, "neutral")
          )
        ),
    h(
      "div",
      { class: "actions" },
      entry.mine ? button("Edit", () => edit(entry, redraw), { kind: "secondary" }) : null,
      entry.revisionCount > 0
        ? button(
            `History (${plural(entry.revisionCount, "earlier version")})`,
            () => history(entry),
            {
              kind: "link",
            }
          )
        : null
    )
  );
}

export function render() {
  const root = h("div");
  const state = { factoryId: "", from: "", to: "", mine: false };
  mount(root, (redraw) => {
    const options = commentService((s, ctx) => s.options(ctx, { factoryId: state.factoryId }));
    state.factoryId = options.factoryId ?? "";
    if (options.factoryId === null) {
      return h(
        "div",
        {},
        pageHeader("Operational comments"),
        emptyState({
          title: "No factory to show",
          body: "Comments are kept per factory. You do not have a factory in your scope yet.",
        })
      );
    }
    const view = commentService((s, ctx) =>
      s.list(ctx, {
        factoryId: state.factoryId,
        from: state.from,
        to: state.to,
        mine: state.mine,
      })
    );
    const set = (key) => (value) => {
      state[key] = value;
      redraw();
    };
    return h(
      "div",
      {},
      pageHeader(
        "Operational comments",
        "Notes about what happened on a line or in a factory, and who was involved.",
        options.canWrite
          ? button("Add a comment", () => compose(options, redraw), { kind: "primary" })
          : null
      ),
      h(
        "div",
        { class: "table-tools" },
        selectControl(
          "cm-factory",
          "Factory",
          options.factories,
          state.factoryId,
          set("factoryId"),
          null
        ),
        dateControl("cm-from", "From", state.from, options.today, set("from")),
        dateControl("cm-to", "To", state.to, options.today, set("to")),
        control(
          "cm-mine",
          "Only mine",
          h("input", {
            id: "cm-mine",
            type: "checkbox",
            checked: state.mine,
            onchange: (event) => set("mine")(event.target.checked),
          })
        ),
        h(
          "span",
          { class: "muted" },
          view.total > view.items.length
            ? `Showing the latest ${view.items.length} of ${view.total}`
            : plural(view.total, "comment")
        )
      ),
      card(
        null,
        view.items.length === 0
          ? emptyState({
              title: "No comments match",
              body: options.canWrite
                ? "Add a comment to record what happened on a line or in the factory."
                : "Nothing has been recorded for these filters.",
            })
          : h(
              "ul",
              { class: "comment-list" },
              view.items.map((entry) => commentCard(entry, redraw))
            )
      )
    );
  });
  return root;
}
