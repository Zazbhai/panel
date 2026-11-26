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
const rotationImportFile = document.getElementById("rotationImportFile");
const rotationImportButton = document.getElementById("rotationImportButton");
const rotationImportStatus = document.getElementById("rotationImportStatus");
const rotationImportErrors = document.getElementById("rotationImportErrors");
const rotationImportErrorRows = document.getElementById("rotationImportErrorRows");
let rotationReady = false;
let rotationSaving = false;
let rotationLoading = false;
let deviceStatsLoading = false;
let deviceStatsPollTimer = null;
let rotationDirty = false;
let lastSavedDatabaseUrls = "";
let rotationImporting = false;

function updateRotationControls() {
  const busy = rotationLoading || rotationSaving || deviceStatsLoading || rotationImporting;
  databaseUrlsInput.disabled = rotationSaving || deviceStatsLoading || rotationImporting;
  saveRotationButton.disabled = !rotationReady || busy;
  checkDeviceStatsButton.disabled = !rotationReady || busy || rotationDirty;
  rotationImportFile.disabled = rotationImporting || rotationSaving || deviceStatsLoading;
  rotationImportButton.disabled = !rotationReady || rotationImporting || rotationSaving
    || deviceStatsLoading || !rotationImportFile.files?.length;
  deviceStatsStatus.toggleAttribute("data-loading", deviceStatsLoading);
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
    failures.push(`Removed ${removedDatabases.length} invalid database${removedDatabases.length === 1 ? "" : "s"} from rotation.`);
  }
  const deferredDatabases = Array.isArray(result.deferredDatabases) ? result.deferredDatabases : [];
  if (deferredDatabases.length) {
    failures.push(`${deferredDatabases.length} database${deferredDatabases.length === 1 ? "" : "s"} deferred to the end and will be retried later.`);
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
    rotationStatus.setAttribute("data-loading", "");
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
    if (!isBackgroundRefresh) rotationStatus.removeAttribute("data-loading");
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
  setRotationStatus("Checking Firebase databases and moving unavailable ones to the end.");
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
    const deferred = Array.isArray(result.deferred) ? result.deferred : [];
    const removalMessage = removed.length
      ? ` Removed ${removed.length}: ${removed.slice(0, 3).map((item) => {
        const url = typeof item.url === "string" ? item.url : "Database URL";
        const displayUrl = url.length > 100 ? `${url.slice(0, 97)}...` : url;
        return `${displayUrl} (${item.reason})`;
      }).join("; ")}${removed.length > 3 ? `; and ${removed.length - 3} more` : ""}.`
      : "";
    const deferredMessage = deferred.length
      ? ` Deferred ${deferred.length} unavailable URL${deferred.length === 1 ? "" : "s"} to the end for retry.`
      : "";
    setRotationStatus(`Saved ${result.databaseUrls.length} database URL${result.databaseUrls.length === 1 ? "" : "s"}.${removalMessage}${deferredMessage}`);
  } catch (error) {
    setRotationStatus(`Could not save database rotation settings: ${error.message}`, true);
  } finally {
    rotationSaving = false;
    updateRotationControls();
  }
});

rotationImportFile.addEventListener("change", () => {
  rotationImportStatus.textContent = rotationImportFile.files?.[0]?.name || "";
  rotationImportStatus.classList.remove("error");
  updateRotationControls();
});

rotationImportButton.addEventListener("click", async () => {
  const file = rotationImportFile.files?.[0];
  if (!file || rotationImporting || !rotationReady) return;
  if (!file.name.toLowerCase().endsWith(".txt") || file.size > 5 * 1024 * 1024) {
    rotationImportStatus.textContent = "Choose a .txt file smaller than 5 MB.";
    rotationImportStatus.classList.add("error");
    return;
  }
  const lines = (await file.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const databaseUrls = [...new Set(lines)];
  const malformed = databaseUrls.filter((line) => !/^https:\/\//i.test(line));
  const candidates = databaseUrls.filter((line) => /^https:\/\//i.test(line));
  if (!candidates.length) {
    rotationImportStatus.textContent = "No HTTPS database URLs were found in the file.";
    rotationImportStatus.classList.add("error");
    return;
  }

  rotationImporting = true;
  rotationImportErrors.hidden = true;
  rotationImportErrorRows.replaceChildren();
  updateRotationControls();
  rotationImportStatus.classList.remove("error");
  const failures = malformed.map((url) => ({ url, reason: "Expected one HTTPS URL per line." }));
  let added = 0;
  let duplicates = 0;
  const batchSize = 1000;
  try {
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      rotationImportStatus.textContent = `Checking ${Math.min(offset + batch.length, candidates.length)} of ${candidates.length} URLs...`;
      const response = await window.dashboardApiFetch("/api/addDatabaseUrls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ databaseUrls: batch })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || `Bulk database check failed (HTTP ${response.status}).`);
      if (!Array.isArray(result.results) || result.results.length !== batch.length) {
        throw new Error("The server returned an incomplete URL check result.");
      }
      for (const item of result.results) {
        if (item.status === "added") added += 1;
        else if (item.status === "duplicate") duplicates += 1;
        else failures.push({ url: item.url, reason: item.reason || "Database check failed." });
      }
    }
    await loadRotationSettings();
    rotationImportStatus.textContent = `Added ${added}; ${duplicates} already in rotation; ${failures.length} invalid or unreachable.`;
    rotationImportStatus.classList.toggle("error", failures.length > 0);
    if (failures.length) {
      const fragment = document.createDocumentFragment();
      for (const failure of failures) {
        const row = document.createElement("tr");
        const url = document.createElement("td");
        url.textContent = failure.url;
        const reason = document.createElement("td");
        reason.textContent = failure.reason;
        row.append(url, reason);
        fragment.append(row);
      }
      rotationImportErrorRows.replaceChildren(fragment);
      rotationImportErrors.hidden = false;
    }
  } catch (error) {
    rotationImportStatus.textContent = `Could not import URL file: ${error.message}`;
    rotationImportStatus.classList.add("error");
  } finally {
    rotationImporting = false;
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
setInterval(() => loadRotationSettings(true), 10000);
