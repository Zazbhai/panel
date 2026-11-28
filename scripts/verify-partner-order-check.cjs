"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeStore } = require("../runtime-store-core.cjs");
const { statusOf, explicitNotFound, mapConcurrent, readLocalOrders } = require("./reconcile-partner-orders.cjs");

assert.equal(statusOf({ data: { order: { status: "cancelled" } } }), "cancelled");
assert.equal(statusOf({ result: [{ status: "completed" }, { state: "cancelled" }] }), "cancelled",
  "A cancellation status takes precedence when the response nests status metadata");
assert.equal(statusOf({ data: { status: "active" } }), "active");
assert.equal(statusOf({ data: { state: "processing" } }), "processing");
assert.equal(statusOf({ data: { message: "Order not found" } }), null);
assert.equal(explicitNotFound({ data: { message: "Order not found" } }), true);
assert.equal(explicitNotFound({ status: "not_found" }), false,
  "Absence wording in an ordinary status does not misclassify an order as missing");

(async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-partner-orders-"));
  const fixtureDbPath = path.join(fixtureDir, "runtime.sqlite");
  const liveStore = new RuntimeStore(fixtureDbPath);
  try {
    liveStore.sql("INSERT INTO orders(id,service,number,database_url,device_id,created_at,expires_at,status,received_otp,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("read-order", "fixture", "9000000000", "https://fixture.firebaseio.com", "device", Date.now(), Date.now() + 60000, "active", null, null);
    liveStore.db.exec("BEGIN IMMEDIATE");
    const readOrders = readLocalOrders(fixtureDbPath, 1000);
    assert.equal(readOrders.length, 1, "Dry-run reads must work while the live WAL database has a writer transaction");
    assert.equal(readOrders[0].id, "read-order");
    liveStore.db.exec("ROLLBACK");
  } finally {
    liveStore.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  const items = Array.from({ length: 30 }, (_, index) => index);
  let active = 0;
  let peak = 0;
  const results = await mapConcurrent(items, 7, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, item % 3));
    active -= 1;
    return item * 2;
  });
  assert.equal(peak, 7, "The worker pool should use its configured parallel capacity");
  assert.deepEqual(results, items.map((item) => item * 2), "Every input must be processed once in input order");
  console.log("PASS: partner response classification, read-only SQLite access during a writer transaction, and bounded parallel worker pool.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
