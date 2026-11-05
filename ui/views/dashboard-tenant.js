// Tenant overview: the cards a person may use, in the order that suits their role (UC-MGT-05,
// FR-PROD-011, D53, D57, D59). A card the person has no permission for is not drawn at all.
import { h } from "../dom.js";
import { EXCEPTION_KINDS } from "../../domain/scoring.js";
import {
  chartCard,
  formatCount,
  formatPercent,
  rankedBars,
  segmentedBar,
  statTile,
} from "../charts.js";
import { badge, card, emptyState, mount, pageHeader, statusBadge } from "../kit.js";
import { dataTable } from "../table.js";
import {
  dashboards,
  emptyFilters,
  filterQuery,
  filterRow,
  headlineStats,
  healthBadge,
  notApprovedNotice,
  outputCard,
  periodText,
} from "./dashboard-common.js";
import { moneyText } from "./orders-common.js";
import { count, dayAddress, percent } from "./production-common.js";

// ---- Cards --------------------------------------------------------------------------------------

function headlineCard(data) {
  return card(
    "Headline figures",
    h("div", {}, headlineStats(data.figures), notApprovedNotice(data.notApproved))
  );
}

function factoryHealthCard(rows) {
  if (rows.length === 0) {
    return card("Factory health", emptyState({ title: "No factories in your scope" }));
  }
  const ranked = [...rows].sort(
    (a, b) => (b.piecesHitRate ?? -1) - (a.piecesHitRate ?? -1) || a.label.localeCompare(b.label)
  );
  return chartCard({
    title: "Factory health",
    note: "Pieces made against plan on approved days. A factory with no approved day shows a dash.",
    chart: rankedBars({
      ariaLabel: "Pieces against plan",
      rows: ranked.map((row) => ({
        label: row.label,
        value: row.piecesHitRate,
        detail: [
          { label: "Pieces made", value: formatCount(row.actualPieces) },
          { label: "Planned", value: formatCount(row.plannedPieces) },
          { label: "Approved days", value: count(row.days) },
          { label: "Not yet approved", value: count(row.notApprovedDays) },
        ],
      })),
      format: (value) => formatPercent(value),
      max: Math.max(100, ...ranked.map((row) => row.piecesHitRate ?? 0)),
    }),
    table: {
      caption: "Factory health",
      rowKey: (row) => row.factoryId,
      columns: [
        { key: "factory", label: "Factory", sort: (r) => r.label, render: (r) => r.label },
        {
          key: "days",
          label: "Approved days",
          align: "end",
          sort: (r) => r.days,
          render: (r) => count(r.days),
        },
        {
          key: "planned",
          label: "Planned",
          align: "end",
          sort: (r) => r.plannedPieces ?? -1,
          render: (r) => formatCount(r.plannedPieces),
        },
        {
          key: "actual",
          label: "Made",
          align: "end",
          sort: (r) => r.actualPieces ?? -1,
          render: (r) => formatCount(r.actualPieces),
        },
        {
          key: "hit",
          label: "Against plan",
          sort: (r) => r.piecesHitRate ?? -1,
          render: (r) => healthBadge(r.piecesHitRate, r.band),
        },
        {
          key: "eff",
          label: "Efficiency",
          align: "end",
          sort: (r) => r.actualEfficiency ?? -1,
          render: (r) => percent(r.actualEfficiency),
        },
        {
          key: "open",
          label: "Not yet approved",
          align: "end",
          sort: (r) => r.notApprovedDays,
          render: (r) => count(r.notApprovedDays),
        },
      ],
      rows,
    },
  });
}

// Today's lines by where their day stands, and the days waiting for an approver.
function dayStatusCard(data) {
  const parts = [
    ["approved", data.approved],
    ["pending_approval", data.pending_approval],
    ["draft", data.draft],
  ];
  return card(
    `Today's production · ${data.date}`,
    h(
      "div",
      {},
      data.lines === 0
        ? h("p", { class: "muted" }, "No active lines run today in this view.")
        : h(
            "ul",
            { class: "dash-list" },
            parts.map(([status, total]) =>
              h("li", {}, statusBadge(status), " ", h("strong", {}, count(total)))
            ),
            h(
              "li",
              {},
              badge("not opened", "neutral"),
              " ",
              h("strong", {}, count(data.notOpened))
            ),
            h("li", {}, badge("no plan", "muted"), " ", h("strong", {}, count(data.noPlan)))
          ),
      data.pending.length === 0
        ? null
        : h(
            "div",
            {},
            h("h3", {}, "Waiting for approval"),
            h(
              "ul",
              { class: "dash-list" },
              data.pending.map((row) =>
                h(
                  "li",
                  {},
                  h("a", { href: dayAddress(row.dayId) }, `${row.lineName} · ${row.shiftName}`),
                  " ",
                  h("span", { class: "muted" }, `${row.factoryName} · ${row.sectionName}`)
                )
              )
            )
          ),
      h("p", {}, h("a", { href: "#/production/dashboard" }, "Open the production dashboard"))
    )
  );
}

function exceptionsCard(data) {
  const kinds = Object.entries(data.counts).filter(([, total]) => total > 0);
  return card(
    "Exceptions",
    h(
      "div",
      {},
      data.total === 0
        ? h("p", { class: "muted" }, "No exceptions in this period.")
        : h(
            "div",
            {},
            h(
              "ul",
              { class: "dash-list" },
              kinds.map(([kind, total]) =>
                h("li", {}, EXCEPTION_KINDS[kind] ?? kind, ": ", h("strong", {}, count(total)))
              )
            ),
            h("h3", {}, "Latest"),
            dataTable({
              caption: "Latest exceptions",
              pageSize: 5,
              rowKey: (row) => row.key,
              columns: [
                { key: "date", label: "Date", render: (r) => r.date },
                { key: "kind", label: "Exception", render: (r) => r.label },
                {
                  key: "where",
                  label: "Where",
                  render: (r) => h("a", { href: dayAddress(r.dayId) }, r.lineName ?? "—"),
                },
              ],
              rows: data.latest,
            })
          ),
      h("p", {}, h("a", { href: "#/scorecard/exceptions" }, "Open all score exceptions"))
    )
  );
}

function workforceCard(data) {
  const total = data.total;
  const closed =
    data.closed.length === 0 ? null : `Not a working day today: ${data.closed.join(", ")}.`;
  return card(
    `Workforce today · ${data.date}`,
    h(
      "div",
      {},
      total.expected === 0
        ? h("p", { class: "muted" }, closed ?? "No employees are expected today in this view.")
        : [
            segmentedBar({
              ariaLabel: "Attendance today",
              segments: [
                { label: "Present", value: total.present, tone: 1 },
                { label: "On leave", value: total.leave, tone: 3 },
                { label: "Absent", value: total.absent, tone: 2 },
                { label: "Not recorded", value: total.unrecorded, tone: "plan" },
              ],
            }),
            h(
              "p",
              { class: "muted" },
              `${count(total.expected)} expected · attendance rate ${percent(total.attendanceRate)} of the days recorded`,
              closed ? ` · ${closed}` : ""
            ),
          ],
      h("p", {}, h("a", { href: "#/dashboard/workforce" }, "Open the workforce dashboard"))
    )
  );
}

function ordersCard(data) {
  const status = (label, value, tone) => ({ label, value, tone });
  return card(
    "Orders and approvals",
    h(
      "div",
      {},
      data.open === 0
        ? h("p", { class: "muted" }, "There are no open orders in this view.")
        : [
            segmentedBar({
              ariaLabel: "Open orders by status",
              segments: [
                status("Draft", data.byStatus.draft, "plan"),
                status("Confirmed", data.byStatus.confirmed, 3),
                status("In production", data.byStatus.in_production, 1),
              ],
            }),
            h(
              "div",
              { class: "stats" },
              statTile("Open orders", formatCount(data.open)),
              statTile(`Ship within ${data.soonDays} days`, formatCount(data.shippingSoon)),
              statTile("Past ship date", formatCount(data.shipOverdue)),
              statTile("Late milestones", formatCount(data.lateMilestones)),
              statTile(
                "Approvals pending",
                formatCount(data.pendingApprovals),
                `${formatCount(data.overdueApprovals)} overdue`
              ),
              statTile("Overloaded bookings", formatCount(data.overloadedBookings))
            ),
          ],
      h("p", {}, h("a", { href: "#/orders/list" }, "Open the buyer orders"))
    )
  );
}

// What is short, what is on order and what waits for a person (D95). Every figure has its word beside
// it; none is shown by colour alone.
function stockCard(data) {
  const { counts, orders, lowest } = data;
  return card(
    "Stock and purchasing",
    h(
      "div",
      {},
      counts.tracked === 0 && orders.open === 0
        ? h("p", { class: "muted" }, "No stock or open purchase orders are recorded in this view.")
        : [
            h(
              "div",
              { class: "stats" },
              statTile(
                "Out of stock",
                formatCount(counts.outOfStock),
                `of ${formatCount(counts.tracked)} items`
              ),
              statTile("Below reorder level", formatCount(counts.belowReorder)),
              statTile(
                "Open purchase orders",
                formatCount(orders.open),
                `${formatCount(orders.late)} late`
              ),
              statTile("Receipts to post", formatCount(data.receiptsToPost)),
              statTile(
                "Requisitions waiting",
                formatCount(data.requisitions.waiting),
                `${formatCount(data.requisitions.toIssue)} approved, to issue`
              )
            ),
            lowest.length === 0
              ? h("p", { class: "muted" }, "Nothing is below its reorder level.")
              : h(
                  "div",
                  {},
                  h("h3", {}, "Needs attention"),
                  h(
                    "ul",
                    { class: "dash-list" },
                    lowest.map((row) =>
                      h(
                        "li",
                        {},
                        statusBadge(row.indicator),
                        " ",
                        h("strong", {}, `${row.materialCode} ${row.materialName}`),
                        " ",
                        h(
                          "span",
                          { class: "muted" },
                          `${formatCount(row.balance)} ${row.unit} on hand, reorder at ${formatCount(row.reorderLevel)}` +
                            (row.onOrder > 0 ? `, ${formatCount(row.onOrder)} on order` : "")
                        )
                      )
                    )
                  )
                ),
          ],
      h("p", {}, h("a", { href: "#/supply/stock" }, "Open the stock page"))
    )
  );
}

// Receivable and payable per currency; two currencies are never added together (D95).
function invoicesCard(data) {
  const side = (label, figures, currency) =>
    h(
      "div",
      { class: "stats" },
      statTile(`${label} open`, formatCount(figures.open)),
      statTile(`${label} balance`, moneyText(figures.balance, currency)),
      statTile(
        `${label} overdue`,
        moneyText(figures.overdue, currency),
        `${formatCount(figures.overdueCount)} invoice${figures.overdueCount === 1 ? "" : "s"}`
      )
    );
  return card(
    "Invoices and payments",
    h(
      "div",
      {},
      data.currencies.length === 0
        ? h("p", { class: "muted" }, "No issued invoice has a balance in this view.")
        : data.currencies.map((row) =>
            h(
              "div",
              {},
              h("h3", {}, row.currency),
              side("Owed to you", row.receivable, row.currency),
              side("You owe", row.payable, row.currency)
            )
          ),
      data.drafts > 0
        ? h(
            "p",
            { class: "muted" },
            `${formatCount(data.drafts)} draft invoice${data.drafts === 1 ? "" : "s"} not yet issued.`
          )
        : null,
      h("p", {}, h("a", { href: "#/finance/invoices" }, "Open the invoices"))
    )
  );
}

const LAYOUT = {
  headline: { draw: headlineCard, wide: true },
  factoryHealth: { draw: factoryHealthCard },
  outputVsPlan: { draw: (rows) => outputCard(rows), wide: true },
  dayStatus: { draw: dayStatusCard },
  exceptions: { draw: exceptionsCard },
  workforceToday: { draw: workforceCard },
  orders: { draw: ordersCard },
  stock: { draw: stockCard },
  invoices: { draw: invoicesCard },
};

// ---- View ---------------------------------------------------------------------------------------

export function render() {
  const root = h("div");
  const state = emptyFilters();
  mount(root, (redraw) => {
    const view = dashboards((s, ctx) => s.tenant(ctx, filterQuery(state)));
    const drawn = view.layout.order
      .filter((id) => Object.hasOwn(view.cards, id))
      .map((id) => {
        const { draw, wide } = LAYOUT[id];
        const node = draw(view.cards[id]);
        if (wide) node.classList.add("dash-wide");
        return node;
      });
    return h(
      "div",
      {},
      pageHeader(
        "Overview",
        `${periodText(view.period)} · approved days only · ${view.layout.profile} layout`
      ),
      filterRow({
        state,
        options: view.options,
        period: view.period,
        today: view.today,
        redraw,
      }),
      drawn.length === 0
        ? card(
            null,
            emptyState({
              title: "No cards for your role",
              body: "Your role does not include any of the overview cards. Ask an administrator if you need one.",
            })
          )
        : h("div", { class: "dash-grid" }, drawn)
    );
  });
  return root;
}
