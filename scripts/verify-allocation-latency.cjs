"use strict";

// Synthetic storage and networking only. This never starts the server or reads
// the production rotation, service configuration, credentials, or Firebase.
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const serverFixture = require("./server-fixture.cjs");

const database = "https://fixture.firebaseio.com";
const turn = () => new Promise(setImmediate);

async function inventoryFixture(count, age = 20000, suppressRefill = true) {
  const f = serverFixture();
  await f.context.getRuntimeStore();
  const now = Date.now();
  f.runtime.rememberBatch(Array.from({ length: count }, (_, index) => ({
    database, deviceId: `device-${index}`, number: String(9000000000 + index),
    now: now - age, verifiedAt: now
  })));
  // Discovery is separately tested. Keep it out of foreground timing checks.
  if (suppressRefill) f.context.refillNumberPool = async () => null;
  return f;
}

function configureService(f) {
  const filename = [...f.files.keys()].find((file) => file.endsWith("services.json"));
  f.files.set(filename, JSON.stringify([
    { id: "fixture", name: "fixture", enabled: true, template: "Code [OTP]" }
  ]));
}

(async () => {
  {
    const f = serverFixture();
    const databases = ["https://refill-slow.firebaseio.com", database];
    const state = { databaseUrls: databases, serviceUsage: {}, orders: [], reserved: [] };
    const started = [];
    let cancelled = 0;
    f.context.readActiveNumbers = async (database, _available, signal) => {
      started.push(database);
      if (database === databases[0]) {
        return new Promise((_resolve, reject) => {
          const abort = () => { cancelled++; reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })); };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      return { numbers: Array.from({ length: 32 }, (_, index) => ({
        deviceId: `refill-${index}`, number: String(9000000300 + index)
      })), messageReadFailures: 0 };
    };
    const controller = new AbortController();
    const refill = f.context.readActiveNumberInventories("fixture", state, 32, null, controller.signal, true);
    let timer;
    try {
      const result = await Promise.race([refill, new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 500);
      })]);
      assert(result, "Background refill must fetch a healthy database alongside a slow database");
      assert.equal(started.length, 2);
      assert.equal(cancelled, 1, "Reaching the prepared-stock target must stop unused refill reads");
      assert.equal(result.inventories[0].numbers.length, 32);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await refill.catch(() => null);
    }
  }
  {
    const f = serverFixture();
    const databases = Array.from({ length: 5 }, (_, index) => `https://prefetch-${index}.firebaseio.com`);
    f.context.readRotationMetadata = async () => ({ databaseUrls: databases });
    let releaseSlow;
    const slow = new Promise((resolve) => { releaseSlow = resolve; });
    const started = [];
    let active = 0, peak = 0;
    f.context.readActiveNumbers = async (database) => {
      started.push(database);
      peak = Math.max(peak, ++active);
      try {
        if (database === databases[0]) await slow;
        return { numbers: [], messageReadFailures: 0 };
      } finally { active--; }
    };
    const preparation = f.context.prefetchAllNumberMappings();
    try {
      await turn();
      assert.equal(started.length, 5, "A slow database must not block the next database in a free prefetch lane");
      assert.equal(f.mappingPrefetchState().completed, 4, "Progress should advance before a slow database finishes");
      assert.equal(peak, 2, "Rolling database preparation must retain its concurrency limit");
    } finally {
      releaseSlow();
      await preparation;
    }
  }
  {
    const f = serverFixture();
    let releaseSlow;
    const slow = new Promise((resolve) => { releaseSlow = resolve; });
    const saved = [];
    let messageReads = 0, active = 0, peak = 0;
    f.fetch = async (url) => {
      if (url.endsWith("/clients.json")) return {
        ok: true, status: 200, json: async () => Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
          `rolling-${index}`, { status: true }
        ]))
      };
      const readIndex = messageReads++;
      peak = Math.max(peak, ++active);
      try {
        if (readIndex === 0) await slow;
        return { ok: true, status: 200, json: async () => ({
          sms: { message: `Jio number ${9000000100 + readIndex}`, timestamp: Date.now() }
        }) };
      } finally { active--; }
    };
    const scan = f.context.readActiveNumbers(database, () => true, null, 100, null, true,
      async (candidates) => { saved.push(...candidates); });
    try {
      for (let index = 0; index < 50 && saved.length < 7; index++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(saved.length, 7, "Fast device mappings must be saved while another device read is pending");
      assert.equal(messageReads, 8, "Every free device lane should immediately fetch another mapping");
      assert(peak <= 4, "Device discovery must keep the default bounded concurrency");
    } finally {
      releaseSlow();
      const result = await scan;
      assert.equal(result.numbers.length, 8);
    }
  }
  {
    const f = serverFixture();
    const databases = Array.from({ length: 6 }, (_, index) => `https://allocation-${index}.firebaseio.com`);
    f.setRotation({ initialized: true, databaseUrls: databases, serviceUsage: {}, orders: [] });
    await f.context.getRuntimeStore();
    f.context.refillNumberPool = async () => null;
    f.runtime.rememberBatch(databases.map((database, index) => ({
      database, deviceId: `rolling-${index}`, number: String(9000000200 + index),
      now: Date.now() - 20000 - index * 100, verifiedAt: Date.now()
    })));
    let cancelled = 0;
    f.fetch = async (url, { signal }) => {
      assert(url.includes("/clients/rolling-"), "Allocation must check saved device status without reading messages");
      const index = Number(url.match(/rolling-(\d+)\.json$/)[1]);
      if (index === 0) return { ok: false, status: 503, headers: { get: () => null } };
      if (index === 3 || index === 4) return {
        ok: true, status: 200, json: async () => ({ status: index === 4 })
      };
      assert(index < 3, "The first successful candidate should stop speculative reads");
      assert(index === 1 || index === 2, "A free check lane should reach the next database after a failure");
      return new Promise((_resolve, reject) => {
        const abort = () => { cancelled++; reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })); };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    };
    const controller = new AbortController();
    const allocation = f.context.findAvailableActiveNumber("fixture", controller.signal, null,
      Date.now() + 4000, { cachedOnly: true });
    let timer;
    try {
      const order = await Promise.race([allocation, new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 500);
      })]);
      assert(order, "A free status-check lane must reach an online fifth database without waiting for the three slow databases");
      assert.equal(order.databaseUrl, databases[4]);
      await turn();
      assert.equal(cancelled, 2, "Winning an atomic claim must cancel only the remaining losing online checks");
      assert.equal(f.runtime.snapshot().orders.length, 1);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await allocation.catch(() => null);
    }
  }
  {
    const f = serverFixture();
    const names = Array.from({ length: 10 }, (_, index) => "service-" + index);
    f.context.readConfiguredServices = async () => ({ services: names.map((name) => ({
      name, enabled: true, template: "code [OTP]"
    })) });
    f.context.readRotationMetadata = async () => ({ databaseUrls: [database] });
    const warmed = [];
    f.context.refillNumberPool = async (service) => { warmed.push(service); };
    await f.context.warmNumberPools();
    assert.equal(new Set(warmed).size, 4,
      "Startup warming should stay bounded to the configured service batch");
    assert(warmed.every((name) => names.includes(name)));
    assert.equal(warmed.length, 4);
  }
  {
    const f = serverFixture();
    let timerIntervals = 0;
    let warmups = 0;
    f.context.setInterval = () => { timerIntervals++; return { unref() {} }; };
    f.context.readConfiguredServices = async () => ({ services: [] });
    f.context.readRotationMetadata = async () => ({ databaseUrls: [database] });
    f.context.warmNumberPools = async () => { warmups++; };
    f.context.startNumberPoolWarmup();
    await turn();
    await turn();
    assert.equal(warmups, 1, "Startup warming runs once rather than continuously polling databases");
    assert.equal(timerIntervals, 0, "Number inventory must not use a periodic scan timer");
  }
  {
    const f = new serverFixture();
    await f.context.getRuntimeStore();
    f.fetch = async (url) => {
      if (url.endsWith("/clients.json")) return {
        ok: true, status: 200, json: async () => Object.fromEntries(Array.from({ length: 60 }, (_, index) => [
          `prefetch-${index}`, { status: true }
        ]))
      };
      const deviceId = decodeURIComponent(url.split("/messages/")[1].split(".json")[0]);
      const index = Number(deviceId.split("-")[1]);
      return { ok: true, status: 200, json: async () => ({
        sms: { message: `Jio number ${9000000000 + index}`, timestamp: Date.now() }
      }) };
    };
    await f.context.prefetchAllNumberMappings();
    const ready = f.runtime.candidates({
      service: "jio", databases: [database], limit: 100, freshOnly: true
    });
    assert.equal(ready.length, 60,
      "The all-database mapping prefetch must persist each discovered number as fresh online inventory");
    assert.equal(f.mappingPrefetchState().mappings, 60,
      "Prefetch progress must count mappings as they are durably saved");
    assert.equal(f.requests.filter((url) => url.includes("/messages/")).length, 60,
      "A complete synthetic prefetch must inspect all unmapped active devices");
    configureService(f);
    const response = await f.request(
      `/stubs/handler_api.php?action=getNumber&service=fixture&api_key=${f.apiKey}`
    );
    assert.equal(response.status, 200);
    assert.match(response.body, /^ACCESS_NUMBER:/,
      "A number prepared by the background sweep should allocate without a foreground Firebase scan");
    assert.equal(f.requests.filter((url) => url.includes("/messages/")).length, 60,
      "A customer allocation must reuse saved mappings rather than re-read message histories");
  }
  {
    const f = serverFixture();
    let refills = 0;
    f.context.fillNumberPool = async () => { refills++; return 1; };
    await f.context.refillNumberPool("event-service");
    await f.context.refillNumberPool("event-service");
    assert.equal(refills, 1, "A refill below the ready-stock threshold should cool down instead of rescanning repeatedly");
  }
  {
    const f = await inventoryFixture(12, 20000, false);
    f.fetch = async (url) => {
      assert.equal(url, database + "/clients.json",
        "Refreshing stale prepared mappings should read client online state only");
      return {
        ok: true, status: 200, json: async () => Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
          `device-${index}`, { status: true }
        ]))
      };
    };
    const readyCount = await f.context.fillNumberPool("fixture");
    assert(readyCount >= 8,
      "Stale saved mappings must be refreshed into ready inventory instead of being mistaken for prepared stock");
    assert.equal(f.requests.length, 1,
      "A bulk online-state refresh should use one clients snapshot and no message-history reads");
    assert.equal(f.runtime.candidates({
      service: "fixture", databases: [database], limit: 20, freshOnly: true
    }).length, 12);
  }
  {
    const f = await inventoryFixture(0, 20000, false);
    configureService(f);
    f.context.requestNumberPoolRefresh = () => {};
    f.context.setTimeout = (callback) => setTimeout(callback, 200);
    f.context.clearTimeout = clearTimeout;
    const databaseUrls = f.runtime.metadata().databaseUrls;
    const devices = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
      "cold-device-" + index, { status: true }
    ]));
    f.fetch = async (url) => {
      if (url.endsWith("/clients.json")) return { ok: true, status: 200, json: async () => devices };
      const deviceId = decodeURIComponent(url.split("/messages/")[1].split(".json")[0]);
      const index = Number(deviceId.slice("cold-device-".length));
      return { ok: true, status: 200, json: async () => ({
        sms: { message: "Jio number 900000000" + index, timestamp: Date.now() }
      }) };
    };
    const startedAt = Date.now();
    const response = await f.request(`/stubs/handler_api.php?action=getNumber&service=fixture&api_key=${f.apiKey}`);
    assert.equal(response.status, 200);
    assert.equal(response.body, "NO_NUMBERS",
      "A cold API request must not read messages; background discovery owns mapping extraction");
    assert(Date.now() - startedAt < 500, "A mapping-only request should return immediately");
    assert(f.requests.every((url) => !url.includes("/messages/")),
      `Customer number requests must never fetch message history: ${f.requests.join(",")}`);
  }
  {
    const f = serverFixture();
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const first = f.context.withServiceAllocationLock("fixture", () => hold);
    await turn();
    const controller = new AbortController();
    let cancelledRan = false;
    const cancelled = f.context.withServiceAllocationLock("fixture", async () => {
      cancelledRan = true;
    }, controller.signal);
    const rejection = assert.rejects(cancelled, { code: "ALLOCATION_TIMEOUT" });
    controller.abort();
    await rejection;
    let lastRan = false;
    const last = f.context.withServiceAllocationLock("fixture", async () => { lastRan = true; });
    try {
      await turn();
      assert.equal(lastRan, false, "Cancelling a waiter must not unlock an earlier allocation");
      assert.equal(cancelledRan, false, "A cancelled waiter must never run its allocation");
    } finally {
      release();
      await Promise.all([first, last]);
    }
    assert.equal(lastRan, true, "The queue must progress after the active allocation finishes");
  }
  {
    const f = serverFixture();
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const first = f.context.withServiceAllocationLock("fixture", () => hold);
    await turn();
    const controller = new AbortController();
    let cancelledRan = false;
    const cancelled = f.context.withServiceAllocationLock("fixture", async () => {
      cancelledRan = true;
    }, controller.signal);
    const rejection = assert.rejects(cancelled, { code: "ALLOCATION_TIMEOUT" });
    controller.abort();
    await rejection;
    let lastRan = false;
    const last = f.context.withServiceAllocationLock("fixture", async () => { lastRan = true; });
    try {
      await turn();
      assert.equal(lastRan, false, "Cancelling a cold-scan waiter must not unlock the active scan");
      assert.equal(cancelledRan, false, "A cancelled cold-scan waiter must never run");
    } finally {
      release();
      await Promise.all([first, last]);
    }
    assert.equal(lastRan, true, "The cold-scan queue must progress after the active scan finishes");
  }
  {
    const f = serverFixture();
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const occupied = Array.from({ length: 6 }, () =>
      f.context.withDatabaseReadSlot(() => hold));
    await turn();
    const controller = new AbortController();
    let cancelledRan = false;
    const cancelled = f.context.withDatabaseReadSlot(async () => {
      cancelledRan = true;
    }, controller.signal);
    const rejection = assert.rejects(cancelled, { code: "ALLOCATION_TIMEOUT" });
    controller.abort();
    await rejection;
    let nextRan = false;
    const next = f.context.withDatabaseReadSlot(async () => { nextRan = true; });
    release();
    await Promise.all([...occupied, next]);
    assert.equal(cancelledRan, false, "An aborted read must leave the queue without running");
    assert.equal(nextRan, true, "Cancelling a read must not lose a database-read slot");
  }
  {
    const f = serverFixture();
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const active = Array.from({ length: 6 }, () => f.context.withDatabaseReadSlot(() => hold));
    await turn();
    const order = [];
    const background = f.context.withDatabaseReadSlot(async () => { order.push("background"); }, null, 1);
    const api = f.context.withDatabaseReadSlot(async () => { order.push("api"); }, null, 0);
    release();
    await Promise.all([...active, api, background]);
    assert.deepEqual(order, ["api", "background"],
      "An API read queued during global inventory prefetch must run before queued background reads");
  }
  {
    const f = await inventoryFixture(4);
    f.fetch = async (url) => {
      assert(url.startsWith(database + "/clients/device-"), "Allocation must verify saved device IDs");
      const deviceId = decodeURIComponent(url.split("/clients/")[1].split(".json")[0]);
      return { ok: true, status: 200, json: async () => ({ status: true, deviceId }) };
    };
    const order = await f.context.findAvailableActiveNumber("fixture", null, null,
      Date.now() + 4500, { cachedOnly: true });
    assert(order, "A saved mapping with an online device should allocate");
    assert.equal(order.number, "9000000000");
    assert.equal(f.runtime.snapshot().orders.length, 1);
    assert(f.requests.length <= 4, "Only a bounded set of device-status reads should be needed");
  }
  {
    const f = await inventoryFixture(4);
    f.fetch = async (url) => {
      assert(url.startsWith(database + "/clients/device-"));
      const deviceId = decodeURIComponent(url.split("/clients/")[1].split(".json")[0]);
      return { ok: true, status: 200, json: async () => ({ status: true, deviceId }) };
    };
    const orders = await Promise.all(["one", "two", "three", "four"].map((service) =>
      f.context.findAvailableActiveNumber(service, null, null,
        Date.now() + 4500, { cachedOnly: true })));
    assert(orders.every(Boolean), "Losing a cross-service claim must try another confirmed candidate");
    assert.equal(new Set(orders.map((order) => order.number)).size, 4,
      "Parallel services must not issue duplicate number leases");
    assert(f.requests.length <= 4, "Parallel services should share a bounded set of candidate checks");
  }
  {
    const f = await inventoryFixture(300);
    const candidates = f.runtime.candidates({ service: "late-online", databases: [database], limit: 300 });
    assert.equal(candidates.length, 300);
    f.fetch = async (url) => {
      const deviceId = decodeURIComponent(url.split("/clients/")[1].split(".json")[0]);
      const index = Number(deviceId.slice("device-".length));
      return { ok: true, status: 200, json: async () => ({ status: index === 199 }) };
    };
    const allocation = await f.context.findAvailableActiveNumber("late-online", null, null,
      Date.now() + 5000, { cachedOnly: true });
    assert(allocation, "An online number later in a large unlocked pool must be found");
    assert.equal(allocation.number, "9000000199",
      "Allocation must continue past offline candidates instead of stopping after the first four");
  }
  {
    const f = await inventoryFixture(10000);
    f.fetch = async (url) => {
      const deviceId = decodeURIComponent(url.split("/clients/")[1].split(".json")[0]);
      const index = Number(deviceId.slice("device-".length));
      return { ok: true, status: 200, json: async () => ({ status: index === 9999 }) };
    };
    const allocation = await f.context.findAvailableActiveNumber("ten-thousand", null, null,
      Date.now() + 10000, { cachedOnly: true });
    assert(allocation, "A healthy mapping beyond the first 8192 candidates must still be found");
    assert.equal(allocation.number, "9000009999");
  }
  {
    const f = await inventoryFixture(1);
    configureService(f);
    f.context.requestNumberPoolRefresh = () => {};
    f.fetch = async (url) => {
      assert.equal(url, database + "/clients/device-0.json");
      return { ok: true, status: 200, json: async () => ({ status: true }) };
    };
    const responses = await Promise.all(Array.from({ length: 64 }, () =>
      f.request(`/stubs/handler_api.php?action=getNumber&service=fixture&api_key=${f.apiKey}`)
    ));
    const allocations = responses.filter((response) => response.body.startsWith("ACCESS_NUMBER:"));
    assert.equal(allocations.length, 1,
      "64 simultaneous API requests competing for one number must create exactly one successful allocation");
    const [, orderId, number] = allocations[0].body.split(":");
    assert(number);
    const activeOrders = f.runtime.snapshot().orders.filter((order) => order.status === "active");
    assert.equal(activeOrders.length, 1, "The SQLite order history must have exactly one live order");
    assert.equal(activeOrders[0].orderId, orderId);
    assert.equal(activeOrders[0].number, number);
    assert.equal(f.runtime.sql("SELECT COUNT(*) AS n FROM leases WHERE expires_at>? AND number=?")
      .get(Date.now(), number).n, 1, "Exactly one unexpired lease must own the allocated number");
    assert.equal(f.runtime.sql("SELECT COUNT(*) AS n FROM orders WHERE number=? AND status='active'")
      .get(number).n, 1, "The active-order uniqueness invariant must hold under API load");
  }
  {
    const f = await inventoryFixture(128, 0);
    const devices = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [
      `device-${index}`, { status: true }
    ]));
    f.fetch = async (url) => {
      assert.equal(url, database + "/clients.json");
      return { ok: true, status: 200, json: async () => devices };
    };
    await f.context.readActiveNumbers(database, () => true, null, 128);
    const orders = await Promise.all(Array.from({ length: 128 }, () =>
      f.context.findAvailableActiveNumber("fixture", null, null, Date.now() + 4500, { cachedOnly: true })));
    assert(orders.every(Boolean), "Concurrent same-service calls must move past candidates another call just claimed");
    assert.equal(new Set(orders.map((order) => order.number)).size, 128,
      "Atomic claims should issue a unique number to each parallel request");
    assert.equal(f.requests.length, 1, "Concurrent warm allocations should not scan Firebase");
  }
  {
    const f = await inventoryFixture(128, 0);
    const devices = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [
      `device-${index}`, { status: true }
    ]));
    f.fetch = async (url) => {
      assert.equal(url, database + "/clients.json");
      return {
        ok: true, status: 200,
        // Exercise a snapshot excluded from the shared object cache.
        headers: { get: (name) => name === "content-length" ? String(2 * 1024 * 1024) : null },
        json: async () => devices
      };
    };
    await f.context.readActiveNumbers(database, () => true, null, 128);
    const readsBefore = f.requests.length;
    const started = performance.now();
    const elapsed = [];
    const orders = await Promise.all(Array.from({ length: 128 }, async () => {
      const order = await f.context.findAvailableActiveNumber("fixture", null, null,
        Date.now() + 4500, { cachedOnly: true });
      elapsed.push(performance.now() - started);
      return order;
    }));
    assert(orders.every(Boolean), "A warm inventory must serve a burst of available numbers");
    assert.equal(new Set(orders.map((order) => order.number)).size, 128,
      "Concurrent callers must receive distinct leased numbers");
    assert.equal(f.requests.length, readsBefore,
      "Fresh inventory must allocate without another upstream read, even if the snapshot is not cached");
    elapsed.sort((a, b) => a - b);
    console.log(`Synthetic warm inventory: 128 unique allocations, 0 foreground upstream reads, p95 ${elapsed[Math.ceil(elapsed.length * .95) - 1].toFixed(1)} ms (in-memory fixture).`);
  }
  {
    const f = await inventoryFixture(1, 0);
    f.fetch = async (url) => {
      assert.equal(url, database + "/clients.json");
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await f.context.readActiveNumbers(database);
    assert.equal(f.runtime.candidates({ service: "fixture", databases: [database] }).length, 0,
      "An empty online snapshot must invalidate previously online inventory");
    const order = await f.context.findAvailableActiveNumber("fixture", null, null,
      Date.now() + 4500, { cachedOnly: true });
    assert.equal(order, null, "A device missing from the latest snapshot cannot use the fast claim path");
  }
  {
    const f = await inventoryFixture(1, 0);
    const first = f.runtime.claim({ service: "recheck", candidate: {
      database, deviceId: "device-0", number: "9000000000"
    }});
    assert(first);
    f.runtime.setStatus({ id: first.orderId, status: "8" });
    assert.equal(f.runtime.advanceCycle({ service: "recheck", databases: [database] }), true);
    let onlineChecks = 0;
    f.fetch = async (url) => {
      assert.equal(url, database + "/clients/device-0.json",
        "A recycled number must verify current device status");
      onlineChecks++;
      return { ok: true, status: 200, json: async () => ({ status: false }) };
    };
    const order = await f.context.findAvailableActiveNumber("recheck", null, null,
      Date.now() + 4500, { cachedOnly: true });
    assert.equal(order, null, "Offline recycled numbers must not be issued");
    assert(onlineChecks >= 1);
  }
  {
    const f = new serverFixture();
    const slowDatabase = "https://slow-fixture.firebaseio.com";
    f.setRotation({ initialized: true, databaseUrls: [slowDatabase, database], serviceUsage: {}, orders: [] });
    await f.context.getRuntimeStore();
    const checkedAt = Date.now() - 20000;
    f.runtime.rememberBatch([
      { database: slowDatabase, deviceId: "slow-device", number: "9000000081", now: checkedAt, verifiedAt: Date.now() },
      { database, deviceId: "ready-device", number: "9000000082", now: checkedAt, verifiedAt: Date.now() }
    ]);
    f.fetch = async (url) => {
      const [projectUrl, deviceId] = url.split("/clients/");
      assert(deviceId, "Allocation must check saved device status, not read messages");
      if (projectUrl === slowDatabase) {
        return { ok: false, status: 503, headers: { get: () => null } };
      }
      assert.equal(projectUrl, database,
        "An unhealthy project must not stop a healthy database from serving the allocation");
      return { ok: true, status: 200, json: async () => ({ status: true }) };
    };
    const order = await f.context.findAvailableActiveNumber(
      "fixture", null, null, Date.now() + 4000, { cachedOnly: true }
    );
    assert(order, "The healthy database should still allocate a number");
    assert.equal(order.databaseUrl, database);
  }
  {
    const f = await inventoryFixture(1);
    configureService(f);
    const timeoutValues = [];
    f.context.setTimeout = (callback, milliseconds) => {
      timeoutValues.push(milliseconds);
      return setTimeout(callback, Math.min(milliseconds, 40));
    };
    f.context.clearTimeout = clearTimeout;
    f.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("Aborted fixture read"), { name: "AbortError" }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    const response = await f.request(`/stubs/handler_api.php?action=getNumber&service=fixture&api_key=${f.apiKey}`);
    assert.equal(timeoutValues[0], 30000, "The foreground waiting budget must use the configured thirty-second maximum");
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).code, "ALLOCATION_TIMEOUT");
    await turn();
    assert.equal(f.runtime.snapshot().orders.length, 0, "A request that times out must not create an order");
  }
  {
    const f = await inventoryFixture(0);
    configureService(f);
    f.context.setTimeout = (callback, milliseconds) => setTimeout(callback, Math.min(milliseconds, 40));
    f.context.clearTimeout = clearTimeout;
    f.context.findAvailableActiveNumber = async (_service, signal, onCommit) => {
      const finishCommit = onCommit();
      finishCommit(false);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(f.context.makeAbortError()), { once: true });
      });
    };
    const response = await f.request(`/stubs/handler_api.php?action=getNumber&service=fixture&api_key=${f.apiKey}`);
    assert.equal(response.status, 503, "A failed claim must restore the request timeout");
    assert.equal(JSON.parse(response.body).code, "ALLOCATION_TIMEOUT");
    assert.equal(f.runtime.snapshot().orders.length, 0);
  }
  console.log("PASS: allocation queue cancellation, read capacity, first-ready verification, warm burst uniqueness, offline invalidation, and request deadlines.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
