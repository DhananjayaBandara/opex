// Shared test harness. It must never hide a failure: only a *missing target module*
// is tolerated, so that the target contracts can fail as assertions (RED) rather
// than as import errors. Everything else is rethrown.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const harnessPath = fileURLToPath(import.meta.url);

export const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      values.set(key, String(value));
    },
    removeItem: (key) => {
      values.delete(key);
    },
    raw: () => JSON.stringify([...values.entries()]),
  };
};

export const optional = async (specifier) => {
  const url = new URL(specifier, import.meta.url);
  try {
    return await import(url.href);
  } catch (error) {
    const missingTarget = `Cannot find module '${fileURLToPath(url)}' imported from ${harnessPath}`;
    if (error?.code === "ERR_MODULE_NOT_FOUND" && error.message.startsWith(missingTarget))
      return {};
    throw error;
  }
};

export const need = (exports, name, source) => {
  assert.equal(
    typeof exports[name],
    "function",
    `${source} must export ${name}() - the contract is not implemented`
  );
  return exports[name];
};

export const near = (actual, expected, label, tolerance = 1e-9) => {
  assert.equal(typeof actual, "number", `${label}: expected a number, got ${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`
  );
};
