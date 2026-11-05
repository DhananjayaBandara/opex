// AC-0.8 The decision log carries every decision of the legacy prototype with its status unchanged
// and records the PROPOSED defaults of the rebuild (plan section "Open decisions").
// The legacy decision file is a byte-identical frozen copy (fixtures/legacy-decisions.md) of
// felix-erp-prototype/PROTOTYPE_DECISIONS.md at commit 0b4283e; the legacy directory was removed
// after the parity gate (plan section 7). Every assertion below is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const legacyPath = new URL("./fixtures/legacy-decisions.md", import.meta.url);
const logPath = new URL("../DECISIONS.md", import.meta.url);
const planPath = new URL("../../docs/engineering/plans/prototype-rebuild.md", import.meta.url);

const squash = (text) => text.replace(/\s+/g, " ").trim();
const read = (url) => readFileSync(url, "utf8");
const loadLog = () => {
  assert.ok(existsSync(logPath), "opex-prototype/DECISIONS.md must exist");
  return read(logPath);
};

function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  assert.notEqual(start, -1, `section "${heading}" must exist`);
  const body = text.slice(start + 1);
  const next = body.slice(3).search(/\n## /);
  return next === -1 ? body : body.slice(0, next + 3);
}
const tableRows = (text) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => squash(cell))
    )
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)))
    .slice(1);

test("AC-0.8 every CONFIRMED requirement is carried with the same text", () => {
  const legacy = section(read(legacyPath), "CONFIRMED requirements")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => squash(line.slice(2)));
  const carried = section(loadLog(), "CONFIRMED requirements")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => squash(line.slice(2)));
  assert.equal(legacy.length, 13);
  assert.deepEqual(
    carried.map((line) => line.replace(/^\*\*C\d+\*\* /, "")),
    legacy
  );
  assert.deepEqual(
    carried.map((line) => line.match(/^\*\*(C\d+)\*\*/)?.[1]),
    legacy.map((_, index) => `C${index + 1}`)
  );
});

test("AC-0.8 every PROPOSED prototype choice is carried with the same area and text", () => {
  const legacy = tableRows(section(read(legacyPath), "PROPOSED prototype choices"));
  const carried = tableRows(section(loadLog(), "PROPOSED prototype choices"));
  assert.equal(legacy.length, 25);
  assert.deepEqual(
    carried.map(([, area, choice]) => [area, choice]),
    legacy
  );
  assert.deepEqual(
    carried.map(([id]) => id),
    legacy.map((_, index) => `P${index + 1}`)
  );
});

test("AC-0.8 all 15 OPEN business decisions are carried, still open", () => {
  const items = (text) =>
    text
      .split("\n")
      .filter((line) => /^\d+\. /.test(line))
      .map((line) => squash(line.replace(/^\d+\. /, "")));
  const legacy = items(section(read(legacyPath), "OPEN business decisions"));
  const carriedSection = section(loadLog(), "OPEN business decisions");
  assert.equal(legacy.length, 15);
  assert.deepEqual(
    items(carriedSection).map((line) => line.replace(/^\*\*O\d+\*\* /, "")),
    legacy
  );
  assert.deepEqual(
    items(carriedSection).map((line) => line.match(/^\*\*(O\d+)\*\*/)?.[1]),
    legacy.map((_, index) => `O${index + 1}`)
  );
  assert.match(carriedSection, /remain unresolved/);
});

test("AC-0.8 the legacy limits and concept mapping are carried", () => {
  const legacyText = read(legacyPath);
  const log = loadLog();
  const body = (text) => squash(text.split("\n").slice(1).join("\n"));
  const legacyLimits = body(section(legacyText, "Intentionally not implemented"));
  assert.ok(legacyLimits.length > 200, "the legacy limits paragraph must be found");
  assert.ok(
    body(section(log, "Intentionally not implemented")).includes(legacyLimits),
    "the list of intentionally unimplemented items must be carried"
  );
  const legacyMapping = tableRows(section(legacyText, "Legacy-to-new mapping"));
  assert.deepEqual(tableRows(section(log, "Legacy-to-new mapping")), legacyMapping);
});

test("AC-0.8 the rebuild defaults D1 to D14 are recorded as PROPOSED", () => {
  const rows = tableRows(section(loadLog(), "PROPOSED defaults for the rebuild"));
  assert.deepEqual(
    rows.map(([id]) => id),
    Array.from({ length: 14 }, (_, index) => `D${index + 1}`)
  );
  for (const [id, decision, source, status, standing] of rows) {
    assert.ok(decision.length > 10, `${id}: decision`);
    assert.ok(source.length > 3, `${id}: source`);
    assert.equal(status, "PROPOSED", `${id}: status`);
    assert.ok(standing.length > 10, `${id}: proposed default`);
  }
});

test("AC-0.8 D1 to D12 use the same ids as the plan's open-decision table", () => {
  const plan = read(planPath);
  const start = plan.indexOf("## Open decisions and PROPOSED defaults");
  const end = plan.indexOf("\n## 7. Parity gate");
  const planIds = tableRows(plan.slice(start, end)).map(([id]) => id);
  assert.deepEqual(
    planIds,
    Array.from({ length: 12 }, (_, index) => `D${index + 1}`)
  );
});
