"use strict";

const stockButton = document.getElementById("refreshStock");
const stockStatus = document.getElementById("stockStatus");
const stockCounts = document.getElementById("stockCounts");
const stockSources = document.getElementById("stockSources");
const stockFields = {
  total: "stockTotal", online: "stockOnline", reserved: "stockReserved",
  offline: "stockOffline", needsCheck: "stockNeedsCheck"
};
const stockNumberFormat = new Intl.NumberFormat();
const stockTimeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

async function loadStock() {
  if (stockButton.disabled) return;
  stockButton.disabled = true;
  stockCounts.setAttribute("aria-busy", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await window.dashboardApiFetch("/api/stocks", { signal: controller.signal });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (![...Object.keys(stockFields), "databaseCount", "checkedAt"]
      .every((key) => Number.isSafeInteger(data?.[key]) && data[key] >= 0)) throw new Error();
    const updated = stockTimeFormat.format(data.checkedAt);
    for (const [key, id] of Object.entries(stockFields)) {
      document.getElementById(id).textContent = stockNumberFormat.format(data[key]);
    }
    stockSources.textContent = `${stockNumberFormat.format(data.databaseCount)} configured database${data.databaseCount === 1 ? "" : "s"}`;
    stockStatus.textContent = data.total ? `Updated at ${updated}.` : "No numbers have been saved yet.";
    stockStatus.classList.remove("error");
  } catch {
    stockStatus.textContent = "Could not refresh stock totals. Try again.";
    stockStatus.classList.add("error");
  } finally {
    clearTimeout(timeout);
    stockButton.disabled = false;
    stockCounts.setAttribute("aria-busy", "false");
  }
}

stockButton.addEventListener("click", loadStock);
void loadStock();
