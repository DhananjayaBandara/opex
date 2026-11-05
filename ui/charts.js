// Small chart kit for the dashboards (D58): a line or column chart in SVG, ranked bars and a segmented
// bar in HTML, a legend, a shared tooltip and a card with a Chart/Table switch. Colours come from the
// `--viz-*` tokens in styles.css (validated for light and dark); text never wears a series colour.
// Every chart has a table view, a legend when it has two series or more, and hover and keyboard
// tooltips that show the figures as plain text. Browser-only.
import { h } from "./dom.js";
import { dataTable } from "./table.js";

const NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, ...children) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined && value !== false) {
      element.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

// ---- Text ---------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const formatCount = (value) =>
  value === null || value === undefined ? "—" : number.format(value);

export const formatPercent = (value, digits = 1) =>
  value === null || value === undefined ? "—" : `${value.toFixed(digits)}%`;

// "3 Nov" for an axis, "Tue 3 Nov 2026" for a tooltip.
export const shortDate = (key) => {
  const [, month, day] = String(key).split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
};
export const fullDate = (key) => {
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? String(key)
    : `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

// ---- Tooltip (one shared element, plain text only) ----------------------------------------------

let tip = null;
let tipListening = false;

function tipElement() {
  if (tip === null || !tip.isConnected) {
    tip = h("div", { class: "viz-tip", role: "status", "aria-live": "polite", hidden: true });
    document.body.append(tip);
  }
  if (!tipListening) {
    tipListening = true;
    window.addEventListener("hashchange", hideTip);
  }
  return tip;
}

export function hideTip() {
  if (tip !== null) tip.hidden = true;
}

// rows: [{ label, value, tone? }]; x and y are viewport coordinates of the point being described.
export function showTip({ x, y, title, rows }) {
  const element = tipElement();
  element.replaceChildren(
    h("strong", {}, title),
    ...rows.map((row) =>
      h(
        "div",
        { class: "viz-tip-row" },
        row.tone
          ? h("span", { class: `viz-swatch viz-s${row.tone}`, "aria-hidden": "true" })
          : null,
        h("span", {}, row.label),
        h("span", { class: "num" }, row.value)
      )
    )
  );
  element.hidden = false;
  const box = element.getBoundingClientRect();
  const left = Math.max(8, Math.min(x + 14, window.innerWidth - box.width - 8));
  const top = Math.max(8, Math.min(y + 14, window.innerHeight - box.height - 8));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

// ---- Legend -------------------------------------------------------------------------------------

// items: [{ label, tone, dashed? }]. A single series needs none: the card title names it.
export const legend = (items) =>
  h(
    "ul",
    { class: "viz-legend", "aria-label": "Legend" },
    items.map((item) =>
      h(
        "li",
        {},
        h("span", {
          class: `viz-swatch viz-s${item.tone}${item.dashed ? " viz-swatch-dashed" : ""}`,
          "aria-hidden": "true",
        }),
        item.label
      )
    )
  );

// ---- Stat tile ----------------------------------------------------------------------------------

export const statTile = (label, value, note) =>
  h(
    "div",
    { class: "stat" },
    h("strong", {}, value),
    h("span", {}, label),
    note ? h("small", { class: "muted" }, note) : null
  );

// ---- Cartesian chart (line or column) -----------------------------------------------------------

const WIDTH = 640;
const HEIGHT = 260;
const MARGIN = { top: 12, right: 64, bottom: 30, left: 52 };

function niceScale(max, target = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let value = 0; value <= top + step / 1000; value += step) ticks.push(value);
  return { max: top, ticks };
}

// Rounded data end (4px) and a square baseline for a column.
const columnPath = (x, top, width, baseline) => {
  const radius = Math.min(4, width / 2, baseline - top);
  return `M${x},${baseline} L${x},${top + radius} Q${x},${top} ${x + radius},${top} L${x + width - radius},${top} Q${x + width},${top} ${x + width},${top + radius} L${x + width},${baseline} Z`;
};

// categories: [{ key, label, full }]; series: [{ id, label, tone, values, dashed? }] with one value per
// category (null leaves a gap); reference: { value, label } draws a dashed target line.
export function cartesianChart({
  kind = "line",
  categories,
  series,
  yFormat = formatCount,
  valueFormat = yFormat,
  reference = null,
  ariaLabel,
}) {
  const count = categories.length;
  const inner = {
    width: WIDTH - MARGIN.left - MARGIN.right,
    height: HEIGHT - MARGIN.top - MARGIN.bottom,
  };
  const seen = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  const { max, ticks } = niceScale(Math.max(0, reference?.value ?? 0, ...seen));
  const band = inner.width / Math.max(count, 1);
  const xAt = (index) =>
    kind === "column"
      ? MARGIN.left + band * (index + 0.5)
      : count === 1
        ? MARGIN.left + inner.width / 2
        : MARGIN.left + (inner.width * index) / (count - 1);
  const yAt = (value) => MARGIN.top + inner.height - (value / max) * inner.height;
  const baseline = yAt(0);

  const parts = [];
  for (const tick of ticks) {
    parts.push(
      svg("line", {
        class: tick === 0 ? "viz-axis" : "viz-grid",
        x1: MARGIN.left,
        x2: WIDTH - MARGIN.right,
        y1: yAt(tick),
        y2: yAt(tick),
      }),
      svg(
        "text",
        { class: "viz-tick", x: MARGIN.left - 8, y: yAt(tick) + 4, "text-anchor": "end" },
        yFormat(tick)
      )
    );
  }
  const labelStep = Math.max(1, Math.ceil(count / 8));
  categories.forEach((category, index) => {
    if (index % labelStep !== 0) return;
    parts.push(
      svg(
        "text",
        { class: "viz-tick", x: xAt(index), y: HEIGHT - 10, "text-anchor": "middle" },
        category.label
      )
    );
  });

  if (reference) {
    parts.push(
      svg("line", {
        class: "viz-ref",
        x1: MARGIN.left,
        x2: WIDTH - MARGIN.right,
        y1: yAt(reference.value),
        y2: yAt(reference.value),
      }),
      svg(
        "text",
        { class: "viz-label", x: WIDTH - MARGIN.right + 6, y: yAt(reference.value) + 4 },
        reference.label
      )
    );
  }

  const bars = [];
  if (kind === "column") {
    const width = Math.min(24, band * 0.6);
    const only = series[0];
    only.values.forEach((value, index) => {
      if (value === null || value === undefined || value <= 0) return;
      bars[index] = svg("path", {
        class: `viz-bar viz-s${only.tone}`,
        d: columnPath(xAt(index) - width / 2, yAt(value), width, baseline),
      });
      parts.push(bars[index]);
    });
  } else {
    const ends = [];
    for (const item of series) {
      let path = "";
      let pen = false;
      item.values.forEach((value, index) => {
        if (value === null || value === undefined) {
          pen = false;
          return;
        }
        path += `${pen ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)} `;
        pen = true;
      });
      parts.push(
        svg("path", {
          class: `viz-line viz-s${item.tone}${item.dashed ? " viz-dashed" : ""}`,
          d: path.trim(),
        })
      );
      if (count <= 31) {
        item.values.forEach((value, index) => {
          if (value === null || value === undefined) return;
          parts.push(
            svg("circle", {
              class: `viz-dot viz-s${item.tone}`,
              cx: xAt(index),
              cy: yAt(value),
              r: 4,
            })
          );
        });
      }
      const last = item.values.findLastIndex((v) => v !== null && v !== undefined);
      if (last >= 0) ends.push({ label: item.label, x: xAt(last), y: yAt(item.values[last]) });
    }
    // Direct labels at the line ends (for up to four series), nudged apart so they do not overlap.
    if (series.length >= 2 && series.length <= 4) {
      ends.sort((a, b) => a.y - b.y);
      ends.forEach((end, index) => {
        if (index > 0 && end.y - ends[index - 1].y < 13) end.y = ends[index - 1].y + 13;
        parts.push(svg("text", { class: "viz-label", x: end.x + 10, y: end.y + 4 }, end.label));
      });
    }
  }

  // The cursor: a vertical line and a dot per series on the category under the pointer or focus.
  const cursorLine = svg("line", {
    class: "viz-cursor",
    y1: MARGIN.top,
    y2: baseline,
    visibility: "hidden",
  });
  const cursorDots =
    kind === "line"
      ? series.map((item) =>
          svg("circle", {
            class: `viz-dot viz-dot-active viz-s${item.tone}`,
            r: 5,
            visibility: "hidden",
          })
        )
      : [];
  const hit = svg("rect", {
    class: "viz-hit",
    x: MARGIN.left,
    y: MARGIN.top,
    width: inner.width,
    height: inner.height,
  });
  const root = svg(
    "svg",
    {
      class: "viz-chart",
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      role: "group",
      "aria-label": `${ariaLabel}. Use the left and right arrow keys to read each point, or open the table.`,
      tabindex: 0,
      preserveAspectRatio: "xMidYMid meet",
    },
    ...parts,
    cursorLine,
    ...cursorDots,
    hit
  );

  let active = -1;
  const show = (index) => {
    if (index < 0 || index >= count) return;
    active = index;
    cursorLine.setAttribute("x1", xAt(index));
    cursorLine.setAttribute("x2", xAt(index));
    cursorLine.setAttribute("visibility", kind === "line" ? "visible" : "hidden");
    series.forEach((item, position) => {
      const value = item.values[index];
      const dot = cursorDots[position];
      if (!dot) return;
      if (value === null || value === undefined) dot.setAttribute("visibility", "hidden");
      else {
        dot.setAttribute("cx", xAt(index));
        dot.setAttribute("cy", yAt(value));
        dot.setAttribute("visibility", "visible");
      }
    });
    bars.forEach((bar, position) => bar?.classList.toggle("viz-active", position === index));
    const box = root.getBoundingClientRect();
    const scale = box.width > 0 ? box.width / WIDTH : 1;
    const value0 = series[0].values[index];
    showTip({
      x: box.left + xAt(index) * scale,
      y: box.top + (value0 === null || value0 === undefined ? MARGIN.top : yAt(value0)) * scale,
      title: categories[index].full ?? categories[index].label,
      rows: series.map((item) => ({
        label: item.label,
        tone: item.tone,
        value: valueFormat(item.values[index]),
      })),
    });
  };
  const clear = () => {
    active = -1;
    cursorLine.setAttribute("visibility", "hidden");
    cursorDots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
    bars.forEach((bar) => bar?.classList.remove("viz-active"));
    hideTip();
  };
  const indexAt = (clientX) => {
    const box = root.getBoundingClientRect();
    if (box.width === 0) return -1;
    const x = ((clientX - box.left) / box.width) * WIDTH;
    const raw =
      kind === "column"
        ? Math.floor((x - MARGIN.left) / band)
        : count === 1
          ? 0
          : Math.round(((x - MARGIN.left) / inner.width) * (count - 1));
    return Math.max(0, Math.min(count - 1, raw));
  };
  hit.addEventListener("pointermove", (event) => show(indexAt(event.clientX)));
  hit.addEventListener("pointerleave", clear);
  root.addEventListener("focus", () => show(active >= 0 ? active : 0));
  root.addEventListener("blur", clear);
  root.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") show(Math.min(count - 1, active + 1));
    else if (event.key === "ArrowLeft") show(Math.max(0, active - 1));
    else if (event.key === "Home") show(0);
    else if (event.key === "End") show(count - 1);
    else if (event.key === "Escape") clear();
    else return;
    event.preventDefault();
  });
  // Exposed so a caller (and a smoke check) can read a point without a pointer.
  root.showPoint = show;
  return root;
}

// ---- Ranked horizontal bars ---------------------------------------------------------------------

// rows: [{ label, value, href?, detail?: [{ label, value }] }]. The bar length is the value against
// the largest value (or `max`), so rows compare at a glance; the number is always printed.
export function rankedBars({ rows, format = formatCount, tone = 1, max, ariaLabel }) {
  const top = max ?? Math.max(0, ...rows.map((row) => row.value ?? 0));
  return h(
    "ol",
    { class: "viz-ranked", "aria-label": ariaLabel },
    rows.map((row) => {
      const share = top > 0 && row.value > 0 ? Math.min(100, (row.value / top) * 100) : 0;
      const tell = (event) =>
        showTip({
          x: event.clientX ?? 0,
          y: event.clientY ?? 0,
          title: row.label,
          rows: [{ label: ariaLabel ?? "Value", value: format(row.value) }, ...(row.detail ?? [])],
        });
      const item = h(
        "li",
        {
          tabindex: row.href ? null : 0,
          onpointermove: tell,
          onpointerleave: hideTip,
          onfocusin: (event) => {
            const box = event.currentTarget.getBoundingClientRect();
            tell({ clientX: box.left + 24, clientY: box.top });
          },
          onfocusout: hideTip,
        },
        h(
          "span",
          { class: "viz-rank-label" },
          row.href ? h("a", { href: row.href }, row.label) : row.label
        ),
        h(
          "span",
          { class: "viz-rank-track", "aria-hidden": "true" },
          h("span", { class: `viz-rank-bar viz-s${tone}`, style: `width:${share.toFixed(1)}%` })
        ),
        h("span", { class: "viz-rank-value num" }, format(row.value))
      );
      return item;
    })
  );
}

// ---- Segmented bar (one whole split into parts) --------------------------------------------------

// segments: [{ label, value, tone }]. The legend stays with the bar and prints each count and share.
export function segmentedBar({ segments, ariaLabel, empty = "Nothing recorded." }) {
  const total = segments.reduce((sum, segment) => sum + (segment.value ?? 0), 0);
  if (total === 0) return h("p", { class: "muted" }, empty);
  return h(
    "div",
    { class: "viz-segmented", role: "group", "aria-label": ariaLabel },
    h(
      "div",
      { class: "viz-seg-track", "aria-hidden": "true" },
      segments
        .filter((segment) => segment.value > 0)
        .map((segment) =>
          h("span", {
            class: `viz-seg viz-s${segment.tone}`,
            style: `flex:${segment.value}`,
            title: `${segment.label}: ${formatCount(segment.value)}`,
          })
        )
    ),
    h(
      "ul",
      { class: "viz-legend viz-legend-values" },
      segments.map((segment) =>
        h(
          "li",
          {},
          h("span", { class: `viz-swatch viz-s${segment.tone}`, "aria-hidden": "true" }),
          h("span", {}, segment.label),
          h("strong", { class: "num" }, formatCount(segment.value)),
          h("span", { class: "muted" }, `${((segment.value / total) * 100).toFixed(0)}%`)
        )
      )
    )
  );
}

// ---- Card with a Chart/Table switch -------------------------------------------------------------

// table: { columns, rows, rowKey?, caption? } for dataTable; every chart has one.
export function chartCard({ title, note, key, chart, table, legendItems }) {
  const body = h("div", { class: "viz-body" });
  const state = { table: false };
  const switcher = h("button", {
    type: "button",
    class: "btn btn-secondary",
    "aria-pressed": "false",
    onclick: () => {
      state.table = !state.table;
      draw();
    },
  });
  function draw() {
    hideTip();
    switcher.textContent = state.table ? "Show chart" : "Show table";
    switcher.setAttribute("aria-pressed", String(state.table));
    body.replaceChildren(
      state.table
        ? dataTable({ pageSize: 10, rowKey: key ?? ((row) => row.key ?? row.label), ...table })
        : h("div", {}, legendItems?.length >= 2 ? legend(legendItems) : null, chart)
    );
  }
  draw();
  return h(
    "section",
    { class: "card viz" },
    h("div", { class: "card-head" }, h("h2", {}, title), h("div", { class: "actions" }, switcher)),
    note ? h("p", { class: "muted viz-note" }, note) : null,
    body
  );
}
