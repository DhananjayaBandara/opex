// Platform administration: platform staff, and support access (ask an organization for read-only
// access, then enter it once approved) (FR-TEN-001, UC-TEN-03, D19).
import { h } from "../dom.js";
import {
  attempt,
  button,
  card,
  formatInstant,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";

const ROLE_OPTIONS = [
  { value: "platform_admin", label: "Platform administrator" },
  { value: "support_engineer", label: "Support engineer" },
];
const ERRORS = {
  invalid_email: "email",
  invalid_name: "name",
  unknown_template: "roleKeys",
  wrong_audience: "roleKeys",
  reason_required: "reason",
  invalid_duration: "durationMinutes",
  duplicate: "reason",
};

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const app = session.app;
    const canStaff = session.can("platform_settings.manage");
    const canSupport = session.can("support_access.request");
    const grants = canSupport ? session.run((ctx) => app.support.list(ctx)) : [];

    const addStaff = () =>
      formDialog({
        title: "Add platform staff",
        description: "A person with an existing account keeps their name and gains the roles.",
        fields: [
          { name: "email", label: "Email", type: "email", required: true },
          { name: "name", label: "Name", required: true },
          { name: "roleKeys", label: "Roles", type: "checkboxes", options: ROLE_OPTIONS },
        ],
        initial: { roleKeys: ["support_engineer"] },
        errorFields: ERRORS,
        onSubmit: (values) => {
          session.run((ctx) => app.tenancy.addPlatformUser(ctx, values));
          toast("Platform staff added", "good");
          redraw();
        },
      });
    const request = () => {
      const directory = session.run((ctx) => app.tenancy.directory(ctx));
      return formDialog({
        title: "Request support access",
        description:
          "The organization's administrator must approve before you can see anything. Access is read-only and ends automatically.",
        fields: [
          {
            name: "tenantId",
            label: "Organization",
            type: "select",
            options: directory.map((tenant) => ({
              value: tenant.id,
              label: `${tenant.name} (${tenant.slug})`,
            })),
          },
          { name: "reason", label: "Reason", type: "textarea", required: true },
          {
            name: "durationMinutes",
            label: "Duration (minutes)",
            type: "number",
            min: 1,
            max: 480,
            step: 1,
            hint: "Up to 480 (eight hours)",
          },
        ],
        initial: { durationMinutes: 60 },
        errorFields: ERRORS,
        onSubmit: (values) => {
          session.run((ctx) => app.support.request(ctx, values));
          toast("Request sent to the organization", "good");
          redraw();
        },
      });
    };
    const enter = (grant) => {
      try {
        session.enterSupport(grant.id);
        // The platform page does not exist inside an organization: start at its Home instead.
        window.location.hash = "#/home";
      } catch (error) {
        toast(error.message, "bad");
        redraw();
      }
    };

    return h(
      "div",
      {},
      pageHeader("Platform administration", "Platform staff and support access."),
      canStaff
        ? card(
            "Platform staff",
            h(
              "p",
              { class: "muted" },
              "Add people who work on the platform itself. Their sign-in needs a second factor."
            ),
            button("Add platform staff", addStaff, { kind: "primary" })
          )
        : null,
      canSupport
        ? card(
            "Support access",
            h(
              "div",
              {},
              notice(
                "You can only see an organization's data after its administrator approves a request. Access is read-only, time-limited and recorded in the organization's audit log.",
                "info"
              ),
              dataTable({
                caption: "Your support access requests",
                columns: [
                  { key: "tenantName", label: "Organization", sort: (g) => g.tenantName },
                  { key: "reason", label: "Reason" },
                  {
                    key: "durationMinutes",
                    label: "Length",
                    render: (g) => `${g.durationMinutes} min`,
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (g) =>
                      h(
                        "div",
                        {},
                        statusBadge(g.status),
                        g.expiresAt
                          ? h("div", { class: "muted" }, `until ${formatInstant(g.expiresAt)}`)
                          : null
                      ),
                  },
                  {
                    key: "requestedAt",
                    label: "Requested",
                    sort: (g) => g.requestedAt,
                    render: (g) => formatInstant(g.requestedAt),
                  },
                  {
                    key: "actions",
                    label: "",
                    align: "end",
                    render: (g) =>
                      h(
                        "div",
                        { class: "actions end" },
                        g.status === "approved"
                          ? button("Enter (read-only)", () => enter(g), { kind: "link" })
                          : null,
                        g.status === "pending" || g.status === "approved"
                          ? button(
                              g.status === "pending" ? "Withdraw" : "End access",
                              () => {
                                attempt(
                                  () => session.run((ctx) => app.support.revoke(ctx, g.id)),
                                  "Support access ended"
                                );
                                redraw();
                              },
                              { kind: "link" }
                            )
                          : null
                      ),
                  },
                ],
                rows: [...grants].reverse(),
                searchText: (g) => `${g.tenantName} ${g.reason} ${g.status}`,
                empty: {
                  title: "No support requests yet",
                  body: "Request access when an organization asks for help.",
                },
              })
            ),
            button("Request access", request, { kind: "primary" })
          )
        : null,
      !canStaff && !canSupport
        ? card(
            null,
            h("p", { class: "muted" }, "Your platform role has nothing to administer on this page.")
          )
        : null
    );
  });
  return root;
}
