#!/usr/bin/env node
"use strict";

// Verify every local order against the partner. Dry-run by default.
const path = require("node:path");
const dotenv = require("dotenv");
const { RuntimeStore } = require("../runtime-store-core.cjs");

const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
const key = process.env.CANDYSMS_API_KEY || process.env.PARTNER_ORDER_HISTORY_KEY;
const endpoint = process.env.CANDYSMS_ORDER_HISTORY_URL || "https://candysms.website/api/private/order-history";
const sqlitePath = process.env.RUNTIME_SQLITE_PATH || path.join(root, "runtime.sqlite");
const concurrency = Math.min(8, Math.max(1, Number(process.env.PARTNER_ORDER_CHECK_CONCURRENCY) || 4));
const apply = process.argv.includes("--apply");

if (!key) {
  console.error("Set CANDYSMS_API_KEY (or PARTNER_ORDER_HISTORY_KEY) before running.");
  process.exit(2);
}
if (process.argv.some((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg))) {
  console.error("This version checks every local order; date arguments are not accepted.");
  process.exit(2);
}

function walk(value, output = []) {
  if (Array.isArray(value)) for (const item of value) walk(item, output);
  else if (value && typeof value === "object") {
    output.push(value);
    for (const child of Object.values(value)) walk(child, output);
  }
  return output;
}
function statusOf(payload) {
  const statuses = [];
  for (const row of walk(payload)) {
    for (const field of ["status", "state", "order_status", "orderStatus"]) {
      if (typeof row[field] === "string" && row[field].trim()) statuses.push(row[field].trim().toLowerCase());
    }
  }
  return statuses.find((status) => ["cancelled", "canceled"].includes(status))
    || statuses.find((status) => ["completed", "complete", "active", "pending", "waiting", "processing"].includes(status))
    || statuses[0] || null;
}
function explicitNotFound(payload) {
  const texts = walk(payload).flatMap((row) => [row.error, row.message, row.detail])
    .filter((value) => typeof value === "string").join(" ").toLowerCase();
  return /\b(order|record)\b.{0,30}\b(not found|does not exist|not exist)\b|\bnot found\b/.test(texts);
}
async function checkOrder(orderId) {
  const url = new URL(endpoint);
  url.searchParams.set("key", key);
  url.searchParams.set("external_order_id", orderId);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } });
  } catch (error) {
    return { orderId, result: "error", detail: error.name || "request failed" };
  }
  const body = await response.text();
  let payload = null;
  try { payload = JSON.parse(body); } catch { /* non-JSON responses are classified below */ }
  if ((response.status === 404 && (/\b(order|record)\b.{0,30}\b(not found|does not exist|not exist)\b/i.test(body)
    || /^\s*not found\s*$/i.test(body)))
    || (response.ok && payload !== null && explicitNotFound(payload))) {
    return { orderId, result: "not_found" };
  }
  if (!response.ok) return { orderId, result: "error", detail: `HTTP ${response.status}` };
  if (payload === null) return { orderId, result: "error", detail: "invalid JSON" };
  if (Array.isArray(payload) && payload.length === 0) return { orderId, result: "not_found" };
  const status = statusOf(payload);
  if (!status) return { orderId, result: "error", detail: "response has no order status" };
  if (["cancelled", "canceled"].includes(status)) return { orderId, result: "cancelled", status };
  if (["completed", "complete", "active", "pending", "waiting", "processing"].includes(status)) {
    return { orderId, result: "keep", status };
  }
  return { orderId, result: "error", detail: `unrecognized status: ${status}` };
}

async function main() {
  const store = new RuntimeStore(sqlitePath);
  try {
    const orders = store.sql("SELECT id,service,number,status FROM orders ORDER BY created_at,id").all();
    const results = new Array(orders.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, orders.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= orders.length) return;
        results[index] = await checkOrder(orders[index].id);
      }
    }));

    const cancelled = results.filter((result) => result.result === "cancelled");
    const notFound = results.filter((result) => result.result === "not_found");
    const errors = results.filter((result) => result.result === "error");
    console.log(`Local orders: ${orders.length}; partner cancelled: ${cancelled.length}; partner not found: ${notFound.length}; request/parse errors: ${errors.length}; mode: ${apply ? "APPLY CANCELLED ONLY" : "DRY RUN"}`);
    const localById = new Map(orders.map((order) => [order.id, order]));
    let unlocked = 0;
    for (const result of cancelled) {
      const order = localById.get(result.orderId);
      if (!apply) {
        console.log(`DRY RUN ${result.result.toUpperCase()} ${order.id} ${order.service} ${order.number}`);
        continue;
      }
      const unlockedOrder = store.unlockUnreceivedOrder({ orderId: order.id, partnerStatus: result.status });
      if (unlockedOrder.ok) {
        unlocked += 1;
        console.log(`UNLOCKED ${result.result.toUpperCase()} ${order.id} ${order.service} ${order.number}`);
      } else console.log(`SKIPPED ${order.id} ${order.service} ${order.number}: ${unlockedOrder.code}`);
    }
    for (const result of notFound) {
      const order = localById.get(result.orderId);
      console.log(`DRY RUN NOT_FOUND ${order.id} ${order.service} ${order.number}; no unlock applied`);
    }
    for (const result of errors) console.log(`ERROR ${result.orderId}: ${result.detail}`);
    console.log(`${apply ? "Unlocked" : "Would unlock"} cancelled orders: ${apply ? unlocked : cancelled.length}; not-found orders left for review: ${notFound.length}`);
  } finally { store.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { statusOf, explicitNotFound, checkOrder };
