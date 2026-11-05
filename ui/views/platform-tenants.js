// Tenants: the registry, provisioning a new organization with its first administrator, and the
// lifecycle (activate, suspend, deactivate, restore) with a reason where one is required
// (FR-TEN-001, UC-TEN-01).
import { FEATURES } from "../../domain/permissions.js";
import { canTransition } from "../../domain/tenancy.js";
import { h } from "../dom.js";
import { button, card, mount, pageHeader, statusBadge, toast } from "../kit.js";
import { confirmDialog, formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";

const ERRORS = {
  invalid_name: "name",
  invalid_slug: "slug",
  reserved_slug: "slug",
  duplicate: "slug",
  invalid_timezone: "timeZone",
  invalid_email: "adminEmail",
  invalid_features: "features",
};
const VERBS = { active: "Activate", suspended: "Suspend", deactivated: "Deactivate" };

export function render() {
  const root = h("div");
  mount(root, (redraw) => {
    const app = session.app;
    const tenants = session.run((ctx) => app.tenancy.list(ctx));

    const provision = () =>
      formDialog({
        title: "Provision an organization",
        description:
          "Creates the organization, its standard roles and settings, and its first administrator in one step.",
        fields: [
          { name: "name", label: "Company name", required: true },
          {
            name: "slug",
            label: "Organization code",
            required: true,
            hint: "3 to 30 lowercase letters, digits or hyphens; used to sign in",
          },
          {
            name: "timeZone",
            label: "Time zone",
            required: true,
            hint: "An IANA name such as Asia/Colombo. It cannot be changed later.",
          },
          { name: "adminEmail", label: "Administrator email", type: "email", required: true },
          { name: "adminName", label: "Administrator name", required: true },
          {
            name: "features",
            label: "Modules to switch on",
            type: "checkboxes",
            inline: true,
            options: FEATURES.map((feature) => ({ value: feature, label: feature })),
          },
        ],
        initial: { timeZone: "Asia/Colombo", features: [...FEATURES] },
        errorFields: ERRORS,
        onSubmit: (values) => {
          const result = session.run((ctx) =>
            app.tenancy.provision(ctx, {
              name: values.name,
              slug: values.slug,
              timeZone: values.timeZone,
              admin: { email: values.adminEmail, name: values.adminName },
              features: values.features,
            })
          );
          toast(
            `${result.tenant.name} was provisioned (status: provisioned). Activate it to let people sign in.`,
            "good"
          );
          redraw();
        },
      });

    const move = (tenant, to) =>
      confirmDialog({
        title: `${VERBS[to]} ${tenant.name}?`,
        message:
          to === "active"
            ? "People in this organization will be able to sign in."
            : to === "suspended"
              ? "Sign-in stops for everyone in this organization until it is resumed."
              : "The organization is closed; its data is kept.",
        confirmLabel: VERBS[to],
        danger: to !== "active",
        reason: to !== "active",
        onConfirm: (reason) => {
          session.run((ctx) => app.tenancy.transition(ctx, tenant.id, { to, reason }));
          toast(`${tenant.name} is now ${to}`, "good");
          redraw();
        },
      });

    return h(
      "div",
      {},
      pageHeader(
        "Tenants",
        "Every organization on the platform.",
        button("Provision organization", provision, { kind: "primary" })
      ),
      card(
        null,
        dataTable({
          caption: "Tenants",
          columns: [
            {
              key: "name",
              label: "Organization",
              sort: (r) => r.name,
              render: (r) =>
                h("div", {}, h("strong", {}, r.name), h("div", { class: "muted" }, r.slug)),
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
            { key: "timeZone", label: "Time zone", sort: (r) => r.timeZone },
            {
              key: "actions",
              label: "",
              align: "end",
              render: (r) =>
                h(
                  "div",
                  { class: "actions end" },
                  Object.keys(VERBS)
                    .filter((to) => canTransition(r.status, to))
                    .map((to) =>
                      button(
                        VERBS[to] +
                          (r.status === "deactivated" && to === "active" ? " (restore)" : ""),
                        () => move(r, to),
                        { kind: "link" }
                      )
                    )
                ),
            },
          ],
          rows: tenants,
          searchText: (r) => `${r.name} ${r.slug} ${r.status}`,
          empty: { title: "No organizations yet", body: "Provision the first organization." },
        })
      )
    );
  });
  return root;
}
