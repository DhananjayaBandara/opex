// Prototype Tools (decision D18, level S): the simulated second-factor codes, the simulated email
// outbox, the demo world and a reset of everything stored in this browser. Available signed out.
import { DEMO_ACCOUNTS, seedDemo } from "../../seed/demo.js";
import { STORAGE_KEY } from "../../store/store.js";
import { createApp } from "../app.js";
import { h } from "../dom.js";
import {
  busy,
  button,
  card,
  formatInstant,
  mount,
  notice,
  pageHeader,
  statusBadge,
  toast,
} from "../kit.js";
import { confirmDialog } from "../dialog.js";
import { dataTable } from "../table.js";
import { session } from "../session.js";

export function render() {
  const root = h("div");
  const revealed = new Map();
  mount(root, (redraw) => {
    const app = session.app;
    const status = app.prototypeTools.status();
    const accounts = [
      ...DEMO_ACCOUNTS.platform.map((p) => ({ ...p, where: "Platform" })),
      ...DEMO_ACCOUNTS.tenants.flatMap((t) => t.people.map((p) => ({ ...p, where: t.name }))),
    ];
    const outbox = [...app.prototypeTools.outbox()].reverse();

    const world =
      status.users === 0
        ? button(
            "Load the demo world",
            (event) =>
              busy(event, "Loading the demo world…", () => {
                try {
                  seedDemo(app);
                  toast("Demo world loaded", "good");
                  redraw();
                } catch (error) {
                  toast(error.message, "bad");
                }
              }),
            { kind: "primary" }
          )
        : h(
            "p",
            { class: "muted" },
            `${status.users} accounts and ${status.tenants} organizations are stored in this browser.`
          );

    const lookup = h("input", { id: "code-email", type: "email", placeholder: "email address" });
    const found = h("output", { class: "code" });

    return h(
      "div",
      {},
      pageHeader(
        "Prototype Tools",
        "Simulated services for walking through the prototype. None of this exists in a real deployment."
      ),
      notice(
        "Level S (simulated): the second-factor code and the email outbox stand in for a real authenticator and mail service.",
        "warn"
      ),
      app.recovery
        ? notice(
            `Stored data could not be read (${app.recovery.reason}) and was kept under ${app.recovery.quarantineKey}. A fresh store is in use.`,
            "warn"
          )
        : null,
      card("Demo world", world),
      card(
        "Sign-in codes",
        h(
          "div",
          {},
          h(
            "div",
            { class: "table-tools" },
            h("label", { for: "code-email", class: "sr-only" }, "Email"),
            lookup,
            button("Show code", () => {
              try {
                found.textContent = app.prototypeTools.mfaCode(lookup.value);
              } catch (error) {
                found.textContent = error.message;
              }
            }),
            found
          ),
          status.users === 0
            ? null
            : dataTable({
                caption: "Demo accounts",
                columns: [
                  { key: "name", label: "Name", sort: (r) => r.name },
                  { key: "email", label: "Email", sort: (r) => r.email },
                  { key: "where", label: "Where", sort: (r) => r.where },
                  {
                    key: "persona",
                    label: "Persona",
                    render: (r) => r.persona.replaceAll("_", " "),
                  },
                  {
                    key: "code",
                    label: "Current code",
                    render: (r) =>
                      revealed.has(r.email)
                        ? h("code", {}, revealed.get(r.email))
                        : button(
                            "Show",
                            () => {
                              revealed.set(r.email, app.prototypeTools.mfaCode(r.email));
                              redraw();
                            },
                            { kind: "link" }
                          ),
                  },
                ],
                rows: accounts,
                rowKey: (r) => r.email,
                searchText: (r) => `${r.name} ${r.email} ${r.where} ${r.persona}`,
              })
        )
      ),
      card(
        "Email outbox",
        dataTable({
          caption: "Simulated outbox",
          columns: [
            {
              key: "createdAt",
              label: "Sent",
              sort: (r) => r.createdAt,
              render: (r) => formatInstant(r.createdAt),
            },
            { key: "to", label: "To", sort: (r) => r.to },
            { key: "kind", label: "Message", render: () => "Password reset" },
            { key: "token", label: "Token", render: (r) => h("code", {}, r.token) },
            {
              key: "state",
              label: "State",
              render: (r) => statusBadge(r.usedAt ? "expired" : "pending"),
            },
            {
              key: "act",
              label: "",
              render: (r) =>
                r.usedAt
                  ? ""
                  : button(
                      "Complete reset",
                      () => {
                        try {
                          app.identity.completePasswordReset({ token: r.token });
                          toast("Access reset", "good");
                          redraw();
                        } catch (error) {
                          toast(error.message, "bad");
                          redraw();
                        }
                      },
                      { kind: "link" }
                    ),
            },
          ],
          rows: outbox,
          empty: {
            title: "The outbox is empty",
            body: "Request a password reset on the sign-in page to see a message here.",
          },
        })
      ),
      card(
        "Reset all data",
        h(
          "div",
          {},
          h(
            "p",
            { class: "muted" },
            "Removes every account, organization and record stored by this prototype in this browser."
          ),
          button(
            "Reset all data…",
            () =>
              confirmDialog({
                title: "Reset all prototype data?",
                message:
                  "Everything stored in this browser by the prototype is deleted and everyone is signed out.",
                confirmLabel: "Reset everything",
                danger: true,
                onConfirm: () => {
                  window.localStorage.removeItem(STORAGE_KEY);
                  session.forget(createApp(), "All prototype data was reset.");
                },
              }),
            { kind: "danger" }
          )
        )
      )
    );
  });
  return root;
}
