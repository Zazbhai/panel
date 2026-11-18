const assert = require("node:assert/strict");
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
