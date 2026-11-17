const refreshOrdersButton = document.getElementById("refreshOrdersButton");
const ordersStatus = document.getElementById("ordersStatus");
const ordersTableBody = document.getElementById("ordersTableBody");
let ordersLoading = false;
let displayedOrders = [];
let serviceTemplatesPromise = null;
const expandedOrderIds = new Set();
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

function makeOrderCell(value, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value === null || value === undefined || value === ""
    ? "—"
    : String(value);
  return cell;
}

function makeOrderBadge(label, className) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${className}`;
  badge.textContent = label;
  cell.append(badge);
  return cell;
}

function formatOrderTime(timestamp) {
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
    && item.name.trim().toLowerCase() === order.service);
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

function makeOrderDetails(order, detailRow) {
  const cell = document.createElement("td");
  cell.colSpan = 10;
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
    ["Received OTP", order.receivedOtp]
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
  cell.append(panel);
  detailRow.append(cell);
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
    const service = await getOrderServiceConfig(order);
    const query = new URLSearchParams({ database: order.databaseUrl, deviceId: order.deviceId });
    const messages = await readJson(`/api/device-messages?${query}`);
    const endTime = Math.min(
      Date.now(),
      Number.isFinite(order.receivedAt) ? order.receivedAt : order.expiresAt
    );
    state.entries = getMessageEntries(messages).filter(([key, message]) => {
      const date = getMessageTimestamp(key, message);
      if (!date) return false;
      const timestamp = date.getTime();
      return timestamp >= order.createdAt
        && timestamp <= endTime
        && (!service || window.serviceMatching.matches(service, getMessageText(message), message));
    });
    state.templateMissing = !service;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    renderOrderMessages(order);
  }
}

function makeOrderRows(order) {
  const row = document.createElement("tr");
  const detailsRow = document.createElement("tr");
  detailsRow.className = "order-details-row";
  detailsRow.hidden = !expandedOrderIds.has(order.orderId);
  const statusLabels = {
    active: "Waiting",
    completed: "OTP received",
    cancelled: "Cancelled",
    expired: "Expired"
  };
  row.append(
    makeOrderCell(order.orderId, "order-id"),
    makeOrderCell(order.service),
    makeOrderCell(order.number, "number"),
    makeOrderCell(order.deviceId),
    makeOrderCell(order.databaseUrl, "database"),
    makeOrderCell(formatOrderTime(order.createdAt)),
    makeOrderBadge(order.locked ? "Locked" : "Unlocked", order.locked ? "locked" : "unlocked"),
    makeOrderCell(order.receivedOtp, "otp"),
    makeOrderBadge(statusLabels[order.status] || "Unknown", order.status || "")
  );
  const detailsCell = document.createElement("td");
  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.className = "secondary";
  detailsButton.textContent = expandedOrderIds.has(order.orderId) ? "Hide details" : "View messages";
  detailsButton.setAttribute("aria-expanded", String(expandedOrderIds.has(order.orderId)));
  detailsButton.addEventListener("click", () => {
    if (expandedOrderIds.has(order.orderId)) expandedOrderIds.delete(order.orderId);
    else expandedOrderIds.add(order.orderId);
    renderOrders(displayedOrders);
  });
  detailsCell.append(detailsButton);
  row.append(detailsCell);
  makeOrderDetails(order, detailsRow);
  return [row, detailsRow];
}

function renderOrders(orders, refreshExpandedMessages = false) {
  displayedOrders = orders;
  orderMessagePanels.clear();
  const rows = [];
  for (const order of orders) rows.push(...makeOrderRows(order));
  ordersTableBody.replaceChildren(...rows);
  for (const order of orders) {
    if (!expandedOrderIds.has(order.orderId)) continue;
    if (refreshExpandedMessages || !orderMessageStates.has(order.orderId)) {
      loadOrderMessages(order);
    }
  }
}

async function loadRecentOrders() {
  if (ordersLoading) return;
  ordersLoading = true;
  refreshOrdersButton.disabled = true;
  try {
    const response = await window.dashboardApiFetch("/api/recent-orders");
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

    ordersTableBody.replaceChildren();
    if (result.orders.length === 0) {
      displayedOrders = [];
      orderMessagePanels.clear();
      const row = document.createElement("tr");
      const empty = makeOrderCell("No orders have been allocated yet.");
      empty.colSpan = 10;
      empty.className = "empty";
      row.append(empty);
      ordersTableBody.append(row);
    } else {
      renderOrders(result.orders, true);
    }
    ordersStatus.textContent = `Loaded ${result.orders.length} order${result.orders.length === 1 ? "" : "s"}.`;
    ordersStatus.classList.remove("error");
  } catch (error) {
    ordersStatus.textContent = `Could not load recent orders: ${error.message}`;
    ordersStatus.classList.add("error");
  } finally {
    ordersLoading = false;
    refreshOrdersButton.disabled = false;
  }
}

refreshOrdersButton.addEventListener("click", loadRecentOrders);
setInterval(() => {
  if (document.visibilityState === "visible") loadRecentOrders();
}, 5000);
loadRecentOrders();
