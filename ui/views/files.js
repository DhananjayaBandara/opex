// Files, CSV imports and CSV exports in one place (SRS 14.3; architecture 16; D101 to D106).
//   Files    what a file is: name, kind, size, who registered it. The content is not kept (D101).
//   Imports  upload a CSV, see every row checked with the same rules as the Add form, then commit the
//            valid rows or cancel. Nothing is created until the commit.
//   Exports  a report as a CSV file; the same page as Reports > Exports.
import { CATEGORIES, CONTENT_TYPES } from "../../domain/files.js";
import { KINDS } from "../../domain/imports.js";
import { h, uid } from "../dom.js";
import { confirmDialog, formDialog } from "../dialog.js";
import { saveText } from "../download.js";
import {
  attempt,
  badge,
  busy,
  button,
  card,
  emptyState,
  formatInstant,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { session } from "../session.js";
import { dataTable } from "../table.js";
import { option, plural } from "./communication-common.js";
import { control } from "./production-common.js";
import { fileService, importService, tabBar } from "./platform-common.js";
import { panel as exportsPanel } from "./reports.js";

const contentTypeOptions = Object.entries(CONTENT_TYPES).map(([value, spec]) => ({
  value,
  label: spec.label,
}));
const categoryOptions = Object.entries(CATEGORIES).map(([value, spec]) => ({
  value,
  label: spec.label,
}));

const FILE_ERRORS = {
  invalid_name: "name",
  invalid_contentType: "contentType",
  invalid_category: "category",
  invalid_size: "size",
};

// ---- Files --------------------------------------------------------------------------------------------

function filesTab(state, redraw) {
  const list = fileService((s, ctx) => s.list(ctx, { category: state.category }));
  const mayRegister = session.can("file.manage") && !session.supporting;
  const register = () =>
    formDialog({
      title: "Register a file",
      description:
        "OPEX+ keeps the details of a file, never its content. Pick the file's real name, kind and size.",
      fields: [
        { name: "name", label: "File name", required: true, placeholder: "sewing-sop-v4.pdf" },
        { name: "contentType", label: "Kind of file", type: "select", options: contentTypeOptions },
        { name: "category", label: "Category", type: "select", options: categoryOptions },
        {
          name: "size",
          label: "Size in bytes",
          type: "number",
          min: 1,
          max: 5242880,
          required: true,
          hint: "Up to 5 MB",
        },
      ],
      initial: { contentType: "application/pdf", category: "attachment" },
      errorFields: FILE_ERRORS,
      submitLabel: "Register",
      onSubmit: (values) => {
        fileService((s, ctx) => s.register(ctx, values));
        toast("File registered", "good");
        redraw();
      },
    });

  return h(
    "div",
    {},
    notice(
      "The prototype keeps what a file is, not what it contains: no content is stored, scanned or served.",
      "info"
    ),
    card(
      "Registered files",
      h(
        "div",
        {},
        h(
          "div",
          { class: "table-tools" },
          control(
            "file-category",
            "Category",
            h(
              "select",
              {
                id: "file-category",
                onchange: (event) => {
                  state.category = event.target.value;
                  redraw();
                },
              },
              option("", "All categories", state.category === ""),
              categoryOptions.map((entry) =>
                option(entry.value, entry.label, entry.value === state.category)
              )
            )
          )
        ),
        dataTable({
          caption: "Registered files",
          pageSize: 10,
          columns: [
            { key: "name", label: "File", sort: (r) => r.name, render: (r) => r.name },
            { key: "type", label: "Kind", sort: (r) => r.typeLabel, render: (r) => r.typeLabel },
            {
              key: "category",
              label: "Category",
              sort: (r) => r.categoryLabel,
              render: (r) => r.categoryLabel,
            },
            {
              key: "size",
              label: "Size",
              align: "end",
              sort: (r) => r.size,
              render: (r) => r.sizeLabel,
            },
            {
              key: "by",
              label: "Registered by",
              sort: (r) => r.registeredByName,
              render: (r) => r.registeredByName,
            },
            {
              key: "when",
              label: "When",
              sort: (r) => r.registeredAt,
              render: (r) => formatInstant(r.registeredAt),
            },
            {
              key: "key",
              label: "Storage key",
              render: (r) => h("code", { class: "wrap" }, r.storageKey),
            },
          ],
          rows: list.items,
          rowKey: (r) => r.id,
          searchText: (r) => `${r.name} ${r.typeLabel} ${r.registeredByName}`,
          empty: {
            title: "No files registered",
            body: mayRegister
              ? "Register a file to see its details here."
              : "No files have been registered.",
          },
        })
      ),
      mayRegister ? button("Register a file", register, { kind: "primary" }) : null
    )
  );
}

// ---- Imports ------------------------------------------------------------------------------------------

const preview = (values) =>
  Object.values(values)
    .filter((value) => value !== "")
    .slice(0, 5)
    .join(" · ");

function reviewCard(state, redraw) {
  const job = importService((s, ctx) => s.get(ctx, state.openId));
  const staged = job.status === "staged";
  const commit = () =>
    confirmDialog({
      title: `Import ${plural(job.valid, "row")}?`,
      message: `${plural(job.valid, `${job.kindLabel.toLowerCase().replace(/s$/, "")}`)} will be created as if each had been added by hand. ${
        job.failed > 0 ? `${plural(job.failed, "row")} with a problem will be skipped.` : ""
      }`,
      confirmLabel: "Import",
      onConfirm: () => {
        const done = importService((s, ctx) => s.commit(ctx, job.id));
        toast(
          `${plural(done.created, "row")} imported${done.failedAtCommit > 0 ? `; ${done.failedAtCommit} could not be created` : ""}`,
          "good"
        );
        redraw();
      },
    });
  const cancel = () =>
    confirmDialog({
      title: "Cancel this import?",
      message: "Nothing has been created. The file stays in the history as cancelled.",
      confirmLabel: "Cancel import",
      danger: true,
      onConfirm: () => {
        importService((s, ctx) => s.cancel(ctx, job.id));
        toast("Import cancelled", "good");
        redraw();
      },
    });
  const report = () => {
    const file = attempt(() => importService((s, ctx) => s.errorReport(ctx, job.id)));
    if (file !== undefined) saveText(file.fileName, file.csv);
  };

  return card(
    `${job.fileName} · ${job.statusLabel}`,
    h(
      "div",
      {},
      h(
        "p",
        {},
        `${job.kindLabel}: ${plural(job.total, "row")} read, `,
        h("strong", {}, `${job.valid} ready`),
        job.failed > 0 ? [", ", h("strong", {}, `${job.failed} with a problem`)] : null,
        job.status === "committed"
          ? `. ${plural(job.created, "row")} created${job.failedAtCommit > 0 ? `, ${job.failedAtCommit} not created` : ""}.`
          : "."
      ),
      job.ignoredColumns.length > 0
        ? notice(`Columns ignored: ${job.ignoredColumns.join(", ")}.`, "info")
        : null,
      job.refusedColumns.length > 0
        ? notice(
            `Columns refused: ${job.refusedColumns.join(", ")}. An import never picks an organization or an id.`,
            "warn"
          )
        : null,
      dataTable({
        caption: "Rows of this import",
        pageSize: 10,
        columns: [
          {
            key: "n",
            label: "Row",
            align: "end",
            sort: (r) => r.number,
            render: (r) => String(r.number),
          },
          {
            key: "status",
            label: "Result",
            sort: (r) => r.status,
            render: (r) => statusBadge(r.status),
          },
          { key: "values", label: "Values", render: (r) => preview(r.values) },
          { key: "problem", label: "Problem", render: (r) => r.problem ?? "—" },
        ],
        rows: job.rows,
        rowKey: (r) => r.id,
        searchText: (r) => `${preview(r.values)} ${r.problem ?? ""}`,
        rowClass: (r) => (r.status === "failed" || r.status === "not_created" ? "row-bad" : null),
      }),
      h(
        "div",
        { class: "actions" },
        staged && job.valid > 0 ? button("Import valid rows", commit, { kind: "primary" }) : null,
        staged ? button("Cancel import", cancel, { kind: "danger" }) : null,
        job.failed + job.failedAtCommit > 0 ? button("Download the failed rows", report) : null,
        button("Close", () => {
          state.openId = null;
          redraw();
        })
      )
    )
  );
}

function importsTab(state, redraw) {
  const kinds = importService((s) => s.kinds()).filter((kind) =>
    session.can(KINDS[kind.key].permission)
  );
  const jobs = importService((s, ctx) => s.list(ctx));
  const mayStage = !session.supporting;
  if (!kinds.some((kind) => kind.key === state.kind)) state.kind = kinds[0]?.key ?? "";
  const chosen = kinds.find((kind) => kind.key === state.kind);

  const nameId = uid("imp-name");
  const textId = uid("imp-text");
  const nameInput = h("input", {
    id: nameId,
    value: state.fileName,
    placeholder: "buyers.csv",
    onchange: (event) => (state.fileName = event.target.value),
  });
  const textInput = h("textarea", {
    id: textId,
    rows: 6,
    placeholder: "Paste the CSV here, header row first",
    onchange: (event) => (state.content = event.target.value),
  });
  textInput.value = state.content;
  const picker = h("input", {
    id: uid("imp-file"),
    type: "file",
    accept: ".csv,text/csv",
    onchange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      state.fileName = file.name;
      state.content = await file.text();
      nameInput.value = state.fileName;
      textInput.value = state.content;
    },
  });
  picker.setAttribute("aria-label", "CSV file");

  const download = () => {
    const file = attempt(() => importService((s, ctx) => s.template(ctx, state.kind)));
    if (file !== undefined) saveText(file.fileName, file.csv);
  };
  const stage = (event) =>
    busy(event, "Checking rows…", () => {
      state.fileName = nameInput.value;
      state.content = textInput.value;
      const job = attempt(() =>
        importService((s, ctx) =>
          s.stage(ctx, { kind: state.kind, fileName: state.fileName, content: state.content })
        )
      );
      if (job !== undefined) {
        state.openId = job.id;
        state.fileName = "";
        state.content = "";
        toast(`${job.fileName} checked: ${job.valid} of ${job.total} rows are ready`, "good");
        redraw();
      }
    });

  return h(
    "div",
    {},
    mayStage
      ? card(
          "Import a CSV",
          kinds.length === 0
            ? h("p", { class: "muted" }, "Your role does not include a kind of import.")
            : h(
                "div",
                { class: "stack" },
                h(
                  "p",
                  { class: "muted" },
                  "Every row is checked with the same rules as the Add form. Nothing is created until you import the valid rows. Up to 500 rows."
                ),
                h(
                  "div",
                  { class: "table-tools" },
                  control(
                    "imp-kind",
                    "What to import",
                    h(
                      "select",
                      {
                        id: "imp-kind",
                        onchange: (event) => {
                          state.fileName = nameInput.value;
                          state.content = textInput.value;
                          state.kind = event.target.value;
                          redraw();
                        },
                      },
                      kinds.map((kind) => option(kind.key, kind.label, kind.key === state.kind))
                    )
                  ),
                  button("Download the template", download)
                ),
                chosen
                  ? h(
                      "p",
                      { class: "muted" },
                      "Columns: ",
                      chosen.columns.map((column) => column.label).join(", "),
                      "."
                    )
                  : null,
                h("div", { class: "field" }, h("label", { for: picker.id }, "CSV file"), picker),
                h("div", { class: "field" }, h("label", { for: nameId }, "File name"), nameInput),
                h(
                  "div",
                  { class: "field" },
                  h("label", { for: textId }, "or paste the contents"),
                  textInput
                ),
                h("div", { class: "actions" }, button("Check the rows", stage, { kind: "primary" }))
              )
        )
      : null,
    state.openId !== null ? reviewCard(state, redraw) : null,
    card(
      "Import history",
      dataTable({
        caption: "CSV imports",
        pageSize: 10,
        columns: [
          { key: "file", label: "File", sort: (r) => r.fileName, render: (r) => r.fileName },
          { key: "kind", label: "Imports", sort: (r) => r.kindLabel, render: (r) => r.kindLabel },
          {
            key: "status",
            label: "Status",
            sort: (r) => r.status,
            render: (r) => statusBadge(r.status),
          },
          {
            key: "rows",
            label: "Rows",
            align: "end",
            sort: (r) => r.total,
            render: (r) => `${r.valid} ready · ${r.failed} with a problem · ${r.created} created`,
          },
          { key: "by", label: "By", sort: (r) => r.stagedByName, render: (r) => r.stagedByName },
          {
            key: "when",
            label: "When",
            sort: (r) => r.stagedAt,
            render: (r) => formatInstant(r.stagedAt),
          },
          {
            key: "open",
            label: "",
            align: "end",
            render: (r) =>
              button(
                r.status === "staged" ? "Review" : "View",
                () => {
                  state.openId = r.id;
                  redraw();
                },
                { kind: "link" }
              ),
          },
        ],
        rows: jobs,
        rowKey: (r) => r.id,
        searchText: (r) => `${r.fileName} ${r.kindLabel} ${r.stagedByName}`,
        empty: {
          title: "No imports yet",
          body: "Imported files and their results are listed here.",
        },
      })
    )
  );
}

// ---- The page -----------------------------------------------------------------------------------------

export function render() {
  const root = h("div");
  const state = { tab: "", category: "", kind: "", fileName: "", content: "", openId: null };
  mount(root, (redraw) => {
    const tabs = [
      session.can("file.view") ? { id: "files", label: "Files" } : null,
      session.can("import.manage") && !session.supporting
        ? { id: "imports", label: "Imports" }
        : null,
      session.can("export.create") && !session.supporting
        ? { id: "exports", label: "Exports" }
        : null,
    ].filter(Boolean);
    if (tabs.length === 0) {
      return h(
        "div",
        {},
        pageHeader("Files, imports and exports"),
        emptyState({
          title: "Nothing here for your role",
          body: "This page needs the permission to view files, run imports or export reports.",
        })
      );
    }
    if (!tabs.some((tab) => tab.id === state.tab)) state.tab = tabs[0].id;
    return h(
      "div",
      {},
      pageHeader(
        "Files, imports and exports",
        "File details, CSV imports with row-by-row checking, and CSV exports of reports."
      ),
      session.supporting ? notice("Read-only support access.", "warn") : null,
      tabBar("Files, imports and exports", tabs, state, redraw),
      state.tab === "files"
        ? filesTab(state, redraw)
        : state.tab === "imports"
          ? importsTab(state, redraw)
          : exportsPanel()
    );
  });
  return root;
}
