const rotationForm = document.getElementById("rotationForm");
const databaseUrlsInput = document.getElementById("databaseUrls");
const saveRotationButton = document.getElementById("saveRotationButton");
const rotationStatus = document.getElementById("rotationStatus");
const checkNumberStatsButton = document.getElementById("checkNumberStatsButton");
const numberStatsStatus = document.getElementById("numberStatsStatus");
const totalNumbers = document.getElementById("totalNumbers");
const activeNumbers = document.getElementById("activeNumbers");
const offlineNumbers = document.getElementById("offlineNumbers");
let rotationReady = false;
let rotationSaving = false;
let rotationLoading = false;
let numberStatsLoading = false;
let rotationDirty = false;
let lastSavedDatabaseUrls = "";

function updateRotationControls() {
  const busy = rotationLoading || rotationSaving || numberStatsLoading;
  databaseUrlsInput.disabled = rotationSaving || numberStatsLoading;
  saveRotationButton.disabled = !rotationReady || busy;
  checkNumberStatsButton.disabled = !rotationReady || busy || rotationDirty;
}

function clearNumberStats() {
  totalNumbers.textContent = "—";
  activeNumbers.textContent = "—";
  offlineNumbers.textContent = "—";
  numberStatsStatus.textContent = "";
  numberStatsStatus.classList.remove("error");
}

function setRotationStatus(message, isError = false) {
  rotationStatus.textContent = message;
  rotationStatus.classList.toggle("error", Boolean(isError));
}

async function readRotationResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`The server returned invalid rotation data (HTTP ${response.status}).`);
  }
  const removed = Array.isArray(result && result.removed) ? result.removed : [];
  const removalDetails = removed.slice(0, 3).map((item) => {
    const url = typeof item.url === "string" ? item.url : "Database URL";
    const displayUrl = url.length > 100 ? `${url.slice(0, 97)}...` : url;
    return `${displayUrl}: ${item.reason}`;
  });
  if (removed.length > 3) removalDetails.push(`and ${removed.length - 3} more`);
  if (!response.ok) {
    const error = result && result.error
      ? result.error
      : `Database rotation request failed (HTTP ${response.status}).`;
    const failedDatabases = Array.isArray(result && result.failedDatabases)
      ? result.failedDatabases
      : [];
    const failureDetails = failedDatabases.slice(0, 3).map((item) => {
      const url = typeof item.url === "string" ? item.url : "Database URL";
      const displayUrl = url.length > 80 ? `${url.slice(0, 77)}...` : url;
      return `${displayUrl}: ${item.reason}`;
    });
    if (failedDatabases.length > 3) failureDetails.push(`and ${failedDatabases.length - 3} more`);
    const details = [
      removalDetails.length ? `Removed: ${removalDetails.join("; ")}` : "",
      failureDetails.length ? `Database errors: ${failureDetails.join("; ")}` : ""
    ].filter(Boolean);
    throw new Error(details.length ? `${error} ${details.join(" ")}` : error);
  }
  return result;
}

async function loadRotationSettings(isBackgroundRefresh = false) {
  if (rotationLoading) return;
  if (isBackgroundRefresh
    && (rotationSaving || numberStatsLoading || rotationDirty || document.visibilityState !== "visible")) return;
  rotationLoading = true;
  if (!isBackgroundRefresh) {
    rotationReady = false;
  }
  updateRotationControls();
  try {
    const response = await window.dashboardApiFetch("/api/rotation");
    const result = await readRotationResponse(response);
    const savedUrls = result.databaseUrls.join("\n");
    const changed = savedUrls !== lastSavedDatabaseUrls;
    lastSavedDatabaseUrls = savedUrls;
    if (changed) clearNumberStats();
    if (!rotationDirty) databaseUrlsInput.value = savedUrls;
    rotationReady = true;
    if (!isBackgroundRefresh) {
      setRotationStatus(result.initialized
        ? "Database rotation settings loaded."
        : "Loaded the current dashboard database. Add more URLs if needed, then save.");
    } else if (changed) {
      setRotationStatus("Database rotation settings updated from the server.");
    } else if (rotationStatus.classList.contains("error")) {
      setRotationStatus("Database rotation settings are synced with the server.");
    }
  } catch (error) {
    setRotationStatus(`Could not load database rotation settings: ${error.message}`, true);
  } finally {
    rotationLoading = false;
    updateRotationControls();
  }
}

databaseUrlsInput.addEventListener("input", () => {
  rotationDirty = databaseUrlsInput.value !== lastSavedDatabaseUrls;
  if (rotationDirty) setRotationStatus("Unsaved database rotation changes.", false);
  updateRotationControls();
});

rotationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!rotationReady || rotationLoading || rotationSaving) {
    setRotationStatus("Database URLs are still loading. Try again shortly.", true);
    return;
  }

  const databaseUrls = databaseUrlsInput.value
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean);
  rotationSaving = true;
  updateRotationControls();
  setRotationStatus("Checking Firebase databases and removing duplicates.");
  try {
    const response = await window.dashboardApiFetch("/api/rotation", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ databaseUrls })
    });
    const result = await readRotationResponse(response);
    databaseUrlsInput.value = result.databaseUrls.join("\n");
    lastSavedDatabaseUrls = result.databaseUrls.join("\n");
    rotationDirty = false;
    clearNumberStats();
    const removed = Array.isArray(result.removed) ? result.removed : [];
    const removalMessage = removed.length
      ? ` Removed ${removed.length}: ${removed.slice(0, 3).map((item) => {
        const url = typeof item.url === "string" ? item.url : "Database URL";
        const displayUrl = url.length > 100 ? `${url.slice(0, 97)}...` : url;
        return `${displayUrl} (${item.reason})`;
      }).join("; ")}${removed.length > 3 ? `; and ${removed.length - 3} more` : ""}.`
      : "";
    setRotationStatus(`Saved ${result.databaseUrls.length} working database URL${result.databaseUrls.length === 1 ? "" : "s"}.${removalMessage}`);
  } catch (error) {
    setRotationStatus(`Could not save database rotation settings: ${error.message}`, true);
  } finally {
    rotationSaving = false;
    updateRotationControls();
  }
});

checkNumberStatsButton.addEventListener("click", async () => {
  if (!rotationReady || rotationLoading || rotationSaving || rotationDirty || numberStatsLoading) return;
  numberStatsLoading = true;
  updateRotationControls();
  clearNumberStats();
  numberStatsStatus.textContent = "Scanning saved databases and client messages. This may take a while.";
  try {
    const response = await window.dashboardApiFetch("/api/rotation/number-stats");
    const result = await readRotationResponse(response);
    const counts = [result.totalNumbers, result.activeNumbers, result.offlineNumbers];
    if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)
      || result.activeNumbers + result.offlineNumbers !== result.totalNumbers
      || !Number.isSafeInteger(result.databaseCount)
      || !Number.isSafeInteger(result.scannedDatabases)
      || !Number.isSafeInteger(result.clientCount)
      || !Number.isSafeInteger(result.messageReadFailures)
      || !Array.isArray(result.messageFailuresByDatabase)
      || !Array.isArray(result.failedDatabases)) {
      throw new Error("The server returned invalid number totals.");
    }

    totalNumbers.textContent = String(result.totalNumbers);
    activeNumbers.textContent = String(result.activeNumbers);
    offlineNumbers.textContent = String(result.offlineNumbers);
    const failures = [];
    if (result.failedDatabases.length) {
      const databaseDetails = result.failedDatabases.slice(0, 3).map((item) => {
        const url = typeof item.url === "string" ? item.url : "Database URL";
        const displayUrl = url.length > 80 ? `${url.slice(0, 77)}...` : url;
        return `${displayUrl}: ${item.reason}`;
      });
      if (result.failedDatabases.length > 3) {
        databaseDetails.push(`and ${result.failedDatabases.length - 3} more`);
      }
      failures.push(`Database errors: ${databaseDetails.join("; ")}.`);
    }
    if (result.messageReadFailures) {
      const messageDetails = result.messageFailuresByDatabase.slice(0, 3).map((item) => {
        const url = typeof item.url === "string" ? item.url : "Database URL";
        const displayUrl = url.length > 80 ? `${url.slice(0, 77)}...` : url;
        return `${displayUrl} (${item.failures})`;
      });
      if (result.messageFailuresByDatabase.length > 3) {
        messageDetails.push(`and ${result.messageFailuresByDatabase.length - 3} more`);
      }
      failures.push(`${result.messageReadFailures} client message read${result.messageReadFailures === 1 ? "" : "s"} failed${messageDetails.length ? ` across ${messageDetails.join("; ")}` : ""}.`);
    }
    const summary = `Scanned ${result.scannedDatabases} of ${result.databaseCount} databases and ${result.clientCount} clients.`;
    numberStatsStatus.textContent = failures.length
      ? `${summary} Results may be incomplete. ${failures.join(" ")}`
      : result.totalNumbers
        ? summary
        : `${summary} No phone numbers could be inferred from client messages.`;
    numberStatsStatus.classList.toggle("error", failures.length > 0);
  } catch (error) {
    clearNumberStats();
    numberStatsStatus.textContent = `Could not check combined number totals: ${error.message}`;
    numberStatsStatus.classList.add("error");
  } finally {
    numberStatsLoading = false;
    updateRotationControls();
  }
});

loadRotationSettings();
setInterval(() => loadRotationSettings(true), 5000);
