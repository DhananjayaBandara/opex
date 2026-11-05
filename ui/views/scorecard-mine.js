// My Scorecard: a supervisor's own rolling score, found through the employee record linked to their
// user (UC-SUP-10, FR-SCR-001, D50). Nobody else's scorecard is reachable from here.
import { h } from "../dom.js";
import { card, emptyState, mount, pageHeader } from "../kit.js";
import { scorecardBody, scorecards } from "./scorecard-common.js";

const EXPLANATIONS = {
  no_employee: {
    title: "Your account is not linked to an employee record",
    body: "A scorecard is built from the employee record linked to your sign-in. Ask an administrator to link it on the Employees page.",
  },
  no_assignment: {
    title: "You have not been assigned to a section yet",
    body: "Your score is built from the sections and shifts you supervise. Ask a manager to assign you.",
  },
  no_data: {
    title: "Nothing to show yet",
    body: "No assignment of yours falls in the current period.",
  },
};

export function render() {
  const root = h("div");
  mount(root, () => {
    const mine = scorecards((s, ctx) => s.mine(ctx));
    if (mine.scorecard === null) {
      const text = EXPLANATIONS[mine.reason] ?? EXPLANATIONS.no_data;
      return h(
        "div",
        {},
        pageHeader("My scorecard", "Your own score."),
        card(null, emptyState(text))
      );
    }
    const detail = mine.scorecard;
    return h(
      "div",
      {},
      pageHeader(
        "My scorecard",
        `${detail.employee.name} · ${detail.employee.employeeCode} · ${detail.employee.factoryName}`
      ),
      scorecardBody(detail, { linkDays: true })
    );
  });
  return root;
}
