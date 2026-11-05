// A welcome summary. The production screens arrived with slice S3, the scorecards with S4, the three
// dashboards with S5.1 and the notification centre, comments, exports and scheduled reports with S5.2.
import { h } from "../dom.js";
import { badge, card, notice, pageHeader, statusBadge } from "../kit.js";
import { session } from "../session.js";

const row = (label, value) => h("div", { class: "kv" }, h("dt", {}, label), h("dd", {}, value));

// The caller's own supervisor assignments, through the employee record linked to their user
// (AC-3.5). Nothing is shown to someone who has no employee record.
function myAssignments() {
  if (session.kind !== "tenant" || session.supporting) return null;
  let mine;
  try {
    mine = session.run((ctx) => session.app.assignments.mine(ctx));
  } catch {
    return null;
  }
  if (mine.employee === null) return null;
  return card(
    "Your assignments",
    mine.assignments.length === 0
      ? h("p", { class: "muted" }, `${mine.employee.name} has no supervisor assignments yet.`)
      : h(
          "ul",
          { class: "plain" },
          mine.assignments.map((row) =>
            h(
              "li",
              {},
              `${row.sectionName} · ${row.shiftName}, from ${row.effectiveFrom}`,
              row.effectiveTo === null ? "" : ` to ${row.effectiveTo}`,
              " ",
              statusBadge(row.status)
            )
          )
        )
  );
}

export function render({ links }) {
  const who = session.who;
  const list = links.length
    ? h(
        "ul",
        { class: "plain" },
        links.map((link) => h("li", {}, h("a", { href: `#/${link.path}` }, link.title)))
      )
    : h(
        "p",
        { class: "muted" },
        "Your role does not include any administration pages in this slice."
      );

  if (who.kind === "platform") {
    return h(
      "div",
      {},
      pageHeader(`Welcome, ${who.name}`, "Platform administration"),
      card(
        "You",
        h(
          "dl",
          {},
          row("Email", who.email),
          row(
            "Platform roles",
            who.roles.map((role) => badge(role.replaceAll("_", " "), "info"))
          )
        )
      ),
      card("Open", list)
    );
  }
  const scope = who.factoryScope.all
    ? "All factories"
    : `${who.factoryScope.factoryIds.length} factory(ies)`;
  return h(
    "div",
    {},
    pageHeader(`Welcome, ${who.name}`, who.tenantName),
    session.supporting
      ? notice("You are in read-only support access. Nothing you open here can be changed.", "warn")
      : null,
    card(
      "You",
      h(
        "dl",
        {},
        row("Email", who.email),
        row("Organization", `${who.tenantName} (${who.tenantSlug})`),
        row("Time zone", who.timeZone),
        row("Factory scope", scope),
        row("Permissions", String(who.permissions.length)),
        who.assignmentScoped
          ? row("Assignment", "Limited to your assigned sections and shifts")
          : null
      )
    ),
    myAssignments(),
    card("Open", list),
    h(
      "p",
      { class: "muted" },
      "The dashboards are under Dashboards in the menu. Your notifications are at the top of the menu; exports and scheduled reports are under Reports."
    )
  );
}
