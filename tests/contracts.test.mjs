// AC-0.2 two-tenant isolation, AC-0.4 audit of every mutation (SRS 11, standards invariants).
import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage, optional, need } from "./harness.mjs";

const mod = await optional("../store/store.js");
const SRC = "store/store.js";
const NOW = "2026-11-02T09:00:00.000Z";
const UNIQUES = { employees: [["code"]] };

const makeStore = (options = {}) => {
  let counter = 0;
  const storage = options.storage ?? memoryStorage();
  const store = need(
    mod,
    "createStore",
    SRC
  )({
    storage,
    clock: () => NOW,
    newId: () => `id-${++counter}`,
    uniques: UNIQUES,
    ...options,
  });
  return { store, storage };
};
const tenantA = { tenantId: "tenant-a", actorId: "user-a" };
const tenantB = { tenantId: "tenant-b", actorId: "user-b" };
const code = (expected) => (error) => error?.code === expected;

test("AC-0.2 an inserted row belongs to the session tenant and gets a generated id", () => {
  const { store } = makeStore();
  const row = store.session(tenantA).insert("employees", { code: "E1", name: "Asha" });
  assert.equal(row.tenantId, "tenant-a");
  assert.equal(row.id, "id-1");
  assert.equal(row.code, "E1");
});

test("AC-0.2 a tenantId or id supplied in the payload is ignored", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const row = a.insert("employees", { code: "E1", tenantId: "tenant-b", id: "forged" });
  assert.equal(row.tenantId, "tenant-a");
  assert.notEqual(row.id, "forged");
  assert.deepEqual(store.session(tenantB).list("employees"), []);
  const moved = a.update("employees", row.id, { tenantId: "tenant-b", name: "Asha" });
  assert.equal(moved.tenantId, "tenant-a");
  assert.deepEqual(store.session(tenantB).list("employees"), []);
  assert.equal(a.list("employees").length, 1);
});

test("AC-0.2 a session needs a tenant and an actor", () => {
  const { store } = makeStore();
  for (const bad of [
    {},
    { tenantId: "tenant-a" },
    { actorId: "u" },
    { tenantId: "", actorId: "u" },
  ])
    assert.throws(() => store.session(bad), code("invalid_context"));
});

test("AC-0.2 reads never cross the tenant boundary", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const b = store.session(tenantB);
  const rowA = a.insert("employees", { code: "E1" });
  b.insert("employees", { code: "E9" });
  assert.deepEqual(
    a.list("employees").map((row) => row.code),
    ["E1"]
  );
  assert.deepEqual(
    b.list("employees").map((row) => row.code),
    ["E9"]
  );
  assert.equal(
    b.get("employees", rowA.id),
    null,
    "another tenant's id is indistinguishable from a missing one"
  );
});

test("AC-0.2 another tenant's row cannot be updated or removed, and nothing leaks about it", () => {
  const { store } = makeStore();
  const rowA = store.session(tenantA).insert("employees", { code: "E1", name: "Asha" });
  const b = store.session(tenantB);
  assert.throws(() => b.update("employees", rowA.id, { name: "Hijack" }), code("not_found"));
  assert.throws(() => b.remove("employees", rowA.id), code("not_found"));
  assert.equal(store.session(tenantA).get("employees", rowA.id).name, "Asha");
  assert.deepEqual(b.auditLog(), []);
});

test("AC-0.2 uniqueness is tenant-aware: the same code is allowed in two tenants, not twice in one", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  a.insert("employees", { code: "E1" });
  assert.doesNotThrow(() => store.session(tenantB).insert("employees", { code: "E1" }));
  assert.throws(() => a.insert("employees", { code: "E1" }), code("duplicate"));
});

test("AC-0.2 updates cannot create a duplicate, but a row may keep its own value", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const first = a.insert("employees", { code: "E1" });
  a.insert("employees", { code: "E2" });
  assert.throws(() => a.update("employees", first.id, { code: "E2" }), code("duplicate"));
  assert.doesNotThrow(() => a.update("employees", first.id, { code: "E1", name: "Asha" }));
});

test("AC-0.2 returned rows are copies: mutating them does not change the store", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const row = a.insert("employees", { code: "E1", name: "Asha" });
  row.name = "Tampered";
  a.list("employees")[0].name = "Tampered";
  assert.equal(a.get("employees", row.id).name, "Asha");
});

test("AC-0.2 list accepts a filter that runs inside the tenant only", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  a.insert("employees", { code: "E1", active: true });
  a.insert("employees", { code: "E2", active: false });
  store.session(tenantB).insert("employees", { code: "E3", active: true });
  assert.deepEqual(
    a.list("employees", (row) => row.active).map((row) => row.code),
    ["E1"]
  );
});

test("AC-0.4 create, update and delete each append one audit event with the required fields", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const row = a.insert("employees", { code: "E1", name: "Asha" });
  a.update("employees", row.id, { name: "Asha D" });
  a.remove("employees", row.id);
  const events = a.auditLog();
  assert.deepEqual(
    events.map((event) => event.action),
    ["create", "update", "delete"]
  );
  for (const event of events) {
    assert.equal(event.tenantId, "tenant-a");
    assert.equal(event.actorId, "user-a");
    assert.equal(event.timestamp, NOW);
    assert.equal(event.entityType, "employees");
    assert.equal(event.entityId, row.id);
    assert.equal(typeof event.id, "string");
  }
});

test("AC-0.4 audit records only the material changes, with before and after", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const row = a.insert("employees", { code: "E1", name: "Asha", grade: "G1" });
  a.update("employees", row.id, { name: "Asha D", grade: "G1" });
  const [created, updated] = a.auditLog();
  assert.deepEqual(updated.changes, { name: { before: "Asha", after: "Asha D" } });
  assert.deepEqual(created.changes.code, { before: null, after: "E1" });
  assert.equal("tenantId" in created.changes, false, "system fields are not material changes");
  assert.equal("id" in created.changes, false);
});

test("AC-0.4 a delete audit event keeps the removed values", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const row = a.insert("employees", { code: "E1", name: "Asha" });
  a.remove("employees", row.id);
  const deleted = a.auditLog().at(-1);
  assert.deepEqual(deleted.changes.name, { before: "Asha", after: null });
  assert.deepEqual(a.list("employees"), []);
});

test("AC-0.4 an update that changes nothing writes nothing and audits nothing", () => {
  const { store, storage } = makeStore();
  const a = store.session(tenantA);
  const row = a.insert("employees", { code: "E1", name: "Asha" });
  const before = storage.raw();
  a.update("employees", row.id, { name: "Asha" });
  assert.equal(a.auditLog().length, 1);
  assert.equal(storage.raw(), before);
});

test("AC-0.4 audit reads are tenant-scoped and filterable", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const e1 = a.insert("employees", { code: "E1" });
  a.insert("employees", { code: "E2" });
  store.session(tenantB).insert("employees", { code: "E1" });
  assert.equal(a.auditLog().length, 2);
  assert.equal(store.session(tenantB).auditLog().length, 1);
  assert.deepEqual(
    a.auditLog({ entityId: e1.id }).map((event) => event.entityId),
    [e1.id]
  );
  assert.equal(a.auditLog({ entityType: "nothing" }).length, 0);
});

test("AC-0.4 the audit log is append-only: it cannot be written through the data API or via copies", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  a.insert("employees", { code: "E1" });
  assert.throws(() => a.insert("audit", { action: "x" }), code("reserved_collection"));
  assert.throws(() => a.update("audit", "id-2", { action: "x" }), code("reserved_collection"));
  assert.throws(() => a.remove("audit", "id-2"), code("reserved_collection"));
  a.auditLog()[0].action = "tampered";
  assert.equal(a.auditLog()[0].action, "create");
});

test("AC-0.4 a rejected mutation leaves no row and no audit event", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  a.insert("employees", { code: "E1" });
  assert.throws(() => a.insert("employees", { code: "E1" }), code("duplicate"));
  assert.equal(a.list("employees").length, 1);
  assert.equal(a.auditLog().length, 1);
});

test("AC-0.4 the audit event is atomic with the mutation: no audit, no change", () => {
  let failing = false;
  const { store } = makeStore({
    clock: () => {
      if (failing) throw new Error("clock unavailable");
      return NOW;
    },
  });
  const a = store.session(tenantA);
  a.insert("employees", { code: "E1" });
  failing = true;
  assert.throws(() => a.insert("employees", { code: "E2" }), /clock unavailable/);
  failing = false;
  assert.deepEqual(
    a.list("employees").map((row) => row.code),
    ["E1"]
  );
  assert.equal(a.auditLog().length, 1);
});

test("AC-0.4 a failed transaction rolls back every row and audit event, in memory and in storage", () => {
  const { store, storage } = makeStore();
  const a = store.session(tenantA);
  a.insert("employees", { code: "E1" });
  const before = storage.raw();
  assert.throws(
    () =>
      a.transaction((tx) => {
        tx.insert("employees", { code: "E2" });
        tx.insert("employees", { code: "E3" });
        tx.insert("employees", { code: "E1" });
      }),
    code("duplicate")
  );
  assert.deepEqual(
    a.list("employees").map((row) => row.code),
    ["E1"]
  );
  assert.equal(a.auditLog().length, 1);
  assert.equal(storage.raw(), before);
});

test("AC-0.4 a committed transaction keeps all rows and audits each mutation", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const result = a.transaction((tx) => {
    tx.insert("employees", { code: "E1" });
    return tx.insert("employees", { code: "E2" }).code;
  });
  assert.equal(result, "E2");
  assert.equal(a.list("employees").length, 2);
  assert.equal(a.auditLog().length, 2);
});

test("AC-0.2 data and audit survive a reload from the same storage", () => {
  const { store, storage } = makeStore();
  store.session(tenantA).insert("employees", { code: "E1" });
  store.session(tenantB).insert("employees", { code: "E2" });
  const reloaded = need(mod, "createStore", SRC)({ storage, uniques: UNIQUES });
  assert.deepEqual(
    reloaded
      .session(tenantA)
      .list("employees")
      .map((row) => row.code),
    ["E1"]
  );
  assert.equal(reloaded.session(tenantA).auditLog().length, 1);
  assert.throws(
    () => reloaded.session(tenantA).insert("employees", { code: "E1" }),
    code("duplicate")
  );
});
