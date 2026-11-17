const refreshButton = document.getElementById("refreshButton");
const messageCount = document.getElementById("messageCount");
const messageList = document.getElementById("messageList");
const serviceFilter = document.getElementById("serviceFilter");
const messageSearch = document.getElementById("messageSearch");
const autoRefresh = document.getElementById("autoRefresh");
const showMoreButton = document.getElementById("showMoreMessages");
const totalMessageCount = document.getElementById("totalMessageCount");
const deviceCount = document.getElementById("activeDeviceCount");
const enabledServiceCount = document.getElementById("enabledServiceCount");
const status = document.getElementById("status");
const messageCards = new Map();
const MESSAGE_BATCH_SIZE = 12;
let matchingMessages = [];
let activeDeviceCount = 0;
let visibleLimit = MESSAGE_BATCH_SIZE;
let cardSequence = 0;
let hasLoaded = false;
let emptyReason = "";
refreshButton.disabled = true;
serviceFilter.disabled = true;

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

function getDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid Firebase Realtime Database URL.");
  }
  const isFirebaseHost = url.hostname.endsWith(".firebaseio.com")
    || url.hostname.endsWith(".firebasedatabase.app");
  if (url.protocol !== "https:" || !isFirebaseHost || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Use an HTTPS Firebase database URL without a port, query, or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function setStatus(message, isError) {
  status.textContent = message;
  status.classList.toggle("error", Boolean(isError));
}

async function getEnabledServices() {
  if (!window.serviceMatching?.getEnabledTemplates || !window.serviceMatching?.matches) {
    throw new Error("Message matching could not start. Reload this page and try again.");
  }
  const result = await readJson("/api/services");
  if (!result || !Array.isArray(result.services)) {
    throw new Error("The server returned invalid configured services.");
  }
  return result.services.filter((service) => service
    && service.enabled === true
    && typeof service.name === "string"
    && window.serviceMatching.getEnabledTemplates(service).length > 0);
}

function getMessageText(message) {
  return [message.message, message.body, message.text, message.msg, message.sms]
    .find((value) => typeof value === "string" && value.length > 0) || "";
}

function getMessageTimestamp(key, message) {
  for (const candidate of [message.timestamp, message.id, key]) {
    const numeric = typeof candidate === "number" ? candidate : /^\d+$/.test(String(candidate)) ? Number(candidate) : NaN;
    if (!Number.isFinite(numeric)) continue;
    const date = new Date(Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof message.dateTime === "string") {
    const parsed = Date.parse(message.dateTime);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return null;
}

function getEntries(messages) {
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) return [];
  return Object.entries(messages)
    .filter(([, message]) => message
      && typeof message === "object"
      && !Array.isArray(message)
      && !/\bjoin[\s\W_]*telegram\b/i.test(getMessageText(message)))
    .sort(([leftKey, left], [rightKey, right]) => {
      const leftTime = getMessageTimestamp(leftKey, left);
      const rightTime = getMessageTimestamp(rightKey, right);
      if (leftTime && rightTime) return rightTime.getTime() - leftTime.getTime();
      if (leftTime) return -1;
      if (rightTime) return 1;
      return String(rightKey).localeCompare(String(leftKey), undefined, { numeric: true });
    });
}

function makeMessageRow(item) {
  const row = document.createElement("article");
  row.className = "message service-message";
  const titleId = `message-service-${++cardSequence}`;
  row.setAttribute("aria-labelledby", titleId);
  row.innerHTML = `<div class="service-message-header"><span class="message-service-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z"/></svg></span><h3 class="service-name" id="${titleId}"></h3><time></time></div><p class="message-body"></p><div class="service-message-footer"><div class="message-origin"><span class="message-device"></span><span class="message-sender"></span></div><button class="copy-message quiet" type="button"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><span>Copy</span></button><span class="copy-feedback" role="status" aria-live="polite"></span></div>`;
  row.querySelector(".copy-message").addEventListener("click", async () => {
    const feedback = row.querySelector(".copy-feedback");
    try {
      await navigator.clipboard.writeText(row.querySelector(".message-body").textContent);
      feedback.textContent = "Copied";
    } catch {
      feedback.textContent = "Select the text to copy.";
    }
    clearTimeout(row.copyFeedbackTimer);
    row.copyFeedbackTimer = setTimeout(() => { feedback.textContent = ""; }, 2500);
  });
  return row;
}

function updateMessageRow(row, item) {
  const signature = JSON.stringify([item.service, item.deviceId, item.date?.getTime(), item.message.sender, getMessageText(item.message)]);
  if (row.messageSignature === signature) return;
  row.messageSignature = signature;
  row.querySelector(".service-name").textContent = item.service;
  row.querySelector(".message-body").textContent = getMessageText(item.message) || "No message text";
  row.querySelector(".message-device").textContent = item.deviceId;
  row.querySelector(".message-device").title = "Device ID";
  const sender = row.querySelector(".message-sender");
  sender.textContent = item.message.sender ? `From ${item.message.sender}` : "";
  sender.hidden = !item.message.sender;
  row.querySelector(".copy-message").setAttribute("aria-label", `Copy ${item.service} message from ${item.deviceId}`);
  const time = row.querySelector("time");
  if (item.date) {
    time.dateTime = item.date.toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(item.date);
  } else {
    time.removeAttribute("datetime");
    time.textContent = "Unknown time";
  }
}

function makeEmpty(title, description, showServicesLink = false) {
  const empty = document.createElement("div");
  empty.className = "empty message-empty";
  empty.innerHTML = '<span class="message-empty-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M3 13h5l2 3h4l2-3h5"/></svg></span><h3></h3><p></p>';
  empty.querySelector("h3").textContent = title;
  empty.querySelector("p").textContent = description;
  if (showServicesLink) {
    const link = document.createElement("a");
    link.href = "/services";
    link.textContent = "Manage services";
    empty.append(link);
  }
  return empty;
}

function updateServiceFilter(services) {
  const selectedService = serviceFilter.value;
  const names = services.map((service) => service.name);
  // Avoid rebuilding a focused select during every background refresh.
  const currentNames = [...serviceFilter.options].slice(1).map((option) => option.value);
  if (JSON.stringify(currentNames) !== JSON.stringify(names)) {
    serviceFilter.replaceChildren(new Option("All enabled services", ""), ...names.map((name) => new Option(name, name)));
  }
  serviceFilter.value = services.some((service) => service.name === selectedService)
    ? selectedService
    : "";
  serviceFilter.disabled = services.length === 0;
}

function renderServiceMessages() {
  const selectedService = serviceFilter.value;
  const query = messageSearch.value.trim().toLocaleLowerCase();
  const matches = matchingMessages.filter((item) => (!selectedService || item.service === selectedService)
    && [item.service, item.deviceId, item.message.sender, getMessageText(item.message)].join(" ").toLocaleLowerCase().includes(query));
  const visible = matches.slice(0, visibleLimit);
  const visibleIds = new Set(visible.map((item) => item.id));
  for (const [id, card] of messageCards) {
    if (!visibleIds.has(id)) { card.remove(); messageCards.delete(id); }
  }
  messageList.querySelectorAll(".empty, .message-skeleton").forEach((element) => element.remove());
  for (const [index, item] of visible.entries()) {
    let row = messageCards.get(item.id);
    if (!row) {
      row = makeMessageRow(item);
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        row.classList.add("is-arriving");
        row.style.setProperty("--arrival-delay", `${Math.min(index, 5) * 35}ms`);
        row.addEventListener("animationend", () => row.classList.remove("is-arriving"), { once: true });
      }
      messageCards.set(item.id, row);
    }
    updateMessageRow(row, item);
    if (messageList.children[index] !== row) messageList.insertBefore(row, messageList.children[index] || null);
  }
  messageCount.textContent = visible.length < matches.length
    ? `${visible.length} of ${matches.length} messages`
    : `${matches.length} message${matches.length === 1 ? "" : "s"}`;
  showMoreButton.hidden = visible.length >= matches.length;
  showMoreButton.setAttribute("aria-label", `Show ${Math.min(MESSAGE_BATCH_SIZE, matches.length - visible.length)} more messages`);
  if (matches.length === 0) {
    if (emptyReason === "no-services") messageList.append(makeEmpty("No enabled templates", "Enable a service and at least one template to see its messages.", true));
    else if (query) messageList.append(makeEmpty("No matching messages", "Try another search or service."));
    else if (emptyReason === "no-devices") messageList.append(makeEmpty("No active devices", "Messages will appear when a device connects."));
    else messageList.append(makeEmpty("No messages yet", selectedService ? `No messages match ${selectedService}.` : "Messages from active devices will appear when they match an enabled template."));
  }
}

async function loadServiceMessages(isBackgroundRefresh = false) {
  if (refreshButton.disabled) return;
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  messageList.setAttribute("aria-busy", "true");
  if (!isBackgroundRefresh) {
    setStatus("Loading messages…", false);
    if (!hasLoaded) {
      messageList.replaceChildren(...Array.from({ length: 4 }, () => {
        const skeleton = document.createElement("div");
        skeleton.className = "message-skeleton";
        skeleton.setAttribute("aria-hidden", "true");
        skeleton.innerHTML = "<span></span><span></span><span></span>";
        return skeleton;
      }));
    }
  }

  try {
    const services = await getEnabledServices();
    updateServiceFilter(services);
    if (services.length === 0) {
      matchingMessages = [];
      activeDeviceCount = 0;
      emptyReason = "no-services";
      totalMessageCount.textContent = "0";
      deviceCount.textContent = "—";
      enabledServiceCount.textContent = "0";
      hasLoaded = true;
      messageSearch.disabled = true;
      renderServiceMessages();
      setStatus("", false);
      return;
    }

    const config = await readJson("/api/config");
    const database = getDatabaseUrl(config?.databaseUrl);
    const clientsQuery = new URLSearchParams({ section: "clients", database });
    const clients = await readJson(`/api/data?${clientsQuery}`);
    if (clients !== null && (typeof clients !== "object" || Array.isArray(clients))) throw new Error("Device status could not be read. Try Refresh.");
    const activeDevices = Object.entries(clients || {})
      .filter(([, client]) => client && typeof client === "object" && client.status === true);
    activeDeviceCount = activeDevices.length;
    const messageResults = await Promise.allSettled(activeDevices.map(async ([deviceId]) => {
      const query = new URLSearchParams({ database, deviceId });
      return { deviceId, messages: await readJson(`/api/device-messages?${query}`) };
    }));

    const matches = [];
    for (const result of messageResults) {
      if (result.status !== "fulfilled") continue;
      const { deviceId, messages } = result.value;
      for (const [key, message] of getEntries(messages)) {
        const text = getMessageText(message);
        for (const service of services) {
          if (!window.serviceMatching.matches(service, text, message)) continue;
          matches.push({
            id: JSON.stringify([database, deviceId, key, service.id || service.name]),
            service: service.name,
            deviceId,
            key,
            date: getMessageTimestamp(key, message),
            message
          });
        }
      }
    }
    matches.sort((left, right) => {
      if (left.date && right.date) return right.date.getTime() - left.date.getTime();
      if (left.date) return -1;
      if (right.date) return 1;
      return String(right.key).localeCompare(String(left.key), undefined, { numeric: true });
    });

    matchingMessages = matches;
    emptyReason = activeDeviceCount ? "" : "no-devices";
    totalMessageCount.textContent = matches.length;
    deviceCount.textContent = activeDeviceCount;
    enabledServiceCount.textContent = services.length;
    hasLoaded = true;
    messageSearch.disabled = false;
    renderServiceMessages();
    const failed = messageResults.filter((result) => result.status === "rejected").length;
    const loadWarning = failed ? `Messages unavailable for ${failed} device${failed === 1 ? "" : "s"}. Try Refresh.` : "";
    if (failed && failed === activeDeviceCount && !matchingMessages.length) {
      messageList.replaceChildren(makeEmpty("Could not load messages", "Use Refresh to try again."));
    }
    setStatus(loadWarning, Boolean(loadWarning));
  } catch (error) {
    if (!hasLoaded) messageList.replaceChildren(makeEmpty("Could not load messages", "Use Refresh to try again."));
    setStatus(error.message, true);
  } finally {
    refreshButton.disabled = false;
    refreshButton.removeAttribute("aria-busy");
    messageList.setAttribute("aria-busy", "false");
  }
}

refreshButton.addEventListener("click", () => loadServiceMessages());
const resetMessageView = () => {
  visibleLimit = MESSAGE_BATCH_SIZE;
  renderServiceMessages();
};
serviceFilter.addEventListener("change", resetMessageView);
messageSearch.addEventListener("input", resetMessageView);
showMoreButton.addEventListener("click", () => {
  const previousCount = messageList.querySelectorAll(".service-message").length;
  visibleLimit += MESSAGE_BATCH_SIZE;
  renderServiceMessages();
  const firstNewCard = messageList.querySelectorAll(".service-message")[previousCount];
  if (firstNewCard) {
    firstNewCard.tabIndex = -1;
    firstNewCard.focus();
  }
});
setInterval(() => {
  if (autoRefresh.checked && !refreshButton.disabled && document.visibilityState === "visible") loadServiceMessages(true);
}, 5000);
refreshButton.disabled = false;
loadServiceMessages();
