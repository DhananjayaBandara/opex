// Company: profile and branding, module entitlements (read-only: the platform sets them), and
// effective-dated KPI targets with the level each value comes from (SRS 4.4, 10.4; FR-TEN-007).
import { h } from "../dom.js";
import { badge, button, card, mount, notice, pageHeader, statusBadge, toast } from "../kit.js";
import { formDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";

const TARGETS = [
  ["efficiency", "Efficiency %"],
  ["firstHour", "First-hour output %"],
  ["defectRate", "Defect rate %"],
  ["qco", "QCO %"],
];
const LEVELS = { system: "System default", tenant: "Organization", factory: "Factory" };
const FEATURE_LABEL = {
  production: "Production",
  performance: "Performance",
  attendance: "Attendance",
  orders: "Orders",
  procurement: "Procurement",
  finance: "Finance",
};

export function render() {
  const root = h("div");
  const state = { factoryId: null };
  mount(root, (redraw) => {
    const app = session.app;
    const profile = session.run((ctx) => app.settings.profile(ctx));
    const entitlements = session.run((ctx) => app.settings.entitlements(ctx));
    const factories = session.run((ctx) => app.organization.list(ctx, "factory"));
    const targets = session.run((ctx) => app.settings.targets(ctx, { factoryId: state.factoryId }));
    const versions = session.run((ctx) =>
      app.settings.targetVersions(ctx, { factoryId: state.factoryId })
    );
    const manage = session.can("tenant_settings.manage");

    const editProfile = () =>
      formDialog({
        title: "Edit company profile",
        fields: [
          { name: "name", label: "Company name", required: true },
          { name: "legalName", label: "Legal name" },
          {
            name: "locale",
            label: "Locale",
            hint: "A language such as en, or en-LK",
            required: true,
          },
          { name: "currency", label: "Currency", hint: "Three letters such as LKR" },
          { name: "primaryColor", label: "Brand colour", hint: "#RRGGBB, for example #1f5fbf" },
          {
            name: "logo",
            label: "Logo",
            type: "file",
            accept: "image/png,image/jpeg",
            hint: "PNG or JPEG, at most 64 KB",
          },
          { name: "clearLogo", label: "Remove the current logo", type: "checkbox" },
        ],
        initial: {
          ...profile,
          currency: profile.currency ?? "",
          legalName: profile.legalName ?? "",
          primaryColor: profile.primaryColor ?? "",
        },
        onSubmit: (values) => {
          const patch = {
            name: values.name,
            legalName: values.legalName,
            locale: values.locale,
            currency: values.currency.trim() === "" ? null : values.currency,
            primaryColor: values.primaryColor.trim() === "" ? null : values.primaryColor,
          };
          if (values.clearLogo) patch.logo = null;
          else if (values.logo !== undefined) patch.logo = values.logo;
          session.run((ctx) => app.settings.updateProfile(ctx, patch));
          session.refresh();
          toast("Company profile saved", "good");
          redraw();
        },
      });

    const editTargets = () =>
      formDialog({
        title: state.factoryId ? "Set factory targets" : "Set organization targets",
        description:
          "Leave a target empty to keep the value from the level above. A new version starts on the date you choose and ends the previous one the day before.",
        fields: [
          ...TARGETS.map(([key, label]) => ({
            name: key,
            label,
            type: "number",
            min: 0,
            max: 100,
            step: "any",
          })),
          {
            name: "effectiveFrom",
            label: "Effective from",
            type: "date",
            hint: "Leave empty to start today",
          },
        ],
        initial: Object.fromEntries(TARGETS.map(([key]) => [key, ""])),
        onSubmit: (values) => {
          const stated = Object.fromEntries(
            TARGETS.filter(([key]) => values[key] !== undefined).map(([key]) => [key, values[key]])
          );
          session.run((ctx) =>
            app.settings.setTargets(ctx, {
              values: stated,
              effectiveFrom: values.effectiveFrom || undefined,
              factoryId: state.factoryId ?? undefined,
            })
          );
          toast("Targets saved", "good");
          redraw();
        },
      });

    const factorySelect = h(
      "select",
      {
        id: "targets-factory",
        onchange: (event) => {
          state.factoryId = event.target.value || null;
          redraw();
        },
      },
      h("option", { value: "", selected: state.factoryId === null }, "Organization default"),
      factories.map((factory) =>
        h(
          "option",
          { value: factory.id, selected: factory.id === state.factoryId },
          `${factory.name} (override)`
        )
      )
    );

    return h(
      "div",
      {},
      pageHeader(
        "Company",
        `${profile.name} · time zone ${session.who.timeZone} (fixed when the organization was provisioned)`
      ),
      card(
        "Profile and branding",
        h(
          "div",
          { class: "split" },
          h(
            "dl",
            {},
            kv("Company name", profile.name),
            kv("Legal name", profile.legalName ?? "—"),
            kv("Locale", profile.locale),
            kv("Currency", profile.currency ?? "—"),
            kv(
              "Brand colour",
              profile.primaryColor
                ? h(
                    "span",
                    {},
                    h("span", { class: "swatch", style: `background:${profile.primaryColor}` }),
                    " ",
                    profile.primaryColor
                  )
                : "—"
            )
          ),
          profile.logo
            ? h("img", { class: "logo", src: profile.logo, alt: `${profile.name} logo` })
            : h("p", { class: "muted" }, "No logo uploaded")
        ),
        manage ? button("Edit profile", editProfile, { kind: "primary" }) : null
      ),
      card(
        "Modules",
        h(
          "div",
          {},
          notice(
            "Modules are switched on by the platform. This page only shows what your organization is entitled to.",
            "info"
          ),
          dataTable({
            caption: "Module entitlements",
            columns: [
              {
                key: "feature",
                label: "Module",
                render: (r) => FEATURE_LABEL[r.feature] ?? r.feature,
              },
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
            ],
            rows: entitlements,
            rowKey: (r) => r.feature,
          })
        )
      ),
      card(
        "KPI targets",
        h(
          "div",
          {},
          h(
            "div",
            { class: "table-tools" },
            h("label", { for: "targets-factory" }, "Level"),
            factorySelect,
            manage ? button("Set targets", editTargets, { kind: "primary" }) : null
          ),
          h(
            "p",
            { class: "muted" },
            `In force on ${targets.asOf}. Each value shows where it comes from: system default, organization, then factory override.`
          ),
          dataTable({
            caption: "Targets in force",
            columns: [
              { key: "label", label: "Target" },
              { key: "value", label: "Value", render: (r) => `${r.value}%` },
              {
                key: "source",
                label: "Source",
                render: (r) =>
                  badge(
                    `${LEVELS[r.level]} v${r.version}`,
                    r.level === "system" ? "neutral" : "info"
                  ),
              },
            ],
            rows: TARGETS.filter(([key]) => targets.values[key] !== undefined).map(
              ([key, label]) => ({
                id: key,
                label,
                value: targets.values[key],
                level: targets.sources[key].level,
                version: targets.sources[key].version,
              })
            ),
          })
        )
      ),
      card(
        "Target history",
        dataTable({
          caption: "Target versions",
          columns: [
            { key: "version", label: "Version", sort: (r) => r.version },
            { key: "effectiveFrom", label: "From", sort: (r) => r.effectiveFrom },
            { key: "effectiveTo", label: "To", render: (r) => r.effectiveTo ?? "open" },
            {
              key: "values",
              label: "Values",
              render: (r) =>
                TARGETS.filter(([key]) => r.values[key] !== undefined)
                  .map(([key, label]) => `${label.replace(" %", "")} ${r.values[key]}%`)
                  .join(" · "),
            },
          ],
          rows: [...versions].reverse(),
          empty: {
            title: "No versions at this level",
            body: state.factoryId
              ? "This factory inherits the organization targets."
              : "The system defaults apply.",
          },
        })
      )
    );
  });
  return root;
}

const kv = (label, value) => h("div", { class: "kv" }, h("dt", {}, label), h("dd", {}, value));
