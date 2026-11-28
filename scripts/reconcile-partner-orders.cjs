#!/usr/bin/env node
"use strict";

// Compare local orders with the partner's order history. Dry-run by default;
// pass --apply only after reviewing the planned unlocks.
const path = require("node:path");
const { RuntimeStore } = require("../runtime-store-core.cjs");

const root = path.resolve(__dirname, "..");
const key = process.env.CANDYSMS_API_KEY || process.env.PARTNER_ORDER_HISTORY_KEY;
const endpoint = process.env.CANDYSMS_ORDER_HISTORY_URL || "https://candysms.website/api/private/order-history";
const from = process.env.CANDYSMS_FROM || process.argv[2];
const to = process.env.CANDYSMS_TO || process.argv[3];
const apply = process.argv.includes("--apply");
const sqlitePath = process.env.RUNTIME_SQLITE_PATH || path.join(root, "runtime.sqlite");

if (!key) {
  console.error("Set CANDYSMS_API_KEY (or PARTNER_ORDER_HISTORY_KEY) before running.");
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
  console.error("Usage: CANDYSMS_API_KEY=... node scripts/reconcile-partner-orders.cjs YYYY-MM-DD YYYY-MM-DD [--apply]");
  process.exit(2);
}

function walk(value, output = []) {
  if (Array.isArray(value)) for (const item of value) walk(item, output);
  else if (value && typeof value === "object") {
    output.push(value);
    for (const item of Object.values(value)) walk(item, output);
  }
  return output;
}
function firstString(item, names) {
  for (const name of names) if (typeof item?.[name] === "string" && item[name].trim()) return item[name].trim();
  for (const name of names) if (typeof item?.[name] === "number") return String(item[name]);
  return null;
}
function isReceived(item) {
  for (const name of ["received", "otpReceived", "otp_received", "isReceived", "is_received", "delivered", "isDelivered", "is_delivered"]) {
    if (typeof item?.[name] === "boolean") return item[name];
    if (typeof item?.[name] === "number" && (item[name] === 0 || item[name] === 1)) return item[name] === 1;
    if (typeof item?.[name] === "string") {
      const value = item[name].trim().toLowerCase();
      if (["true", "yes", "1", "received", "delivered", "success"].includes(value)) return true;
      if (["false", "no", "0", "not received", "not_received", "pending", "failed", "undelivered"].includes(value)) return false;
    }
  }
  for (const name of ["otp", "code", "sms", "otpCode", "otp_code"]) {
    if (typeof item?.[name] === "string" && item[name].trim()) return true;
  }
  const status = firstString(item, ["status", "state", "result"]);
  if (!status) return null;
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["received", "delivered", "success", "completed", "otp_received", "status_ok"].includes(normalized)) return true;
  if (["pending", "waiting", "failed", "not_received", "undelivered", "no_otp", "expired", "cancelled"].includes(normalized)) return false;
  return null;
}

async function main() {
  const url = new URL(endpoint);
  url.searchParams.set("key", key);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { accept: "application/json" } });
  const body = await response.text();
  if (!response.ok) throw new Error(`Partner request failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  let payload;
  try { payload = JSON.parse(body); } catch { throw new Error("Partner returned invalid JSON."); }
  const partnerRows = walk(payload);
  const partnerById = new Map();
  let recognizedStatusRows = 0;
  for (const row of partnerRows) {
    const id = firstString(row, ["orderId", "order_id", "activationId", "activation_id", "id"]);
    const received = isReceived(row);
    if (id && received !== null) {
      recognizedStatusRows += 1;
      partnerById.set(id, received);
    }
  }
  if (!recognizedStatusRows) {
    throw new Error("Partner response contains no recognizable order IDs and received statuses. No local data was changed.");
  }
  const store = new RuntimeStore(sqlitePath);
  try {
    const orders = store.sql("SELECT id,service,number,status,received_otp FROM orders WHERE created_at>=? AND created_at<? ORDER BY created_at")
      .all(Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`) + 86400000);
    const candidates = orders.filter((order) => order.status !== "active" && partnerById.has(order.id) && !partnerById.get(order.id));
    const matchedOrders = orders.filter((order) => partnerById.has(order.id));
    const missingIds = orders.filter((order) => !partnerById.has(order.id)).length;
    console.log(`Recognized partner rows: ${partnerById.size}; local orders: ${orders.length}; matched: ${matchedOrders.length}; unmatched local orders: ${missingIds}; unlock candidates: ${candidates.length}; mode: ${apply ? "APPLY" : "DRY RUN"}`);
    let unlocked = 0;
    for (const order of candidates) {
      if (!apply) { console.log(`DRY RUN ${order.id} ${order.service} ${order.number}`); continue; }
      const result = store.unlockUnreceivedOrder({ orderId: order.id });
      if (result.ok) { unlocked += 1; console.log(`UNLOCKED ${order.id} ${order.service} ${order.number}`); }
      else console.log(`SKIPPED ${order.id}: ${result.code}`);
    }
    console.log(`${apply ? "Unlocked" : "Would unlock"}: ${apply ? unlocked : candidates.length}`);
  } finally { store.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
