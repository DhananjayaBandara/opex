// Users: members of the organization, their roles and factory scope, revoke/restore with a reason,
// and the support-access requests the organization approves or denies (FR-TEN-003, FR-AUTH, D16, D19).
import { h } from "../dom.js";
import {
  attempt,
  badge,
  button,
  card,
  formatInstant,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { confirmDialog, formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";

const ERRORS = {
  invalid_email: "email",
  invalid_name: "name",
  duplicate: "email",
  cannot_grant: "roleIds",
  invalid_role: "roleIds",
  invalid_scope: "factoryIds",
  unknown_role: "roleIds",
};

const scopeText = (member, factories) =>
  member.factoryScope?.all
    ? "All factories"
    : (member.factoryScope?.factoryIds ?? [])
        .map((id) => factories.find((factory) => factory.id === id)?.name ?? "removed factory")
        .join(", ");

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const app = session.app;
    const admin = (call) => session.run((ctx) => call(app.administration, ctx));
    const members = admin((a, ctx) => a.members(ctx));
    const roles = admin((a, ctx) => a.roles(ctx));
    const factories = session.run((ctx) => app.organization.list(ctx, "factory"));
    const manage = session.can("user.manage");

    const fields = (member) => [
      ...(member
        ? []
        : [
            { name: "email", label: "Email", type: "email", required: true },
            {
              name: "name",
              label: "Name",
              required: true,
              hint: "Ignored when the person already has an account",
            },
          ]),
      {
        name: "roleIds",
        label: "Roles",
        type: "checkboxes",
        options: roles.map((role) => ({
          value: role.id,
          label: role.name,
          hint: role.system ? "(standard)" : "",
        })),
      },
      { name: "allFactories", label: "All factories", type: "checkbox" },
      {
        name: "factoryIds",
        label: "Or only these factories",
        type: "checkboxes",
        options: factories.map((factory) => ({ value: factory.id, label: factory.name })),
        hint: "Used when “All factories” is off",
      },
      {
        name: "assignmentScoped",
        label: "Limit to their own assignments (supervisors)",
        type: "checkbox",
      },
    ];
    const edit = (member) =>
      formDialog({
        title: member ? `Change ${member.name}` : "Add a member",
        fields: fields(member),
        errorFields: ERRORS,
        initial: member
          ? {
              roleIds: member.roles.map((role) => role.id),
              allFactories: member.factoryScope?.all === true,
              factoryIds: member.factoryScope?.factoryIds ?? [],
              assignmentScoped: member.assignmentScoped,
            }
          : { roleIds: [], allFactories: true, factoryIds: [], assignmentScoped: false },
        onSubmit: (values) => {
          const factoryScope = values.allFactories
            ? { all: true }
            : { factoryIds: values.factoryIds };
          const common = {
            roleIds: values.roleIds,
            factoryScope,
            assignmentScoped: values.assignmentScoped,
          };
          if (member) admin((a, ctx) => a.updateMember(ctx, member.userId, common));
          else
            admin((a, ctx) =>
              a.addMember(ctx, { ...common, email: values.email, name: values.name })
            );
          session.refresh();
          toast(member ? "Member updated" : "Member added", "good");
          redraw();
        },
      });
    const revoke = (member) =>
      confirmDialog({
        title: `Revoke ${member.name}?`,
        message:
          "Their access ends on their next request. Their history is kept and they can be restored.",
        confirmLabel: "Revoke access",
        danger: true,
        reason: true,
        onConfirm: (reason) => {
          admin((a, ctx) => a.revokeMember(ctx, member.userId, { reason }));
          redraw();
        },
      });

    return h(
      "div",
      {},
      pageHeader(
        "Users",
        "People who can sign in to this organization.",
        manage ? button("Add member", () => edit(null), { kind: "primary" }) : null
      ),
      card(
        null,
        dataTable({
          caption: "Members",
          columns: [
            {
              key: "name",
              label: "Name",
              sort: (r) => r.name,
              render: (r) =>
                h("div", {}, h("strong", {}, r.name), h("div", { class: "muted" }, r.email)),
            },
            {
              key: "roles",
              label: "Roles",
              render: (r) => r.roles.map((role) => badge(role.name, "info")),
            },
            {
              key: "scope",
              label: "Factories",
              render: (r) =>
                h(
                  "span",
                  {},
                  scopeText(r, factories),
                  r.assignmentScoped ? badge("own assignments", "muted") : null
                ),
            },
            {
              key: "status",
              label: "Status",
              sort: (r) => r.status,
              render: (r) =>
                h(
                  "div",
                  {},
                  statusBadge(r.status),
                  r.statusReason ? h("div", { class: "muted" }, r.statusReason) : null
                ),
            },
            ...(manage
              ? [
                  {
                    key: "actions",
                    label: "",
                    align: "end",
                    render: (r) =>
                      h(
                        "div",
                        { class: "actions end" },
                        r.status === "active"
                          ? [
                              button("Change", () => edit(r), { kind: "link" }),
                              button("Revoke", () => revoke(r), { kind: "link" }),
                            ]
                          : button(
                              "Restore",
                              () => {
                                attempt(
                                  () => admin((a, ctx) => a.restoreMember(ctx, r.userId)),
                                  `${r.name} restored`
                                );
                                redraw();
                              },
                              { kind: "link" }
                            )
                      ),
                  },
                ]
              : []),
          ],
          rows: members,
          rowKey: (r) => r.userId,
          rowClass: (r) => (r.status === "active" ? null : "is-inactive"),
          searchText: (r) => `${r.name} ${r.email} ${r.roles.map((role) => role.name).join(" ")}`,
          empty: { title: "No members" },
        })
      ),
      session.can("support_access.approve") ? supportPanel(redraw) : null
    );
  });
  return root;
}

// Requests from the platform's support team. Access is read-only and ends at the expiry.
function supportPanel(redraw) {
  const app = session.app;
  const grants = session.run((ctx) => app.support.list(ctx));
  const decide = (verb, grant) => {
    attempt(
      () => session.run((ctx) => app.support[verb](ctx, grant.id)),
      verb === "approve"
        ? "Support access approved"
        : verb === "deny"
          ? "Support request denied"
          : "Support access revoked"
    );
    redraw();
  };
  return card(
    "Support access",
    h(
      "div",
      {},
      notice(
        "The platform's support team can only see your data after you approve a request here. Access is read-only, limited in time and recorded.",
        "info"
      ),
      dataTable({
        caption: "Support access requests",
        columns: [
          {
            key: "requestedBy",
            label: "Engineer",
            render: (g) =>
              h(
                "div",
                {},
                h("strong", {}, g.requestedBy.name),
                h("div", { class: "muted" }, g.requestedBy.email)
              ),
          },
          { key: "reason", label: "Reason" },
          { key: "duration", label: "Length", render: (g) => `${g.durationMinutes} min` },
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
                g.status === "pending"
                  ? [
                      button("Approve", () => decide("approve", g), { kind: "link" }),
                      button("Deny", () => decide("deny", g), { kind: "link" }),
                    ]
                  : null,
                g.status === "approved"
                  ? button("End access", () => decide("revoke", g), { kind: "link" })
                  : null
              ),
          },
        ],
        rows: [...grants].reverse(),
        searchText: (g) => `${g.requestedBy.name} ${g.reason} ${g.status}`,
        empty: {
          title: "No support requests",
          body: "Requests from the platform's support team appear here for your decision.",
        },
      })
    )
  );
}
