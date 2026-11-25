"use strict";
// Synthetic SQLite and mocked network only. Never reads production orders.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { RuntimeStore } = require("../runtime-store-core.cjs");
const fixture = require("./server-fixture.cjs");
const database = "https://fixture.firebaseio.com";
const turn = () => new Promise(setImmediate);

function seedDemand(store, service, count, now = Date.now()) {
  for (let i = 0; i < count; i++) store.importOrder({
    orderId: service + "-" + now + "-" + i, service, number: "9000000000",
    databaseUrl: database, deviceId: "demand-only", createdAt: now - 1000,
    expiresAt: now + 5000, status: "cancelled", receivedOtp: null, receivedAt: null
  });
}
function state(f) { return vm.runInContext("JSON.parse(JSON.stringify(priorityStockState))", f.context); }

async function setup() {
  const f = fixture({ env: { PRIORITY_STOCK_TARGET: "8", PRIORITY_STOCK_WORKERS: "2" } });
  await f.context.getRuntimeStore();
  const services = Array.from({ length: 12 }, (_, i) => ({
    id: "service-" + i, name: "service" + i, enabled: true,
    templates: [{ text: "service" + i + " OTP {{OTP}}", enabled: true }]
  }));
  for (let i = 0; i < services.length; i++) seedDemand(f.runtime, services[i].name, 30 - i);
  seedDemand(f.runtime, "disabled", 100);
  seedDemand(f.runtime, "bare", 99);
  seedDemand(f.runtime, "ancient", 100, Date.now() - 2 * 86400000);
  services.push({ name: "disabled", enabled: false, templates: [{ text: "OTP {{OTP}}", enabled: true }] },
    { name: "bare", enabled: true, templates: [{ text: "{{OTP}}", enabled: true }] },
    { name: "ancient", enabled: true, templates: [{ text: "Ancient {{OTP}}", enabled: true }] });
  f.context.readConfiguredServices = async () => ({ services });
  return f;
}

function eligibility() {
  const store = new RuntimeStore(":memory:");
  try {
    store.initialize({ initialized: true, databaseUrls: [database] });
    const now = Date.now();
    const rows = Array.from({ length: 9 }, (_, i) => ({
      database, deviceId: "device-" + i, number: String(9777777000 + i), now
    }));
    rows[1].number = rows[0].number; // Duplicate mapping must not inflate stock.
    rows[2].online = false;
    rows[3].now -= 120000;
    rows[4].verifiedAt = now - 86400001;
    rows[5].database = "https://removed.firebaseio.com";
    store.rememberBatch(rows);
    store.recordDatabaseCheck({ database, now });
    store.lock("busy", rows[6].number, now);
    assert(store.claim({ service: "another", candidate: rows[7], onlineTtl: 60000 }));
    store.sql("INSERT INTO service_usage VALUES(?,?,?)").run("busy", rows[8].number, -1);
    assert.equal(store.readyStockCount({ service: "busy", onlineTtl: 60000 }), 2);
    assert.equal(store.readyStockCount({ service: "busy", onlineTtl: 60000, limit: 1 }), 1);
    assert.equal(store.readyStockCount({ service: "another", onlineTtl: 60000 }), 3,
      "A lock for one service must not hide stock from other services");
    const first = store.claimReady({ service: "busy", onlineTtl: 60000 });
    assert.equal(first.number, rows[0].number);
    assert.equal(store.readyStockCount({ service: "busy", onlineTtl: 60000 }), 1);
    assert.equal(store.claimReady({ service: "busy", onlineTtl: 60000 }).number, rows[8].number);
    assert.equal(store.readyStockCount({ service: "busy", onlineTtl: 60000 }), 0);
  } finally { store.close(); }
}

async function rankingAndLanes() {
  const f = await setup();
  const urls = Array.from({ length: 12 }, (_, i) => "https://db" + i + ".firebaseio.com");
  const rankedUrls = [urls[0], urls[1], urls[2]];
  const firstWindow = f.context.selectPriorityStockDatabases(urls, rankedUrls, 8);
  const secondWindow = f.context.selectPriorityStockDatabases(urls, rankedUrls, 8);
  const freshUrl = "https://new-db.firebaseio.com";
  const freshWindow = f.context.selectPriorityStockDatabases(urls, rankedUrls, 8, [freshUrl]);
  assert(firstWindow.includes(urls[0]) && firstWindow.includes(urls[1]),
    "Priority scans should retain their strongest saved inventory databases");
  assert(secondWindow.some((database) => !firstWindow.includes(database)),
    "Priority scans must rotate through databases outside the first window");
  assert.equal(new Set([...firstWindow, ...secondWindow]).size, urls.length,
    "Consecutive bounded windows should cover the full database list");
  assert(freshWindow.includes(freshUrl), "Never-checked databases must enter priority scans immediately");
  const ranked = f.runtime.topOrderedServices({
    services: [...Array.from({ length: 12 }, (_, i) => "service" + i), "ancient"], limit: 10
  });
  assert.deepEqual(ranked.map((row) => row.service), Array.from({ length: 10 }, (_, i) => "service" + i));
  const initialOrders = f.runtime.sql("SELECT COUNT(*) AS n FROM orders").get().n;
  vm.runInContext("numberMappingPrefetchPromise = new Promise(() => {});", f.context);
  let active = 0, peak = 0;
  const started = [];
  const releases = [];
  f.context.fillNumberPool = (service, _signal, options) => {
    assert.equal(options.target, 8);
    assert.equal(options.priority, true);
    started.push(service);
    peak = Math.max(peak, ++active);
    return new Promise((resolve) => releases.push(() => { active--; resolve(8); }));
  };
  const first = f.context.startPriorityStockWorkers();
  assert.equal(f.context.startPriorityStockWorkers(), first, "Repeated ticks must share one running pass");
  for (let i = 0; i < 20 && started.length < 2; i++) await turn();
  assert.equal(started.length, 2, "Dedicated lanes must start while the full inventory sweep is pending");
  const normalRequest = f.context.refillNumberPool("service0");
  await turn();
  assert.equal(started.length, 2, "Ordinary refills must share an existing priority job for the same service");
  while (started.length < 5 || active) {
    releases.splice(0).forEach((release) => release());
    await turn();
  }
  await first;
  await normalRequest;
  assert.equal(peak, 2);
  assert.deepEqual(started, ranked.map((row) => row.service));
  assert(state(f).services.every((item) => item.ready === 8 && item.status === "ready"));
  assert.equal(f.runtime.sql("SELECT COUNT(*) AS n FROM orders").get().n, initialOrders,
    "Preparing priority stock must not create customer orders");
  assert.equal(f.runtime.stockSnapshot().priorityStock.services.length, 10,
    "Leader progress must be visible from shared storage");
  assert.equal(f.requests.length, 0);

  seedDemand(f.runtime, "service5", 20);
  const now = Date.now() + 61000;
  f.context.Date = class extends Date { static now() { return now; } };
  f.context.fillNumberPool = async () => 8;
  await f.context.startPriorityStockWorkers();
  assert.equal(state(f).services[0].service, "service5", "Ranking must adapt to demand after the cache expires");
  assert(!state(f).services.some((item) => item.service === "service4"));
}

async function prepareMappings() {
  const f = fixture();
  await f.context.getRuntimeStore();
  f.runtime.rememberBatch(Array.from({ length: 501 }, (_, i) => ({
    database, deviceId: "device-" + i, number: String(9888888000 + i)
  })));
  f.runtime.recordDatabaseCheck({ database });
  let messages = 0;
  f.fetch = async (url) => {
    if (url.endsWith("/clients.json")) return { ok: true, json: async () => Object.fromEntries(
      Array.from({ length: 505 }, (_, i) => ["device-" + i, { status: true }])) };
    messages++;
    const index = Number(url.split("device-")[1].split(".json")[0]);
    return { ok: true, json: async () => ({ sms: { message: "Jio number " + (9888888000 + index), timestamp: Date.now() } }) };
  };
  const ready = await f.context.fillNumberPool("busy", null, { priority: true, target: 505 });
  assert.equal(ready, 505, "Priority fill must reach its own target, rather than stop at the ordinary threshold of 500");
  assert.equal(messages, 4, "Only missing device mappings should require message reads");
  assert.equal(f.runtime.readyStockCount({ service: "busy", onlineTtl: 60000 }), 505);
  assert.equal(f.runtime.sql("SELECT COUNT(*) AS n FROM orders").get().n, 0);
  const reads = f.requests.length;
  await f.context.fillNumberPool("busy", null, { priority: true, target: 505 });
  assert.equal(f.requests.length, reads, "A full prepared service must not fetch Firebase again");
}

async function priorityDiscoveryIsIncremental() {
  const f = fixture({ env: { PRIORITY_STOCK_SCAN_CANDIDATES: "256" } });
  await f.context.getRuntimeStore();
  let args;
  f.context.readActiveNumberInventories = async (...values) => {
    args = values;
    return { inventories: [], failures: [] };
  };
  const count = await f.context.fillNumberPool("popular", null, { priority: true, target: 2000 });
  assert.equal(count, 0);
  assert.equal(args[2], 256, "Priority workers should discover numbers in bounded batches");
  assert.equal(args[6], false, "Priority discovery must return without exhausting each database");
  assert.equal(args[7], 1, "Priority reads must use the priority lane");
  assert.equal(args[8], 8, "Priority database concurrency should remain bounded");
  assert.equal(args[9].remaining, 256, "Each priority service pass should have a finite total read budget");
}

async function priorityMessageReadBudgetIsSharedAcrossDatabases() {
  const f = fixture();
  const databases = ["https://budget-a.firebaseio.com", "https://budget-b.firebaseio.com"];
  await f.context.getRuntimeStore();
  f.runtime.setMetadata({ initialized: true, databaseUrls: databases });
  const messageReads = [];
  f.fetch = async (url) => {
    if (url.endsWith("/clients.json")) return { ok: true, json: async () =>
      Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`device-${index}`, { status: true }])) };
    if (url.includes("/messages/")) {
      messageReads.push(url);
      return { ok: true, json: async () => ({ sms: { message: "No number in this message" } }) };
    }
    throw new Error("Unexpected database read " + url);
  };
  const budget = { remaining: 3 };
  await f.context.readActiveNumberInventories(
    "instagram", { databaseUrls: databases, serviceUsage: {}, orders: [] },
    8, null, null, true, false, 1, 2, budget
  );
  assert.equal(messageReads.length, 3, "The whole service pass must not exceed its total Firebase message budget");
  assert.equal(budget.remaining, 0);
}

async function addedDatabaseFeedsPriorityStock() {
  const f = fixture();
  await f.context.getRuntimeStore();
  const addedDatabase = "https://new-priority.firebaseio.com";
  let rejectAdded = false;
  f.fetch = async (url) => {
    if (url.startsWith(addedDatabase) && url.endsWith("?shallow=true")) {
      return rejectAdded
        ? { ok: false, status: 423, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({}) };
    }
    if (url === addedDatabase + "/clients.json") {
      return { ok: true, status: 200, json: async () => ({ device42: { status: true } }) };
    }
    if (url === addedDatabase + "/messages/device42.json") {
      return { ok: true, status: 200, json: async () => ({ sms: {
        message: "Jio number 9876543210", timestamp: Date.now()
      } }) };
    }
    throw new Error("Unexpected synthetic URL " + url);
  };
  const rejected = await f.request("/api/addDatabaseUrl?api_key=" + f.apiKey, {
    method: "POST", body: { databaseUrl: addedDatabase }
  });
  assert.equal(rejected.status, 200);
  assert.equal(JSON.parse(rejected.body).added, true);

  rejectAdded = true;
  const lockedDatabase = "https://locked-priority.firebaseio.com";
  const locked = await f.request("/api/addDatabaseUrl?api_key=" + f.apiKey, {
    method: "POST", body: { databaseUrl: lockedDatabase }
  });
  assert.equal(locked.status, 502, "HTTP 423 databases must not be admitted to rotation");
  assert(!f.runtime.metadata().databaseUrls.includes(lockedDatabase));

  const ready = await f.context.fillNumberPool("instagram", null, { priority: true, target: 1 });
  assert.equal(ready, 1, "Newly added database should contribute eligible priority stock");
  const mapping = f.runtime.mappings(addedDatabase);
  assert.deepEqual(mapping.map((row) => [row.deviceId, row.number]), [["device42", "9876543210"]]);
  assert.equal(f.runtime.readyStockCount({ service: "instagram", onlineTtl: 60000 }), 1);
}

async function failureRecovery() {
  const f = await setup();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(f.context.waitForAbortable(Promise.reject(new Error("Already rejected operation")),
    cancelled.signal), { code: "ALLOCATION_TIMEOUT" });
  await turn(); // An unobserved underlying rejection would terminate this test.
  f.context.setTimeout = (callback, ms) => setTimeout(callback, Math.min(ms, 40));
  f.context.clearTimeout = clearTimeout;
  f.context.fillNumberPool = async () => new Promise(() => {});
  await f.context.startPriorityStockWorkers();
  assert(state(f).services.every((item) => item.status === "retrying"),
    "Hung jobs must time out instead of holding all lanes forever");
  const now = Date.now() + 10000;
  f.context.Date = class extends Date { static now() { return now; } };
  f.context.fillNumberPool = async () => 8;
  await f.context.startPriorityStockWorkers();
  assert(state(f).services.every((item) => item.status === "ready"),
    "The next pass must recover from timed-out jobs");
}

async function readScheduling() {
  const f = fixture({ env: { MAX_CONCURRENT_DATABASE_READS: "3" } });
  const order = [];
  let release;
  const first = f.context.withDatabaseReadSlot(async () => {
    order.push("background");
    await new Promise((resolve) => { release = resolve; });
  }, null, 2);
  const ordinary = f.context.withDatabaseReadSlot(async () => { order.push("ordinary"); }, null, 2);
  const priority = f.context.withDatabaseReadSlot(async () => { order.push("priority"); }, null, 1);
  const customer = f.context.withDatabaseReadSlot(async () => { order.push("customer"); }, null, 0);
  await customer;
  assert.deepEqual(order, ["background", "customer"],
    "Reserved customer capacity must remain available while background lanes are full");
  release();
  await Promise.all([first, ordinary, priority]);
  assert.deepEqual(order, ["background", "customer", "priority", "ordinary"]);
}

async function partialDiscoverySurvivesAbort() {
  const f = fixture();
  await f.context.getRuntimeStore();
  const controller = new AbortController();
  f.fetch = async (url, { signal }) => {
    if (url.endsWith("/clients.json")) return { ok: true, json: async () =>
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => ["device-" + i, { status: true }])) };
    const index = Number(url.split("device-")[1].split(".json")[0]);
    if (index === 0) return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("Synthetic cancellation"), { name: "AbortError" })), { once: true });
    });
    return { ok: true, json: async () => ({ sms: {
      message: "Jio number " + (9666666000 + index), timestamp: Date.now()
    } }) };
  };
  const work = f.context.refillNumberPool("busy", controller.signal, { priority: true, target: 8 });
  try {
    for (let i = 0; i < 100 && f.runtime.sql("SELECT COUNT(*) AS n FROM numbers").get().n < 9; i++) await turn();
    assert.equal(f.runtime.sql("SELECT COUNT(*) AS n FROM numbers").get().n, 9,
      "Finished mappings must be persisted before the slowest device read completes");
  } finally {
    controller.abort();
    await work;
  }
  assert.equal(f.runtime.readyStockCount({ service: "busy", onlineTtl: 60000 }), 9);
  assert.equal(f.runtime.sql("SELECT COUNT(*) AS n FROM orders").get().n, 0);
}

(async () => {
  eligibility();
  await rankingAndLanes();
  await prepareMappings();
  await priorityDiscoveryIsIncremental();
  await priorityMessageReadBudgetIsSharedAcrossDatabases();
  await addedDatabaseFeedsPriorityStock();
  await failureRecovery();
  await readScheduling();
  await partialDiscoverySurvivesAbort();
  console.log("PASS: top-ten demand ranking, independent bounded lanes, coalescing, eligible stock, mapping persistence and timeout recovery.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
