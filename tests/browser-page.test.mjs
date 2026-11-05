// AC-0.1 The browser smoke page script. It runs in Node here, with stubbed browser globals, so its
// import graph and exports are verified without Chrome or sockets. The same script is exercised in
// a real browser by browser-smoke.browser.mjs (run through `npm run test:opex-prototype:browser`).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { memoryStorage } from "./harness.mjs";

const pageUrl = new URL("./browser/smoke.html", import.meta.url);
const scriptUrl = new URL("./browser/smoke-page.js", import.meta.url);

test("AC-0.1 the smoke page exists and loads only the page script as a module", () => {
  assert.ok(existsSync(pageUrl), "opex-prototype/tests/browser/smoke.html must exist");
  const html = readFileSync(pageUrl, "utf8");
  assert.match(html, /<script type="module" src="\.\/smoke-page\.js"><\/script>/);
  assert.ok(!/<script(?![^>]*src=)/.test(html), "no inline scripts: the page script is testable");
});

test("AC-0.1 the page script imports in a browser-like environment and exposes the S0 API", async () => {
  assert.ok(existsSync(scriptUrl), "opex-prototype/tests/browser/smoke-page.js must exist");
  const storage = memoryStorage();
  globalThis.window = globalThis;
  globalThis.localStorage = storage;
  try {
    await import(scriptUrl.href);
    const api = globalThis.opex;
    assert.ok(api, "window.opex must be defined");
    assert.equal(api.ready, true);
    for (const name of [
      "createStore",
      "resolveAccess",
      "canAccess",
      "calculateProductionDay",
      "calculateSupervisorScore",
      "resolveTargets",
      "replaceAssignment",
    ])
      assert.equal(typeof api[name], "function", `window.opex.${name}`);
    assert.equal(api.storage, storage, "the page uses the browser's localStorage");
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
    delete globalThis.opex;
  }
});

test("AC-0.1 the page script uses no Node-only imports", () => {
  assert.ok(existsSync(scriptUrl), "opex-prototype/tests/browser/smoke-page.js must exist");
  const source = readFileSync(scriptUrl, "utf8");
  assert.ok(!/from\s+["']node:/.test(source), "browser code must not import node: modules");
  assert.ok(!/\brequire\(/.test(source), "browser code must not use require");
});
