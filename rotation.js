const rotationForm = document.getElementById("rotationForm");
const databaseUrlsInput = document.getElementById("databaseUrls");
const databaseCount = document.getElementById("databaseCount");
const saveRotationButton = document.getElementById("saveRotationButton");
const rotationStatus = document.getElementById("rotationStatus");
const checkDeviceStatsButton = document.getElementById("checkDeviceStatsButton");
const deviceStatsStatus = document.getElementById("deviceStatsStatus");
const totalDevices = document.getElementById("totalDevices");
const activeDevices = document.getElementById("activeDevices");
const offlineDevices = document.getElementById("offlineDevices");
let rotationReady = false;
let rotationSaving = false;
let rotationLoading = false;
let deviceStatsLoading = false;
let deviceStatsPollTimer = null;
let rotationDirty = false;
let lastSavedDatabaseUrls = "";

function updateRotationControls() {
  const busy = rotationLoading || rotationSaving || deviceStatsLoading;
  databaseUrlsInput.disabled = rotationSaving || deviceStatsLoading;
  saveRotationButton.disabled = !rotationReady || busy;
  checkDeviceStatsButton.disabled = !rotationReady || busy || rotationDirty;
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

function renderDeviceStats(result) {
  const counts = [result.deviceCount, result.activeDeviceCount, result.offlineDeviceCount];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)
    || result.activeDeviceCount + result.offlineDeviceCount !== result.deviceCount
    || !Number.isSafeInteger(result.databaseCount) || result.databaseCount < 0
    || !Number.isSafeInteger(result.scannedDatabases) || result.scannedDatabases < 0
    || !Array.isArray(result.failedDatabases)) {
    throw new Error("The server returned invalid device totals.");
  }

  totalDevices.textContent = String(result.deviceCount);
  activeDevices.textContent = String(result.activeDeviceCount);
  offlineDevices.textContent = String(result.offlineDeviceCount);
  const failures = [];
  const removedDatabases = Array.isArray(result.removedDatabases) ? result.removedDatabases : [];
  if (removedDatabases.length) {
    failures.push(`Removed ${removedDatabases.length} missing database${removedDatabases.length === 1 ? "" : "s"} from rotation.`);
  }
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
  const summary = `Scanned ${result.scannedDatabases} of ${result.databaseCount} databases.`;
  deviceStatsStatus.textContent = failures.length
    ? `${summary} Results may be incomplete. ${failures.join(" ")}`
    : result.deviceCount
      ? `${summary} Found ${result.deviceCount} devices.`
      : `${summary} No devices were found in clients.json.`;
  deviceStatsStatus.classList.toggle("error", failures.length > 0);
}

function scheduleDeviceStatsPoll() {
  if (deviceStatsPollTimer !== null) return;
  deviceStatsPollTimer = window.setTimeout(() => {
    deviceStatsPollTimer = null;
    void loadDeviceStatsJob();
  }, 1500);
}

async function loadDeviceStatsJob() {
  try {
    const response = await window.dashboardApiFetch("/api/rotation/device-stats");
    const job = await readRotationResponse(response);
    if (job.status === "running") {
      if (job.previousResult) renderDeviceStats(job.previousResult);
      deviceStatsLoading = true;
      deviceStatsStatus.textContent = "Checking clients.json in the background. You can leave this page.";
      deviceStatsStatus.classList.remove("error");
      updateRotationControls();
      scheduleDeviceStatsPoll();
      return;
    }
    if (job.status === "completed" && job.result) {
      renderDeviceStats(job.result);
      if (job.error) {
        deviceStatsStatus.textContent = `${deviceStatsStatus.textContent} ${job.error}`;
        deviceStatsStatus.classList.add("error");
      }
    } else if (job.status === "failed") {
      throw new Error(job.error || "The device totals scan failed.");
    }
    deviceStatsLoading = false;
    updateRotationControls();
    if (job.status === "completed") void loadRotationSettings(true);
  } catch (error) {
    const wasRunning = deviceStatsLoading;
    deviceStatsLoading = false;
    deviceStatsStatus.textContent = `Could not check combined device totals: ${error.message}`;
    deviceStatsStatus.classList.add("error");
    updateRotationControls();
    if (wasRunning) scheduleDeviceStatsPoll();
  }
}

async function loadRotationSettings(isBackgroundRefresh = false) {
  if (rotationLoading) return;
  if (isBackgroundRefresh
    && (rotationSaving || deviceStatsLoading || rotationDirty || document.visibilityState !== "visible")) return;
  rotationLoading = true;
  if (!isBackgroundRefresh) {
    rotationReady = false;
  }
  updateRotationControls();
  try {
    const response = await window.dashboardApiFetch("/api/rotation");
    const result = await readRotationResponse(response);
    const savedUrls = result.databaseUrls.join("\n");
    databaseCount.textContent = String(result.databaseUrls.length);
    const changed = savedUrls !== lastSavedDatabaseUrls;
    lastSavedDatabaseUrls = savedUrls;
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
    databaseCount.textContent = String(result.databaseUrls.length);
    lastSavedDatabaseUrls = result.databaseUrls.join("\n");
    rotationDirty = false;
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

checkDeviceStatsButton.addEventListener("click", async () => {
  if (!rotationReady || rotationLoading || rotationSaving || rotationDirty || deviceStatsLoading) return;
  deviceStatsLoading = true;
  updateRotationControls();
  deviceStatsStatus.textContent = "Starting background device totals check...";
  deviceStatsStatus.classList.remove("error");
  try {
    const response = await window.dashboardApiFetch("/api/rotation/device-stats", { method: "POST" });
    await readRotationResponse(response);
    await loadDeviceStatsJob();
  } catch (error) {
    deviceStatsStatus.textContent = `Could not check combined device totals: ${error.message}`;
    deviceStatsStatus.classList.add("error");
    deviceStatsLoading = false;
    updateRotationControls();
  } finally {
    if (deviceStatsLoading) scheduleDeviceStatsPoll();
  }
});

void loadRotationSettings().then(() => loadDeviceStatsJob());
setInterval(() => loadRotationSettings(true), 5000);
