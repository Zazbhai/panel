"use strict";
// Synthetic fixtures only. No server startup, credentials, Firebase, or other network access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeStore } = require("../runtime-store-core.cjs");
const { AsyncRuntimeStore } = require("../runtime-store.cjs");
const serverFixture = require("./server-fixture.cjs");
const database = "https://fixture.firebaseio.com";
const candidate = { database, deviceId: "synthetic-device", number: "9000000001" };
const state = { initialized: true, databaseUrls: [database], orders: [], serviceUsage: {} };

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-store-test-"));
  const filename = path.join(directory, "test.sqlite");
  const stores = [];
  let core;
  try {
    core = new RuntimeStore(filename);
    assert.equal(core.initialize(state), true);
    assert.equal(core.initialize({ ...state, databaseUrls: [] }), false);
    core.remember(candidate);
    const first = core.claim({ service: "jio", candidate });
    assert(first);
    assert.equal(core.claim({ service: "swiggy", candidate }), null, "Only one waiting order may lease a number globally");
    core.receive({ id: first.orderId, matches: [{ key: "first", code: "123456", timestamp: Date.now(), message: { text: "Jio code 123456" } }] });
    assert.equal(core.claim({ service: "jio", candidate }), null, "An OTP permanently locks the number for its service");
    const second = core.claim({ service: "swiggy", candidate });
    assert(second, "After the first OTP, another service may reuse the number");
    core.receive({ id: second.orderId, matches: [{ key: "first", code: "123456", timestamp: Date.now(), message: { text: "Jio code 123456" } }] });
    assert.equal(core.getOrder(second.orderId).receivedOtp, null, "One SMS may belong to only one order");
    const followup = { key: "followup", code: "654321", timestamp: Date.now(), message: { text: "Jio code 654321" } };
    core.receive({ id: first.orderId, matches: [followup, followup] });
    assert.equal(core.getOrder(first.orderId).receivedOtps.length, 2, "Completed orders accept additional distinct OTPs");
    assert.equal(core.getOrder(first.orderId).messageHistory.length, 2);
    assert.equal(core.latestMessages().orders.length, 2, "Saved OTP feed is backed by individual recent OTP rows");
    assert.equal(core.claim({ service: "flipkart", candidate }), null, "A follow-up OTP must not release another order's lease");
    assert.equal(core.setStatus({ id: second.orderId, status: "8" }), "ACCESS_CANCEL");
    const third = core.claim({ service: "flipkart", candidate, duration: 10000 });
    assert(third);
    assert.equal(core.claim({ service: "swiggy", candidate }), null);
    core.sql("UPDATE leases SET expires_at=? WHERE number=?").run(Date.now() - 1, candidate.number);
    assert(core.claim({ service: "unused-service", candidate }), "Expired leases are reusable without scanning orders");
    core.close(); core = null;

    core = new RuntimeStore(filename);
    assert.equal(core.claim({ service: "jio", candidate }), null, "Service locks survive process restarts");
    assert.equal(core.getOrder(first.orderId).receivedOtps.length, 2);
    const count = core.sql("SELECT COUNT(*) AS n FROM orders").get().n;
    assert.throws(() => core.claim({ service: "other", candidate, deadline: Date.now() - 1 }), { code: "ALLOCATION_TIMEOUT" });
    assert.equal(core.sql("SELECT COUNT(*) AS n FROM orders").get().n, count, "A late claim must not count as an order");
    core.close(); core = null;

    const a = new AsyncRuntimeStore(filename), b = new AsyncRuntimeStore(filename);
    stores.push(a, b);
    const candidate2 = { ...candidate, deviceId: "second", number: "9000000002" };
    await a.call("remember", candidate2);
    const claims = await Promise.all([
      a.call("claim", { service: "one", candidate: candidate2 }),
      b.call("claim", { service: "two", candidate: candidate2 })
    ]);
    assert.equal(claims.filter(Boolean).length, 1, "Concurrent workers must atomically claim one global lease");
    const page = await a.call("getRecentOrders", { limit: 1 });
    assert.equal(page.orders.length, 1);
    assert(page.hasMore);
    const next = await a.call("getRecentOrders", { limit: 1, before: page.nextCursor });
    assert.notEqual(next.orders[0].orderId, page.orders[0].orderId);
    const filtered = await a.call("getRecentOrders", { search: "9000000002" });
    assert.equal(filtered.stats.total, 1);
    assert.equal(filtered.orders[0].number, "9000000002");
    const cycleStore = new RuntimeStore(":memory:");
    cycleStore.initialize(state);
    const only = { ...candidate, deviceId: "cycle-device", number: "9000000003" };
    cycleStore.remember(only);
    const used = cycleStore.claim({ service: "once", candidate: only });
    assert(used);
    cycleStore.setStatus({ id: used.orderId, status: "8" });
    assert.equal(cycleStore.candidates({ service: "once", databases: [database] }).length, 0);
    assert.equal(cycleStore.advanceCycle({ service: "once", databases: [database] }), true);
    assert.equal(cycleStore.candidates({ service: "once", databases: [database] }).length, 1,
      "A non-OTP number can be reused after every online number in the service cycle was tried");
    cycleStore.close();
  } finally {
    if (core) core.close();
    for (const store of stores) await store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(filename + suffix); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    fs.rmdirSync(directory);
  }

  {
    const f = serverFixture();
    await f.context.getRuntimeStore();
    f.runtime.remember(candidate);
    let statusReads = 0;
    f.fetch = async (url) => {
      assert.equal(url, database + "/clients/synthetic-device.json", "Warm allocation may only check the device status");
      statusReads++;
      return { ok: true, status: 200, json: async () => ({ status: true }) };
    };
    const before = [...f.readCounts].find(([name]) => name.endsWith("rotation.json"))[1];
    const order = await f.context.findAvailableActiveNumber("jio");
    assert(order);
    assert.equal(statusReads, 1);
    assert.equal([...f.readCounts].find(([name]) => name.endsWith("rotation.json"))[1], before);
    const file = [...f.files.keys()].find((name) => name.endsWith("rotation.json"));
    assert.equal(JSON.parse(f.files.get(file)).orders.length, 0, "New orders must not rewrite the JSON history");
  }
  {
    const f = serverFixture();
    await f.context.getRuntimeStore();
    f.runtime.remember(candidate);
    f.fetch = async (url) => ({ ok: true, status: 200, json: async () => url.endsWith("/clients.json") ? {} : { status: false } });
    assert.equal(await f.context.findAvailableActiveNumber("jio"), null, "Offline devices cannot be allocated");
  }
  {
    const f = serverFixture();
    const now = Date.now();
    f.setRotation({ ...state, orders: [{
      orderId: "a".repeat(24), deviceId: candidate.deviceId, databaseUrl: database, number: candidate.number,
      service: "jio", createdAt: now - 10000, expiresAt: now + 60000, status: "completed",
      receivedOtp: "123456", receivedAt: now - 1000,
      receivedOtps: [{ code: "123456", receivedAt: now - 1000, messageKey: "saved" }], messageHistory: []
    }] });
    await f.context.getRuntimeStore();
    f.runtime.remember(candidate);
    assert.equal(f.runtime.candidates({ service: "jio", databases: [database] }).length, 0);
    assert.equal(f.runtime.candidates({ service: "other", databases: [database] }).length, 1);
    const backup = [...f.files.keys()].find((name) => name.endsWith("rotation.pre-sqlite.json"));
    assert.equal(JSON.parse(f.files.get(backup)).orders[0].receivedOtp, "123456", "Migration preserves the original JSON backup");
  }
  {
    const f = serverFixture();
    f.setRotation({ ...state, runtimeStoreVersion: 1 });
    await assert.rejects(f.context.getRuntimeStore(), /Restore the runtime database backup/, "Missing permanent locks must fail closed");
  }
  console.log("PASS: durable shared inventory, permanent service locks, cross-service reuse, atomic leases, multiple OTPs, migration, pagination, offline checks, and warm allocation without SMS scans or JSON rewrites.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
