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
    assert.equal(f.runtime.candidates({ service: "fixture", databases: f.rotation().databaseUrls, limit: 100 }).length, 40,
      "Background refill should prepare a bounded shared inventory of future numbers");
    const readsBeforeAllocation = upstreamReads;
    const reservation = await f.context.findAvailableActiveNumber("fixture");
    assert(reservation, "A prepared number should be allocated");
    assert.equal(upstreamReads, readsBeforeAllocation,
      "A warm-pool allocation must not scan Firebase on the request path");
    assert.equal(f.runtime.candidates({ service: "fixture", databases: f.rotation().databaseUrls, limit: 100 }).length, 39,
      "An active lease should exclude the number from the shared inventory");
    assert.equal(typeof reservation.number, "string",
      "A prepared candidate should include its allocated number");
  }
  {
    const f = serverFixture();
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [] });
    const servicesPath = [...f.files.keys()].find((file) => file.endsWith("services.json"));
    f.files.set(servicesPath, JSON.stringify([
      { id: "fixture", name: "fixture", enabled: true, template: "Code [OTP]" }
    ]));
    f.context.setTimeout = (callback) => setTimeout(callback, 20);
    f.context.clearTimeout = clearTimeout;
    let upstreamAborted = false;
    f.fetch = async (url, { signal }) => {
      if (url.endsWith("/clients.json")) {
        return { ok: true, status: 200, json: async () => ({ device: { status: true } }) };
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          upstreamAborted = true;
          reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    };
    const startedAt = Date.now();
    const result = await f.request("/stubs/handler_api.php?action=getNumber&service=fixture&api_key=" + f.apiKey);
    assert(Date.now() - startedAt < 500, "A slow number request must return within its configured deadline");
    assert.equal(result.status, 200);
    assert.equal(result.body, "NO_NUMBERS",
      "A slow cold-pool refill should not block the API or read message history");
    assert.equal(f.rotation().orders.length, 0, "A timed-out request must not create an order");
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
    const readLimit = 32;
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
      throw new TypeError("fetch failed");
    };
    const healthSignals = [];
    f.context.recordSlowDatabase = (...args) => healthSignals.push(["slow", ...args]);
    f.context.requestNumberPoolRefresh = (...args) => healthSignals.push(["refresh", ...args]);
    const logs = [];
    f.context.console = { error: (...args) => logs.push(args) };
    const result = await f.request("/stubs/handler_api.php?action=getStatus&id=" + order.orderId + "&api_key=" + f.apiKey);
    assert.equal(result.status, 503, "A network fetch failure should be retryable");
    assert.equal(result.headers["Retry-After"], "1");
    assert.equal(logs.length, 1, "A fetch failure should be logged once to trigger operator visibility");
    assert.deepEqual(healthSignals.map(([type]) => type), ["slow", "refresh"],
      "A failed order message fetch should record the database issue and trigger one event-driven pool refresh");
    assert.equal(healthSignals[1][1], order.service);
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
    const endpoint = "https://fixture.firebaseio.com/messages/shared-device.json";
    let readCount = 0;
    let backgroundAborted = false;
    let releaseLiveRead;
    f.fetch = async (_url, { signal }) => {
      readCount++;
      if (readCount === 1) return new Promise((_resolve, reject) => {
        const abort = () => {
          backgroundAborted = true;
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      return new Promise((resolve) => {
        releaseLiveRead = () => resolve({ ok: true, status: 200, json: async () => ({ live: true }) });
      });
    };
    const controller = new AbortController();
    const background = f.context.fetchSharedDatabaseJson(endpoint, 1000, 1000, controller.signal);
    await new Promise(setImmediate);
    controller.abort();
    await assert.rejects(background, { name: "AbortError" });
    assert(backgroundAborted);
    const apiRead = f.context.fetchSharedDatabaseJson(endpoint, 1000, 1000);
    await new Promise(setImmediate);
    assert.equal(readCount, 2, "An API caller must start a new read instead of joining an aborted background read");
    releaseLiveRead();
    assert.deepEqual(await apiRead, { live: true });
  }
  {
    const f = serverFixture();
    const endpoint = "https://fixture.firebaseio.com/messages/priority-device.json";
    let reads = 0;
    let releaseBackground;
    const backgroundResponse = new Promise((resolve) => { releaseBackground = resolve; });
    f.fetch = async (_url, { signal }) => {
      reads++;
      if (reads === 1) return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("background aborted"), { name: "AbortError" })), { once: true });
        backgroundResponse.then(resolve);
      });
      return { ok: true, status: 200, json: async () => ({ priority: "api" }) };
    };
    const background = f.context.fetchSharedDatabaseJson(endpoint, 1000, 1000, null, 1);
    await new Promise(setImmediate);
    const apiRead = f.context.fetchSharedDatabaseJson(endpoint, 1000, 1000, null, 0);
    assert.deepEqual(await apiRead, { priority: "api" });
    assert.equal(reads, 2, "An API read must not join a slower background inventory read for the same endpoint");
    releaseBackground({ ok: true, status: 200, json: async () => ({ priority: "background" }) });
    await background;
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
    assert.equal(response.status, 200,
      "A mapping-only API request should not probe an unreadable database");
    assert.equal(response.body, "NO_NUMBERS");
    assert.equal(f.requests.length, 0, "Customer allocation should not start message discovery");
  }
  {
    const f = serverFixture();
    await f.context.getRuntimeStore();
    const databaseUrl = "https://fixture.firebaseio.com";
    f.setRotation({ databaseUrls: [databaseUrl], serviceUsage: {}, orders: [] });
    const servicesPath = [...f.files.keys()].find((name) => name.endsWith("services.json"));
    f.files.set(servicesPath, JSON.stringify([{ name: "fixture", enabled: true, templates: [{ text: "Code {{OTP}}", enabled: true }] }]));
    const now = Date.now();
    const oldOrder = { ...completedOrder(), orderId: "d".repeat(24), receivedOtp: null,
      receivedAt: null, receivedOtps: [], status: "cancelled", createdAt: now - 60000,
      expiresAt: now - 1000, deviceId: "rebuy-device", number: "9000000001" };
    f.runtime.importOrder(oldOrder);
    f.runtime.remember({ database: databaseUrl, deviceId: oldOrder.deviceId,
      number: oldOrder.number, now, verifiedAt: now });
    f.runtime.recordDatabaseCheck({ database: databaseUrl, now });
    let online = true;
    f.fetch = async (url) => {
      assert.equal(url, databaseUrl + "/clients/" + encodeURIComponent(oldOrder.deviceId) + ".json?shallow=true");
      return online
        ? { ok: true, status: 200, json: async () => ({ status: true }) }
        : { ok: true, status: 200, json: async () => ({ status: false }) };
    };
    vm.runInContext(`activeClientOnlineIds.set(${JSON.stringify(databaseUrl)}, {
      onlineIds: new Set([${JSON.stringify(oldOrder.deviceId)}]), checkedIds: null,
      complete: true, expiresAt: Date.now() + 30000
    })`, f.context);
    const missingKey = await f.request("/api/rebuy", { method: "POST", body: { id: oldOrder.orderId } });
    assert.equal(missingKey.status, 401, "Rebuy is protected by the dashboard API key");
    const oldParameter = await f.request("/api/rebuy?api_key=" + f.apiKey,
      { method: "POST", body: { oldOrderId: oldOrder.orderId } });
    assert.equal(oldParameter.status, 400, "Rebuy accepts id, not oldOrderId");
    const duplicateIds = await f.request(`/api/rebuy?api_key=${f.apiKey}&id=${oldOrder.orderId}&id=${oldOrder.orderId}`);
    assert.equal(duplicateIds.status, 400, "Rebuy requires exactly one id parameter");
    const success = await f.request("/api/rebuy?api_key=" + f.apiKey,
      { method: "POST", body: { id: oldOrder.orderId } });
    assert.equal(success.status, 200);
    const rebuy = JSON.parse(success.body);
    assert.equal(rebuy.success, true);
    assert.notEqual(rebuy.orderId, oldOrder.orderId);
    assert.equal(rebuy.number, oldOrder.number);
    assert.equal(rebuy.deviceId, oldOrder.deviceId);
    assert.equal(rebuy.service, oldOrder.service);
    assert.equal(f.runtime.getOrder(rebuy.orderId).status, "active");
    assert.equal(f.requests.length, 0, "A recent complete status snapshot should avoid another Firebase request");
    const protocolOrder = { ...oldOrder, orderId: "8".repeat(24), number: "9000000005" };
    f.runtime.importOrder(protocolOrder);
    f.runtime.remember({ database: databaseUrl, deviceId: protocolOrder.deviceId,
      number: protocolOrder.number, now, verifiedAt: now });
    const protocolRebuy = await f.request(
      `/stubs/handler_api.php?api_key=${f.apiKey}&action=rebuy&id=${protocolOrder.orderId}`
    );
    assert.equal(protocolRebuy.status, 200);
    assert(protocolRebuy.body.startsWith("ACCESS_NUMBER:"));
    assert.equal(protocolRebuy.body.split(":")[2], protocolOrder.number,
      "The rebuy provider action must return the same phone number");
    assert.notEqual(protocolRebuy.body.split(":")[1], protocolOrder.orderId);
    const raceOrder = { ...oldOrder, orderId: "7".repeat(24), number: "9000000006" };
    f.runtime.importOrder(raceOrder);
    f.runtime.remember({ database: databaseUrl, deviceId: raceOrder.deviceId,
      number: raceOrder.number, now, verifiedAt: now });
    const race = await Promise.all([1, 2].map(() => f.request(
      `/stubs/handler_api.php?api_key=${f.apiKey}&action=rebuy&id=${raceOrder.orderId}`
    )));
    assert.equal(race.filter((result) => result.body.startsWith("ACCESS_NUMBER:")).length, 1,
      "Concurrent rebuy attempts must create at most one new lease/order");
    const activeOldOrder = { ...oldOrder, orderId: "f".repeat(24), number: "9000000003",
      status: "active", createdAt: Date.now(), expiresAt: Date.now() + 60000 };
    f.runtime.importOrder(activeOldOrder);
    f.runtime.remember({ database: databaseUrl, deviceId: activeOldOrder.deviceId,
      number: activeOldOrder.number, now, verifiedAt: now });
    const activeRebuy = await f.request(`/api/rebuy?api_key=${f.apiKey}&id=${activeOldOrder.orderId}`);
    assert.equal(JSON.parse(activeRebuy.body).error, "rebuy Unsuccessful order still active");

    const lockedOldOrder = { ...oldOrder, orderId: "9".repeat(24), number: "9000000004",
      receivedOtp: "123456", receivedAt: now - 5000, receivedOtps: [{
        code: "123456", receivedAt: now - 5000, messageKey: "otp"
      }], status: "completed" };
    f.runtime.importOrder(lockedOldOrder);
    f.runtime.remember({ database: databaseUrl, deviceId: lockedOldOrder.deviceId,
      number: lockedOldOrder.number, now, verifiedAt: now });
    const lockedRebuy = await f.request("/api/rebuy?api_key=" + f.apiKey,
      { method: "POST", body: { id: lockedOldOrder.orderId } });
    assert.equal(JSON.parse(lockedRebuy.body).error, "rebuy Unsuccessful number unavailable");

    const competing = await f.request("/api/rebuy?api_key=" + f.apiKey,
      { method: "POST", body: { id: oldOrder.orderId } });
    assert.equal(JSON.parse(competing.body).error, "rebuy Unsuccessful source offline");

    const offlineOrder = { ...oldOrder, orderId: "e".repeat(24), number: "9000000002" };
    f.runtime.importOrder(offlineOrder);
    f.runtime.remember({ database: databaseUrl, deviceId: offlineOrder.deviceId,
      number: offlineOrder.number, now, verifiedAt: now });
    vm.runInContext(`activeClientOnlineIds.delete(${JSON.stringify(databaseUrl)})`, f.context);
    online = false;
    const readsBeforeOffline = f.requests.length;
    const offline = await f.request(
      `/stubs/handler_api.php?api_key=${f.apiKey}&action=rebuy&id=${offlineOrder.orderId}`
    );
    assert.equal(offline.status, 200);
    assert.equal(offline.body, "rebuy Unsuccessful source offline");
    assert.equal(f.requests.length - readsBeforeOffline, 1,
      "Without a recent snapshot, rebuy should shallow-check only the source device");
    assert.equal(f.runtime.sql("SELECT COUNT(*) AS n FROM orders").get().n, 9,
      "Offline rebuy must not create an order");
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
    for (const order of orders) {
      await f.request(`/stubs/handler_api.php?action=getStatus&id=${order.orderId}&api_key=${f.apiKey}`);
    }
    assert.equal(messageReads, 1,
      "Orders sharing one device must reuse a single messages read per scan");
    const updated = f.rotation().orders;
    assert.equal(updated.filter((order) => order.receivedOtp === "654321").length, 1,
      "The same device message must never be credited to two orders");
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
    const payload = JSON.parse(result.body);
    assert.equal(payload.orders.length, 1);
    assert.equal(payload.stats.total, 1);
    assert.equal(payload.orders[0].locked, true, "Saved orders still expose locked state");
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
    const order = completedOrder();
    order.expiresAt = Date.now() + 600000;
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [order] });
    const result = await f.request(`/stubs/handler_api.php?action=getStatus&id=${order.orderId}&api_key=${f.apiKey}`);
    assert.equal(result.status, 200);
    assert.equal(result.body, "STATUS_OK:123456");
    assert.equal(f.requests.length, 0,
      "Completed orders must return saved OTPs without requiring Firebase or service-config reads");
  }
  {
    const f = serverFixture({ env: {
      OTP_WEBHOOK_URL: "https://partner.test/callback",
      OTP_WEBHOOK_SECRET: "fixture-webhook-secret"
    } });
    const now = Date.now();
    const order = { ...completedOrder(), status: "active", receivedOtp: null, receivedAt: null,
      receivedOtps: [], createdAt: now - 1000, expiresAt: now + 600000 };
    f.setRotation({ databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: [order] });
    f.files.set([...f.files.keys()].find((file) => file.endsWith("services.json")), JSON.stringify([
      { id: "fixture", name: "fixture", enabled: true, template: "Code [OTP]" }
    ]));
    const callbacks = [];
    let failNextCallback = false;
    let messages = {
      sms1: { message: "Fixture code 123456", timestamp: now - 500 }
    };
    f.fetch = async (url, options) => {
      if (String(url) === "https://partner.test/callback") {
        callbacks.push({ headers: options.headers, payload: JSON.parse(options.body) });
        if (failNextCallback) {
          failNextCallback = false;
          return { ok: false, status: 503, text: async () => "temporary failure" };
        }
        return { ok: true, status: 200, text: async () => "ok" };
      }
      assert(String(url).endsWith("/messages/device-1.json"));
      return { ok: true, status: 200, json: async () => messages };
    };
    await f.context.pollOrdersForWebhook();
    assert.equal(f.runtime.getOrder(order.orderId).receivedOtp, "123456",
      "Background polling must save OTPs without a partner getStatus call");
    assert.equal(callbacks.length, 0, "Unlinked orders must not send the local ID as a provider ID");
    const linked = await f.request(`/api/order-link?api_key=${f.apiKey}`, { method: "POST",
      body: { local_order_id: order.orderId, external_order_id: "partner-order-482" } });
    assert.equal(linked.status, 200);
    await f.context.deliverPendingOtpWebhooks();
    assert.equal(callbacks.length, 1);
    assert.deepEqual(callbacks[0].payload, { external_order_id: "partner-order-482", otp: "123456" });
    assert.equal(callbacks[0].headers.authorization, "Bearer fixture-webhook-secret");
    assert.equal(callbacks[0].headers["x-provider-webhook-secret"], "fixture-webhook-secret");
    await f.context.pollOrdersForWebhook();
    assert.equal(callbacks.length, 1, "Successful callbacks must not be sent again on the next scan");
    messages = {
      ...messages,
      sms2: { message: "Fixture code 654321", timestamp: now - 100 }
    };
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await f.context.pollOrdersForWebhook();
    await f.context.deliverPendingOtpWebhooks();
    assert.equal(callbacks.length, 2,
      "Completed orders must remain monitored and deliver each later matching OTP");
    assert.deepEqual(callbacks[1].payload, { external_order_id: "partner-order-482", otp: "654321" });
    failNextCallback = true;
    messages = {
      ...messages,
      sms3: { message: "Fixture code 777888", timestamp: now - 50 }
    };
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await f.context.pollOrdersForWebhook();
    assert.equal(callbacks.length, 3, "A failed provider attempt must keep the OTP queued");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await f.context.deliverPendingOtpWebhooks();
    assert.equal(callbacks.length, 4, "A failed provider attempt must be retried");
    assert.deepEqual(callbacks[3].payload, { external_order_id: "partner-order-482", otp: "777888" });
    const resentLink = await f.request(`/api/order-link?api_key=${f.apiKey}`, { method: "POST",
      body: { local_order_id: order.orderId, retry: true } });
    assert.equal(resentLink.status, 200);
    await f.context.deliverPendingOtpWebhooks();
    assert.equal(callbacks.length, 7, "A linked order's saved OTPs can be explicitly requeued");
  }
  {
    const f = serverFixture();
    const linked = await f.request(`/api/order-link?api_key=${f.apiKey}`, { method: "POST",
      body: { local_order_id: "a".repeat(24), external_order_id: "partner-order-api" } });
    assert.equal(linked.status, 404, "An unknown local order cannot be linked");
  }
  {
    const f = serverFixture();
    f.fetch = async () => ({ ok: true, status: 200, json: async () => null });
    const result = await f.context.readRotatingDeviceStats();
    assert.equal(f.rotation().databaseUrls.length, 1, "Missing clients must remain in rotation");
    assert.equal(result.removedDatabases.length, 0);
    assert.equal(result.deferredDatabases.length, 1);
    assert.equal(result.databaseCount, 1, "Scan denominator must describe the original snapshot");
    assert.equal(result.remainingDatabaseCount, 1);
    assert.equal((await f.context.readRotationState()).databaseUrls.length, 1);
  }
  {
    const f = serverFixture();
    f.fetch = async () => ({ ok: false, status: 403 });
    await f.context.readRotatingDeviceStats();
    assert.equal(f.rotation().databaseUrls.length, 1, "Permission errors must not remove databases");
  }
  {
    const f = serverFixture();
    const working = "https://working.firebaseio.com";
    const unavailable = "https://later.firebaseio.com";
    f.fetch = async (url) => {
      if (url.startsWith(unavailable)) return { ok: false, status: 503, text: async () => "" };
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const result = await f.request("/api/rotation", {
      method: "PUT", admin: true,
      body: { databaseUrls: [unavailable, working] }
    });
    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);
    assert.deepEqual(body.databaseUrls, [working, unavailable],
      "Unavailable URLs must be retained at the end of rotation");
    assert.equal(body.deferred.length, 1);
    assert.equal(body.removed.length, 0);
  }
  {
    const f = serverFixture();
    const existing = "https://fixture.firebaseio.com";
    const added = "https://new-project.firebaseio.com";
    f.setRotation({ databaseUrls: [existing], serviceUsage: {}, orders: [] });
    const checked = [];
    f.fetch = async (url) => {
      checked.push(url);
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const result = await f.request("/api/rotation", {
      method: "PUT", admin: true, body: { databaseUrls: [existing, added] }
    });
    assert.equal(result.status, 200);
    assert.deepEqual(checked, [`${added}/clients.json?shallow=true`],
      "Adding one rotation URL must ping only the new database, not every existing URL");
  }
  {
    const f = serverFixture();
    const existing = "https://fixture.firebaseio.com";
    f.setRotation({ databaseUrls: [existing], serviceUsage: {}, orders: [] });
    let checks = 0;
    f.fetch = async () => { checks += 1; return { ok: true, status: 200, text: async () => "{}" }; };
    const result = await f.request("/api/rotation", {
      method: "PUT", admin: true, body: { databaseUrls: [existing] }
    });
    assert.equal(result.status, 200);
    assert.equal(checks, 0, "Saving unchanged rotation URLs must not ping Firebase again");
  }
  {
    const f = serverFixture({ env: {
      NUMBER_DATABASE_CONCURRENCY: "2", MAX_CONCURRENT_DATABASE_READS: "1000",
      ROTATION_DATABASE_CHECK_CONCURRENCY: "64"
    } });
    f.setRotation({ databaseUrls: [], serviceUsage: {}, orders: [] });
    let active = 0, peak = 0;
    f.fetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(setImmediate);
      active -= 1;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const urls = Array.from({ length: 100 }, (_, index) => `https://new-${index}.firebaseio.com`);
    const result = await f.request("/api/rotation", {
      method: "PUT", admin: true, body: { databaseUrls: urls }
    });
    assert.equal(result.status, 200);
    assert.equal(peak, 64, "New URLs should validate concurrently beyond the ordinary scan batch size");
    assert.equal(JSON.parse(result.body).databaseUrls.length, 100);
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
  {
    const f = serverFixture();
    const denied = await f.request("/api/stocks");
    assert.equal(denied.status, 401, "Stocks summary must require an admin session");
    const result = await f.request("/api/stocks", { admin: true });
    assert.equal(result.status, 200);
    const summary = JSON.parse(result.body);
    assert.deepEqual(
      [summary.total, summary.online, summary.reserved, summary.offline, summary.needsCheck],
      [0, 0, 0, 0, 0],
      "An empty local stock inventory returns zero counts"
    );
    assert.equal(f.requests.length, 0, "Stocks summary must not fetch from Firebase");
  }
  {
    const f = serverFixture();
    const store = await f.context.getRuntimeStore();
    const original = store.call.bind(store);
    let release;
    store.call = async (method, ...args) => {
      if (method === "databaseStockSummary") await new Promise((resolve) => { release = resolve; });
      return original(method, ...args);
    };
    const summary = await f.request("/api/stocks", { admin: true });
    assert.equal(summary.status, 200, "Global stock totals must not wait for per-database aggregation");
    const details = await f.request("/api/stocks/databases", { admin: true });
    assert.equal(details.status, 200);
    assert.equal(JSON.parse(details.body).refreshing, true);
    await new Promise(setImmediate);
    release();
  }
  console.log("PASS: expiry, missing clients cleanup, permission failures, history limits, out-of-order OTPs, saved-only feed and admin-only local stock summary.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
