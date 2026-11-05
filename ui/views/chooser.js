// Where to go after signing in: an organization the person belongs to, or the platform.
import { h } from "../dom.js";
import { button, card, emptyState, mount, toast } from "../kit.js";
import { session } from "../session.js";

export function render() {
  const root = h("div", { class: "auth" });
  mount(root, () => {
    const { platform, organizations } = session.choices();
    const enter = (action) => () => {
      try {
        action();
      } catch (error) {
        toast(error.message, "bad");
      }
    };
    const items = [
      ...organizations.map((org) =>
        h(
          "li",
          { class: "choice" },
          h("div", {}, h("strong", {}, org.name), h("div", { class: "muted" }, org.slug)),
          button(
            "Open",
            enter(() => session.enterTenant(org.slug)),
            { kind: "primary", title: `Open ${org.name}` }
          )
        )
      ),
      platform
        ? h(
            "li",
            { class: "choice" },
            h(
              "div",
              {},
              h("strong", {}, "Platform administration"),
              h("div", { class: "muted" }, "Tenants, features, platform staff and support access")
            ),
            button(
              "Open",
              enter(() => session.enterPlatform()),
              { kind: "primary", title: "Open platform administration" }
            )
          )
        : null,
    ].filter(Boolean);
    return card(
      `Welcome, ${session.user.name}`,
      items.length
        ? h(
            "div",
            {},
            h("p", { class: "muted" }, "Choose where to work."),
            h("ul", { class: "plain choices" }, items)
          )
        : emptyState({
            title: "No organization available",
            body: "You do not belong to an active organization. Ask an administrator to add you.",
          }),
      button("Sign out", () => session.signOut(), { kind: "secondary" })
    );
  });
  return root;
}
