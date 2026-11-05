// A data table with search, sortable columns and pagination (SRS 16: pagination for large tables).
// Columns: { key, label, sort?: (row) => value | false, render?: (row) => Node|string, align? }.
import { h, uid } from "./dom.js";
import { emptyState } from "./kit.js";

export function dataTable({
  columns,
  rows,
  rowKey = (row) => row.id,
  searchText,
  pageSize = 10,
  empty,
  caption,
  rowClass,
}) {
  const view = { query: "", sortKey: null, descending: false, page: 0 };
  const root = h("div", { class: "table-wrap" });
  const searchId = uid("search");

  function filtered() {
    const query = view.query.trim().toLowerCase();
    let list =
      query && searchText
        ? rows.filter((row) => searchText(row).toLowerCase().includes(query))
        : [...rows];
    const column = columns.find((candidate) => candidate.key === view.sortKey);
    if (column && column.sort) {
      list.sort((a, b) => {
        const x = column.sort(a);
        const y = column.sort(b);
        const order =
          typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x ?? "").localeCompare(String(y ?? ""), undefined, {
                numeric: true,
                sensitivity: "base",
              });
        return view.descending ? -order : order;
      });
    }
    return list;
  }

  function draw() {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    view.page = Math.min(view.page, pages - 1);
    const slice = list.slice(view.page * pageSize, (view.page + 1) * pageSize);

    const head = columns.map((column) => {
      const sortable = typeof column.sort === "function";
      const active = view.sortKey === column.key;
      const label = h("span", {}, column.label);
      return h(
        "th",
        {
          scope: "col",
          class: column.align === "end" ? "end" : null,
          "aria-sort": sortable
            ? active
              ? view.descending
                ? "descending"
                : "ascending"
              : "none"
            : null,
        },
        sortable
          ? h(
              "button",
              {
                type: "button",
                class: "sort",
                onclick: () => {
                  view.descending = active ? !view.descending : false;
                  view.sortKey = column.key;
                  draw();
                },
              },
              label,
              h("span", { "aria-hidden": "true" }, active ? (view.descending ? " ▼" : " ▲") : " ↕")
            )
          : label
      );
    });

    const body = slice.map((row) =>
      h(
        "tr",
        { class: rowClass ? rowClass(row) : null, dataset: { key: rowKey(row) } },
        columns.map((column) =>
          h(
            "td",
            { class: column.align === "end" ? "end" : null },
            column.render ? column.render(row) : String(row[column.key] ?? "")
          )
        )
      )
    );

    const search = searchText
      ? h(
          "div",
          { class: "table-tools" },
          h("label", { for: searchId, class: "sr-only" }, "Search"),
          h("input", {
            id: searchId,
            type: "search",
            placeholder: "Search…",
            value: view.query,
            oninput: (event) => {
              view.query = event.target.value;
              view.page = 0;
              draw();
              const input = root.querySelector(`#${searchId}`);
              input.focus();
              input.setSelectionRange(input.value.length, input.value.length);
            },
          }),
          h("span", { class: "muted" }, `${list.length} of ${rows.length}`)
        )
      : null;

    const table = h(
      "table",
      { class: "table" },
      caption ? h("caption", { class: "sr-only" }, caption) : null,
      h("thead", {}, h("tr", {}, head)),
      h("tbody", {}, body)
    );

    const pager =
      pages > 1
        ? h(
            "nav",
            { class: "pager", "aria-label": "Pages" },
            h(
              "button",
              {
                type: "button",
                class: "btn btn-secondary",
                disabled: view.page === 0,
                onclick: () => {
                  view.page -= 1;
                  draw();
                },
              },
              "Previous"
            ),
            h("span", { class: "muted" }, `Page ${view.page + 1} of ${pages}`),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-secondary",
                disabled: view.page >= pages - 1,
                onclick: () => {
                  view.page += 1;
                  draw();
                },
              },
              "Next"
            )
          )
        : null;

    const nothing =
      rows.length === 0
        ? emptyState(empty ?? { title: "Nothing here yet" })
        : list.length === 0
          ? emptyState({ title: "No matches", body: "Try a different search." })
          : null;

    root.replaceChildren(
      ...[
        search,
        nothing ? null : h("div", { class: "table-scroll" }, table),
        nothing,
        pager,
      ].filter(Boolean)
    );
  }

  draw();
  return root;
}
