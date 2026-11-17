const rotationForm = document.getElementById("rotationForm");
const databaseUrlsInput = document.getElementById("databaseUrls");
const saveRotationButton = document.getElementById("saveRotationButton");
const rotationStatus = document.getElementById("rotationStatus");
let rotationReady = false;
let rotationSaving = false;
let rotationLoading = false;
let rotationDirty = false;
let lastSavedDatabaseUrls = "";

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
    throw new Error(removalDetails.length ? `${error} Removed: ${removalDetails.join("; ")}` : error);
  }
  return result;
}

async function loadRotationSettings(isBackgroundRefresh = false) {
  if (rotationLoading) return;
  if (isBackgroundRefresh
    && (rotationSaving || rotationDirty || document.visibilityState !== "visible")) return;
  rotationLoading = true;
  if (!isBackgroundRefresh) {
    rotationReady = false;
    saveRotationButton.disabled = true;
  }
  try {
    const response = await window.dashboardApiFetch("/api/rotation");
    const result = await readRotationResponse(response);
    const savedUrls = result.databaseUrls.join("\n");
    const changed = savedUrls !== lastSavedDatabaseUrls;
    lastSavedDatabaseUrls = savedUrls;
    if (!rotationDirty) databaseUrlsInput.value = savedUrls;
    rotationReady = true;
    saveRotationButton.disabled = false;
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
  }
}

databaseUrlsInput.addEventListener("input", () => {
  rotationDirty = databaseUrlsInput.value !== lastSavedDatabaseUrls;
  if (rotationDirty) setRotationStatus("Unsaved database rotation changes.", false);
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
  saveRotationButton.disabled = true;
  databaseUrlsInput.disabled = true;
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
    databaseUrlsInput.disabled = false;
    saveRotationButton.disabled = false;
  }
});

loadRotationSettings();
setInterval(() => loadRotationSettings(true), 5000);
