// AC-0.1 Browser smoke: the S0 modules run in a real browser against its real LocalStorage.
// Run through `npm run test:opex-prototype:browser`, which starts the static server and a
// disposable Chrome profile and sets OPEX_CDP_URL and OPEX_PROTOTYPE_URL.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { connectPage } from "./cdp.mjs";

const endpoint = process.env.OPEX_CDP_URL;
const base = process.env.OPEX_PROTOTYPE_URL;
if (!endpoint || !base) {
  throw new Error(
    "OPEX_CDP_URL and OPEX_PROTOTYPE_URL are required; run `npm run test:opex-prototype:browser`."
  );
}

const page = await connectPage(endpoint);
const smokeUrl = new URL("tests/browser/smoke.html", base).href;
const openSmokePage = async () => {
  await page.navigate(smokeUrl);
  await page.waitFor("window.opex?.ready === true", "window.opex to be ready");
};

after(() => {
  page.close();
});

test("AC-0.1 the S0 modules load in a real browser without errors", async () => {
  await openSmokePage();
  const exported = await page.run(
    `Object.entries(window.opex).filter(([, value]) => typeof value === "function").map(([name]) => name).sort()`
  );
  assert.deepEqual(exported, [
    "calculateProductionDay",
    "calculateSupervisorScore",
    "canAccess",
    "createStore",
    "replaceAssignment",
    "resolveAccess",
    "resolveTargets",
  ]);
  assert.deepEqual(page.problems(), []);
});

const storeScript = (body) => `(() => {
  const store = opex.createStore({ storage: opex.storage, uniques: { employees: [["code"]] } });
  const tenantA = store.session({ tenantId: "tenant-a", actorId: "user-a" });
  const tenantB = store.session({ tenantId: "tenant-b", actorId: "user-b" });
  ${body}
})()`;

test("AC-0.2 AC-0.4 tenant data and audit survive a real page reload in LocalStorage", async () => {
  await openSmokePage();
  await page.run("localStorage.clear()");
  await page.run(
    storeScript(`
      tenantA.insert("employees", { code: "E1", name: "Asha" });
      tenantB.insert("employees", { code: "E1", name: "Bimal" });
      return true;`)
  );
  await page.reload();
  await page.waitFor("window.opex?.ready === true", "window.opex after reload");
  const seen = await page.run(
    storeScript(`
      const bimal = tenantB.list("employees")[0];
      return {
        tenantA: tenantA.list("employees").map((row) => row.name),
        tenantB: tenantB.list("employees").map((row) => row.name),
        leak: tenantA.get("employees", bimal.id),
        auditA: tenantA.auditLog().map((event) => [event.action, event.actorId]),
        auditB: tenantB.auditLog().map((event) => [event.action, event.actorId]),
      };`)
  );
  assert.deepEqual(seen, {
    tenantA: ["Asha"],
    tenantB: ["Bimal"],
    leak: null,
    auditA: [["create", "user-a"]],
    auditB: [["create", "user-b"]],
  });
});

test("AC-0.2 a duplicate code is rejected in the same tenant and allowed in another", async () => {
  await openSmokePage();
  await page.run("localStorage.clear()");
  const outcome = await page.run(
    storeScript(`
      tenantA.insert("employees", { code: "E1", name: "Asha" });
      tenantB.insert("employees", { code: "E1", name: "Bimal" });
      let code = null;
      try { tenantA.insert("employees", { code: "E1", name: "Again" }); } catch (error) { code = error.code; }
      return { code, countA: tenantA.list("employees").length, auditA: tenantA.auditLog().length };`)
  );
  assert.deepEqual(outcome, { code: "duplicate", countA: 1, auditA: 1 });
});

test("AC-0.6 SRS 10.1 calculations give the same answers in the browser", async () => {
  await openSmokePage();
  const day = await page.run(`opex.calculateProductionDay(
    { hourlyTarget: 100, workingHours: 8, presentMCOperators: 20, presentHelpers: 5,
      presentManual: 0, plannedMCOperators: 20, plannedManual: 0, plannedEfficiency: 20 },
    { smv: 10 },
    [
      { ordinalHour: 1, actualPieces: 100 },
      { ordinalHour: 2, actualPieces: 120 },
      { ordinalHour: 3, actualPieces: null },
      { ordinalHour: 4, actualPieces: 80 },
    ]
  )`);
  assert.equal(day.totalProduction, 300);
  assert.equal(day.hoursRun, 3);
  assert.equal(day.averageHourly, 100);
  assert.equal(day.earnedSAH, 50);
  assert.equal(day.presentManpower, 25);
  assert.equal(day.achievedEfficiency, 25);
  assert.equal(day.firstHourHitRate, 100);
  assert.equal(day.plannedPieces, 800);
  assert.equal(day.piecesVariance, -500);
});

test("AC-0.3 access is denied across tenants and outside the factory scope", async () => {
  await openSmokePage();
  const verdicts = await page.run(`(() => {
    const access = opex.resolveAccess({
      tenantId: "tenant-a", userId: "user-a", asOf: "2026-11-02",
      permissionFeatures: { "production.read": null },
      entitlements: [],
      roles: [{ id: "role-1", tenantId: "tenant-a", permissions: ["production.read"] }],
      memberships: [{ tenantId: "tenant-a", userId: "user-a", status: "active",
        roleIds: ["role-1"], factoryScope: { all: false, factoryIds: ["factory-1"] } }],
      assignments: [],
    });
    return {
      inScope: opex.canAccess(access, "production.read", { tenantId: "tenant-a", factoryId: "factory-1" }),
      sameTenantOtherFactory: opex.canAccess(access, "production.read", { tenantId: "tenant-a", factoryId: "factory-2" }),
      otherTenant: opex.canAccess(access, "production.read", { tenantId: "tenant-b", factoryId: "factory-1" }),
    };
  })()`);
  assert.deepEqual(verdicts, { inScope: true, sameTenantOtherFactory: false, otherTenant: false });
});

test("AC-0.1 no page error was raised during the whole browser session", () => {
  assert.deepEqual(page.problems(), []);
});
