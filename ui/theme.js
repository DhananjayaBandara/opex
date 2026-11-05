// Light / dark / auto theme. The choice is a per-viewer convenience kept in localStorage; the page
// works without it (private windows and blocked storage can throw).
const KEY = "opex-prototype:theme";
export const THEMES = ["auto", "light", "dark"];

function read() {
  try {
    const value = window.localStorage.getItem(KEY);
    return THEMES.includes(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(theme = read()) {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  return theme;
}

export const currentTheme = read;

export function setTheme(theme) {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable: the theme still applies for this page view
  }
  return applyTheme(theme);
}

export function nextTheme(theme = read()) {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}
