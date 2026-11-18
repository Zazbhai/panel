const refreshOrdersButton = document.getElementById("refreshOrdersButton");
const ordersStatus = document.getElementById("ordersStatus");
const orderList = document.getElementById("orderList");
const orderSearch = document.getElementById("orderSearch");
const statusFilter = document.getElementById("orderStatusFilter");
const datePresets = document.getElementById("orderDatePresets");
const customDates = document.getElementById("customOrderDates");
const dateFrom = document.getElementById("orderDateFrom");
const dateTo = document.getElementById("orderDateTo");
const dateError = document.getElementById("orderDateError");
const orderCount = document.getElementById("orderCount");
const showMoreOrders = document.getElementById("showMoreOrders");
const ordersRefreshStatus = document.getElementById("ordersRefreshStatus");
const activeNumberCount = document.getElementById("activeNumberCount");
const orderCards = new Map();
const ORDER_BATCH_SIZE = 6;
const ORDER_REFRESH_INTERVAL = 6000;
const ORDER_REQUEST_TIMEOUT = 30000;
let visibleLimit = ORDER_BATCH_SIZE;
let selectedRange = "all";
let appliedCustomRange = null;
let cardSequence = 0;
let ordersLoading = false;
let requestSequence = 0;
let displayedOrders = [];
let serviceTemplatesPromise = null;
const orderMessageStates = new Map();
const orderMessagePanels = new Map();

async function readJson(url) {
  const response = await window.dashboardApiFetch(url);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The server returned invalid data (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(data && data.error
      ? data.error
      : `Request failed (HTTP ${response.status}).`);
  }
  return data;
}

function formatOrderTime(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === "") return "Not reported";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date);
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

function getMessageEntries(messages) {
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

function getOrderOtpHistory(order) {
  if (Array.isArray(order.receivedOtps)) {
    return order.receivedOtps
      .filter((entry) => entry && typeof entry.code === "string")
      .map((entry) => entry.code);
  }
  return typeof order.receivedOtp === "string" && order.receivedOtp ? [order.receivedOtp] : [];
}

function getSavedOrderMessages(order) {
  if (!Array.isArray(order.messageHistory)) return [];
  return order.messageHistory
    .filter((entry) => entry
      && typeof entry.key === "string"
      && Number.isFinite(entry.timestamp)
      && entry.message
      && typeof entry.message === "object"
      && !Array.isArray(entry.message))
    .map((entry) => [entry.key, entry.message.timestamp === undefined
      ? { ...entry.message, timestamp: entry.timestamp }
      : entry.message]);
}

async function getOrderServiceConfig(order) {
  if (!serviceTemplatesPromise) serviceTemplatesPromise = readJson("/api/services");
  let result;
  try {
    result = await serviceTemplatesPromise;
  } catch (error) {
    serviceTemplatesPromise = null;
    throw error;
  }
  if (!result || !Array.isArray(result.services)) {
    throw new Error("The server returned invalid configured services.");
  }
  const service = result.services.find((item) => item
    && typeof item.name === "string"
    && item.name.trim().toLowerCase() === String(order.service).trim().toLowerCase());
  return service || null;
}

function makeOrderMessageRow(order, [key, message]) {
  const row = document.createElement("article");
  row.className = "message";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const service = document.createElement("span");
  service.className = "service-name";
  service.textContent = order.service;
  const device = document.createElement("span");
  device.textContent = `Device: ${order.deviceId}`;
  const date = getMessageTimestamp(key, message);
  const time = document.createElement("time");
  if (date) {
    time.dateTime = date.toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } else {
    time.textContent = "Unknown time";
  }
  meta.append(service, device);
  if (typeof message.sender === "string" && message.sender) {
    const sender = document.createElement("span");
    sender.textContent = `From: ${message.sender}`;
    meta.append(sender);
  }
  meta.append(time);
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = getMessageText(message) || "No message text";
  row.append(meta, body);
  return row;
}

function makeOrderDetails(order, container) {
  const panel = document.createElement("div");
  panel.className = "order-detail-panel";
  const heading = document.createElement("h3");
  heading.textContent = "Order details";
  const details = document.createElement("dl");
  details.className = "data-grid";
  const fields = [
    ["Order ID", order.orderId],
    ["Service", order.service],
    ["Number", order.number],
    ["Device ID", order.deviceId],
    ["Database", order.databaseUrl],
    ["Created", formatOrderTime(order.createdAt)],
    ["Expires", formatOrderTime(order.expiresAt)],
    ["Status", order.status],
    ["OTP locked", order.locked ? "Yes" : "No"],
    ["Number active", order.numberActive ? "Yes" : "No"],
    ["Latest OTP", order.receivedOtp],
    ["OTP history", getOrderOtpHistory(order).join(", ")]
  ];
  for (const [label, value] of fields) {
    const field = document.createElement("div");
    field.className = "data-field";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
    field.append(term, description);
    details.append(field);
  }
  const messagesHeading = document.createElement("h3");
  messagesHeading.textContent = "Messages for this order";
  const messageStatus = document.createElement("p");
  messageStatus.className = "status order-message-status";
  const messageList = document.createElement("div");
  messageList.className = "message-list";
  panel.append(heading, details, messagesHeading, messageStatus, messageList);
  container.append(panel);
  orderMessagePanels.set(order.orderId, { messageStatus, messageList });
  renderOrderMessages(order);
}

function renderOrderMessages(order) {
  const panel = orderMessagePanels.get(order.orderId);
  if (!panel) return;
  const state = orderMessageStates.get(order.orderId);
  if (!state || state.loading) {
    panel.messageStatus.textContent = state && state.loading
      ? "Loading messages for this order…"
      : "Open the order details to load its messages.";
    panel.messageList.replaceChildren();
    return;
  }
  if (state.error) {
    panel.messageStatus.textContent = `Could not load order messages: ${state.error}`;
    panel.messageStatus.classList.add("error");
    panel.messageList.replaceChildren();
    return;
  }
  panel.messageStatus.classList.remove("error");
  panel.messageStatus.textContent = state.templateMissing
    ? "Service template unavailable; showing messages from this device during the order window."
    : `Found ${state.entries.length} matching message${state.entries.length === 1 ? "" : "s"} for this order.`;
  if (state.entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No matching messages were received during this order.";
    panel.messageList.replaceChildren(empty);
  } else {
    panel.messageList.replaceChildren(...state.entries.map((entry) => makeOrderMessageRow(order, entry)));
  }
}

async function loadOrderMessages(order) {
  const existing = orderMessageStates.get(order.orderId);
  if (existing && existing.loading) return;
  const state = { loading: true, entries: [], error: "", templateMissing: false };
  orderMessageStates.set(order.orderId, state);
  renderOrderMessages(order);
  try {
    const endTime = Math.min(
      Date.now(),
      Number.isFinite(order.expiresAt) ? order.expiresAt : Date.now()
    );
    state.entries = getSavedOrderMessages(order).filter(([key, message]) => {
      const date = getMessageTimestamp(key, message);
      if (!date) return false;
      const timestamp = date.getTime();
      return timestamp >= order.createdAt
        && timestamp <= endTime;
    });
    state.templateMissing = false;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    renderOrderMessages(order);
  }
}

function makeOrderCard(order) {
  const card = document.createElement("article");
  card.className = "order-card";
  card.dataset.orderId = order.orderId;
  const titleId = `order-title-${++cardSequence}`;
  card.setAttribute("aria-labelledby", titleId);
  card.innerHTML = `<div class="order-card-header"><h3 id="${titleId}"></h3><div class="order-state-group"><span class="order-state"></span><span class="order-live-state" hidden>Number active</span></div></div><span class="order-reference"></span><dl class="order-values"><div><dt>Allocated number</dt><dd class="order-number"></dd></div><div><dt>Received OTP</dt><dd class="order-code"></dd></div></dl><div class="order-card-meta"><time></time><span class="order-lock"></span></div><button class="order-details-trigger" type="button" aria-haspopup="dialog">Details &amp; messages<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button><dialog class="order-dialog"></dialog>`;
  const trigger = card.querySelector(".order-details-trigger");
  const dialog = card.querySelector(".order-dialog");
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    orderMessagePanels.delete(order.orderId);
    if (trigger.isConnected) trigger.focus();
  });
  trigger.addEventListener("click", () => {
    const current = displayedOrders.find((item) => item.orderId === order.orderId) || order;
    dialog.showModal();
    loadOrderMessages(current);
  });
  return card;
}

function updateOrderCard(card, order) {
  const statusLabels = {
    active: "Waiting",
    completed: "OTP received",
    cancelled: "Cancelled",
    expired: "Expired"
  };
  const signature = JSON.stringify(order);
  if (card.orderSignature === signature) return;
  card.orderSignature = signature;
  card.dataset.state = Object.hasOwn(statusLabels, order.status) ? order.status : "unknown";
  card.dataset.numberActive = String(order.numberActive === true);
  card.querySelector("h3").textContent = order.service || "Unnamed service";
  card.querySelector(".order-state").textContent = statusLabels[order.status] || "Unknown";
  card.querySelector(".order-live-state").hidden = order.numberActive !== true;
  card.querySelector(".order-reference").textContent = order.orderId;
  card.querySelector(".order-number").textContent = order.number || "Not reported";
  card.querySelector(".order-code").textContent = order.receivedOtp || "—";
  card.querySelector(".order-lock").textContent = order.locked ? "OTP locked" : "Unlocked";
  card.querySelector("time").textContent = formatOrderTime(order.createdAt);
  const date = new Date(order.createdAt);
  if (Number.isFinite(date.getTime())) card.querySelector("time").dateTime = date.toISOString();
  const dialog = card.querySelector(".order-dialog");
  let content = dialog.querySelector(".order-dialog-content");
  if (!content) {
    const form = document.createElement("form");
    form.method = "dialog";
    form.innerHTML = `<div class="order-dialog-header"><h2>Details &amp; messages</h2><button class="quiet icon-button" value="cancel" type="submit" aria-label="Close order details"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="order-dialog-content"></div>`;
    dialog.append(form);
    content = form.querySelector(".order-dialog-content");
  }
  content.replaceChildren();
  makeOrderDetails(order, content);
}

function parseCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function getDateBounds() {
  if (selectedRange === "all") return null;
  if (selectedRange === "custom") return appliedCustomRange;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (selectedRange === "yesterday") { end.setTime(start.getTime()); start.setDate(start.getDate() - 1); }
  if (selectedRange === "week") {
    start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 7);
  }
  if (selectedRange === "month") {
    start.setDate(1);
    end.setFullYear(start.getFullYear(), start.getMonth() + 1, 1);
  }
  return { start: start.getTime(), end: end.getTime() };
}

function makeOrderEmpty(title, text) {
  const empty = document.createElement("div");
  empty.className = "empty order-empty";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = text;
  empty.append(heading, description);
  return empty;
}

function renderOrders(orders, refreshExpandedMessages = false) {
  displayedOrders = orders;
  const bounds = getDateBounds();
  const query = orderSearch.value.trim().toLocaleLowerCase();
  const matches = orders.filter((order) => (!bounds || (Number.isFinite(order.createdAt) && order.createdAt >= bounds.start && order.createdAt < bounds.end))
    && (!statusFilter.value
      || (statusFilter.value === "number-active" ? order.numberActive === true : order.status === statusFilter.value))
    && [order.orderId, order.service, order.number, order.deviceId].join(" ").toLocaleLowerCase().includes(query))
    .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0));
  document.getElementById("totalOrderCount").textContent = matches.length;
  document.getElementById("waitingOrderCount").textContent = matches.filter((order) => order.status === "active").length;
  document.getElementById("completedOrderCount").textContent = matches.filter((order) => order.status === "completed").length;
  activeNumberCount.textContent = new Set(matches.filter((order) => order.numberActive === true).map((order) => order.number)).size;
  const visible = matches.slice(0, visibleLimit);
  const ids = new Set(visible.map((order) => order.orderId));
  for (const [id, card] of orderCards) {
    if (!ids.has(id)) { card.remove(); orderCards.delete(id); orderMessagePanels.delete(id); }
  }
  orderList.querySelectorAll(".empty").forEach((empty) => { if (empty.parentElement === orderList) empty.remove(); });
  for (const [index, order] of visible.entries()) {
    const card = orderCards.get(order.orderId) || makeOrderCard(order);
    updateOrderCard(card, order);
    orderCards.set(order.orderId, card);
    if (orderList.children[index] !== card) orderList.insertBefore(card, orderList.children[index] || null);
    const dialog = card.querySelector(".order-dialog");
    if (!dialog.open) continue;
    if (refreshExpandedMessages || !orderMessageStates.has(order.orderId)) {
      loadOrderMessages(order);
    }
  }
  orderCount.textContent = visible.length < matches.length ? `${visible.length} of ${matches.length} orders` : `${matches.length} order${matches.length === 1 ? "" : "s"}`;
  showMoreOrders.hidden = visible.length >= matches.length;
  showMoreOrders.setAttribute("aria-label", `Show ${Math.min(ORDER_BATCH_SIZE, matches.length - visible.length)} more orders`);
  if (!matches.length) orderList.append(makeOrderEmpty(orders.length ? "No matching orders" : "No orders yet", orders.length ? "Try another date range, status or search." : "Allocated numbers will appear here."));
  const existingIds = new Set(orders.map((order) => order.orderId));
  for (const id of orderMessageStates.keys()) if (!existingIds.has(id)) orderMessageStates.delete(id);
}

function setRefreshStatus(text) {
  if (ordersRefreshStatus) ordersRefreshStatus.textContent = text;
}

function isPageVisible() {
  return document.visibilityState !== "hidden";
}

async function loadRecentOrders() {
  if (ordersLoading) return;
  ordersLoading = true;
  const requestId = ++requestSequence;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), ORDER_REQUEST_TIMEOUT);
  refreshOrdersButton.disabled = true;
  orderList.setAttribute("aria-busy", "true");
  setRefreshStatus("Updating...");
  try {
    const response = await window.dashboardApiFetch(`/api/recent-orders?_=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`The server returned invalid order data (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(result && result.error
        ? result.error
        : `Could not load recent orders (HTTP ${response.status}).`);
    }
    if (!result || !Array.isArray(result.orders)) {
      throw new Error("The server returned an invalid recent orders list.");
    }

    if (requestId !== requestSequence) return;
    renderOrders(result.orders, true);
    ordersStatus.textContent = "";
    ordersStatus.classList.remove("error");
    setRefreshStatus(`Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date())}`);
  } catch (error) {
    if (requestId !== requestSequence) return;
    const message = error && error.name === "AbortError"
      ? "The update timed out. Retrying..."
      : error.message;
    ordersStatus.textContent = `Could not load recent orders: ${message}`;
    ordersStatus.classList.add("error");
    setRefreshStatus("Update failed; retrying");
    if (!displayedOrders.length) orderList.replaceChildren(makeOrderEmpty("Could not load orders", "Use Refresh to try again."));
  } finally {
    window.clearTimeout(timeoutId);
    if (requestId === requestSequence) {
      ordersLoading = false;
      refreshOrdersButton.disabled = false;
      orderList.setAttribute("aria-busy", "false");
    }
  }
}

refreshOrdersButton.addEventListener("click", loadRecentOrders);
function applyOrderFilters() { visibleLimit = ORDER_BATCH_SIZE; renderOrders(displayedOrders); }
orderSearch.addEventListener("input", applyOrderFilters);
statusFilter.addEventListener("change", applyOrderFilters);
function selectRange(range) {
  selectedRange = range;
  datePresets.querySelectorAll("button").forEach((button) => { button.setAttribute("aria-pressed", String(button.dataset.range === range)); });
}
datePresets.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button) return;
  const custom = button.dataset.range === "custom";
  customDates.hidden = !custom;
  datePresets.querySelector('[data-range="custom"]').setAttribute("aria-expanded", String(custom));
  dateError.textContent = "";
  if (custom) { dateFrom.focus(); return; }
  selectRange(button.dataset.range);
  applyOrderFilters();
});
customDates.addEventListener("submit", (event) => {
  event.preventDefault();
  const start = parseCalendarDate(dateFrom.value);
  const end = parseCalendarDate(dateTo.value);
  if (!start || !end || start > end) { dateError.textContent = "Choose an end date on or after the start date."; dateTo.focus(); return; }
  end.setDate(end.getDate() + 1);
  appliedCustomRange = { start: start.getTime(), end: end.getTime() };
  dateError.textContent = "";
  selectRange("custom");
  applyOrderFilters();
});
showMoreOrders.addEventListener("click", () => {
  const count = orderCards.size;
  visibleLimit += ORDER_BATCH_SIZE;
  renderOrders(displayedOrders);
  const card = orderList.children[count];
  if (card) { card.tabIndex = -1; card.focus(); }
});
let refreshTimer = window.setInterval(() => {
  if (isPageVisible()) loadRecentOrders();
}, ORDER_REFRESH_INTERVAL);
window.addEventListener("pagehide", () => { window.clearInterval(refreshTimer); refreshTimer = null; });
window.addEventListener("pageshow", (event) => {
  if (event.persisted && refreshTimer === null) {
    refreshTimer = window.setInterval(() => { if (isPageVisible()) loadRecentOrders(); }, ORDER_REFRESH_INTERVAL);
    loadRecentOrders();
  }
});
document.addEventListener("visibilitychange", () => {
  if (isPageVisible()) loadRecentOrders();
});
window.addEventListener("focus", () => loadRecentOrders());
loadRecentOrders();
