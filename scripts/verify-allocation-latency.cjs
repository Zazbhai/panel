"use strict";

// Synthetic storage and networking only. This never starts the server or reads
// the production rotation, service configuration, credentials, or Firebase.
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const serverFixture = require("./server-fixture.cjs");

const database = "https://fixture.firebaseio.com";
const turn = () => new Promise(setImmediate);

async function inventoryFixture(count, age = 20000) {
  const f = serverFixture();
  await f.context.getRuntimeStore();
  const now = Date.now();
  f.runtime.rememberBatch(Array.from({ length: count }, (_, index) => ({
    database, deviceId: `device-${index}`, number: String(9000000000 + index),
    now: now - age, verifiedAt: now
  })));
  // Discovery is separately tested. Keep it out of foreground timing checks.
  f.context.refillNumberPool = async () => null;
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
    const names = Array.from({ length: 10 }, (_, index) => "service-" + index);
    f.context.readConfiguredServices = async () => ({ services: names.map((name) => ({
      name, enabled: true, template: "code [OTP]"
    })) });
    f.context.readRotationMetadata = async () => ({ databaseUrls: [database] });
    const warmed = [];
    f.context.refillNumberPool = async (service) => { warmed.push(service); };
    await f.context.warmNumberPools();
    assert.equal(new Set(warmed).size, names.length,
      "One-time startup warming should cover every enabled service without recurring polling");
    assert(names.every((name) => warmed.includes(name)));
    assert.equal(warmed.length, names.length);
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
    const f = serverFixture();
    let refills = 0;
    f.context.fillNumberPool = async () => { refills++; return 1; };
    await f.context.refillNumberPool("event-service");
    await f.context.refillNumberPool("event-service");
    assert.equal(refills, 1, "A refill below the ready-stock threshold should cool down instead of rescanning repeatedly");
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
    const f = await inventoryFixture(4);
    const controller = new AbortController();
    let abortedReads = 0;
    f.fetch = async (url, { signal }) => {
      assert(url.includes("/clients/device-"), "Allocation may only verify individual device status");
      if (url.endsWith("/device-3.json")) {
        return { ok: true, status: 200, json: async () => ({ status: true }) };
      }
      return new Promise((_resolve, reject) => {
        const abort = () => {
          abortedReads++;
          reject(Object.assign(new Error("Cancelled losing check"), { name: "AbortError" }));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    };
    let timeout;
    try {
      const order = await Promise.race([
        f.context.findAvailableActiveNumber("fixture", controller.signal, null,
          Date.now() + 4500, { cachedOnly: true }),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 500); })
      ]);
      assert(order, "A confirmed online device must not wait for the other status checks");
      assert.equal(order.number, "9000000003");
      assert.equal(f.runtime.snapshot().orders.length, 1, "Only the winning device may create an order");
      await turn();
      assert.equal(abortedReads, 3, "Losing status checks must be cancelled");
      assert.equal(f.requests.length, 4, "One allocation may verify only a small candidate batch");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  {
    const f = await inventoryFixture(4);
    f.fetch = async (url) => {
      assert(url.includes("/clients/device-"));
      return { ok: true, status: 200, json: async () => ({ status: true }) };
    };
    const orders = await Promise.all(["one", "two", "three", "four"].map((service) =>
      f.context.findAvailableActiveNumber(service, null, null,
        Date.now() + 4500, { cachedOnly: true })));
    assert(orders.every(Boolean), "Losing a cross-service claim must try another confirmed candidate");
    assert.equal(new Set(orders.map((order) => order.number)).size, 4,
      "Parallel services must not issue duplicate number leases");
    assert.equal(f.requests.length, 4, "Parallel services must share identical upstream checks");
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
        "A recycled number must verify the individual device online status");
      onlineChecks++;
      return { ok: true, status: 200, json: async () => ({ status: false }) };
    };
    const order = await f.context.findAvailableActiveNumber("recheck", null, null,
      Date.now() + 4500, { cachedOnly: true });
    assert.equal(order, null, "Offline recycled numbers must not be issued");
    assert(onlineChecks >= 1);
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
    assert.equal(timeoutValues[0], 4500, "The foreground waiting budget must stay below five seconds");
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
