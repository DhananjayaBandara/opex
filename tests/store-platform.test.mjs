// AC-1.1 Store extensions for S1: a reserved platform partition, a unit of work that spans
// partitions atomically, domain audit events, and recovery from unreadable storage.
// (SRS 4.2, 9.1, 15.4; architecture 4.6, 5.5, 8.)
import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage, optional, need } from "./harness.mjs";

const mod = await optional("../store/store.js");
const SRC = "store/store.js";
const NOW = "2026-11-02T09:00:00.000Z";
const UNIQUES = { tenants: [["slug"]], factories: [["code"]] };

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
const actor = { actorId: "user-1" };
const tenantA = { tenantId: "tenant-a", actorId: "user-a" };
const tenantB = { tenantId: "tenant-b", actorId: "user-b" };
const code = (expected) => (error) => error?.code === expected;
const needFn = (target, name) => {
  assert.equal(typeof target[name], "function", `${SRC} must provide ${name}()`);
  return target[name].bind(target);
};

test("AC-1.1 the platform partition holds rows that no tenant session can see", () => {
  const { store } = makeStore();
  const platform = needFn(store, "platformSession")(actor);
  const tenant = platform.insert("tenants", { slug: "felix", name: "Felix Fashions" });
  assert.equal(tenant.tenantId, "platform");
  assert.equal(platform.list("tenants").length, 1);

  const a = store.session(tenantA);
  assert.deepEqual(a.list("tenants"), []);
  assert.equal(a.get("tenants", tenant.id), null);
  assert.throws(() => a.update("tenants", tenant.id, { name: "x" }), code("not_found"));
  assert.throws(() => a.remove("tenants", tenant.id), code("not_found"));
});

test("AC-1.1 a tenant row is invisible to the platform partition", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  const row = a.insert("factories", { code: "F1" });
  const platform = needFn(store, "platformSession")(actor);
  assert.deepEqual(platform.list("factories"), []);
  assert.equal(platform.get("factories", row.id), null);
});

test("AC-1.1 the reserved platform id cannot be used for a tenant session", () => {
  const { store } = makeStore();
  assert.throws(
    () => store.session({ tenantId: "platform", actorId: "user-1" }),
    code("reserved_tenant")
  );
  assert.throws(
    () => needFn(store, "unitOfWork")(actor, ({ tenant }) => tenant("platform")),
    code("reserved_tenant")
  );
});

test("AC-1.1 platform audit events carry the platform partition and the actor", () => {
  const { store } = makeStore();
  const platform = needFn(store, "platformSession")(actor);
  const tenant = platform.insert("tenants", { slug: "felix" });
  const [event] = platform.auditLog({ entityType: "tenants" });
  assert.equal(event.tenantId, "platform");
  assert.equal(event.actorId, "user-1");
  assert.equal(event.entityId, tenant.id);
  assert.deepEqual(store.session(tenantA).auditLog(), []);
});

test("AC-1.1 a unit of work commits platform and tenant rows with their audit events together", () => {
  const { store } = makeStore();
  const tenantRow = needFn(store, "unitOfWork")(actor, ({ platform, tenant }) => {
    const row = platform.insert("tenants", { slug: "felix" });
    tenant("tenant-a").insert("factories", { code: "F1" });
    return row;
  });
  const platform = needFn(store, "platformSession")(actor);
  assert.equal(platform.list("tenants").length, 1);
  assert.equal(platform.auditLog().length, 1);
  const a = store.session(tenantA);
  assert.equal(a.list("factories").length, 1);
  assert.equal(a.auditLog()[0].actorId, "user-1");
  assert.equal(tenantRow.slug, "felix");
});

test("AC-1.1 a failed unit of work leaves no rows and no audit events in either partition", () => {
  const { store, storage } = makeStore();
  const platform = needFn(store, "platformSession")(actor);
  platform.insert("tenants", { slug: "existing" });
  const before = storage.raw();
  assert.throws(
    () =>
      needFn(store, "unitOfWork")(actor, ({ platform: p, tenant }) => {
        p.insert("tenants", { slug: "new" });
        tenant("tenant-a").insert("factories", { code: "F1" });
        throw new Error("seeding failed");
      }),
    /seeding failed/
  );
  assert.equal(storage.raw(), before, "storage is untouched");
  assert.equal(platform.list("tenants").length, 1);
  assert.deepEqual(store.session(tenantA).list("factories"), []);
  assert.deepEqual(store.session(tenantA).auditLog(), []);
});

test("AC-1.1 a uniqueness failure inside a unit of work rolls the whole unit back", () => {
  const { store } = makeStore();
  const platform = needFn(store, "platformSession")(actor);
  platform.insert("tenants", { slug: "felix" });
  assert.throws(
    () =>
      needFn(store, "unitOfWork")(actor, ({ platform: p, tenant }) => {
        tenant("tenant-a").insert("factories", { code: "F1" });
        p.insert("tenants", { slug: "felix" });
      }),
    code("duplicate")
  );
  assert.deepEqual(store.session(tenantA).list("factories"), []);
});

test("AC-1.1 record appends a domain audit event atomically with the transaction", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  a.transaction((tx) => {
    const row = tx.insert("factories", { code: "F1" });
    needFn(
      tx,
      "record"
    )({
      action: "deactivate",
      entityType: "factories",
      entityId: row.id,
      changes: { active: { before: true, after: false } },
    });
  });
  const events = a.auditLog({ entityType: "factories" });
  assert.deepEqual(
    events.map((event) => event.action),
    ["create", "deactivate"]
  );
  assert.deepEqual(events[1].changes, { active: { before: true, after: false } });
  assert.equal(events[1].tenantId, "tenant-a");
  assert.equal(events[1].actorId, "user-a");
  assert.equal(events[1].timestamp, NOW);
});

test("AC-1.1 record rolls back with a failed transaction and rejects the store's own actions", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  assert.throws(
    () =>
      a.transaction((tx) => {
        needFn(tx, "record")({ action: "sign_in", entityType: "users", entityId: "u1" });
        throw new Error("boom");
      }),
    /boom/
  );
  assert.deepEqual(a.auditLog(), []);
  for (const bad of ["create", "update", "delete", "", "Sign-In", 7])
    assert.throws(
      () =>
        a.transaction((tx) =>
          needFn(tx, "record")({ action: bad, entityType: "users", entityId: "u1" })
        ),
      (error) => ["reserved_action", "invalid_action"].includes(error?.code),
      `action ${String(bad)}`
    );
  assert.throws(
    () =>
      a.transaction((tx) =>
        needFn(tx, "record")({ action: "sign_in", entityType: "audit", entityId: "u1" })
      ),
    code("reserved_collection")
  );
});

test("AC-1.1 record is also available on a session and inside a unit of work", () => {
  const { store } = makeStore();
  const a = store.session(tenantA);
  needFn(a, "record")({ action: "sign_in", entityType: "users", entityId: "u1" });
  needFn(store, "unitOfWork")(actor, ({ platform, tenant }) => {
    needFn(platform, "record")({ action: "provision", entityType: "tenants", entityId: "t1" });
    needFn(
      tenant("tenant-b"),
      "record"
    )({
      action: "seed",
      entityType: "roles",
      entityId: "r1",
    });
  });
  assert.equal(a.auditLog()[0].action, "sign_in");
  assert.equal(store.platformSession(actor).auditLog()[0].action, "provision");
  assert.equal(store.session(tenantB).auditLog()[0].action, "seed");
});

test("AC-1.1 unreadable storage opens an empty store, quarantines the raw value and reports it", () => {
  const storage = memoryStorage();
  storage.setItem("opex-prototype:v1", "{not json");
  const { store } = makeStore({ storage });
  assert.ok(store.recovery, "the recovery is reported");
  assert.equal(store.recovery.reason, "unreadable");
  assert.equal(storage.getItem(store.recovery.quarantineKey), "{not json");
  assert.equal(storage.getItem("opex-prototype:v1"), null);
  const a = store.session(tenantA);
  assert.deepEqual(a.list("factories"), []);
  a.insert("factories", { code: "F1" });
  assert.equal(a.list("factories").length, 1, "the store is usable after recovery");
});

test("AC-1.1 storage of the wrong shape or schema version is quarantined, not trusted", () => {
  for (const [raw, reason] of [
    [JSON.stringify({ schemaVersion: 99, tables: {}, audit: [] }), "schema_version"],
    [JSON.stringify({ schemaVersion: 1, tables: [], audit: {} }), "unreadable"],
    ["null", "unreadable"],
  ]) {
    const storage = memoryStorage();
    storage.setItem("opex-prototype:v1", raw);
    const { store } = makeStore({ storage });
    assert.equal(store.recovery?.reason, reason, raw);
    assert.equal(storage.getItem(store.recovery.quarantineKey), raw);
  }
});

test("AC-1.1 readable storage reports no recovery and keeps its data", () => {
  const storage = memoryStorage();
  const first = makeStore({ storage }).store;
  first.session(tenantA).insert("factories", { code: "F1" });
  const { store } = makeStore({ storage });
  assert.equal(store.recovery, null);
  assert.equal(store.session(tenantA).list("factories").length, 1);
});
