// A tiny element builder. Text is always added as a text node, never parsed as markup, so data from
// the store or from a person cannot inject HTML. Browser-only (uses the global `document`).

const PROPERTY_ATTRIBUTES = new Set(["value", "checked", "disabled", "selected", "indeterminate"]);

export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROPERTY_ATTRIBUTES.has(key)) element[key] = value;
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  append(element, children);
  return element;
}

export function append(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

let counter = 0;
export const uid = (prefix = "id") => `${prefix}-${(counter += 1)}`;

// Where focus returns after a dialog closes.
export const activeElement = () => document.activeElement;
