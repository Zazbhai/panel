"use strict";

const stockButton = document.getElementById("refreshStock");
const stockStatus = document.getElementById("stockStatus");
const stockCounts = document.getElementById("stockCounts");
const stockSources = document.getElementById("stockSources");
const mappingPrefetchStatus = document.getElementById("mappingPrefetchStatus");
const priorityStockStatus = document.getElementById("priorityStockStatus");
const stockFields = {
  total: "stockTotal", online: "stockOnline", reserved: "stockReserved",
  offline: "stockOffline", needsCheck: "stockNeedsCheck"
};
const stockNumberFormat = new Intl.NumberFormat();
const stockTimeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
let stockHasTotals = false;

async function loadStock() {
  if (stockButton.disabled) return;
  stockButton.disabled = true;
  // Keep previously loaded numbers visible during the periodic refresh.
  if (!stockHasTotals) stockCounts.setAttribute("aria-busy", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await window.dashboardApiFetch("/api/stocks", { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `Stock request failed (HTTP ${response.status}).`);
    if (![...Object.keys(stockFields), "databaseCount", "checkedAt"]
      .every((key) => Number.isSafeInteger(data?.[key]) && data[key] >= 0)) throw new Error();
    const updated = stockTimeFormat.format(data.checkedAt);
    for (const [key, id] of Object.entries(stockFields)) {
      document.getElementById(id).textContent = stockNumberFormat.format(data[key]);
    }
    stockSources.textContent = `${stockNumberFormat.format(data.databaseCount)} configured database${data.databaseCount === 1 ? "" : "s"}`;
    stockHasTotals = true;
    stockStatus.textContent = data.stale
      ? `Showing totals from ${updated}; refreshing in the background.`
      : data.total ? `Updated at ${updated}.` : "No numbers have been saved yet.";
    const prefetch = data.mappingPrefetch;
    if (prefetch && Number.isSafeInteger(prefetch.total) && Number.isSafeInteger(prefetch.completed)) {
      mappingPrefetchStatus.textContent = prefetch.status === "discovering"
        ? `Discovering mappings: ${stockNumberFormat.format(prefetch.discoveryCompleted || 0)} of ${stockNumberFormat.format(prefetch.discoveryTotal || prefetch.total)} databases scanned; ${stockNumberFormat.format(prefetch.mappings || 0)} mappings saved.`
        : prefetch.status === "running"
        ? `Preparing inventory: ${stockNumberFormat.format(prefetch.completed)} of ${stockNumberFormat.format(prefetch.total)} databases checked; ${stockNumberFormat.format(prefetch.mappings || 0)} number mappings saved; ${stockNumberFormat.format(prefetch.failed || 0)} failed.`
        : prefetch.status === "partial"
          ? `Inventory preparation saved ${stockNumberFormat.format(prefetch.mappings || 0)} number mappings, with ${stockNumberFormat.format(prefetch.failed)} database failures of ${stockNumberFormat.format(prefetch.total)}.`
          : prefetch.status === "complete"
            ? `Inventory preparation complete: ${stockNumberFormat.format(prefetch.completed)} databases checked and ${stockNumberFormat.format(prefetch.mappings || 0)} mappings saved.`
            : prefetch.status === "failed"
              ? "Inventory preparation failed before it completed. Check the server logs."
              : "Inventory preparation has not started.";
    }
    if (priorityStockStatus) {
      const priority = data.priorityStock;
      const entries = Array.isArray(priority?.services) ? priority.services.slice(0, 5) : [];
      priorityStockStatus.textContent = entries.length
        ? entries.map((entry) => {
          const ready = Number.isSafeInteger(entry.ready) ? stockNumberFormat.format(entry.ready) : "Checking";
          const target = Number.isSafeInteger(entry.target) ? stockNumberFormat.format(entry.target) : "—";
          return entry.service + ": " + ready + " / " + target
            + (entry.status === "retrying" ? " · retrying" : "");
        }).join("\n") + (priority.checkedAt ? "\nChecked at " + stockTimeFormat.format(priority.checkedAt) + "." : "")
        : "Waiting for service demand.";
    }
    stockStatus.classList.remove("error");
  } catch (error) {
    const detail = error.name === "AbortError" ? "The stock request timed out."
      : error.message || "The server could not be reached.";
    stockStatus.textContent = stockHasTotals
      ? `Showing previous totals. ${detail} Retrying automatically.`
      : `${detail} Retrying automatically.`;
    stockStatus.classList.add("error");
  } finally {
    clearTimeout(timeout);
    stockButton.disabled = false;
    stockCounts.setAttribute("aria-busy", "false");
  }
}

stockButton.addEventListener("click", loadStock);
void loadStock();
setInterval(() => {
  if (document.visibilityState === "visible") void loadStock();
}, 5000);
