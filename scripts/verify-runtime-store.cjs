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
    const webhookBatch = core.pendingOtpWebhooks();
    assert.equal(webhookBatch.length, 2, "Newly saved OTPs are durably queued for webhook delivery");
    assert.equal(core.pendingOtpWebhooks().length, 0, "Outbox claims prevent concurrent duplicate sends");
    core.markOtpWebhookAttempt({ orderId: first.orderId, otpKey: webhookBatch[0].otpKey, sent: false });
    core.markOtpWebhookAttempt({ orderId: first.orderId, otpKey: webhookBatch[1].otpKey, sent: false });
    assert.equal(core.pendingOtpWebhooks({ now: Date.now() + 500 }).length, 0,
      "Failed webhooks retry only after their backoff delay");
    const retry = core.pendingOtpWebhooks({ now: Date.now() + 2000 });
    assert.equal(retry.length, 2);
    core.markOtpWebhookAttempt({ orderId: first.orderId, otpKey: retry[0].otpKey, sent: true });
    assert.equal(core.pendingOtpWebhooks({ now: Date.now() + 2000 }).length, 0,
      "Successful webhook rows are removed and the remaining failed row stays in backoff");
    assert.equal(core.latestMessages().orders.length, 2, "Saved OTP feed is backed by individual recent OTP rows");
    assert.equal(core.claim({ service: "flipkart", candidate }), null, "A follow-up OTP must not release another order's lease");
    assert.equal(core.setStatus({ id: second.orderId, status: "8" }), "ACCESS_CANCEL");
    const third = core.claim({ service: "flipkart", candidate, duration: 10000 });
    assert(third);
    assert.equal(core.claim({ service: "swiggy", candidate }), null);
    const expiredAt = Date.now() - 1;
    core.sql("UPDATE leases SET expires_at=? WHERE number=?").run(expiredAt, candidate.number);
    core.sql("UPDATE orders SET expires_at=? WHERE number=? AND status='active'").run(expiredAt, candidate.number);
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
    const stressCandidate = { ...candidate, deviceId: "worker-contention", number: "9000000007" };
    await a.call("remember", stressCandidate);
    const concurrentClaims = await Promise.allSettled(Array.from({ length: 128 }, (_, index) =>
      (index % 2 ? a : b).call("claim", { service: `stress-${index}`, candidate: stressCandidate })
    ));
    assert(concurrentClaims.every((result) => result.status === "fulfilled"),
      "Concurrent claim contention must return a result, never leak SQLite lock errors");
    const stressWinners = concurrentClaims
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
    assert.equal(stressWinners.length, 1,
      "Many simultaneous workers must create exactly one active order for a shared number");
    let stressSnapshot = await a.call("snapshot");
    assert.equal(stressSnapshot.orders.filter((order) =>
      order.number === stressCandidate.number && order.status === "active").length, 1,
    "The durable order table must not contain duplicate active rows for a number");
    const cancellationRace = await Promise.all([
      b.call("setStatus", { id: stressWinners[0].orderId, status: "8" }),
      ...Array.from({ length: 64 }, (_, index) =>
        (index % 2 ? a : b).call("claim", { service: `after-cancel-${index}`, candidate: stressCandidate }))
    ]);
    assert.equal(cancellationRace[0], "ACCESS_CANCEL");
    assert(cancellationRace.slice(1).filter(Boolean).length <= 1,
      "Racing cancellation with new claims must never produce two winners");
    stressSnapshot = await a.call("snapshot");
    assert(stressSnapshot.orders.filter((order) =>
      order.number === stressCandidate.number && order.status === "active").length <= 1,
    "The active-order invariant must hold after cancellation races too");
    const invariantStore = new RuntimeStore(":memory:");
    invariantStore.initialize(state);
    invariantStore.sql("INSERT INTO orders VALUES(?,?,?,?,?,?,?,'active',NULL,NULL,1)")
      .run("first-invariant-order", "first-service", "9000000008", database, "first-device",
        Date.now(), Date.now() + 60000);
    assert.throws(() => {
      invariantStore.sql("INSERT INTO orders VALUES(?,?,?,?,?,?,?,'active',NULL,NULL,1)")
        .run("duplicate-order", "other-service", "9000000008", database, "duplicate-device",
          Date.now(), Date.now() + 60000);
    }, /UNIQUE constraint failed: orders.number/,
    "SQLite must reject a second active order even when a caller bypasses the claim method");
    invariantStore.close();
    const page = await a.call("getRecentOrders", { limit: 1 });
    assert.equal(page.orders.length, 1);
    assert(page.hasMore);
    const next = await a.call("getRecentOrders", { limit: 1, before: page.nextCursor });
    assert.notEqual(next.orders[0].orderId, page.orders[0].orderId);
    const filtered = await a.call("getRecentOrders", { search: "9000000002" });
    assert.equal(filtered.stats.total, 1);
    assert.equal(filtered.orders[0].number, "9000000002");
    const otpStatsStore = new RuntimeStore(":memory:");
    otpStatsStore.initialize(state);
    const otpNumberA = { ...candidate, deviceId: "otp-stats-a", number: "9666666661" };
    const otpNumberB = { ...candidate, deviceId: "otp-stats-b", number: "9666666662" };
    otpStatsStore.rememberBatch([otpNumberA, otpNumberB]);
    const multiOtpOrder = otpStatsStore.claim({ service: "otp-stats", candidate: otpNumberA });
    assert(multiOtpOrder);
    const firstOtpTime = multiOtpOrder.createdAt + 1;
    otpStatsStore.receive({ id: multiOtpOrder.orderId, matches: [
      { key: "otp-a", code: "111111", timestamp: firstOtpTime, message: { text: "Code 111111" } },
      { key: "otp-b", code: "222222", timestamp: firstOtpTime + 1, message: { text: "Code 222222" } }
    ], now: firstOtpTime + 2 });
    const singleOtpOrder = otpStatsStore.claim({ service: "otp-stats", candidate: otpNumberB });
    assert(singleOtpOrder);
    const secondOtpTime = singleOtpOrder.createdAt + 1;
    otpStatsStore.receive({ id: singleOtpOrder.orderId, matches: [
      { key: "otp-c", code: "333333", timestamp: secondOtpTime, message: { text: "Code 333333" } }
    ], now: secondOtpTime + 1 });
    const otpStats = otpStatsStore.getRecentOrders({ status: "completed" }).stats;
    assert.equal(otpStats.completed, 2, "An order with several OTP messages counts once in the OTP order total");
    assert.equal(otpStats.uniqueNumbers, 2, "Unique number totals count distinct allocated numbers");
    assert.equal(otpStatsStore.getOrder(multiOtpOrder.orderId).receivedOtps.length, 2,
      "Each order retains its individual OTP history");
    otpStatsStore.close();
    const unlockStore = new RuntimeStore(":memory:");
    unlockStore.initialize(state);
    const unlockCandidate = { ...candidate, deviceId: "partner-unlock-device", number: "9666666671" };
    unlockStore.remember(unlockCandidate);
    const unlockOrder = unlockStore.claim({ service: "partner-unlock", candidate: unlockCandidate });
    assert(unlockOrder);
    unlockStore.setStatus({ id: unlockOrder.orderId, status: "8" });
    assert.deepEqual(unlockStore.unlockUnreceivedOrder({ orderId: unlockOrder.orderId }), {
      ok: true, code: "UNLOCKED", orderId: unlockOrder.orderId, service: "partner-unlock", number: unlockCandidate.number
    });
    assert.equal(unlockStore.sql("SELECT 1 FROM service_locks WHERE service=? AND number=?")
      .get("partner-unlock", unlockCandidate.number), undefined);
    assert.equal(unlockStore.sql("SELECT 1 FROM service_usage WHERE service=? AND number=?")
      .get("partner-unlock", unlockCandidate.number), undefined);
    const protectedCandidate = { ...candidate, deviceId: "partner-unlock-protected", number: "9666666672" };
    unlockStore.remember(protectedCandidate);
    const protectedOrder = unlockStore.claim({ service: "partner-unlock", candidate: protectedCandidate });
    assert(protectedOrder);
    unlockStore.receive({ id: protectedOrder.orderId, matches: [
      { key: "protected-otp", code: "445566", timestamp: protectedOrder.createdAt + 1, message: { text: "Code 445566" } }
    ], now: protectedOrder.createdAt + 2 });
    assert.equal(unlockStore.unlockUnreceivedOrder({ orderId: protectedOrder.orderId }).code, "UNLOCKED",
      "An explicit partner non-receipt can unlock an order even if the local device received an OTP");
    const duplicateHistoryOrder = unlockStore.claim({ service: "partner-unlock", candidate: unlockCandidate });
    assert(duplicateHistoryOrder);
    unlockStore.setStatus({ id: duplicateHistoryOrder.orderId, status: "8" });
    const previousOtpOrderId = "e".repeat(24);
    unlockStore.sql("INSERT INTO orders VALUES(?,?,?,?,?,?,?,'completed','778899',?,0)")
      .run(previousOtpOrderId, "partner-unlock", unlockCandidate.number, database, "old-device",
        duplicateHistoryOrder.createdAt - 1000, duplicateHistoryOrder.createdAt - 500, duplicateHistoryOrder.createdAt - 900);
    unlockStore.sql("INSERT INTO otps VALUES(?,?,?,?,?)")
      .run(previousOtpOrderId, "old-otp", "778899", duplicateHistoryOrder.createdAt - 900, "old-message");
    assert.equal(unlockStore.unlockUnreceivedOrder({ orderId: duplicateHistoryOrder.orderId }).code, "NUMBER_HAS_OTHER_OTP");
    unlockStore.close();
    const originalSend = a.send.bind(a);
    let orderReads = 0;
    a.send = (method, args) => {
      if (method === "getOrder") orderReads += 1;
      return originalSend(method, args);
    };
    await Promise.all(Array.from({ length: 500 }, () => a.call("getOrder", "missing-order")));
    assert.equal(orderReads, 1, "Concurrent reads for one order should share one SQLite worker request");
    const summaryStore = new RuntimeStore(":memory:");
    summaryStore.initialize(state);
    const summaryNumbers = [
      { ...candidate, deviceId: "summary-online", number: "9111111111" },
      { ...candidate, deviceId: "summary-offline", number: "9222222222", online: false },
      { ...candidate, deviceId: "summary-stale", number: "9333333333" },
      { ...candidate, deviceId: "summary-reserved", number: "9444444444" },
      { ...candidate, deviceId: "summary-duplicate", number: "9111111111", online: false }
    ];
    summaryStore.rememberBatch(summaryNumbers);
    summaryStore.sql("UPDATE numbers SET checked_at=? WHERE number=?").run(Date.now() - 20000, "9333333333");
    const heldNumber = summaryNumbers[3];
    const heldOrder = summaryStore.claim({ service: "stock-test", candidate: heldNumber });
    assert(heldOrder);
    const stock = summaryStore.stockSummary({ onlineTtl: 10000 });
    assert.deepEqual(
      [stock.total, stock.online, stock.reserved, stock.offline, stock.needsCheck, stock.databaseCount],
      [4, 1, 1, 1, 1, 1],
      "Stock totals should deduplicate phone numbers and classify recent, reserved, offline, and stale inventory"
    );
    const snapshotStore = new RuntimeStore(":memory:");
    snapshotStore.initialize(state);
    snapshotStore.rememberBatch([
      { ...candidate, deviceId: "snapshot-online", number: "9555555551", now: Date.now() - 20000 },
      { ...candidate, deviceId: "snapshot-offline", number: "9555555552", now: Date.now() - 20000 }
    ]);
    const snapshotCheckedAt = Date.now();
    snapshotStore.markDatabaseOnline({
      database, onlineDeviceIds: ["snapshot-online"], now: snapshotCheckedAt
    });
    assert.deepEqual(snapshotStore.sql("SELECT device_id,online,checked_at FROM numbers WHERE number LIKE '955555555%' ORDER BY device_id")
      .all().map((row) => [row.device_id, row.online, row.checked_at]), [
      ["snapshot-offline", 0, snapshotCheckedAt], ["snapshot-online", 1, snapshotCheckedAt]
    ], "One clients snapshot must update all saved online states in a single SQLite pass");
    snapshotStore.close();
    summaryStore.close();
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

    const fallbackStore = new RuntimeStore(":memory:");
    fallbackStore.initialize(state);
    const unused = { ...candidate, deviceId: "unused-device", number: "9000000004" };
    const attempted = { ...candidate, deviceId: "attempted-device", number: "9000000005" };
    fallbackStore.remember(unused);
    fallbackStore.remember(attempted);
    const firstAttempt = fallbackStore.claim({ service: "ordered", candidate: attempted });
    assert(firstAttempt);
    assert.equal(fallbackStore.claim({ service: "ordered", candidate: attempted }), null,
      "An attempted no-OTP number must not be returned again in the same cycle");
    assert.equal(fallbackStore.candidates({ service: "ordered", databases: [database] })
      .map((item) => item.number).includes(unused.number), true,
      "Unused online numbers must remain ahead of prior no-OTP attempts");
    fallbackStore.setStatus({ id: firstAttempt.orderId, status: "8" });
    const nextAttempt = fallbackStore.claim({ service: "ordered", candidate: unused });
    assert(nextAttempt);
    fallbackStore.setStatus({ id: nextAttempt.orderId, status: "8" });
    assert.equal(fallbackStore.advanceCycle({ service: "ordered", databases: [database] }), true);
    const freshAfterCycle = { ...candidate, deviceId: "fresh-after-cycle", number: "9000000006" };
    fallbackStore.remember(freshAfterCycle);
    const orderedCandidates = fallbackStore.candidates({ service: "ordered", databases: [database] });
    assert.equal(orderedCandidates.length, 3,
      "Only after all numbers were attempted may no-OTP numbers re-enter as fallbacks");
    assert.equal(orderedCandidates[0].number, freshAfterCycle.number,
      "Fresh numbers must be returned before recycled no-OTP numbers");
    assert.equal(orderedCandidates.slice(1).every((item) => item.reused === true), true,
      "Numbers re-entering after a no-OTP attempt must be marked for an online recheck");
    fallbackStore.close();
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
    f.context.refillNumberPool = async () => null;
    f.runtime.remember(candidate);
    let statusReads = 0;
    f.fetch = async (url) => {
      assert.equal(url, database + "/clients/synthetic-device.json", "Warm allocation may only check the saved device status");
      statusReads++;
      return { ok: true, status: 200, json: async () => ({ status: true }) };
    };
    const before = [...f.readCounts].find(([name]) => name.endsWith("rotation.json"))[1];
    const order = await f.context.findAvailableActiveNumber("jio");
    assert(order);
    assert(statusReads <= 1);
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
