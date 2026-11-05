// Tenant features: which modules each organization is entitled to, with an effective date and the
// history of changes. Only the platform changes this (FR-TEN-007, D17).
import { h } from "../dom.js";
import { button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";

const ERRORS = {
  past_effective_date: "effectiveFrom",
  invalid_range: "effectiveFrom",
  version_in_effect: "effectiveFrom",
  overlap: "effectiveFrom",
};

export function render() {
  const root = h("div");
  const state = { tenantId: null };
  mount(root, (redraw) => {
    const app = session.app;
    const tenants = session.run((ctx) => app.tenancy.list(ctx));
    if (state.tenantId === null || !tenants.some((tenant) => tenant.id === state.tenantId))
      state.tenantId = tenants[0]?.id ?? null;
    const tenant = tenants.find((entry) => entry.id === state.tenantId);
    const rows = tenant
      ? session.run((ctx) => app.settings.tenantEntitlements(ctx, tenant.id))
      : [];

    const change = (row) =>
      formDialog({
        title: `${row.feature} for ${tenant.name}`,
        description:
          "A change starts on the date you choose and ends the previous setting the day before. Past dates are refused.",
        fields: [
          { name: "enabled", label: "Module is switched on", type: "checkbox" },
          {
            name: "effectiveFrom",
            label: "Effective from",
            type: "date",
            hint: "Leave empty to start today",
          },
        ],
        initial: { enabled: !row.entitled },
        errorFields: ERRORS,
        onSubmit: (values) => {
          session.run((ctx) =>
            app.settings.setEntitlement(ctx, tenant.id, {
              feature: row.feature,
              enabled: values.enabled,
              effectiveFrom: values.effectiveFrom || undefined,
            })
          );
          toast("Entitlement saved", "good");
          redraw();
        },
      });

    const select = h(
      "select",
      {
        id: "feature-tenant",
        onchange: (event) => {
          state.tenantId = event.target.value;
          redraw();
        },
      },
      tenants.map((entry) =>
        h(
          "option",
          { value: entry.id, selected: entry.id === state.tenantId },
          `${entry.name} (${entry.status})`
        )
      )
    );

    return h(
      "div",
      {},
      pageHeader(
        "Tenant features",
        "Switch modules on or off for an organization, from a chosen date."
      ),
      tenants.length === 0
        ? card(null, h("p", { class: "muted" }, "There are no organizations yet."))
        : h(
            "div",
            {},
            h(
              "div",
              { class: "table-tools" },
              h("label", { for: "feature-tenant" }, "Organization"),
              select
            ),
            notice(
              "Turning a module off hides its permissions from the organization's users from the effective date; their data is kept.",
              "info"
            ),
            card(
              null,
              dataTable({
                caption: "Module entitlements",
                columns: [
                  { key: "feature", label: "Module", sort: (r) => r.feature },
                  {
                    key: "entitled",
                    label: "Today",
                    render: (r) => statusBadge(r.entitled ? "enabled" : "disabled"),
                  },
                  {
                    key: "history",
                    label: "History",
                    render: (r) =>
                      r.history.length
                        ? r.history.map((v) =>
                            h(
                              "div",
                              { class: "muted" },
                              `${v.enabled ? "On" : "Off"} from ${v.effectiveFrom}${v.effectiveTo ? ` to ${v.effectiveTo}` : ""}`
                            )
                          )
                        : "Never enabled",
                  },
                  {
                    key: "actions",
                    label: "",
                    align: "end",
                    render: (r) =>
                      button(r.entitled ? "Change…" : "Enable…", () => change(r), { kind: "link" }),
                  },
                ],
                rows,
                rowKey: (r) => r.feature,
              })
            )
          )
    );
  });
  return root;
}
