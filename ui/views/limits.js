// What the prototype does not do for real (D108). Open to everyone, signed in or not.
import { LEVELS, LIMITS, SIMULATED } from "../../domain/limits.js";
import { h } from "../dom.js";
import { badge, card, pageHeader } from "../kit.js";

const tone = { D: "good", S: "info", N: "muted" };

export function render() {
  return h(
    "div",
    {},
    pageHeader(
      "Limits of this prototype",
      "OPEX+ is shown here as a demonstration. This page says what is real, what is pretended and what cannot be shown in a browser."
    ),
    card(
      "The three levels",
      h(
        "ul",
        { class: "plain" },
        LEVELS.map((level) =>
          h("li", {}, badge(`${level.key} · ${level.label}`, tone[level.key]), " ", level.meaning)
        )
      )
    ),
    card(
      "Simulated",
      h(
        "dl",
        { class: "kv" },
        SIMULATED.flatMap((item) => [
          h("dt", {}, item.title),
          h(
            "dd",
            {},
            h("p", {}, h("strong", {}, "Pretended: "), item.simulated),
            h("p", {}, h("strong", {}, "Still real: "), item.real),
            h("p", { class: "muted" }, `Source: ${item.source}`)
          ),
        ])
      )
    ),
    card(
      "Cannot be shown in a browser",
      h(
        "dl",
        { class: "kv" },
        LIMITS.flatMap((item) => [
          h("dt", {}, item.title),
          h(
            "dd",
            {},
            h("p", {}, item.reason),
            h("p", { class: "muted" }, `Source: ${item.source}`)
          ),
        ])
      )
    )
  );
}
