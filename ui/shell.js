// The page frame: what to show for the current state (sign-in, chooser, or the signed-in layout with
// header, navigation and banners) and the redraw when the state or the address changes.
import { h } from "./dom.js";
import { NOTIFICATIONS_CHANGED } from "./download.js";
import { button, emptyState, formatInstant, mount } from "./kit.js";
import { homeLinks, navigation, parse, resolve } from "./router.js";
import { session } from "./session.js";
import { currentTheme, nextTheme, setTheme } from "./theme.js";
import * as chooser from "./views/chooser.js";
import * as signin from "./views/signin.js";

let container = null;
let slot = null;
let lastKey = null;

const bannerFor = () => {
  const banners = [];
  const recovery = session.app?.recovery;
  if (recovery) {
    banners.push(
      h(
        "div",
        { class: "banner banner-warn", role: "status" },
        `Saved prototype data could not be read (${recovery.reason}). It was set aside and the prototype started empty.`
      )
    );
  }
  if (session.supporting) {
    const support = session.who.support;
    banners.push(
      h(
        "div",
        { class: "banner banner-warn", role: "status" },
        h(
          "span",
          {},
          `Read-only support access to ${session.who.tenantName}, until ${formatInstant(support.expiresAt)}. Every call is recorded in the organization's audit log.`
        ),
        button(
          "Exit support",
          () => {
            session.leaveSupport();
            // The organization's page does not exist on the platform side: go back to its Home.
            window.location.hash = "#/home";
          },
          { kind: "secondary" }
        )
      )
    );
  } else if (session.kind === "platform") {
    banners.push(
      h(
        "div",
        { class: "banner banner-info", role: "status" },
        "Platform administration. An organization's data is visible only through approved, read-only support access."
      )
    );
  }
  if (session.notice) {
    banners.push(
      h(
        "div",
        { class: "banner banner-info", role: "status" },
        h("span", {}, session.notice),
        button(
          "Dismiss",
          () => {
            session.clearNotice();
            draw();
          },
          { kind: "link" }
        )
      )
    );
  }
  return banners;
};

function header() {
  const theme = currentTheme();
  const place = session.inside
    ? session.kind === "platform"
      ? "Platform"
      : session.who.tenantName
    : null;
  return h(
    "header",
    { class: "app-header" },
    h(
      "a",
      { class: "brand", href: "#/home" },
      "OPEX+",
      h("span", { class: "muted" }, " prototype")
    ),
    place ? h("span", { class: "place" }, place) : null,
    h(
      "div",
      { class: "actions" },
      h("a", { href: "#/limits" }, "Limits"),
      h("a", { href: "#/tools" }, "Prototype tools"),
      button(
        `Theme: ${theme}`,
        () => {
          setTheme(nextTheme(theme));
          draw();
        },
        { kind: "link", title: "Switch between automatic, light and dark" }
      ),
      session.signedIn ? h("span", { class: "muted" }, session.user.email) : null,
      session.inside
        ? button("Switch organization", () => session.switchEntry(), { kind: "link" })
        : null,
      session.signedIn ? button("Sign out", () => session.signOut(), { kind: "secondary" }) : null
    )
  );
}

// A member's own notifications are for people working in an organization, not for platform staff or
// someone reading through read-only support access. Read directly (not through session.run) so that
// drawing the menu can never end the session.
const hasNotifications = () => session.kind === "tenant" && !session.supporting;

function unreadCount() {
  if (!hasNotifications()) return 0;
  try {
    return session.app.notifications.unreadCount(session.ctx);
  } catch {
    return 0;
  }
}

function setUnread(badge, count) {
  badge.textContent = count > 0 ? String(count) : "";
  badge.hidden = count === 0;
  badge.setAttribute("aria-label", count > 0 ? `${count} unread` : "");
}

function notificationsLink(path) {
  const badge = h("span", { class: "nav-count", dataset: { unreadBadge: "" } });
  setUnread(badge, unreadCount());
  return h(
    "a",
    {
      href: "#/notifications",
      class: "nav-link",
      "aria-current": path === "notifications" ? "page" : null,
    },
    "Notifications ",
    badge
  );
}

// Reading a notification or doing something that creates one changes the count without a redraw of
// the page (which would lose what is typed in it).
function refreshUnread() {
  const badge = document.querySelector("[data-unread-badge]");
  if (badge) setUnread(badge, unreadCount());
}

// Pages anyone can read before signing in or choosing where to work.
const OPEN_PAGES = new Set(["tools", "limits"]);
const openPage = (path) =>
  h("main", { class: "content", id: "content", tabindex: "-1" }, page(path));

function sidebar(path) {
  const entries = navigation();
  const groups = [...new Set(entries.map((route) => route.group))];
  return h(
    "nav",
    { class: "sidebar", "aria-label": "Main" },
    h(
      "a",
      { href: "#/home", class: "nav-link", "aria-current": path === "home" ? "page" : null },
      "Home"
    ),
    hasNotifications() ? notificationsLink(path) : null,
    groups.map((group) =>
      h(
        "div",
        { class: "nav-group" },
        h("div", { class: "nav-title" }, group),
        entries
          .filter((route) => route.group === group)
          .map((route) =>
            h(
              "a",
              {
                href: `#/${route.path}`,
                class: "nav-link",
                "aria-current": route.path === path ? "page" : null,
              },
              route.label
            )
          )
      )
    )
  );
}

function page(path) {
  const { route, reason } = resolve(path);
  if (!route) {
    return reason === "not_inside"
      ? emptyState({
          title: "Choose where to work first",
          body: "Pick an organization or the platform to open this page.",
        })
      : emptyState({
          title: "Page not found",
          body: `There is no page at "${path}".`,
          action: h("a", { href: "#/home" }, "Go to Home"),
        });
  }
  if (reason === "wrong_context") {
    return emptyState({
      title: "Not available here",
      body: "This page belongs to a different kind of access.",
      action: h("a", { href: "#/home" }, "Go to Home"),
    });
  }
  const view = h("div");
  mount(view, () => route.view.render({ links: homeLinks() }));
  return view;
}

function draw() {
  if (container === null) return;
  const path = parse(window.location.hash);
  let body;
  if (!session.signedIn) {
    body = OPEN_PAGES.has(path)
      ? openPage(path)
      : h("main", { class: "centered" }, signin.render());
  } else if (!session.inside) {
    body = OPEN_PAGES.has(path)
      ? openPage(path)
      : h("main", { class: "centered" }, chooser.render());
  } else {
    const content = h("main", { class: "content", id: "content", tabindex: "-1" }, page(path));
    body = h("div", { class: "layout" }, sidebar(path), content);
  }
  slot = h(
    "div",
    { class: "app" },
    h("a", { class: "skip", href: "#content" }, "Skip to content"),
    header(),
    bannerFor(),
    body
  );
  container.replaceChildren(slot);
  // A new page takes focus so keyboard and screen-reader users start at its content.
  const key = `${session.signedIn}|${session.inside}|${path}`;
  if (key !== lastKey) {
    lastKey = key;
    document.getElementById("content")?.focus({ preventScroll: false });
  }
}

export function startApp(root) {
  container = root;
  session.onChange(draw);
  window.addEventListener("hashchange", draw);
  document.addEventListener(NOTIFICATIONS_CHANGED, refreshUnread);
  draw();
}
