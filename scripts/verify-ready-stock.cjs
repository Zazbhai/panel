"use strict";
// Temporary, synthetic WAL database only; no credentials, Firebase, or live orders.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");
const { RuntimeStore } = require("../runtime-store-core.cjs");
const { AsyncRuntimeStore } = require("../runtime-store.cjs");
const fixture = require("./server-fixture.cjs");

async function diskBurst() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-ready-stock-"));
  const filename = path.join(directory, "fixture.sqlite");
  const workers = [];
  let seed;
  try {
    seed = new RuntimeStore(filename);
    const databases = Array.from({ length: 1374 }, (_, i) => `https://fixture-${i}.firebaseio.com`);
    seed.initialize({ initialized: true, databaseUrls: databases, orders: [], serviceUsage: {} });
    const now = Date.now();
    const mappings = Array.from({ length: 19392 }, (_, i) => ({
      database: databases[i % databases.length], deviceId: `device-${i}`,
      number: String(9000000000 + i), online: i < 2600,
      now: i < 4978 ? now : now - 120000, verifiedAt: now
    }));
    seed.rememberBatch(mappings);
    for (const database of databases) seed.recordDatabaseCheck({ database, now });
    for (let i = 0; i < 462; i++) {
      assert(seed.claimReady({ service: "reserved", onlineTtl: 60000 }));
    }
    for (let i = 462; i < 562; i++) seed.lock("rush", mappings[i].number, now);
    const stock = seed.stockSummary({ onlineTtl: 60000 });
    assert.equal(stock.total, 19392);
    assert.equal(stock.online, 2138);
    assert.equal(stock.reserved, 462);
    seed.close(); seed = null;

    // Separate SQLite workers represent independent PM2 processes sharing WAL.
    for (let i = 0; i < 4; i++) {
      const worker = new AsyncRuntimeStore(filename);
      workers.push(worker);
      await worker.ready;
      const call = worker.call.bind(worker);
      worker.call = async (method, ...args) => {
        try { return await call(method, ...args); }
        catch (error) { error.message = `${method}: ${error.message}`; throw error; }
      };
    }
    const latencies = [];
    const started = performance.now();
    const background = Promise.allSettled(Array.from({ length: 100 }, (_, i) => {
      const database = databases[1000 + i];
      const onlineDeviceIds = mappings.filter((m) => m.database === database && m.online).map((m) => m.deviceId);
      return workers[3].call("refreshDatabaseInventory", { database, onlineDeviceIds });
    }));
    const snapshots = Promise.allSettled(Array.from({ length: 8 }, () => workers[2].call("stockSnapshot", { onlineTtl: 60000 })));
    const orders = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      const start = performance.now();
      const order = await workers[i % 3].call("claimReady", {
        service: "rush", onlineTtl: 60000, deadline: Date.now() + 5000
      });
      latencies.push(performance.now() - start);
      return order;
    }));
    const backgroundResults = await background;
    for (const result of backgroundResults) if (result.status === "rejected") throw result.reason;
    const snapshotResults = await snapshots;
    for (const result of snapshotResults) if (result.status === "rejected") throw result.reason;
    const stockReads = snapshotResults.map((result) => result.value);
    assert(orders.every(Boolean), "100 disk-backed claims must succeed despite concurrent inventory writes");
    assert.equal(new Set(orders.map((o) => o.number)).size, 100, "All 100 claims must lease distinct numbers");
    assert.equal(new Set(orders.map((o) => o.orderId)).size, 100);
    const locked = new Set(mappings.slice(462, 562).map((m) => m.number));
    assert(orders.every((o) => !locked.has(o.number)), "Service locks must be respected by the direct ready path");
    assert(stockReads.every((s) => s.total === 19392 && s.inventoryProgress.checkedDatabases === 1374));
    seed = new RuntimeStore(filename);
    assert.equal(seed.sql("SELECT COUNT(*) AS n FROM leases WHERE expires_at>?").get(Date.now()).n, 562);
    assert.equal(seed.sql("SELECT COUNT(*) AS n FROM orders WHERE service='rush'").get().n, 100);
    assert.equal(seed.sql("SELECT COUNT(*) AS n FROM (SELECT number FROM orders WHERE status='active' GROUP BY number HAVING COUNT(*)>1)").get().n, 0);
    latencies.sort((a, b) => a - b);
    console.log(`Disk-backed stock: ${orders.length}/100 unique claims; 19,392 mappings / 1,374 databases; `
      + `100 background refreshes; p95 ${latencies[94].toFixed(1)} ms; total ${(performance.now() - started).toFixed(1)} ms.`);
  } finally {
    if (seed) seed.close();
    for (const worker of workers) await worker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function stockCache() {
  const f = fixture();
  const store = await f.context.getRuntimeStore();
  const call = store.call.bind(store);
  let reads = 0;
  store.call = async (method, ...args) => {
    if (method === "stockSnapshot") reads++;
    return call(method, ...args);
  };
  const first = await Promise.all(Array.from({ length: 20 }, () => f.request("/api/stocks", { admin: true })));
  assert(first.every((r) => r.status === 200));
  assert.equal(reads, 1, "Concurrent initial reads must share one full stock snapshot");
  const now = Date.now() + 5000;
  f.context.Date = class extends Date { static now() { return now; } };
  let release;
  let delayedReads = 0;
  const delayed = new Promise((resolve) => { release = resolve; });
  store.call = async (method, ...args) => {
    if (method === "stockSnapshot") { delayedReads++; await delayed; }
    return call(method, ...args);
  };
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.request("/api/stocks", { admin: true })));
  assert(responses.every((r) => r.status === 200 && JSON.parse(r.body).stale === true),
    "Cached stocks must respond while SQLite refresh is still blocked");
  assert.equal(delayedReads, 1, "Polling must not enqueue duplicate stock refreshes");
  release();
  await f.context.refreshStockSummarySnapshot();
  assert.equal(JSON.parse((await f.request("/api/stocks", { admin: true })).body).stale, false);
  assert.equal(f.requests.length, 0, "Stock refresh must not contact Firebase");
  console.log("PASS: cached stock responds during delayed storage refresh; duplicate refreshes are coalesced.");
}

async function readyApi() {
  const f = fixture();
  const store = await f.context.getRuntimeStore();
  const database = "https://fixture.firebaseio.com";
  f.runtime.rememberBatch(Array.from({ length: 120 }, (_, i) => ({
    database, deviceId: `api-${i}`, number: String(9111111000 + i)
  })));
  f.runtime.markDatabaseOnline({ database,
    onlineDeviceIds: Array.from({ length: 120 }, (_, i) => `api-${i}`) });
  const config = [...f.files.keys()].find((name) => name.endsWith("services.json"));
  f.files.set(config, JSON.stringify([{ id: "rush", name: "rush", enabled: true, template: "Code [OTP]" }]));
  f.context.requestNumberPoolRefresh = () => {};
  f.context.refreshReadyNumberQueue = () => { throw new Error("Ready requests must not rebuild queues"); };
  const call = store.call.bind(store);
  const methods = [];
  store.call = (method, ...args) => { methods.push(method); return call(method, ...args); };
  const responses = await Promise.all(Array.from({ length: 100 }, () =>
    f.request(`/stubs/handler_api.php?action=getNumber&service=rush&api_key=${f.apiKey}`)));
  assert(responses.every((r) => r.status === 200 && r.body.startsWith("ACCESS_NUMBER:")));
  assert.equal(new Set(responses.map((r) => r.body.split(":")[2])).size, 100);
  assert.equal(methods.length, 100, "Ready allocation should make exactly one worker call per request");
  assert(methods.every((method) => method === "claimReady"));
  assert.equal(f.requests.length, 0, "Ready requests must not fetch Firebase");
  console.log("PASS: 100 HTTP handler allocations; one SQLite claim each; no queue rebuilds or Firebase reads.");
}

function readyEligibility() {
  const store = new RuntimeStore(":memory:");
  try {
    const database = "https://fixture.firebaseio.com";
    const now = Date.now();
    store.initialize({ initialized: true, databaseUrls: [database] });
    const entries = Array.from({ length: 8 }, (_, i) => ({
      database, deviceId: `eligibility-${i}`, number: String(9222222000 + i), now
    }));
    entries[1].online = false;
    entries[2].now = now - 120000;
    entries[3].verifiedAt = now - 86400001;
    entries[4].database = "https://removed.firebaseio.com";
    entries[5].database = "https://unchecked.firebaseio.com";
    store.setMetadata({ databaseUrls: [database, entries[5].database] });
    store.rememberBatch(entries);
    store.recordDatabaseCheck({ database, now: now - 120000 });
    assert.equal(store.claimReady({ service: "rush", onlineTtl: 60000 }), null,
      "Stale database verification must not enable a direct ready claim");
    store.recordDatabaseCheck({ database });
    store.lock("rush", entries[6].number, now);
    store.sql("INSERT INTO service_usage VALUES(?,?,?)").run("rush", entries[7].number, -1);
    const order = store.claimReady({ service: "rush", onlineTtl: 60000 });
    assert.equal(order.number, entries[0].number);
    assert.equal(store.claimReady({ service: "rush", onlineTtl: 60000 }), null,
      "Offline, stale, unconfigured, unchecked, locked, leased and recycled entries must be skipped");
    assert.throws(() => store.claimReady({ service: "other", deadline: now - 1 }),
      { code: "ALLOCATION_TIMEOUT" });
    assert.equal(store.sql("SELECT COUNT(*) AS n FROM orders").get().n, 1,
      "Expired claim deadlines must not create an order");
    console.log("PASS: ready claims enforce freshness, database configuration, locks, leases and deadlines.");
  } finally { store.close(); }
}

function emptySnapshotSafety() {
  const store = new RuntimeStore(":memory:");
  try {
    const database = "https://fixture.firebaseio.com";
    store.initialize({ initialized: true, databaseUrls: [database] });
    store.remember({ database, deviceId: "stable-device", number: "9444444000" });
    store.markDatabaseOnline({ database, onlineDeviceIds: ["stable-device"] });
    store.refreshDatabaseInventory({ database, onlineDeviceIds: [] });
    assert.equal(store.sql("SELECT online FROM numbers WHERE number=?").get("9444444000").online, 1,
      "A transient empty inventory refresh must preserve saved stock");
    console.log("PASS: empty status snapshots cannot erase saved online inventory.");
  } finally { store.close(); }
}

async function stockUi() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", disabled: false, attributes: {}, classList: { add() {}, remove() {} },
      setAttribute(name, value) { this.attributes[name] = value; }
    });
    return elements.get(id);
  };
  let respond = async () => ({ ok: true, json: async () => ({
    total: 2000, online: 1900, reserved: 100, offline: 0, needsCheck: 0,
    databaseCount: 100, checkedAt: Date.now()
  }) });
  const context = vm.createContext({
    document: { getElementById: element },
    window: { dashboardApiFetch: () => respond() },
    Intl, Date, AbortController, setTimeout, clearTimeout
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "stocks.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('stockButton.addEventListener("click"')), context);
  await context.loadStock();
  const previous = element("stockOnline").textContent;
  let release;
  respond = () => new Promise((resolve) => { release = resolve; });
  const pending = context.loadStock();
  assert.equal(element("stockCounts").attributes["aria-busy"], "false",
    "Background refresh must not hide existing totals");
  release({ ok: false, status: 503, json: async () => ({ error: "Stock storage unavailable." }) });
  await pending;
  assert.equal(element("stockOnline").textContent, previous);
  assert.match(element("stockStatus").textContent, /Showing previous totals.*Stock storage unavailable/);
  console.log("PASS: stock UI preserves visible totals through a delayed, failed refresh.");
}

async function briefWriteLock() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-ready-lock-"));
  let seed, worker, timer;
  try {
    const filename = path.join(directory, "fixture.sqlite");
    seed = new RuntimeStore(filename);
    const database = "https://fixture.firebaseio.com";
    seed.initialize({ initialized: true, databaseUrls: [database] });
    seed.remember({ database, deviceId: "locked-writer", number: "9333333000" });
    seed.recordDatabaseCheck({ database });
    worker = new AsyncRuntimeStore(filename);
    await worker.ready;
    const send = worker.send.bind(worker);
    let attempts = 0;
    worker.send = (method, args) => {
      if (method === "claimReady") attempts++;
      return send(method, args);
    };
    seed.db.exec("BEGIN IMMEDIATE");
    timer = setTimeout(() => seed.db.exec("COMMIT"), 350);
    const order = await worker.call("claimReady", { service: "rush", deadline: Date.now() + 2000 });
    assert(order);
    assert(attempts >= 2 && attempts <= 3, "Brief SQLite lock conflicts should get bounded retries");
    assert.equal(seed.sql("SELECT COUNT(*) AS n FROM orders").get().n, 1);
    console.log("PASS: brief cross-process write lock retries without duplicate orders.");
  } finally {
    clearTimeout(timer);
    if (worker) await worker.close();
    if (seed) seed.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  readyEligibility(); emptySnapshotSafety(); await briefWriteLock(); await diskBurst(); await stockCache(); await readyApi(); await stockUi();
})().catch((error) => { console.error(error); process.exitCode = 1; });
