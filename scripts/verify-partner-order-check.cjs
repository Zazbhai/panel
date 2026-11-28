"use strict";
const assert = require("node:assert/strict");
const { statusOf, explicitNotFound } = require("./reconcile-partner-orders.cjs");

assert.equal(statusOf({ data: { order: { status: "cancelled" } } }), "cancelled");
assert.equal(statusOf({ result: [{ status: "completed" }, { state: "cancelled" }] }), "cancelled",
  "A cancellation status takes precedence when the response nests status metadata");
assert.equal(statusOf({ data: { status: "active" } }), "active");
assert.equal(statusOf({ data: { state: "processing" } }), "processing");
assert.equal(statusOf({ data: { message: "Order not found" } }), null);
assert.equal(explicitNotFound({ data: { message: "Order not found" } }), true);
assert.equal(explicitNotFound({ status: "not_found" }), false,
  "Absence wording in an ordinary status does not misclassify an order as missing");
console.log("PASS: partner cancellation, completed, active, unknown and not-found response classification.");
