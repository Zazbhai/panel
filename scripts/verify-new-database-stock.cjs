"use strict";
// Synthetic databases and numbers only. No production or network access.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fixture = require("./server-fixture.cjs");

async function priorityFindsCheckedDatabaseWithoutMappings() {
  const f = fixture({ env: { PRIORITY_STOCK_DATABASE_LIMIT: "8" } });
  await f.context.getRuntimeStore();
  const old = Array.from({ length: 12 }, (_, i) => `https://old-${i}.firebaseio.com`);
  const added = "https://new-stock.firebaseio.com";
  f.runtime.setMetadata({ databaseUrls: [...old, added] });
  old.forEach((database, i) => {
    f.runtime.remember({ database, deviceId: "old", number: String(9888888000 + i) });
    f.runtime.recordDatabaseCheck({ database });
    f.runtime.lock("instagram", String(9888888000 + i), Date.now());
  });
  // A status check can succeed before any phone mapping is discovered.
  f.runtime.recordDatabaseCheck({ database: added });
  vm.runInContext("priorityStockScanCursor = 0", f.context);
  const inventory = f.context.readActiveNumberInventories;
  const selections = [];
  f.context.readActiveNumberInventories = (...args) => {
    selections.push([...args[1].databaseUrls]);
    return inventory(...args);
  };
  f.fetch = async (url) => {
    if (url === added + "/clients.json") return { ok: true, json: async () => ({ fresh: { status: true } }) };
    if (url === added + "/messages/fresh.json") return { ok: true, json: async () => ({
      one: { message: "Jio number 9876543210", timestamp: Date.now() }
    }) };
    if (old.some((database) => url === database + "/clients.json")) {
      return { ok: true, json: async () => ({ old: { status: true } }) };
    }
    throw new Error("Unexpected synthetic request");
  };
  const ready = await f.context.fillNumberPool("instagram", null, { priority: true, target: 1 });
  assert.equal(selections[0][0], added,
    "Status-checked databases with no mappings must still lead the next priority window");
  assert.equal(ready, 1);
  assert.equal(f.runtime.readyStockCount({ service: "instagram", onlineTtl: 60000 }), 1);
  assert.equal(f.runtime.readyStockCount({ service: "meesho", onlineTtl: 60000 }), 13,
    "Newly discovered mappings are shared with other services");
  assert.equal(f.runtime.sql("SELECT COUNT(*) AS n FROM orders").get().n, 0);
  f.runtime.close();
}

async function discoveryVisitsUnmappedDatabasesFirst() {
  const f = fixture();
  await f.context.getRuntimeStore();
  const known = "https://known-stock.firebaseio.com";
  const added = "https://added-stock.firebaseio.com";
  f.runtime.setMetadata({ databaseUrls: [known, added] });
  f.runtime.remember({ database: known, deviceId: "old", number: "9888888000" });
  [known, added].forEach((database) => f.runtime.recordDatabaseCheck({ database }));
  const visited = [];
  f.context.readActiveNumbers = async (database) => {
    visited.push(database);
    return { numbers: [], messageReadFailures: 0 };
  };
  await f.context.prefetchAllNumberMappings();
  assert.deepEqual(visited, [added, known],
    "The global sweep must discover unmapped databases ahead of refreshing known inventory");
  f.runtime.close();
}

const watchdog = setTimeout(() => { throw new Error("New database stock regression stalled"); }, 10000);
(async () => {
  await priorityFindsCheckedDatabaseWithoutMappings();
  await discoveryVisitsUnmappedDatabasesFirst();
  clearTimeout(watchdog);
  console.log("PASS: checked-but-unmapped databases enter priority stock; global discovery scans new databases first.");
})().catch((error) => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
