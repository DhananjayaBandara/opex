// One supervisor's scorecard for a manager: the same breakdown as My Scorecard plus the days it came
// from, reached from the Management Scorecard (UC-MGT-03, D48). The employee id and the period are
// in the address; a person outside the caller's scope is refused like any unknown one.
import { h } from "../dom.js";
import { emptyState, mount, pageHeader } from "../kit.js";
import { addressValue, scorecardBody, scorecards } from "./scorecard-common.js";

export function render() {
  const root = h("div");
  mount(root, () => {
    const id = addressValue("id");
    if (!id) {
      return emptyState({
        title: "No supervisor chosen",
        body: "Open a supervisor from the management scorecard.",
        action: h("a", { href: "#/scorecard/board" }, "Go to the management scorecard"),
      });
    }
    const period = {
      ...(addressValue("from") ? { from: addressValue("from") } : {}),
      ...(addressValue("to") ? { to: addressValue("to") } : {}),
    };
    const detail = scorecards((s, ctx) => s.detail(ctx, id, period));
    return h(
      "div",
      {},
      pageHeader(
        detail.employee.name,
        `${detail.employee.employeeCode} · ${detail.employee.designationName ?? "Supervisor"} · ${detail.employee.factoryName}`,
        h("a", { href: "#/scorecard/board", class: "btn btn-secondary" }, "Back to the scorecard")
      ),
      scorecardBody(detail, { linkDays: true })
    );
  });
  return root;
}
