"use strict";
const assert = require("node:assert/strict");
const { statusOf, explicitNotFound, mapConcurrent } = require("./reconcile-partner-orders.cjs");

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
  console.log("PASS: partner order response classification and bounded parallel worker pool.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
