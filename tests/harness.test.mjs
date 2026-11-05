import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage, optional, need, near } from "./harness.mjs";

test("harness: in-memory storage behaves like Storage", () => {
  const storage = memoryStorage();
  assert.equal(storage.getItem("missing"), null);
  storage.setItem("a", "1");
  assert.equal(storage.getItem("a"), "1");
  storage.removeItem("a");
  assert.equal(storage.getItem("a"), null);
});

test("harness: optional() loads an existing module", async () => {
  const loaded = await optional("./fixtures/ok.mjs");
  assert.equal(loaded.answer, 42);
});

test("harness: optional() tolerates only a missing target module", async () => {
  assert.deepEqual(await optional("./fixtures/not-created-yet.mjs"), {});
});

test("harness: optional() does not hide a missing import inside an existing module", async () => {
  await assert.rejects(optional("./fixtures/imports-missing.mjs"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

test("harness: optional() does not hide a load-time failure", async () => {
  await assert.rejects(optional("./fixtures/throws.mjs"), /fixture module failed while loading/);
});

test("harness: need() returns a present function and names the contract when absent", () => {
  const f = () => 1;
  assert.equal(need({ f }, "f", "x.js"), f);
  assert.throws(() => need({}, "g", "x.js"), /x\.js must export g\(\)/);
});

test("harness: near() compares numbers with a tolerance and rejects non-numbers", () => {
  near(0.1 + 0.2, 0.3, "float sum");
  assert.throws(() => near(1, 2, "different"));
  assert.throws(() => near(null, 0, "null is not zero"));
});
