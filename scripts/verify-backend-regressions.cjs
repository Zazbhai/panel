const assert = require("node:assert/strict");
const { gunzipSync } = require("node:zlib");
const vm = require("node:vm");
const serverFixture = require("./server-fixture.cjs");

function completedOrder() {
  return {
    orderId: "a".repeat(24), deviceId: "device-1", number: "9000000001",
    databaseUrl: "https://fixture.firebaseio.com", service: "fixture",
    createdAt: Date.now() - 1200000, expiresAt: Date.now() - 600000,
    status: "completed", receivedOtp: "123456", receivedAt: Date.now() - 900000,
    receivedOtps: [{ code: "123456", receivedAt: Date.now() - 900000, messageKey: "one" }],
    messageHistory: []
  };
}

(async () => {
  {
    const f = serverFixture();
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      f.context.readConfiguredServices()
    ));
    assert(results.every((result) => result.initialized));
    const servicesPath = [...f.files.keys()].find((file) => file.endsWith("services.json"));
    assert.equal(f.readCounts.get(servicesPath), 1,
      "Concurrent service reads should share one full-file read and JSON parse");
  }
  {
    const f = serverFixture();
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [] });
    const devices = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
      `device-${index + 1}`, { status: true }
    ]));
    const numbers = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
      `device-${index + 1}`, `900000000${index + 1}`
    ]));
    f.fetch = async (url) => {
      if (url.endsWith("/clients.json")) {
        return { ok: true, status: 200, json: async () => devices };
      }
      const deviceId = decodeURIComponent(url.split("/messages/")[1].replace(/\.json$/, ""));
      return { ok: true, status: 200, json: async () => ({
        message1: { message: `Jio number ${numbers[deviceId]}` }
      }) };
    };
    const reservations = await Promise.all(Array.from({ length: 4 }, () =>
      f.context.findAvailableActiveNumber("fixture")
    ));
    assert.equal(reservations.length, 4);
    assert.equal(new Set(reservations.map((reservation) => reservation?.number)).size, 4,
      "Concurrent allocations for one service should serialize and reserve unique numbers");
    assert(reservations.every(Boolean),
      "Concurrent same-service allocations should not exhaust conflict retries");
  }
  {
    const f = serverFixture();
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [] });
    const devices = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      "device-" + index, { status: true }
    ]));
    let upstreamReads = 0;
    f.fetch = async (url) => {
      upstreamReads++;
      if (url.endsWith("/clients.json")) return { ok: true, status: 200, json: async () => devices };
      const deviceId = decodeURIComponent(url.split("/messages/")[1].replace(/\.json$/, ""));
      const index = Number(deviceId.slice("device-".length));
      return { ok: true, status: 200, json: async () => ({
        message1: { message: "Jio number " + ("9000000" + String(index).padStart(3, "0")), timestamp: Date.now() }
      }) };
    };
    await f.context.refillNumberPool("fixture");
    assert.equal(vm.runInContext('numberPools.get("fixture").items.size', f.context), 32,
      "Background refill should prepare a bounded batch of future numbers");
    const readsBeforeAllocation = upstreamReads;
    const reservation = await f.context.findAvailableActiveNumber("fixture");
    assert(reservation, "A prepared number should be allocated");
    assert.equal(upstreamReads, readsBeforeAllocation,
      "A warm-pool allocation must not scan Firebase on the request path");
    assert.equal(vm.runInContext('numberPools.get("fixture").items.size', f.context), 31,
      "An allocated candidate should be removed from the pool");
    assert.equal(typeof reservation.number, "string",
      "A prepared candidate should include its allocated number");
  }
  {
    const f = serverFixture();
    let proxyBodyCancelled = false;
    const proxyBody = {
      body: { getReader: () => ({
        async read() { return { done: false, value: Buffer.from("oversized") }; },
        async cancel() { proxyBodyCancelled = true; },
        releaseLock() {}
      }) },
      headers: { get: () => null }
    };
    await assert.rejects(
      f.context.readUpstreamText(proxyBody, 4),
      (error) => error.code === "RESPONSE_TOO_LARGE"
    );
    assert.equal(proxyBodyCancelled, true, "Oversized proxy streams should be cancelled immediately");
  }
  {
    const f = serverFixture();
    f.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === "content-length" ? String(5 * 1024 * 1024) : null },
      body: { getReader() { throw new Error("Oversized response body must not be read"); } }
    });
    const response = await f.request(
      "/api/data?section=large&database=https%3A%2F%2Ffixture.firebaseio.com",
      { admin: true }
    );
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.body).code, "UPSTREAM_RESPONSE_TOO_LARGE");
  }
  {
    const f = serverFixture();
    let activeReads = 0;
    let peakReads = 0;
    f.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeReads -= 1;
        return { ok: true };
      }
    });
    const readLimit = 6;
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      f.context.fetchDatabaseJson(`https://fixture.firebaseio.com/clients/${index}.json`)
    ));
    assert(peakReads <= readLimit, "Firebase JSON reads must respect the process-wide concurrency limit");
  }
  {
    const f = serverFixture();
    f.context.setTimeout = (callback) => setTimeout(callback, 1);
    f.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      }, { once: true });
    });
    await assert.rejects(
      f.context.fetchDatabaseJson("https://fixture.firebaseio.com/messages/device-1.json", 1000),
      (error) => error.name === "TimeoutError" && error.code === "UPSTREAM_TIMEOUT"
    );
  }
  {
    const f = serverFixture();
    const order = completedOrder();
    order.status = "active";
    order.receivedOtp = null;
    order.receivedAt = null;
    order.receivedOtps = [];
    order.createdAt = Date.now() - 1000;
    order.expiresAt = Date.now() + 600000;
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [order] });
    f.context.fetchSharedDatabaseJson = async () => {
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    };
    const logs = [];
    f.context.console = { error: (...args) => logs.push(args) };
    const result = await f.request("/stubs/handler_api.php?action=getStatus&id=" + order.orderId + "&api_key=" + f.apiKey);
    assert.equal(result.status, 503, "An aborted Firebase read should remain a temporary API failure");
    assert.equal(logs.length, 0, "Expected aborted reads must not flood the server error log");
  }
  {
    const f = serverFixture();
    let sharedReads = 0;
    f.fetch = async () => {
      sharedReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { ok: true, status: 200, json: async () => ({ shared: true }) };
    };
    const sharedEndpoint = "https://fixture.firebaseio.com/clients/shared.json";
    const [sharedFirst, sharedSecond] = await Promise.all([
      f.context.fetchSharedDatabaseJson(sharedEndpoint, 1000, 1000),
      f.context.fetchSharedDatabaseJson(sharedEndpoint, 1000, 1000)
    ]);
    assert.deepEqual(sharedFirst, { shared: true });
    assert.deepEqual(sharedSecond, { shared: true });
    assert.equal(sharedReads, 1,
      "Concurrent identical Firebase reads must share one upstream request");
    await f.context.fetchSharedDatabaseJson(sharedEndpoint, 1000, 1000);
    assert.equal(sharedReads, 1, "Short-lived Firebase read cache should prevent repeat requests");
  }
  {
    const f = serverFixture();
    let oversizedBodyRead = false;
    f.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === "content-length" ? String(9 * 1024 * 1024) : null },
      body: { getReader() { oversizedBodyRead = true; throw new Error("Body should not be read"); } }
    });
    await assert.rejects(
      f.context.fetchDatabaseJson("https://fixture.firebaseio.com/messages/large.json"),
      (error) => error.code === "RESPONSE_TOO_LARGE"
    );
    assert.equal(oversizedBodyRead, false,
      "Oversized Firebase responses should be rejected from Content-Length before buffering");
  }
  {
    const f = serverFixture();
    let throttledReads = 0;
    f.fetch = async () => {
      throttledReads += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name === "retry-after" ? "2" : null }
      };
    };
    const throttledEndpoint = "https://fixture.firebaseio.com/clients/throttled.json";
    const results = await Promise.allSettled([
      f.context.fetchSharedDatabaseJson(throttledEndpoint, 1000, 1000),
      f.context.fetchSharedDatabaseJson(throttledEndpoint, 1000, 1000)
    ]);
    assert.equal(throttledReads, 1, "Concurrent throttled reads should share one failed upstream request");
    assert.equal(results[0].reason.status, 429);
    assert.equal(results[0].reason.retryAfterMs, 2000);
  }
  {
    const f = serverFixture();
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [] });
    const servicesPath = [...f.files.keys()].find((name) => name.endsWith("services.json"));
    f.files.set(servicesPath, JSON.stringify([{
      id: "fixture-service", name: "fixture", enabled: true,
      templates: [{ text: "Code {{OTP}}", enabled: true }],
      minOtpLength: 4, maxOtpLength: 8, senderFilter: ""
    }]));
    f.fetch = async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => name === "retry-after" ? "2" : null }
    });
    const response = await f.request(`/stubs/handler_api.php?action=getNumber&service=fixture&api_key=${f.apiKey}`);
    assert.equal(response.status, 503,
      "Firebase rate limiting must be reported as a retryable dependency failure, not NO_NUMBERS");
    assert.equal(response.headers["Retry-After"], "2");
    assert.equal(JSON.parse(response.body).code, "UPSTREAM_UNAVAILABLE");
  }
  {
    const f = serverFixture();
    const largeBody = Buffer.from(JSON.stringify({ value: "x".repeat(1024 * 1024) }));
    let largeReads = 0;
    f.fetch = async () => {
      largeReads += 1;
      let read = false;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === "content-length" ? String(largeBody.length) : null },
        body: { getReader: () => ({
          async read() {
            if (read) return { done: true };
            read = true;
            return { done: false, value: largeBody };
          },
          async cancel() {},
          releaseLock() {}
        }) }
      };
    };
    const largeEndpoint = "https://fixture.firebaseio.com/messages/large.json";
    await f.context.fetchSharedDatabaseJson(largeEndpoint, 1000, 1000);
    await f.context.fetchSharedDatabaseJson(largeEndpoint, 1000, 1000);
    assert.equal(largeReads, 2,
      "Large Firebase payloads should be processed but excluded from the shared object cache");
  }
  {
    const f = serverFixture();
    const first = await f.context.readRotationState();
    first.databaseUrls.push("https://mutation.invalid");
    const second = await f.context.readRotationState();
    assert.equal(second.databaseUrls.includes("https://mutation.invalid"), false,
      "Cached rotation state must not expose mutable internal data");
    assert.equal([...f.readCounts].filter(([file]) => file.endsWith("rotation.json")).length, 1);
    assert.equal([...f.readCounts].find(([file]) => file.endsWith("rotation.json"))[1], 1,
      "Repeated rotation reads should use the short-lived normalized-state cache");
    second.databaseUrls = [];
    await f.context.saveRotationState(second);
    second.databaseUrls.push("https://mutation.invalid");
    assert.equal((await f.context.readRotationState()).databaseUrls.length, 0,
      "Saving rotation must replace the cached state and isolate later caller mutations");

    const candidate = f.context.findAvailableNumberCandidate("fixture", {
      databaseUrls: ["https://failed.firebaseio.com", "https://working.firebaseio.com"],
      serviceUsage: {}, orders: []
    }, [
      { database: "https://failed.firebaseio.com", numbers: [], messageReadFailures: 1 },
      { database: "https://working.firebaseio.com", numbers: [{ deviceId: "fast", number: "9000000001" }], messageReadFailures: 0 }
    ], false);
    assert.equal(candidate.database, "https://working.firebaseio.com",
      "A failed earlier inventory must not hide a usable candidate from another database");

    const path = "/fixture-asset.js";
    const original = Buffer.from("window.fixture = 'old';");
    const updated = Buffer.from("window.fixture = 'new';");
    const oldCompressed = f.context.getCompressedStaticAsset(path, original);
    const newCompressed = f.context.getCompressedStaticAsset(path, updated);
    assert.equal(gunzipSync(oldCompressed).toString(), original.toString());
    assert.equal(gunzipSync(newCompressed).toString(), updated.toString(),
      "Compressed asset cache must invalidate when the underlying content changes");
  }
  {
    const f = serverFixture();
    const now = Date.now();
    const baseOrder = completedOrder();
    const orders = ["b".repeat(24), "c".repeat(24)].map((orderId, index) => ({
      ...baseOrder,
      orderId,
      number: `900000000${index + 1}`,
      status: "active", receivedOtp: null, receivedAt: null, receivedOtps: [],
      createdAt: now - 60000, expiresAt: now + 600000,
      service: "fixture"
    }));
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders });
    f.files.set([...f.files.keys()].find((name) => name.endsWith("services.json")), JSON.stringify([
      { id: "fixture", name: "fixture", enabled: true, template: "Code [OTP]" }
    ]));
    let messageReads = 0;
    f.fetch = async (url) => {
      if (url.endsWith("/messages/device-1.json")) {
        messageReads += 1;
        return { ok: true, status: 200, json: async () => ({
          message1: { message: "Fixture code 654321", timestamp: now - 1000 }
        }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: true }) };
    };
    await f.context.synchronizeRecentOrderOtps();
    assert.equal(messageReads, 1,
      "Orders sharing one device must reuse a single messages read per scan");
    const updated = f.rotation().orders;
    assert.equal(updated.filter((order) => order.receivedOtp === "654321").length, 2,
      "Both orders must receive the matched OTP from the shared read");
  }
  {
    const f = serverFixture();
    let upstreamCalls = 0;
    f.fetch = async () => {
      upstreamCalls += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [completedOrder()] });
    const result = await f.request("/api/recent-orders", { admin: true });
    assert.equal(result.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(upstreamCalls, 0,
      "The recent-orders endpoint must never trigger Firebase OTP scans; getStatus is the only trigger");
  }
  {
    const f = serverFixture();
    let slowReadAborted = false;
    f.fetch = async (url, { signal }) => {
      if (url.endsWith("/clients.json")) {
        return { ok: true, status: 200, json: async () => ({
          fast: { status: true }, slow: { status: true }
        }) };
      }
      if (url.endsWith("/messages/fast.json")) {
        return { ok: true, status: 200, json: async () => ({
          message1: { message: "Jio number 9000000001" }
        }) };
      }
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          slowReadAborted = true;
          reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    };
    const result = await f.context.readActiveNumbers(
      "https://fixture.firebaseio.com",
      (candidate) => candidate.number === "9000000001"
    );
    assert.equal(result.numbers[0]?.deviceId, "fast");
    assert.equal(slowReadAborted, true,
      "A winning device read should cancel unused shared message requests");
  }
  {
    const f = serverFixture();
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [completedOrder()] });
    const result = await f.request(`/stubs/handler_api.php?action=getStatus&id=${"a".repeat(24)}&api_key=${f.apiKey}`);
    assert.equal(result.body, "STATUS_OK:123456");
    assert.equal(f.requests.length, 0, "Expired completed orders must use saved OTPs without querying Firebase");
  }
  {
    const f = serverFixture();
    f.fetch = async () => ({ ok: true, status: 200, json: async () => null });
    const result = await f.context.readRotatingDeviceStats();
    assert.equal(f.rotation().databaseUrls.length, 0, "Firebase HTTP 200/null means clients is missing");
    assert.equal(result.removedDatabases.length, 1);
    assert.equal(result.databaseCount, 1, "Scan denominator must describe the original snapshot");
    assert.equal(result.remainingDatabaseCount, 0);
    assert.equal((await f.context.readRotationState()).databaseUrls.length, 0);
  }
  {
    const f = serverFixture();
    f.fetch = async () => ({ ok: false, status: 403 });
    await f.context.readRotatingDeviceStats();
    assert.equal(f.rotation().databaseUrls.length, 1, "Permission errors must not remove databases");
  }
  {
    const f = serverFixture();
    const order = completedOrder();
    for (let index = 0; index < 105; index++) {
      f.context.appendOrderOtp(order, { code: "654321", receivedAt: order.receivedAt + index + 1, messageKey: `new-${index}` });
    }
    f.setRotation({ databaseUrls: [], serviceUsage: {}, orders: [order] });
    assert.equal((await f.context.readRotationState()).orders[0].receivedOtps.length, 106,
      "Receiving the 101st OTP must not invalidate the entire rotation file");
    f.context.appendOrderOtp(order, { code: "111111", receivedAt: 100, messageKey: "late-old-message" });
    assert.equal(order.receivedOtp, "654321", "Late older messages must not replace the newest OTP");
  }
  {
    const f = serverFixture();
    const order = completedOrder();
    f.context.appendOrderOtp(order, { code: "12345678901234567890", receivedAt: Date.now(), messageKey: "long-code" });
    f.setRotation({ databaseUrls: [], serviceUsage: {}, orders: [order] });
    assert.equal((await f.context.readRotationState()).orders[0].receivedOtp, "12345678901234567890");
    const services = [
      { id: "same-id", name: "first", enabled: true, template: "Code [OTP]" },
      { id: "same-id", name: "second", enabled: true, template: "Code [OTP]" }
    ];
    assert.equal(f.context.validateServiceList(f.context.normalizeConfiguredServices(services)), "Service IDs must be unique.");
    const file = [...f.files.keys()].find((name) => name.endsWith("services.json"));
    f.files.set(file, JSON.stringify([{ id: "disabled", name: "disabled", enabled: false, template: "Code [OTP]" }]));
    const result = await f.request(`/stubs/handler_api.php?action=getNumber&service=disabled&api_key=${f.apiKey}`);
    assert.equal(result.body, "BAD_SERVICE");
    assert.equal(f.requests.length, 0);
    const state = await f.context.readRotationState();
    assert.equal(Object.getPrototypeOf(state.serviceUsage), null);
    await f.context.saveRotationState(state);
    assert.equal([...f.files.keys()].some((name) => name.endsWith(".tmp")), false);
    assert.equal(f.rotation().orders[0].receivedOtp, "12345678901234567890");
  }
  {
    const f = serverFixture();
    const order = completedOrder();
    order.status = "active"; order.receivedOtp = null; order.receivedAt = null; order.receivedOtps = [];
    order.createdAt = Date.now(); order.expiresAt = Date.now() + 600000;
    f.setRotation({ databaseUrls: [], serviceUsage: {}, orders: [order] });
    const result = await f.request("/api/recent-orders?source=saved", { admin: true });
    assert.equal(result.status, 200);
    await new Promise(setImmediate);
    assert.equal(f.requests.length, 0, "Saved OTP feed must not initiate an upstream scan");
  }
  {
    const f = serverFixture();
    f.setRotation({
      databaseUrls: ["https://fixture.firebaseio.com", "https://unreachable.firebaseio.com"],
      serviceUsage: {},
      orders: []
    });
    let releaseScan;
    const scanBlocked = new Promise((resolve) => { releaseScan = resolve; });
    f.fetch = async (url) => {
      if (url.endsWith("/clients.json")) {
        if (url.startsWith("https://unreachable.")) {
          throw new Error("The second database must not be scanned after a usable number is found");
        }
        await scanBlocked;
        return { ok: true, status: 200, json: async () => ({ "device-1": { status: true } }) };
      }
      return { ok: true, status: 200, json: async () => ({
        message1: { message: "Jio number 9000000001" }
      }) };
    };
    const allocation = f.context.findAvailableActiveNumber("fixture");
    await new Promise(setImmediate);
    const recentOrders = await Promise.race([
      f.request("/api/recent-orders?source=saved", { admin: true }),
      new Promise((resolve) => setTimeout(() => resolve(null), 100))
    ]);
    assert(recentOrders && recentOrders.status === 200,
      "A slow number scan must not block the recent-orders endpoint");
    releaseScan();
    const reservation = await allocation;
    assert.equal(reservation?.number, "9000000001",
      "Allocation must reserve a usable number without scanning later databases");
  }
  console.log("PASS: expiry, missing clients cleanup, permission failures, history limits, out-of-order OTPs and saved-only feed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
