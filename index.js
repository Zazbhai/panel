const dbUrlInput = document.getElementById("dbUrl");
const discoverButton = document.getElementById("discoverButton");
const loadButton = document.getElementById("loadButton");
const recordKeyInput = document.getElementById("recordKey");
const recordLookupButton = document.getElementById("recordLookupButton");
const deviceLookupStatus = document.getElementById("deviceLookupStatus");
const deviceLookupResult = document.getElementById("deviceLookupResult");
const sendSmsForm = document.getElementById("sendSmsForm");
const smsDeviceId = document.getElementById("smsDeviceId");
const smsDestination = document.getElementById("smsDestination");
const smsSim = document.getElementById("smsSim");
const smsBody = document.getElementById("smsBody");
const smsCharacterCount = document.getElementById("smsCharacterCount");
const refreshSmsDevicesButton = document.getElementById("refreshSmsDevicesButton");
const sendSmsButton = document.getElementById("sendSmsButton");
const smsStatus = document.getElementById("smsStatus");
const selectAll = document.getElementById("selectAll");
const sectionPanel = document.getElementById("sectionPanel");
const sectionPicker = document.getElementById("sectionPicker");
const recordTools = document.getElementById("recordTools");
const recordSearch = document.getElementById("recordSearch");
const visibleCount = document.getElementById("visibleCount");
const results = document.getElementById("results");
const status = document.getElementById("status");
discoverButton.disabled = true;
loadButton.disabled = true;
recordLookupButton.disabled = true;
refreshSmsDevicesButton.disabled = true;
let smsDevicesLoading = false;
let smsQueueing = false;
let smsDevicesLoaded = false;

async function readJson(url, options) {
  const response = await window.dashboardApiFetch(url, options);
  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`The database returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const detail = data && data.error ? `: ${data.error}` : "";
    throw new Error(`Request failed (HTTP ${response.status})${detail}`);
  }
  return data;
}

function setStatus(message, isError) {
  status.textContent = message;
  status.classList.toggle("error", Boolean(isError));
}

function getDatabaseUrl() {
  let url;
  try {
    url = new URL(dbUrlInput.value.trim());
  } catch {
    throw new Error("Enter a valid Firebase Realtime Database URL.");
  }

  const isFirebaseHost = url.hostname.endsWith(".firebaseio.com")
    || url.hostname.endsWith(".firebasedatabase.app");
  if (
    url.protocol !== "https:" ||
    !isFirebaseHost ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use an HTTPS Firebase database URL without a port, query, or fragment.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function humanizeLabel(key) {
  const words = String(key)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/);
  const acronyms = { api: "API", id: "ID", ip: "IP", sms: "SMS", url: "URL" };
  return words.map((word) => acronyms[word.toLowerCase()]
    || `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`).join(" ");
}

function formatDate(key, value) {
  if (!/(?:date|time|timestamp|createdat|updatedat|deletedat|_at|_date|_time)$/i.test(key)) {
    return null;
  }

  let milliseconds;
  if (typeof value === "number") {
    milliseconds = Math.abs(value) < 100000000000 ? value * 1000 : value;
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value)) {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }

  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date,
    text: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date)
  };
}

function formatScalar(key, value) {
  const date = formatDate(key, value);
  if (date) return date.text;
  if (typeof value === "number") {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function valueBadge(text, kind) {
  const badge = document.createElement("span");
  badge.className = `value-badge ${kind || ""}`.trim();
  badge.textContent = text;
  return badge;
}

function recordEntries(data) {
  if (data === null || typeof data !== "object") {
    return data === null ? [] : [["value", data]];
  }
  return Object.entries(data);
}

function createFieldGrid(entries, depth) {
  const grid = document.createElement("dl");
  grid.className = "data-grid";
  for (const [key, value] of entries) {
    const field = document.createElement("div");
    field.className = "data-field";

    const label = document.createElement("dt");
    label.textContent = humanizeLabel(key);
    const content = document.createElement("dd");
    content.append(createValue(key, value, depth));

    field.append(label, content);
    grid.append(field);
  }
  return grid;
}

function createRawDetails(value, label) {
  const details = document.createElement("details");
  details.className = "deep-value";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2) ?? "null";
  details.append(summary, pre);
  return details;
}

function createValue(key, value, depth) {
  if (value === null || value === undefined) return valueBadge("Not set", "muted");
  if (typeof value === "boolean") return valueBadge(formatScalar(key, value), value ? "yes" : "no");
  if (typeof value === "number") return document.createTextNode(formatScalar(key, value));
  if (typeof value === "string") {
    const date = formatDate(key, value);
    if (date) {
      const time = document.createElement("time");
      time.dateTime = date.date.toISOString();
      time.textContent = date.text;
      return time;
    }

    const linkUrl = safeLink(value);
    if (linkUrl) {
      const link = document.createElement("a");
      link.href = linkUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = value;
      return link;
    }
    return document.createTextNode(formatScalar(key, value));
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? value.map((item, index) => [`Item ${index + 1}`, item])
    : Object.entries(value);
  if (entries.length === 0) return valueBadge(isArray ? "No items" : "No details", "muted");

  const label = `${entries.length} ${isArray
    ? entries.length === 1 ? "item" : "items"
    : entries.length === 1 ? "field" : "fields"}`;
  if (depth >= 2) return createRawDetails(value, `View ${label}`);

  const details = document.createElement("details");
  details.className = "nested-value";
  const summary = document.createElement("summary");
  summary.textContent = `View ${label}`;
  details.append(summary);

  if (isArray) {
    const list = document.createElement("ol");
    list.className = "array-list";
    for (const [itemLabel, item] of entries) {
      const listItem = document.createElement("li");
      listItem.append(createValue(itemLabel, item, depth + 1));
      list.append(listItem);
    }
    details.append(list);
  } else {
    details.append(createFieldGrid(entries, depth + 1));
  }
  return details;
}

function makeSectionOption(name) {
  const label = document.createElement("label");
  label.className = "section-option";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = name;
  checkbox.className = "section-checkbox";
  checkbox.addEventListener("change", updateSelectAll);

  const text = document.createElement("span");
  text.textContent = humanizeLabel(name);
  label.append(checkbox, text);
  return label;
}

function updateSelectAll() {
  const boxes = Array.from(sectionPicker.querySelectorAll(".section-checkbox"));
  const selectedCount = boxes.filter((box) => box.checked).length;
  selectAll.checked = boxes.length > 0 && selectedCount === boxes.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < boxes.length;
}

function getRecordName(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const preferred = /^(displayName|fullName|name|title|deviceName|label|email)$/i;
  for (const [key, fieldValue] of Object.entries(value)) {
    if (preferred.test(key) && ["string", "number"].includes(typeof fieldValue) && String(fieldValue).trim()) {
      return String(fieldValue);
    }
  }
  return null;
}

function getPreviewFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = Object.entries(value);
  const prioritized = entries.filter(([key, item]) =>
    /^(status|state|type|model|platform|createdAt|timestamp|email|phone|city)$/i.test(key)
      && item !== null
      && ["string", "number", "boolean"].includes(typeof item));
  const remaining = entries.filter(([key, item]) =>
    !prioritized.some(([preferredKey]) => preferredKey === key)
      && item !== null
      && ["string", "number", "boolean"].includes(typeof item));
  return [...prioritized, ...remaining].slice(0, 3);
}

function findPhoneNumbers(value) {
  const phoneFields = /^(?:phone(?:number)?|mobile(?:number)?|mobno|msisdn|contact(?:number|phone)?|number|rawnumber|cleannumber|cleanphone|destination|to|address)$/i;
  const numbers = new Map();

  function visit(item, key) {
    if (item === null || item === undefined) return;
    if (Array.isArray(item)) {
      item.forEach((entry) => visit(entry, key));
      return;
    }
    if (typeof item === "object") {
      for (const [childKey, child] of Object.entries(item)) {
        visit(child, childKey);
      }
      return;
    }
    if (!phoneFields.test(key) || !["string", "number"].includes(typeof item)) return;

    const text = String(item).trim();
    if (!/^[+()\-\s.\d]+$/.test(text)) return;
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15 && !numbers.has(digits)) {
      numbers.set(digits, text);
    }
  }

  visit(value, "");
  return Array.from(numbers.values());
}

function createRecord(sectionName, key, value) {
  const record = document.createElement("details");
  record.className = "record";
  record.dataset.recordKey = JSON.stringify([sectionName, key]);
  record.searchText = `${key} ${JSON.stringify(value)}`.toLocaleLowerCase();
  const entries = recordEntries(value);

  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "record-title";
  title.textContent = getRecordName(value) || `${humanizeLabel(sectionName)} record`;
  const recordId = document.createElement("span");
  recordId.className = "record-meta";
  recordId.textContent = `Record ID: ${key} · ${entries.length} ${entries.length === 1 ? "field" : "fields"} · click to view`;
  summary.append(title, recordId);

  const previewFields = getPreviewFields(value);
  const phoneNumbers = findPhoneNumbers(value);
  if (previewFields.length > 0 || phoneNumbers.length > 0) {
    const preview = document.createElement("span");
    preview.className = "record-preview";
    for (const [fieldKey, fieldValue] of previewFields) {
      const pill = document.createElement("span");
      pill.className = "preview-item";
      const fieldLabel = document.createElement("span");
      fieldLabel.className = "preview-label";
      fieldLabel.textContent = `${humanizeLabel(fieldKey)}:`;
      pill.append(fieldLabel, document.createTextNode(formatScalar(fieldKey, fieldValue)));
      preview.append(pill);
    }
    for (const number of phoneNumbers) {
      const pill = document.createElement("span");
      pill.className = "preview-item";
      const fieldLabel = document.createElement("span");
      fieldLabel.className = "preview-label";
      fieldLabel.textContent = "Phone:";
      const link = document.createElement("a");
      link.href = `tel:${number.replace(/\D/g, "")}`;
      link.textContent = number;
      pill.append(fieldLabel, link);
      preview.append(pill);
    }
    summary.append(preview);
  }

  const content = document.createElement("div");
  content.className = "record-content";
  if (entries.length > 0) {
    content.append(createFieldGrid(entries, 0));
  } else {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "This record has no fields.";
    content.append(empty);
  }

  content.append(createRawDetails(value, "View raw data"));
  record.append(summary, content);
  return record;
}

function createSectionCard(name, data) {
  const card = document.createElement("section");
  card.className = "section-card";
  card.dataset.sectionName = name;

  const heading = document.createElement("div");
  heading.className = "section-heading";
  const title = document.createElement("h2");
  title.textContent = humanizeLabel(name);
  const entries = recordEntries(data);
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = `${entries.length} ${entries.length === 1 ? "record" : "records"}`;
  heading.append(title, count);
  card.append(heading);

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = data === null ? "This section is empty." : "No records to display.";
    card.append(empty);
    return card;
  }

  const list = document.createElement("div");
  list.className = "record-list";
  for (const [key, value] of entries) {
    list.append(createRecord(name, key, value));
  }
  card.append(list);
  return card;
}

function filterRecords() {
  const query = recordSearch.value.trim().toLocaleLowerCase();
  const records = Array.from(results.querySelectorAll(".record"));
  let visible = 0;
  for (const record of records) {
    const matches = !query || record.searchText.includes(query);
    record.hidden = !matches;
    if (matches) visible += 1;
  }

  visibleCount.textContent = query
    ? `Showing ${visible} of ${records.length} records`
    : `${records.length} records loaded`;
}

async function discoverSections() {
  discoverButton.disabled = true;
  loadButton.disabled = true;
  sectionPanel.hidden = true;
  recordTools.hidden = true;
  results.replaceChildren();
  setStatus("Loading available sections…", false);

  try {
    const query = new URLSearchParams({ database: getDatabaseUrl() });
    const data = await readJson(`/api/sections?${query}`);
    if (data === null || typeof data !== "object") {
      throw new Error("The database root is empty or is not a collection of sections.");
    }

    const names = Object.keys(data);
    sectionPicker.replaceChildren(...names.map(makeSectionOption));
    sectionPanel.hidden = names.length === 0;
    selectAll.checked = false;
    selectAll.indeterminate = false;
    setStatus(names.length
      ? `Found ${names.length} top-level sections. Select which ones to load.`
      : "No top-level sections were found.", false);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    discoverButton.disabled = false;
    loadButton.disabled = false;
  }
}

async function loadSelectedSections(isBackgroundRefresh = false) {
  if (loadButton.disabled || (isBackgroundRefresh && document.visibilityState !== "visible")) return;
  const selected = Array.from(sectionPicker.querySelectorAll(".section-checkbox:checked"))
    .map((checkbox) => checkbox.value);
  if (selected.length === 0) {
    if (!isBackgroundRefresh) setStatus("Select at least one section to load.", true);
    return;
  }

  let database;
  try {
    database = getDatabaseUrl();
  } catch (error) {
    setStatus(error.message, true);
    return;
  }

  loadButton.disabled = true;
  const openRecordKeys = isBackgroundRefresh
    ? new Set(Array.from(results.querySelectorAll(".record[open]"), (record) => record.dataset.recordKey))
    : new Set();
  const existingSections = new Map(Array.from(results.children, (section) =>
    [section.dataset.sectionName, section]));
  if (!isBackgroundRefresh) {
    results.replaceChildren();
    recordSearch.value = "";
    recordTools.hidden = true;
    setStatus(`Loading ${selected.length} selected ${selected.length === 1 ? "section" : "sections"}…`, false);
  }

  try {
    const loaded = await Promise.all(selected.map(async (name) => {
      try {
        const query = new URLSearchParams({ section: name, database });
        const data = await readJson(`/api/data?${query}`);
        return { name, data };
      } catch (error) {
        return { name, error };
      }
    }));

    if (isBackgroundRefresh) {
      const currentSelection = Array.from(sectionPicker.querySelectorAll(".section-checkbox:checked"))
        .map((checkbox) => checkbox.value);
      if (currentSelection.join("\0") !== selected.join("\0") || getDatabaseUrl() !== database) return;
    }

    const failures = [];
    const refreshedSections = [];
    for (const section of loaded) {
      if (section.error) {
        failures.push(`${section.name}: ${section.error.message}`);
        if (isBackgroundRefresh && existingSections.has(section.name)) {
          refreshedSections.push(existingSections.get(section.name));
        }
        continue;
      }
      const card = createSectionCard(section.name, section.data);
      if (isBackgroundRefresh) {
        card.querySelectorAll(".record").forEach((record) => {
          record.open = openRecordKeys.has(record.dataset.recordKey);
        });
      }
      refreshedSections.push(card);
    }

    results.replaceChildren(...refreshedSections);
    const recordCount = results.querySelectorAll(".record").length;
    recordTools.hidden = recordCount === 0;
    filterRecords();
    setStatus(failures.length
      ? `${isBackgroundRefresh ? "Live update failed" : `Loaded ${loaded.length - failures.length} section(s). Could not load`}: ${failures.join(" | ")}`
      : isBackgroundRefresh
        ? `Live updates active: ${refreshedSections.length} section(s).`
        : `Loaded ${loaded.length} section(s).`, failures.length > 0);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    loadButton.disabled = false;
  }
}

function setDeviceLookupStatus(message, isError) {
  deviceLookupStatus.textContent = message;
  deviceLookupStatus.classList.toggle("error", Boolean(isError));
}

function setSmsStatus(message, isError) {
  smsStatus.textContent = message;
  smsStatus.classList.toggle("error", Boolean(isError));
}

async function loadSmsDevices(isBackgroundRefresh = false) {
  if (smsDevicesLoading
    || smsQueueing
    || refreshSmsDevicesButton.disabled
    || (isBackgroundRefresh && !smsDevicesLoaded)
    || (isBackgroundRefresh && document.visibilityState !== "visible")) return;
  smsDevicesLoading = true;
  const previousDeviceId = smsDeviceId.value;
  refreshSmsDevicesButton.disabled = true;
  if (!isBackgroundRefresh) {
    sendSmsButton.disabled = true;
    smsDeviceId.replaceChildren(new Option("Loading device IDs…", ""));
    setSmsStatus("Loading sender IDs from Devices…", false);
  }

  try {
    const query = new URLSearchParams({ section: "devices", database: getDatabaseUrl() });
    const devices = await readJson(`/api/data?${query}`);
    if (smsQueueing) return;
    if (!devices || typeof devices !== "object" || Array.isArray(devices)) {
      throw new Error("The Devices section is empty or unavailable.");
    }

    const options = Object.entries(devices)
      .filter(([, device]) => device && typeof device === "object" && !Array.isArray(device))
      .sort(([left], [right]) => left.localeCompare(right));
    if (options.length === 0) {
      throw new Error("No device IDs were found in the Devices section.");
    }

    const placeholder = new Option("Choose a device ID", "");
    const deviceOptions = options.map(([id, device]) => {
      const numbers = findPhoneNumbers(device);
      const label = numbers.length ? `${id} — ${numbers.join(", ")}` : id;
      return new Option(label, id);
    });
    smsDeviceId.replaceChildren(placeholder, ...deviceOptions);
    smsDevicesLoaded = true;
    if (options.some(([id]) => id === previousDeviceId)) {
      smsDeviceId.value = previousDeviceId;
    }
    sendSmsButton.disabled = options.length === 0;
    if (previousDeviceId && !options.some(([id]) => id === previousDeviceId)) {
      setSmsStatus("The selected sender device is no longer available. Choose another device.", true);
    } else if (!isBackgroundRefresh || smsStatus.classList.contains("error")) {
      setSmsStatus(`Loaded ${options.length} sender ID${options.length === 1 ? "" : "s"}.`, false);
    }
  } catch (error) {
    if (!isBackgroundRefresh) {
      smsDeviceId.replaceChildren(new Option("Could not load device IDs", ""));
      sendSmsButton.disabled = true;
    }
    setSmsStatus(error.message, true);
  } finally {
    refreshSmsDevicesButton.disabled = smsQueueing;
    smsDevicesLoading = false;
  }
}

async function queueSms(event) {
  event.preventDefault();
  if (!sendSmsForm.reportValidity()) return;

  const deviceId = smsDeviceId.value;
  const destination = smsDestination.value.trim();
  const message = smsBody.value;
  const sim = Number(smsSim.value);
  const confirmed = await window.dashboardUI.confirm({
    title: "Queue this SMS?",
    description: "The selected device may send a real SMS. Delivery is not confirmed by queueing.",
    fields: [["From device", deviceId], ["Recipient", destination], ["SIM", sim]],
    message,
    confirmLabel: "Queue SMS"
  });
  if (!confirmed) {
    setSmsStatus("SMS not queued.", false);
    return;
  }

  let database;
  try {
    database = getDatabaseUrl();
  } catch (error) {
    setSmsStatus(error.message, true);
    return;
  }

  sendSmsButton.disabled = true;
  smsQueueing = true;
  refreshSmsDevicesButton.disabled = true;
  setSmsStatus("Submitting the SMS task…", false);
  try {
    const result = await readJson("/api/send-sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ database, deviceId, destination, message, sim })
    });
    smsBody.value = "";
    smsCharacterCount.textContent = "0 / 1600 characters";
    setSmsStatus(
      `Queued as ${result.id} under sendSms/${deviceId}. Status: pending. Delivery is not confirmed.`,
      false
    );
  } catch (error) {
    setSmsStatus(`${error.message} Check the Send SMS records before retrying.`, true);
  } finally {
    sendSmsButton.disabled = smsDeviceId.options.length < 2;
    smsQueueing = false;
    refreshSmsDevicesButton.disabled = smsDevicesLoading;
  }
}

async function lookupRecordByKey() {
  const recordKey = recordKeyInput.value.trim();
  if (!recordKey || /[.#$\[\]\/]/.test(recordKey) || new TextEncoder().encode(recordKey).length > 768) {
    setDeviceLookupStatus("Enter a valid Firebase record key.", true);
    return;
  }

  let database;
  try {
    database = getDatabaseUrl();
  } catch (error) {
    setDeviceLookupStatus(error.message, true);
    return;
  }

  recordLookupButton.disabled = true;
  deviceLookupResult.replaceChildren();
  setDeviceLookupStatus("Looking up device…", false);

  try {
    const query = new URLSearchParams({ database, recordKey });
    const device = await readJson(`/api/device-record?${query}`);
    if (device === null) {
      setDeviceLookupStatus(`No Devices record found with key "${recordKey}".`, true);
      return;
    }

    const numbers = findPhoneNumbers(device);
    const record = createRecord("devices", recordKey, device);
    record.open = true;
    deviceLookupResult.append(record);
    setDeviceLookupStatus(numbers.length
      ? `Found the record and ${numbers.length} phone number${numbers.length === 1 ? "" : "s"}.`
      : "Found the record, but no phone-number fields were recognized. Check its details below.", !numbers.length);
  } catch (error) {
    setDeviceLookupStatus(error.message, true);
  } finally {
    recordLookupButton.disabled = false;
  }
}

discoverButton.addEventListener("click", discoverSections);
loadButton.addEventListener("click", () => loadSelectedSections());
recordSearch.addEventListener("input", filterRecords);
recordLookupButton.addEventListener("click", lookupRecordByKey);
refreshSmsDevicesButton.addEventListener("click", () => loadSmsDevices());
sendSmsForm.addEventListener("submit", queueSms);
smsBody.addEventListener("input", () => {
  smsCharacterCount.textContent = `${smsBody.value.length} / 1600 characters`;
});
recordKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") lookupRecordByKey();
});
dbUrlInput.addEventListener("input", () => {
  smsDevicesLoaded = false;
  sectionPicker.replaceChildren();
  sectionPanel.hidden = true;
  results.replaceChildren();
  recordTools.hidden = true;
  deviceLookupResult.replaceChildren();
  setDeviceLookupStatus("Database URL changed. Search again to look up this device there.", false);
  smsDeviceId.replaceChildren(new Option("Reload device IDs", ""));
  sendSmsButton.disabled = true;
  setSmsStatus("Database URL changed. Reload device IDs before queueing an SMS.", false);
  selectAll.checked = false;
  selectAll.indeterminate = false;
  setStatus("Database URL changed. Load available sections for this database.", false);
});
selectAll.addEventListener("change", () => {
  sectionPicker.querySelectorAll(".section-checkbox")
    .forEach((checkbox) => { checkbox.checked = selectAll.checked; });
  selectAll.indeterminate = false;
});

async function connectToServer() {
  try {
    const config = await readJson("/api/config");
    dbUrlInput.value = config.databaseUrl;
    discoverButton.disabled = false;
    loadButton.disabled = false;
    recordLookupButton.disabled = false;
    refreshSmsDevicesButton.disabled = false;
    setStatus("Server connected. Choose which sections to load.", false);
  } catch (error) {
    discoverButton.disabled = true;
    loadButton.disabled = true;
    setStatus(`Cannot connect to the dashboard server: ${error.message}. Start it with npm start.`, true);
  }
}

setStatus("Connecting to the dashboard server…", false);
connectToServer();
setInterval(() => loadSmsDevices(true), 10000);
setInterval(() => {
  if (document.visibilityState === "visible"
    && !sectionPanel.hidden
    && results.children.length > 0) {
    loadSelectedSections(true);
  }
}, 5000);

function safeLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    return null;
  }
  return null;
}
