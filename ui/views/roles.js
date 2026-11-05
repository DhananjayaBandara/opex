// Roles: a role is a named set of permissions (FR-AUTH, D16). The standard roles are read-only;
// custom roles can be created, changed and deleted when nobody holds them. A role can only carry
// permissions the editor holds themselves (no escalation).
import { PERMISSIONS } from "../../domain/permissions.js";
import { h } from "../dom.js";
import { badge, button, card, mount, notice, pageHeader, toast } from "../kit.js";
import { confirmDialog, formDialog, infoDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";

const CATALOGUE = PERMISSIONS.filter((permission) => permission.audience === "tenant");
const FAMILIES = [...new Set(CATALOGUE.map((permission) => permission.family))];
const ERRORS = { invalid_name: "name", duplicate: "name", unique_violation: "name" };

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const app = session.app;
    const admin = (call) => session.run((ctx) => call(app.administration, ctx));
    const roles = admin((a, ctx) => a.roles(ctx));
    const manage = session.can("role.manage");
    const labelOf = (id) => CATALOGUE.find((permission) => permission.id === id)?.label ?? id;

    const edit = (role) =>
      formDialog({
        title: role ? `Edit ${role.name}` : "New role",
        description: "Permissions you do not hold yourself cannot be added to a role.",
        fields: [
          { name: "name", label: "Role name", required: true },
          ...FAMILIES.map((family) => ({
            name: `family:${family}`,
            label: family,
            type: "checkboxes",
            options: CATALOGUE.filter((permission) => permission.family === family).map(
              (permission) => ({
                value: permission.id,
                label: permission.label,
                hint: permission.kind === "write" ? "(changes data)" : "",
                disabled:
                  !session.can(permission.id) && !(role?.permissions ?? []).includes(permission.id),
              })
            ),
          })),
        ],
        errorFields: ERRORS,
        initial: {
          name: role?.name ?? "",
          ...Object.fromEntries(
            FAMILIES.map((family) => [
              `family:${family}`,
              (role?.permissions ?? []).filter(
                (id) => CATALOGUE.find((permission) => permission.id === id)?.family === family
              ),
            ])
          ),
        },
        onSubmit: (values) => {
          const permissions = FAMILIES.flatMap((family) => values[`family:${family}`]);
          if (role)
            admin((a, ctx) => a.updateRole(ctx, role.id, { name: values.name, permissions }));
          else admin((a, ctx) => a.createRole(ctx, { name: values.name, permissions }));
          session.refresh();
          toast("Role saved", "good");
          redraw();
        },
      });
    const view = (role) =>
      infoDialog({
        title: role.name,
        body: h(
          "div",
          {},
          role.system
            ? notice(
                "A standard role. It cannot be changed or deleted; create a custom role to adjust permissions.",
                "info"
              )
            : null,
          FAMILIES.map((family) => {
            const held = role.permissions.filter(
              (id) => CATALOGUE.find((permission) => permission.id === id)?.family === family
            );
            return held.length
              ? h("p", {}, h("strong", {}, `${family}: `), held.map(labelOf).join(", "))
              : null;
          })
        ),
      });
    const remove = (role) =>
      confirmDialog({
        title: `Delete ${role.name}?`,
        message: "A role that members or former members still hold cannot be deleted.",
        confirmLabel: "Delete role",
        danger: true,
        onConfirm: () => {
          admin((a, ctx) => a.deleteRole(ctx, role.id));
          redraw();
        },
      });

    return h(
      "div",
      {},
      pageHeader(
        "Roles",
        "What each kind of user is allowed to do.",
        manage ? button("New role", () => edit(null), { kind: "primary" }) : null
      ),
      card(
        null,
        dataTable({
          caption: "Roles",
          columns: [
            {
              key: "name",
              label: "Role",
              sort: (r) => r.name,
              render: (r) =>
                h(
                  "span",
                  {},
                  r.name,
                  " ",
                  r.system ? badge("standard", "muted") : badge("custom", "info")
                ),
            },
            {
              key: "permissions",
              label: "Permissions",
              sort: (r) => r.permissions.length,
              render: (r) => `${r.permissions.length}`,
            },
            {
              key: "members",
              label: "Members",
              sort: (r) => r.members,
              render: (r) => String(r.members),
            },
            {
              key: "actions",
              label: "",
              align: "end",
              render: (r) =>
                h(
                  "div",
                  { class: "actions end" },
                  r.system
                    ? button("View", () => view(r), { kind: "link" })
                    : manage
                      ? [
                          button("Edit", () => edit(r), { kind: "link" }),
                          button("Delete", () => remove(r), { kind: "link" }),
                        ]
                      : button("View", () => view(r), { kind: "link" })
                ),
            },
          ],
          rows: roles,
          searchText: (r) => r.name,
          empty: { title: "No roles" },
        })
      )
    );
  });
  return root;
}
