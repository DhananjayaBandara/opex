// Sign-in (email, then the simulated second factor when the account needs one), password reset
// request and completion, and the one-click demo accounts (decision D18, level S).
import { DEMO_ACCOUNTS, seedDemo } from "../../seed/demo.js";
import { h } from "../dom.js";
import { busy, button, card, mount, notice, toast } from "../kit.js";
import { session } from "../session.js";

function finishSignIn() {
  try {
    session.autoEnter();
  } catch (error) {
    toast(error.message, "bad");
  }
}

// The demo accounts sign in with a single click; the simulated code is supplied for them.
export function signInAs(email) {
  let result = session.signIn({ email });
  if (result.mfaRequired)
    result = session.signIn({ email, mfaCode: session.app.prototypeTools.mfaCode(email) });
  finishSignIn();
}

export function render() {
  const root = h("div", { class: "auth" });
  const state = { step: "email", email: "", error: null, info: null };

  mount(root, (redraw) => {
    const go = (step, extra = {}) => {
      Object.assign(state, { step, error: null, info: null }, extra);
      redraw();
    };
    const fail = (error) => {
      state.error = error.message;
      state.info = null;
      redraw();
    };
    const message = () => [
      state.error ? notice(state.error, "bad") : null,
      state.info ? notice(state.info, "good") : null,
    ];

    let form;
    if (state.step === "email") {
      const email = h("input", {
        id: "signin-email",
        type: "email",
        value: state.email,
        autocomplete: "username",
        required: true,
      });
      form = h(
        "form",
        {
          onsubmit: (event) => {
            event.preventDefault();
            state.email = email.value.trim();
            try {
              const result = session.signIn({ email: state.email });
              if (result.mfaRequired) go("mfa");
              else finishSignIn();
            } catch (error) {
              fail(error);
            }
          },
        },
        h("h2", {}, "Sign in"),
        message(),
        h("div", { class: "field" }, h("label", { for: "signin-email" }, "Email"), email),
        h(
          "p",
          { class: "muted" },
          "Authentication is simulated in this prototype: no password is asked for."
        ),
        h(
          "div",
          { class: "dialog-actions" },
          button("Forgot access?", () => go("forgot", { email: email.value.trim() }), {
            kind: "link",
          }),
          h("button", { type: "submit", class: "btn btn-primary" }, "Continue")
        )
      );
      queueMicrotask(() => email.focus());
    } else if (state.step === "mfa") {
      const code = h("input", {
        id: "signin-code",
        type: "text",
        inputmode: "numeric",
        autocomplete: "one-time-code",
      });
      form = h(
        "form",
        {
          onsubmit: (event) => {
            event.preventDefault();
            try {
              session.signIn({ email: state.email, mfaCode: code.value.trim() });
              finishSignIn();
            } catch (error) {
              fail(error);
            }
          },
        },
        h("h2", {}, "Second factor"),
        message(),
        h("p", {}, `A sign-in code is required for ${state.email}.`),
        h(
          "div",
          { class: "field" },
          h("label", { for: "signin-code" }, "Sign-in code"),
          code,
          h(
            "small",
            { class: "muted" },
            "Simulated: open ",
            h("a", { href: "#/tools" }, "Prototype Tools"),
            " to read the current code."
          )
        ),
        h(
          "div",
          { class: "dialog-actions" },
          button("Back", () => go("email"), { kind: "link" }),
          h("button", { type: "submit", class: "btn btn-primary" }, "Sign in")
        )
      );
      queueMicrotask(() => code.focus());
    } else if (state.step === "forgot") {
      const email = h("input", {
        id: "forgot-email",
        type: "email",
        value: state.email,
        required: true,
      });
      form = h(
        "form",
        {
          onsubmit: (event) => {
            event.preventDefault();
            try {
              session.app.identity.requestPasswordReset({ email: email.value.trim() });
              go("reset", {
                info: "If that account exists, a reset message was sent. In this prototype it appears in the Prototype Tools outbox.",
              });
            } catch (error) {
              fail(error);
            }
          },
        },
        h("h2", {}, "Reset access"),
        message(),
        h("div", { class: "field" }, h("label", { for: "forgot-email" }, "Email"), email),
        h(
          "div",
          { class: "dialog-actions" },
          button("Back", () => go("email"), { kind: "link" }),
          h("button", { type: "submit", class: "btn btn-primary" }, "Send reset message")
        )
      );
    } else {
      const token = h("input", { id: "reset-token", type: "text", autocomplete: "off" });
      form = h(
        "form",
        {
          onsubmit: (event) => {
            event.preventDefault();
            try {
              session.app.identity.completePasswordReset({ token: token.value.trim() });
              go("email", { info: "Access was reset. Sign in again." });
            } catch (error) {
              fail(error);
            }
          },
        },
        h("h2", {}, "Complete the reset"),
        message(),
        h(
          "div",
          { class: "field" },
          h("label", { for: "reset-token" }, "Reset token"),
          token,
          h(
            "small",
            { class: "muted" },
            "Copy it from the outbox in ",
            h("a", { href: "#/tools" }, "Prototype Tools"),
            ". It works once and expires after 30 minutes."
          )
        ),
        h(
          "div",
          { class: "dialog-actions" },
          button("Back", () => go("email"), { kind: "link" }),
          h("button", { type: "submit", class: "btn btn-primary" }, "Reset")
        )
      );
    }

    return h("div", {}, card(null, form), demoPanel(redraw));
  });
  return root;
}

function demoPanel(redraw) {
  const { users } = session.app.prototypeTools.status();
  if (users === 0) {
    return card(
      "Demo world",
      h(
        "div",
        {},
        h(
          "p",
          { class: "muted" },
          "This browser holds no data yet. Load a ready-made platform team and two organizations to walk through the prototype."
        ),
        button(
          "Load the demo world",
          (event) =>
            busy(event, "Loading the demo world…", () => {
              try {
                seedDemo(session.app);
                toast("Demo world loaded", "good");
                redraw();
              } catch (error) {
                toast(error.message, "bad");
              }
            }),
          { kind: "primary" }
        )
      )
    );
  }
  const person = (p, where) =>
    h(
      "li",
      {},
      button(`${p.name}`, () => attemptSignIn(p.email), { kind: "link" }),
      h("span", { class: "muted" }, ` ${p.persona.replaceAll("_", " ")} · ${where}`)
    );
  return card(
    "Demo accounts",
    h(
      "div",
      {},
      h(
        "p",
        { class: "muted" },
        "One click signs in (the simulated second factor is filled in for you)."
      ),
      h(
        "ul",
        { class: "plain" },
        DEMO_ACCOUNTS.platform.map((p) => person(p, "platform")),
        DEMO_ACCOUNTS.tenants.flatMap((t) => t.people.map((p) => person(p, t.name)))
      )
    )
  );
}

function attemptSignIn(email) {
  try {
    signInAs(email);
  } catch (error) {
    toast(error.message, "bad");
  }
}
