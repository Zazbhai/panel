const { createServer } = require("node:http");
const {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { matchServiceMessage } = require("./service-matching-core");
const path = require("node:path");

const envFileResult = require("dotenv").config({ path: path.join(__dirname, ".env") });
if (envFileResult.error && envFileResult.error.code !== "ENOENT") {
  throw envFileResult.error;
}

const defaultDatabaseUrl = "https://satanoopfirebase-47068-default-rtdb.firebaseio.com";
const rawDatabaseUrl = process.env.FIREBASE_DATABASE_URL || defaultDatabaseUrl;
const port = Number(process.env.PORT || 3000);
const dashboardPath = path.join(__dirname, "index.html");
const clientScriptPath = path.join(__dirname, "index.js");
const activeDevicesPath = path.join(__dirname, "active-devices.html");
const activeDevicesScriptPath = path.join(__dirname, "active-devices.js");
const servicesPath = path.join(__dirname, "services.html");
const servicesScriptPath = path.join(__dirname, "services.js");
const rotationPath = path.join(__dirname, "rotation.html");
const rotationScriptPath = path.join(__dirname, "rotation.js");
const serviceMessagesPath = path.join(__dirname, "service-messages.html");
const serviceMessagesScriptPath = path.join(__dirname, "service-messages.js");
const serviceMatchingScriptPath = path.join(__dirname, "service-matching.js");
const recentOrdersPath = path.join(__dirname, "recent-orders.html");
const recentOrdersScriptPath = path.join(__dirname, "recent-orders.js");
const servicesDataPath = path.join(__dirname, "services.json");
const rotationDataPath = path.join(__dirname, "rotation.json");
const maximumRotationRequestBytes = 1024 * 1024;
const databasePingConcurrency = 8;
const apiDocsPath = path.join(__dirname, "api-docs.html");
const apiClientScriptPath = path.join(__dirname, "api-client.js");
const dashboardApiKey = process.env.DASHBOARD_API_KEY;
const dashboardAdminKey = process.env.DASHBOARD_ADMIN_KEY;
const adminSessionCookieName = "dashboard_admin_session";
const adminSessionDurationSeconds = 30 * 24 * 60 * 60;
const loginAttemptWindowMs = 15 * 60 * 1000;
const maximumLoginAttempts = 10;
const numberReservationDurationMs = 10 * 60 * 1000;
const reservedNumbers = new Map();
const orderExpirationTimers = new Map();
const recentOrderOtpChecks = new Map();
const recentOrderOtpScanIntervalMs = 4000;
const failedLoginAttempts = new Map();
let rotationOperation = Promise.resolve();
let recentOrderOtpScanPromise = null;

if (typeof dashboardApiKey !== "string" || dashboardApiKey.length < 32 || /\s/.test(dashboardApiKey)) {
  throw new Error("Set DASHBOARD_API_KEY to a secret of at least 32 non-whitespace characters.");
}
if (typeof dashboardAdminKey !== "string" || dashboardAdminKey.length < 32 || /\s/.test(dashboardAdminKey)) {
  throw new Error(`Set DASHBOARD_ADMIN_KEY to a separate private secret of at least 32 non-whitespace characters. Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))".`);
}

function normalizeDatabaseUrl(value) {
  const parsedUrl = new URL(value);
  const isFirebaseHost = parsedUrl.hostname.endsWith(".firebaseio.com")
    || parsedUrl.hostname.endsWith(".firebasedatabase.app");
  if (
    parsedUrl.protocol !== "https:" ||
    !isFirebaseHost ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.port ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error("Use an HTTPS Firebase database URL without a port, query, or fragment.");
  }
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
  return parsedUrl.toString().replace(/\/$/, "");
}

let databaseUrl;
try {
  databaseUrl = normalizeDatabaseUrl(rawDatabaseUrl);
} catch (error) {
  throw new Error(`Invalid FIREBASE_DATABASE_URL: ${error.message}`);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

function sendJson(response, statusCode, data, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(data));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(text);
}

function hasValidApiKey(requestUrl) {
  const providedKeys = requestUrl.searchParams.getAll("api_key");
  if (providedKeys.length !== 1) return false;
  const providedKey = providedKeys[0];
  const providedBuffer = Buffer.from(providedKey);
  const expectedBuffer = Buffer.from(dashboardApiKey);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

function isSameOriginRequest(request) {
  if (!request.headers.origin || !request.headers.host) return false;
  try {
    const origin = new URL(request.headers.origin);
    return ["http:", "https:"].includes(origin.protocol)
      && origin.host.toLowerCase() === request.headers.host.toLowerCase();
  } catch {
    return false;
  }
}

function getAdminSessionCookie(request) {
  const cookies = (request.headers.cookie || "").split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(`${adminSessionCookieName}=`));
  if (cookies.length !== 1) return null;
  return cookies[0].slice(adminSessionCookieName.length + 1);
}

function hasValidAdminSession(request) {
  const token = getAdminSessionCookie(request);
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0])
    || !/^[A-Za-z0-9_-]{40,50}$/.test(parts[1])
    || !/^[A-Za-z0-9_-]{40,50}$/.test(parts[2])) return false;

  const expiresAt = Number(parts[0]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now
    || expiresAt > now + adminSessionDurationSeconds) return false;

  const payload = `${parts[0]}.${parts[1]}`;
  const expectedSignature = createHmac("sha256", dashboardAdminKey)
    .update(payload)
    .digest();
  const providedSignature = Buffer.from(parts[2], "base64url");
  return providedSignature.length === expectedSignature.length
    && timingSafeEqual(providedSignature, expectedSignature);
}

function createAdminSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + adminSessionDurationSeconds;
  const payload = `${expiresAt}.${randomBytes(32).toString("base64url")}`;
  const signature = createHmac("sha256", dashboardAdminKey)
    .update(payload)
    .digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt };
}

function adminSessionCookie(request, value, expiresAt, maxAge) {
  const secure = request.socket.encrypted ? "; Secure" : "";
  const expires = expiresAt ? new Date(expiresAt * 1000).toUTCString() : "Thu, 01 Jan 1970 00:00:00 GMT";
  return `${adminSessionCookieName}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}; Expires=${expires}${secure}`;
}

function isLoginRateLimited(request) {
  const address = request.socket.remoteAddress || "unknown";
  const attempt = failedLoginAttempts.get(address);
  if (!attempt || attempt.resetAt <= Date.now()) {
    failedLoginAttempts.delete(address);
    return false;
  }
  return attempt.count >= maximumLoginAttempts;
}

function recordFailedLogin(request) {
  const address = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const previous = failedLoginAttempts.get(address);
  const attempt = !previous || previous.resetAt <= now
    ? { count: 1, resetAt: now + loginAttemptWindowMs }
    : { ...previous, count: previous.count + 1 };
  failedLoginAttempts.set(address, attempt);
}

function clearFailedLogins(request) {
  failedLoginAttempts.delete(request.socket.remoteAddress || "unknown");
}

function hasValidAdminKey(value) {
  const providedDigest = createHash("sha256").update(value).digest();
  const expectedDigest = createHash("sha256").update(dashboardAdminKey).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
async function readJsonBody(request, maximumBytes) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("Send the request as JSON.");
    error.statusCode = 415;
    throw error;
  }

  const chunks = [];
  let byteLength = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > maximumBytes) {
      tooLarge = true;
    } else {
      chunks.push(chunk);
    }
  }
  if (tooLarge) {
    const error = new Error("The request body is too large.");
    error.statusCode = 413;
    throw error;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Send a valid JSON request body.");
    error.statusCode = 400;
    throw error;
  }
}

function normalizeConfiguredServices(services) {
  if (!Array.isArray(services)) return services;
  return services.map((service) => {
    if (!service || typeof service !== "object" || Array.isArray(service)) return service;
    const { template: legacyTemplate, ...rest } = service;
    const templates = Array.isArray(service.templates)
      ? service.templates
      : typeof legacyTemplate === "string"
        ? [{ text: legacyTemplate, enabled: true }]
        : service.templates;
    return {
      ...rest,
      templates,
      minOtpLength: service.minOtpLength === undefined ? 4 : service.minOtpLength,
      maxOtpLength: service.maxOtpLength === undefined ? 8 : service.maxOtpLength,
      senderFilter: service.senderFilter === undefined ? "" : service.senderFilter
    };
  });
}

function validateServiceList(services) {
  if (!Array.isArray(services)) return "Provide services as an array.";
  const names = new Set();
  for (const service of services) {
    if (!service || typeof service !== "object" || Array.isArray(service)
      || typeof service.id !== "string" || !service.id.trim() || service.id.length > 100
      || typeof service.name !== "string" || !service.name.trim() || service.name.length > 60
      || !Array.isArray(service.templates) || service.templates.length === 0
      || !Number.isInteger(service.minOtpLength) || service.minOtpLength < 1 || service.minOtpLength > 32
      || !Number.isInteger(service.maxOtpLength) || service.maxOtpLength < service.minOtpLength || service.maxOtpLength > 32
      || typeof service.senderFilter !== "string" || service.senderFilter.length > 100
      || typeof service.enabled !== "boolean") {
      return "Each service needs a name, enabled state, templates, OTP length range, and valid sender filter.";
    }
    if (service.templates.some((template) => !template
      || typeof template !== "object" || Array.isArray(template)
      || typeof template.text !== "string" || !template.text.trim()
      || template.text.length > 5000 || !template.text.includes("{{OTP}}")
      || typeof template.enabled !== "boolean")) {
      return "Each template needs message text, an OTP placeholder, and an enabled state.";
    }
    const name = service.name.trim().toLowerCase();
    if (names.has(name)) return "Service names must be unique.";
    names.add(name);
  }
  return null;
}

async function readConfiguredServices() {
  let contents;
  try {
    contents = await readFile(servicesDataPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { initialized: false, services: [] };
    throw error;
  }

  let services;
  try {
    services = normalizeConfiguredServices(JSON.parse(contents));
  } catch {
    throw new Error("The configured services file contains invalid JSON.");
  }
  const validationError = validateServiceList(services);
  if (validationError) throw new Error(validationError);
  return { initialized: true, services };
}

async function saveConfiguredServices(services) {
  await writeFile(servicesDataPath, JSON.stringify(services, null, 2), "utf8");
}

function normalizeRotatingDatabaseUrls(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Provide at least one database URL.");
  }
  const urls = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== "string" || !values[index].trim() || values[index].trim().length > 2048) {
      throw new Error(`Database URL ${index + 1} is empty or invalid.`);
    }
    let normalized;
    try {
      normalized = normalizeDatabaseUrl(values[index].trim());
    } catch (error) {
      throw new Error(`Database URL ${index + 1} is invalid: ${error.message}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

async function validateAndPingRotatingDatabases(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Provide at least one database URL.");
  }
  const databaseUrls = [];
  const seen = new Set();
  const removed = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const label = typeof value === "string" ? value.trim() : "";
    if (!label || label.length > 2048) {
      removed.push({ url: label || `Line ${index + 1}`, reason: "invalid URL" });
      continue;
    }
    let normalized;
    try {
      normalized = normalizeDatabaseUrl(label);
    } catch (error) {
      removed.push({ url: label, reason: error.message });
      continue;
    }
    if (seen.has(normalized)) {
      removed.push({ url: label, reason: "duplicate URL" });
      continue;
    }
    seen.add(normalized);
    databaseUrls.push(normalized);
  }

  const checks = [];
  for (let index = 0; index < databaseUrls.length; index += databasePingConcurrency) {
    const batch = databaseUrls.slice(index, index + databasePingConcurrency);
    const batchChecks = await Promise.all(batch.map(async (url) => {
      try {
        const response = await fetch(`${url}/clients.json?shallow=true`, {
          signal: AbortSignal.timeout(6000)
        });
        if (!response.ok) {
          return { url, reason: `Firebase returned HTTP ${response.status}` };
        }
        try {
          await response.json();
        } catch {
          return { url, reason: "Firebase returned invalid JSON" };
        }
        return { url, working: true };
      } catch (error) {
        return {
          url,
          reason: error.name === "TimeoutError" ? "connection timed out" : "connection failed"
        };
      }
    }));
    checks.push(...batchChecks);
  }
  const workingUrls = [];
  for (const check of checks) {
    if (check.working) {
      workingUrls.push(check.url);
    } else {
      removed.push({ url: check.url, reason: check.reason });
    }
  }
  return { databaseUrls: workingUrls, removed };
}

function normalizeOrderOtpHistory(order) {
  const legacyHistory = order.receivedOtp === null || order.receivedOtp === undefined
    ? []
    : [{ code: order.receivedOtp, receivedAt: order.receivedAt, messageKey: null }];
  const history = order.receivedOtps === undefined ? legacyHistory : order.receivedOtps;
  if (!Array.isArray(history) || history.length > 100
    || history.some((entry) => !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof entry.code !== "string"
      || !/^\d{4,8}$/.test(entry.code)
      || !Number.isFinite(entry.receivedAt)
      || (entry.messageKey !== null && typeof entry.messageKey !== "string"))) {
    throw new Error("The recent orders data has an invalid OTP history.");
  }
  return history.map((entry) => ({
    code: entry.code,
    receivedAt: entry.receivedAt,
    messageKey: entry.messageKey || null
  }));
}

function normalizeOrderMessageHistory(order) {
  const history = order.messageHistory === undefined ? [] : order.messageHistory;
  if (!Array.isArray(history) || history.length > 500
    || history.some((entry) => !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof entry.key !== "string"
      || !Number.isFinite(entry.timestamp)
      || !entry.message
      || typeof entry.message !== "object"
      || Array.isArray(entry.message))) {
    throw new Error("The recent orders data has an invalid message history.");
  }
  return history.map((entry) => ({
    key: entry.key,
    timestamp: entry.timestamp,
    message: entry.message
  }));
}

async function readRotationState() {
  let contents;
  try {
    contents = await readFile(rotationDataPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { initialized: false, databaseUrls: [databaseUrl], serviceUsage: {}, orders: [] };
    }
    throw error;
  }

  let stored;
  try {
    stored = JSON.parse(contents);
  } catch {
    throw new Error("The database rotation file contains invalid JSON.");
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error("The database rotation file has an invalid format.");
  }
  const databaseUrls = normalizeRotatingDatabaseUrls(stored.databaseUrls);
  if (!stored.serviceUsage || typeof stored.serviceUsage !== "object" || Array.isArray(stored.serviceUsage)) {
    throw new Error("The database rotation usage data has an invalid format.");
  }
  const serviceUsage = {};
  for (const [service, state] of Object.entries(stored.serviceUsage)) {
    if (!service || service !== service.toLowerCase()
      || !state || typeof state !== "object" || Array.isArray(state)
      || typeof state.cursorUrl !== "string"
      || !Array.isArray(state.usedNumbers)
      || !Number.isInteger(state.cycle) || state.cycle < 0
      || state.usedNumbers.some((number) => typeof number !== "string" || !/^\d{10}$/.test(number))) {
      throw new Error("The database rotation usage data has an invalid format.");
    }
    serviceUsage[service] = {
      cursorUrl: databaseUrls.includes(state.cursorUrl) ? state.cursorUrl : databaseUrls[0],
      usedNumbers: [...new Set(state.usedNumbers)],
      cycle: state.cycle
    };
  }
  const orders = [];
  const orderIds = new Set();
  const activeNumbers = new Set();
  if (stored.orders !== undefined && !Array.isArray(stored.orders)) {
    throw new Error("The recent orders data has an invalid format.");
  }
  for (const order of stored.orders || []) {
    let orderDatabase;
    try {
      orderDatabase = normalizeDatabaseUrl(order && order.databaseUrl);
    } catch {
      throw new Error("The recent orders data has an invalid format.");
    }
    let receivedOtps;
    try {
      receivedOtps = normalizeOrderOtpHistory(order);
    } catch {
      throw new Error("The recent orders data has an invalid format.");
    }
    const latestOtp = receivedOtps.at(-1) || null;
    let messageHistory;
    try {
      messageHistory = normalizeOrderMessageHistory(order);
    } catch {
      throw new Error("The recent orders data has an invalid format.");
    }
    const numberActive = Boolean(order
      && order.numberActive === true
      && order.status !== "cancelled"
      && order.status !== "expired"
      && Number.isFinite(order.expiresAt)
      && order.expiresAt > Date.now());
    if (!order || typeof order !== "object" || Array.isArray(order)
      || typeof order.orderId !== "string" || !/^[a-f0-9]{24}$/.test(order.orderId)
      || orderIds.has(order.orderId)
      || typeof order.deviceId !== "string" || !isValidDatabaseKey(order.deviceId)
      || typeof order.number !== "string" || !/^\d{10}$/.test(order.number)
      || typeof order.service !== "string" || !order.service
      || order.service !== order.service.toLowerCase() || order.service.length > 60
      || !Number.isFinite(order.createdAt) || !Number.isFinite(order.expiresAt)
      || order.expiresAt <= order.createdAt
      || !["active", "completed", "cancelled", "expired"].includes(order.status)
      || !(order.receivedOtp === null || (typeof order.receivedOtp === "string" && /^\d{4,8}$/.test(order.receivedOtp)))
      || !(order.receivedAt === null || Number.isFinite(order.receivedAt))
      || (order.receivedOtp === null) !== (order.receivedAt === null)
      || order.receivedOtp !== (latestOtp ? latestOtp.code : null)
      || order.receivedAt !== (latestOtp ? latestOtp.receivedAt : null)
      || (order.numberActive !== undefined && typeof order.numberActive !== "boolean")
      || (order.receivedOtp !== null && order.status !== "completed")
      || (order.status === "completed" && order.receivedOtp === null)
      || (order.status === "active" && activeNumbers.has(order.number))) {
      throw new Error("The recent orders data has an invalid format.");
    }
    orderIds.add(order.orderId);
    if (order.status === "active") activeNumbers.add(order.number);
    const expiresAt = order.status === "active"
      ? Math.min(order.expiresAt, order.createdAt + numberReservationDurationMs)
      : order.expiresAt;
    orders.push({
      orderId: order.orderId,
      deviceId: order.deviceId,
      number: order.number,
      databaseUrl: orderDatabase,
      service: order.service,
      createdAt: order.createdAt,
      expiresAt,
      status: order.status,
      receivedOtp: order.receivedOtp,
      receivedAt: order.receivedAt,
      receivedOtps,
      messageHistory,
      numberActive
    });
  }
  return { initialized: true, databaseUrls, serviceUsage, orders };
}

async function saveRotationState(state) {
  await writeFile(rotationDataPath, JSON.stringify({
    databaseUrls: state.databaseUrls,
    serviceUsage: state.serviceUsage,
    orders: state.orders
  }, null, 2), "utf8");
}

async function withRotationLock(operation) {
  const previous = rotationOperation;
  let release;
  rotationOperation = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function isValidPhoneNumber(value) {
  if (typeof value !== "string" || !/^\+?[\d\s().-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function getRequestedDatabaseUrl(requestUrl, response) {
  const values = requestUrl.searchParams.getAll("database");
  if (values.length !== 1) {
    sendJson(response, 400, { error: "Provide one Firebase database URL." });
    return null;
  }

  try {
    return normalizeDatabaseUrl(values[0]);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return null;
  }
}

function isValidDatabaseKey(key) {
  return Boolean(key)
    && !/[.#$\[\]\/]/.test(key)
    && Buffer.byteLength(key, "utf8") <= 768;
}

function getMessageText(message) {
  return [message.message, message.body, message.text, message.msg, message.sms]
    .find((value) => typeof value === "string" && value.length > 0) || "";
}

function getMessageTimestamp(key, message) {
  for (const candidate of [message.timestamp, message.id, key]) {
    const numeric = typeof candidate === "number"
      ? candidate
      : /^\d+$/.test(String(candidate)) ? Number(candidate) : NaN;
    if (!Number.isFinite(numeric)) continue;
    const timestamp = new Date(Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.getTime();
  }
  if (typeof message.dateTime === "string") {
    const timestamp = Date.parse(message.dateTime);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function extractCarrierNumber(message) {
  const carrierNames = String.raw`(?:jio|airtel|vi|vodafone|idea|bsnl)`;
  const phoneCandidate = String.raw`(?<![\d])(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)`;
  const patterns = [
    new RegExp(String.raw`\b${carrierNames}\s*(?:mobile\s*)?(?:number|no\.?|\u0928\u0902\u092c\u0930)\s*(?:(?:is|:|=|-)\s*)?(${phoneCandidate})`, "i"),
    new RegExp(String.raw`\b(?:mobile|phone)\s*(?:number|no\.?)\s*(?:(?:is|:|=|-)\s*)?(${phoneCandidate})`, "i"),
    new RegExp(String.raw`\b(?:number|no\.?)\s+(?:for|on)\s+${carrierNames}\s*(?:(?:is|:|=|-)\s*)?(${phoneCandidate})`, "i")
  ];
  const text = getMessageText(message);
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    let digits = match[1].replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (digits.length === 10) return digits;
  }
  return null;
}

function getLatestCarrierNumber(messages) {
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) return null;
  const entries = Object.entries(messages)
    .filter(([, message]) => message
      && typeof message === "object"
      && !Array.isArray(message)
      && !/\bjoin[\s\W_]*telegram\b/i.test(getMessageText(message)))
    .sort(([leftKey, left], [rightKey, right]) => {
      const leftTime = getMessageTimestamp(leftKey, left);
      const rightTime = getMessageTimestamp(rightKey, right);
      if (leftTime !== null && rightTime !== null) return rightTime - leftTime;
      if (leftTime !== null) return -1;
      if (rightTime !== null) return 1;
      return String(rightKey).localeCompare(String(leftKey), undefined, { numeric: true });
    });
  for (const [, message] of entries) {
    const number = extractCarrierNumber(message);
    if (number) return number;
  }
  return null;
}

function synchronizeNumberReservations(rotationState, now = Date.now()) {
  let changed = false;
  reservedNumbers.clear();
  for (const order of rotationState.orders) {
    if (order.status === "active" && order.expiresAt <= now) {
      order.status = "expired";
      order.numberActive = false;
      changed = true;
    }
    if (order.status !== "active") {
      if (order.expiresAt <= now && order.numberActive) {
        order.numberActive = false;
        changed = true;
      }
      clearOrderExpirationTimer(order.orderId);
      continue;
    }
    reservedNumbers.set(order.number, order.orderId);
    scheduleOrderExpiration(order);
  }
  return changed;
}

function clearOrderExpirationTimer(orderId) {
  const timer = orderExpirationTimers.get(orderId);
  if (timer) clearTimeout(timer);
  orderExpirationTimers.delete(orderId);
}

function scheduleOrderExpiration(order) {
  if (orderExpirationTimers.has(order.orderId)) return;
  const timer = setTimeout(() => {
    orderExpirationTimers.delete(order.orderId);
    withRotationLock(async () => {
      const rotationState = await readRotationState();
      if (synchronizeNumberReservations(rotationState)) {
        await saveRotationState(rotationState);
      }
    }).catch((error) => {
      console.error(`Could not automatically cancel expired order ${order.orderId}:`, error.message);
      scheduleOrderExpiration({ orderId: order.orderId, expiresAt: Date.now() + 30000 });
    });
  }, Math.max(0, order.expiresAt - Date.now()));
  timer.unref();
  orderExpirationTimers.set(order.orderId, timer);
}

async function initializeOrderExpirationTimers() {
  await withRotationLock(async () => {
    const rotationState = await readRotationState();
    if (synchronizeNumberReservations(rotationState)) {
      await saveRotationState(rotationState);
    }
  });
}

async function fetchDatabaseJson(endpoint) {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Firebase request failed.");
  try {
    return await response.json();
  } catch {
    throw new Error("Firebase returned invalid JSON.");
  }
}

async function readActiveNumbers(database) {
  const clients = await fetchDatabaseJson(`${database}/clients.json`);
  if (!clients || typeof clients !== "object" || Array.isArray(clients)) {
    return { numbers: [], messageReadFailures: 0 };
  }
  const activeClients = Object.entries(clients)
    .filter(([id, client]) => isValidDatabaseKey(id)
      && client
      && typeof client === "object"
      && !Array.isArray(client)
      && client.status === true);
  if (activeClients.length === 0) return { numbers: [], messageReadFailures: 0 };

  const offset = randomInt(activeClients.length);
  const candidates = activeClients.map((_, index) => activeClients[(offset + index) % activeClients.length]);
  const numbers = new Map();
  let messageReadFailures = 0;
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = candidates.slice(index, index + 8);
    const results = await Promise.allSettled(batch.map(async ([deviceId]) => ({
      deviceId,
      number: getLatestCarrierNumber(await fetchDatabaseJson(
        `${database}/messages/${encodeURIComponent(deviceId)}.json`
      ))
    })));
    for (const result of results) {
      if (result.status === "rejected") {
        messageReadFailures += 1;
      } else if (result.value.number && !numbers.has(result.value.number)) {
        numbers.set(result.value.number, result.value);
      }
    }
  }
  return { numbers: [...numbers.values()], messageReadFailures };
}

async function readRotatingNumberStats() {
  const databaseUrls = await withRotationLock(async () => {
    const state = await readRotationState();
    return [...state.databaseUrls];
  });
  const failedDatabases = [];
  const clients = [];
  let scannedDatabases = 0;

  for (let index = 0; index < databaseUrls.length; index += databasePingConcurrency) {
    const batch = databaseUrls.slice(index, index + databasePingConcurrency);
    const results = await Promise.allSettled(batch.map(async (url) => ({
      url,
      records: await fetchDatabaseJson(`${url}/clients.json`)
    })));
    for (let offset = 0; offset < results.length; offset += 1) {
      const result = results[offset];
      const url = batch[offset];
      if (result.status === "rejected") {
        failedDatabases.push({ url, reason: result.reason.message });
        continue;
      }
      const records = result.value.records;
      if (records !== null && (typeof records !== "object" || Array.isArray(records))) {
        failedDatabases.push({ url, reason: "Firebase returned an invalid clients list." });
        continue;
      }
      scannedDatabases += 1;
      if (!records) continue;
      for (const [deviceId, client] of Object.entries(records)) {
        if (!isValidDatabaseKey(deviceId) || !client
          || typeof client !== "object" || Array.isArray(client)) continue;
        clients.push({ url, deviceId, active: client.status === true });
      }
    }
  }

  const numbers = new Map();
  let messageReadFailures = 0;
  const messageFailuresByDatabase = new Map();
  for (let index = 0; index < clients.length; index += databasePingConcurrency) {
    const batch = clients.slice(index, index + databasePingConcurrency);
    const results = await Promise.allSettled(batch.map(async (client) => ({
      client,
      number: getLatestCarrierNumber(await fetchDatabaseJson(
        `${client.url}/messages/${encodeURIComponent(client.deviceId)}.json`
      ))
    })));
    for (let offset = 0; offset < results.length; offset += 1) {
      const result = results[offset];
      if (result.status === "rejected") {
        messageReadFailures += 1;
        const url = batch[offset].url;
        messageFailuresByDatabase.set(url, (messageFailuresByDatabase.get(url) || 0) + 1);
        continue;
      }
      const { client, number } = result.value;
      if (!number) continue;
      const current = numbers.get(number);
      numbers.set(number, { active: Boolean(client.active || (current && current.active)) });
    }
  }

  const activeNumbers = [...numbers.values()].filter((number) => number.active).length;
  return {
    databaseCount: databaseUrls.length,
    scannedDatabases,
    failedDatabases,
    clientCount: clients.length,
    messageReadFailures,
    messageFailuresByDatabase: [...messageFailuresByDatabase]
      .map(([url, failures]) => ({ url, failures })),
    totalNumbers: numbers.size,
    activeNumbers,
    offlineNumbers: numbers.size - activeNumbers
  };
}

async function reserveNumber(service, database, candidate, serviceState, rotationState) {
  const usedNumbers = new Set(serviceState.usedNumbers);
  usedNumbers.add(candidate.number);
  rotationState.serviceUsage[service] = {
    cursorUrl: database,
    usedNumbers: [...usedNumbers],
    cycle: serviceState.cycle
  };

  let orderId;
  do {
    orderId = randomBytes(12).toString("hex");
  } while (rotationState.orders.some((order) => order.orderId === orderId));
  const createdAt = Date.now();
  const reservation = {
    orderId,
    deviceId: candidate.deviceId,
    number: candidate.number,
    databaseUrl: database,
    service,
    createdAt,
    expiresAt: createdAt + numberReservationDurationMs,
    status: "active",
    receivedOtp: null,
    receivedAt: null,
    receivedOtps: [],
    messageHistory: [],
    numberActive: false
  };
  rotationState.orders.push(reservation);
  await saveRotationState(rotationState);
  reservedNumbers.set(candidate.number, orderId);
  scheduleOrderExpiration(reservation);
  return reservation;
}

async function findAvailableActiveNumber(service, rotationState) {
  const configuredUrls = rotationState.databaseUrls;
  const serviceState = rotationState.serviceUsage[service] || {
    cursorUrl: configuredUrls[0],
    usedNumbers: [],
    cycle: 0
  };
  const startIndex = Math.max(0, configuredUrls.indexOf(serviceState.cursorUrl));
  const orderedUrls = configuredUrls.map((_, index) =>
    configuredUrls[(startIndex + index) % configuredUrls.length]);
  const usedNumbers = new Set(serviceState.usedNumbers);
  const lockedNumbers = new Set(rotationState.orders
    .filter((order) => order.service === service && order.receivedOtp !== null)
    .map((order) => order.number));
  const inventories = [];

  for (const database of orderedUrls) {
    const inventory = await readActiveNumbers(database);
    inventories.push({ database, ...inventory });
    const available = inventory.numbers.filter((candidate) =>
      !usedNumbers.has(candidate.number)
      && !lockedNumbers.has(candidate.number)
      && !reservedNumbers.has(candidate.number));
    if (available.length > 0) {
      return reserveNumber(service, database, available[randomInt(available.length)], serviceState, rotationState);
    }
    if (inventory.messageReadFailures > 0) {
      throw new Error(`Could not read every active client in database ${database}.`);
    }
  }

  const allNumbers = new Set(inventories.flatMap((inventory) =>
    inventory.numbers.map((candidate) => candidate.number)));
  const recyclableNumbers = [...allNumbers].filter((number) => !lockedNumbers.has(number));
  if (recyclableNumbers.length === 0) return null;
  if (recyclableNumbers.some((number) => !usedNumbers.has(number))) return null;

  const recycledServiceState = {
    cursorUrl: serviceState.cursorUrl,
    usedNumbers: [],
    cycle: serviceState.cycle + 1
  };
  rotationState.serviceUsage[service] = recycledServiceState;
  for (const inventory of inventories) {
    const available = inventory.numbers.filter((candidate) =>
      !lockedNumbers.has(candidate.number) && !reservedNumbers.has(candidate.number));
    if (available.length > 0) {
      return reserveNumber(
        service,
        inventory.database,
        available[randomInt(available.length)],
        recycledServiceState,
        rotationState
      );
    }
  }
  await saveRotationState(rotationState);
  return null;
}

function findMatchingMessages(messages, afterTimestamp, service, untilTimestamp = Infinity) {
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) return [];
  const entries = Object.entries(messages)
    .filter(([key, message]) => message
      && typeof message === "object"
      && !Array.isArray(message)
      && !/\bjoin[\s\W_]*telegram\b/i.test(getMessageText(message)))
    .sort(([leftKey, left], [rightKey, right]) => {
      const leftTime = getMessageTimestamp(leftKey, left);
      const rightTime = getMessageTimestamp(rightKey, right);
      if (leftTime !== null && rightTime !== null) return rightTime - leftTime;
      if (leftTime !== null) return -1;
      if (rightTime !== null) return 1;
      return String(rightKey).localeCompare(String(leftKey), undefined, { numeric: true });
    });
  const matches = [];
  for (const [key, message] of entries) {
    const timestamp = getMessageTimestamp(key, message);
    if (timestamp === null || timestamp < afterTimestamp || timestamp > untilTimestamp) continue;
    const text = getMessageText(message);
    const match = matchServiceMessage(service, text, message);
    if (match) matches.push({ key, timestamp, message, code: match.code });
  }
  return matches.reverse();
}

function findOtpCodes(messages, afterTimestamp, service, untilTimestamp = Infinity) {
  return findMatchingMessages(messages, afterTimestamp, service, untilTimestamp)
    .map((match) => ({
      code: match.code,
      receivedAt: match.timestamp,
      messageKey: match.key
    }));
}

function findOtpCode(messages, afterTimestamp, service) {
  const matches = findOtpCodes(messages, afterTimestamp, service);
  return matches.length ? matches[matches.length - 1].code : null;
}

function appendOrderOtp(order, match) {
  if (!Array.isArray(order.receivedOtps)) order.receivedOtps = [];
  const duplicate = order.receivedOtps.some((entry) => entry.messageKey
    ? entry.messageKey === match.messageKey
    : entry.code === match.code);
  if (duplicate) return false;
  order.receivedOtps.push({
    code: match.code,
    receivedAt: match.receivedAt,
    messageKey: match.messageKey || null
  });
  order.receivedOtp = match.code;
  order.receivedAt = match.receivedAt;
  order.status = "completed";
  return true;
}

function appendOrderMessage(order, match) {
  if (!Array.isArray(order.messageHistory)) order.messageHistory = [];
  if (order.messageHistory.some((entry) => entry.key === match.key)) return false;
  order.messageHistory.push({
    key: match.key,
    timestamp: match.timestamp,
    message: match.message
  });
  return true;
}

async function synchronizeRecentOrderOtps() {
  if (recentOrderOtpScanPromise) return recentOrderOtpScanPromise;
  recentOrderOtpScanPromise = (async () => {
    let snapshot;
    try {
      snapshot = await withRotationLock(async () => {
        const rotationState = await readRotationState();
        if (synchronizeNumberReservations(rotationState)) await saveRotationState(rotationState);
        return rotationState.orders
          .filter((order) => (order.status === "active" || order.status === "completed")
            && order.expiresAt > Date.now())
          .map((order) => ({ ...order }));
      });
    } catch (error) {
      console.error("Could not prepare recent order OTP scan:", error.message);
      return;
    }
    if (!snapshot.length) return;

    let configuredServices;
    try {
      configuredServices = await readConfiguredServices();
    } catch (error) {
      console.error("Could not read configured services for recent order OTP scan:", error.message);
      return;
    }
    const services = new Map(configuredServices.services
      .filter((service) => service && typeof service.name === "string")
      .map((service) => [service.name.trim().toLowerCase(), service]));
    const now = Date.now();
    const candidates = snapshot.filter((order) => {
      const lastCheck = recentOrderOtpChecks.get(order.orderId) || 0;
      return now - lastCheck >= recentOrderOtpScanIntervalMs;
    });
    if (!candidates.length) return;

    const matches = [];
    const numberStatusUpdates = [];
    await Promise.all(candidates.map(async (order) => {
      recentOrderOtpChecks.set(order.orderId, now);
      try {
        const client = await fetchDatabaseJson(
          `${order.databaseUrl}/clients/${encodeURIComponent(order.deviceId)}.json`
        );
        numberStatusUpdates.push({ orderId: order.orderId, numberActive: client?.status === true });
      } catch (error) {
        console.error(`Could not check active status for recent order ${order.orderId}:`, error.message);
      }
      const service = services.get(order.service.trim().toLowerCase());
      if (!service) return;
      try {
        const messages = await fetchDatabaseJson(
          `${order.databaseUrl}/messages/${encodeURIComponent(order.deviceId)}.json`
        );
        const knownMessageKeys = new Set((order.messageHistory || [])
          .map((entry) => entry.key));
        const knownKeys = new Set((order.receivedOtps || [])
          .map((entry) => entry.messageKey)
          .filter(Boolean));
        const knownFallbacks = new Set((order.receivedOtps || [])
          .filter((entry) => !entry.messageKey)
          .flatMap((entry) => [entry.code, `${entry.code}:${entry.receivedAt}`]));
        const untilTimestamp = Math.min(Date.now(), order.expiresAt);
        for (const message of findMatchingMessages(messages, order.createdAt, service, untilTimestamp)) {
          if (knownMessageKeys.has(message.key)) continue;
          if (!knownKeys.has(message.key)
            && !knownFallbacks.has(message.code)
            && !knownFallbacks.has(`${message.code}:${message.timestamp}`)) {
            matches.push({ orderId: order.orderId, message });
          }
        }
      } catch (error) {
        console.error(`Could not scan messages for recent order ${order.orderId}:`, error.message);
      }
    }));
    if (!matches.length && !numberStatusUpdates.length) return;

    await withRotationLock(async () => {
      const rotationState = await readRotationState();
      let changed = false;
      for (const update of numberStatusUpdates) {
        const order = rotationState.orders.find((item) => item.orderId === update.orderId);
        if (!order || (order.status !== "active" && order.status !== "completed")) continue;
        if (order.numberActive !== update.numberActive) {
          order.numberActive = update.numberActive;
          changed = true;
        }
      }
      for (const match of matches) {
        const order = rotationState.orders.find((item) => item.orderId === match.orderId);
        if (!order || (order.status !== "active" && order.status !== "completed")) continue;
        const messageAdded = appendOrderMessage(order, match.message);
        const otpAdded = appendOrderOtp(order, {
          code: match.message.code,
          receivedAt: match.message.timestamp,
          messageKey: match.message.key
        });
        if (messageAdded || otpAdded) {
          recentOrderOtpChecks.delete(order.orderId);
          changed = true;
        }
      }
      if (changed) {
        synchronizeNumberReservations(rotationState);
        await saveRotationState(rotationState);
      }
    });
  })().finally(() => {
    recentOrderOtpScanPromise = null;
  });
  return recentOrderOtpScanPromise;
}

async function handleLocalOtpRequest(requestUrl, response) {
  const actions = requestUrl.searchParams.getAll("action");
  if (actions.length !== 1) {
    sendText(response, 400, "BAD_ACTION");
    return;
  }
  const action = actions[0];

  if (action === "getNumber") {
    const services = requestUrl.searchParams.getAll("service");
    if (services.length !== 1 || !services[0].trim() || services[0].trim().length > 60) {
      sendText(response, 400, "BAD_SERVICE");
      return;
    }
    const service = services[0].trim().toLowerCase();
    let configuredServices;
    try {
      configuredServices = await readConfiguredServices();
    } catch (error) {
      console.error("Could not read configured services:", error.message);
      sendJson(response, 500, { error: "Could not read configured services." });
      return;
    }
    if (!configuredServices.services.some((item) => item.name.trim().toLowerCase() === service)) {
      sendText(response, 200, "BAD_SERVICE");
      return;
    }
    let reservation;
    try {
      reservation = await withRotationLock(async () => {
        const rotationState = await readRotationState();
        if (synchronizeNumberReservations(rotationState)) {
          await saveRotationState(rotationState);
        }
        return findAvailableActiveNumber(service, rotationState);
      });
    } catch (error) {
      console.error("Could not select an active client number:", error.message);
      sendJson(response, 502, { error: "Could not select an active-client number from the configured databases." });
      return;
    }
    if (!reservation) {
      sendText(response, 200, "NO_NUMBERS");
      return;
    }
    sendText(response, 200, `ACCESS_NUMBER:${reservation.orderId}:${reservation.number}`);
    return;
  }

  if (!["getStatus", "setStatus"].includes(action)) {
    sendText(response, 400, "BAD_ACTION");
    return;
  }
  const orderIds = requestUrl.searchParams.getAll("id");
  if (orderIds.length !== 1 || !orderIds[0]) {
    sendText(response, 400, "NO_ACTIVATION");
    return;
  }
  if (action === "setStatus") {
    const statuses = requestUrl.searchParams.getAll("status");
    if (statuses.length !== 1 || !["3", "8"].includes(statuses[0])) {
      sendText(response, 400, "BAD_STATUS");
      return;
    }
    let result;
    try {
      result = await withRotationLock(async () => {
        const rotationState = await readRotationState();
        const expiredOrdersChanged = synchronizeNumberReservations(rotationState);
        const reservation = rotationState.orders.find((order) => order.orderId === orderIds[0]);
        if (!reservation) {
          if (expiredOrdersChanged) await saveRotationState(rotationState);
          return "NO_ACTIVATION";
        }
        if (reservation.status !== "active") {
          if (expiredOrdersChanged) await saveRotationState(rotationState);
          return "STATUS_CANCEL";
        }
        if (statuses[0] === "8") {
          reservation.status = "cancelled";
          reservation.numberActive = false;
          synchronizeNumberReservations(rotationState);
          await saveRotationState(rotationState);
          return "ACCESS_CANCEL";
        }
        if (expiredOrdersChanged) await saveRotationState(rotationState);
        return "ACCESS_RETRY_GET";
      });
    } catch (error) {
      console.error("Could not update a recent number order:", error.message);
      sendJson(response, 500, { error: "Could not update the number order." });
      return;
    }
    sendText(response, 200, result);
    return;
  }

  let reservation;
  try {
    reservation = await withRotationLock(async () => {
      const rotationState = await readRotationState();
      const expiredOrdersChanged = synchronizeNumberReservations(rotationState);
      const order = rotationState.orders.find((item) => item.orderId === orderIds[0]);
      if (expiredOrdersChanged) await saveRotationState(rotationState);
      return order || null;
    });
  } catch (error) {
    console.error("Could not read a recent number order:", error.message);
    sendJson(response, 500, { error: "Could not read the number order." });
    return;
  }
  if (!reservation) {
    sendText(response, 200, "NO_ACTIVATION");
    return;
  }
  if (reservation.status !== "active" && reservation.status !== "completed") {
    sendText(response, 200, "STATUS_CANCEL");
    return;
  }
  if (action === "getStatus") {
    let messages;
    try {
      messages = await fetchDatabaseJson(
        `${reservation.databaseUrl}/messages/${encodeURIComponent(reservation.deviceId)}.json`
      );
    } catch (error) {
      console.error("Could not read messages for a number order:", error.message);
      if (reservation.receivedOtp !== null) {
        sendText(response, 200, `STATUS_OK:${reservation.receivedOtp}`);
        return;
      }
      sendJson(response, 502, { error: "Could not read SMS messages from the active client." });
      return;
    }
    let configuredServices;
    try {
      configuredServices = await readConfiguredServices();
    } catch (error) {
      console.error("Could not read configured services for an order:", error.message);
      sendJson(response, 500, { error: "Could not read the configured service for this order." });
      return;
    }
    const orderService = configuredServices.services.find((service) =>
      service && typeof service.name === "string"
      && service.name.trim().toLowerCase() === reservation.service.trim().toLowerCase());
    if (!orderService) {
      sendText(response, 200, reservation.receivedOtp === null
        ? "STATUS_WAIT_CODE"
        : `STATUS_OK:${reservation.receivedOtp}`);
      return;
    }
    const matches = findMatchingMessages(
      messages,
      reservation.createdAt,
      orderService,
      Math.min(Date.now(), reservation.expiresAt)
    );
    if (!matches.length && reservation.receivedOtp !== null) {
      sendText(response, 200, `STATUS_OK:${reservation.receivedOtp}`);
      return;
    }
    if (!matches.length) {
      sendText(response, 200, "STATUS_WAIT_CODE");
      return;
    }
    let updatedOrder;
    try {
      updatedOrder = await withRotationLock(async () => {
        const rotationState = await readRotationState();
        const expiredOrdersChanged = synchronizeNumberReservations(rotationState);
        const currentOrder = rotationState.orders.find((order) => order.orderId === orderIds[0]);
        if (!currentOrder) {
          if (expiredOrdersChanged) await saveRotationState(rotationState);
          return null;
        }
        if (currentOrder.status === "active" || currentOrder.status === "completed") {
          let changed = false;
          for (const match of matches) {
            const messageAdded = appendOrderMessage(currentOrder, match);
            const otpAdded = appendOrderOtp(currentOrder, {
              code: match.code,
              receivedAt: match.timestamp,
              messageKey: match.key
            });
            changed = messageAdded || otpAdded || changed;
          }
          synchronizeNumberReservations(rotationState);
          if (changed || expiredOrdersChanged) await saveRotationState(rotationState);
        } else if (expiredOrdersChanged) {
          await saveRotationState(rotationState);
        }
        return currentOrder;
      });
    } catch (error) {
      console.error("Could not save an OTP received for a number order:", error.message);
      sendJson(response, 500, { error: "Could not save the received OTP." });
      return;
    }
    if (updatedOrder && updatedOrder.receivedOtp !== null) {
      sendText(response, 200, `STATUS_OK:${updatedOrder.receivedOtp}`);
    } else {
      sendText(response, 200, "STATUS_CANCEL");
    }
    return;
  }
}

async function queueSms(request, response) {
  let input;
  try {
    input = await readJsonBody(request, 16384);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    sendJson(response, 400, { error: "Provide an SMS task as a JSON object." });
    return;
  }
  if (typeof input.database !== "string") {
    sendJson(response, 400, { error: "Provide one Firebase database URL." });
    return;
  }
  let requestedDatabase;
  try {
    requestedDatabase = normalizeDatabaseUrl(input.database);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const deviceId = input.deviceId;
  const destination = typeof input.destination === "string" ? input.destination.trim() : "";
  const message = input.message;
  const sim = input.sim;
  if (typeof deviceId !== "string" || !isValidDatabaseKey(deviceId)) {
    sendJson(response, 400, { error: "Choose one valid sender device ID." });
    return;
  }
  if (!isValidPhoneNumber(destination)) {
    sendJson(response, 400, { error: "Enter a phone number with 7 to 15 digits." });
    return;
  }
  if (typeof message !== "string" || !message.trim() || message.length > 1600) {
    sendJson(response, 400, { error: "Enter a message between 1 and 1600 characters." });
    return;
  }
  if (sim !== 1 && sim !== 2) {
    sendJson(response, 400, { error: "Choose SIM 1 or SIM 2." });
    return;
  }

  const signal = AbortSignal.timeout(15000);
  let deviceResponse;
  try {
    deviceResponse = await fetch(
      `${requestedDatabase}/devices/${encodeURIComponent(deviceId)}.json`,
      { signal }
    );
  } catch (error) {
    console.error("Could not verify SMS sender:", error.message);
    sendJson(response, 502, { error: "Could not verify the sender device in Firebase." });
    return;
  }
  if (!deviceResponse.ok) {
    sendJson(response, 502, { error: `Could not verify the sender device (Firebase HTTP ${deviceResponse.status}).` });
    return;
  }

  let device;
  try {
    device = await deviceResponse.json();
  } catch {
    sendJson(response, 502, { error: "Firebase returned invalid device data." });
    return;
  }
  if (!device || typeof device !== "object" || Array.isArray(device)) {
    sendJson(response, 404, { error: "That sender ID was not found in the Devices section." });
    return;
  }

  const timestamp = Date.now();
  const broadcastId = `Task-${timestamp}`;
  const id = `${broadcastId}_${randomBytes(4).toString("hex")}`;
  const digits = destination.replace(/\D/g, "");
  const simIndex = sim - 1;
  const task = {
    action: "send_sms",
    address: destination,
    body: message,
    broadcastId,
    cleanNumber: digits,
    cleanPhone: digits,
    command: "sendSMS",
    destination,
    from: sim,
    fromSlot: sim,
    id,
    isSended: false,
    message,
    messageText: message,
    mobNo: destination,
    mobile: destination,
    msg: message,
    number: destination,
    phone: destination,
    phoneNumber: destination,
    priority: "high",
    rawNumber: digits,
    sim,
    simIndex,
    simSlot: simIndex,
    sim_slot: simIndex,
    slot: simIndex,
    sms: message,
    status: "pending",
    text: message,
    timestamp,
    to: destination,
    type: "sms"
  };
  const taskUrl = `${requestedDatabase}/sendSms/${encodeURIComponent(deviceId)}/${encodeURIComponent(id)}.json`;

  try {
    const existingResponse = await fetch(taskUrl, {
      headers: { "X-Firebase-ETag": "true" },
      signal
    });
    if (!existingResponse.ok) {
      sendJson(response, 502, { error: `Could not check the new SMS task key (Firebase HTTP ${existingResponse.status}).` });
      return;
    }
    const existing = await existingResponse.json();
    const etag = existingResponse.headers.get("etag");
    if (existing !== null) {
      sendJson(response, 409, { error: "The generated SMS task ID already exists; nothing was overwritten. Please submit again." });
      return;
    }
    if (!etag) {
      sendJson(response, 502, { error: "Firebase did not provide an ETag, so the task was not written." });
      return;
    }

    const writeResponse = await fetch(taskUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": etag
      },
      body: JSON.stringify(task),
      signal
    });
    if (writeResponse.status === 412) {
      sendJson(response, 409, { error: "The SMS task key changed before writing; nothing was overwritten." });
      return;
    }
    if (!writeResponse.ok) {
      const detail = await writeResponse.text();
      console.error(`Firebase SMS queue write failed (HTTP ${writeResponse.status}):`, detail.slice(0, 500));
      sendJson(response, writeResponse.status, { error: `Firebase rejected the SMS task (HTTP ${writeResponse.status}).` });
      return;
    }
    sendJson(response, 201, { id, deviceId, status: "pending" });
  } catch (error) {
    console.error("Could not queue SMS task:", error.message);
    sendJson(response, 502, { error: "Could not confirm the SMS task write. Check Send SMS records before retrying." });
  }
}

async function proxyOtpProvider(request, response) {
  let input;
  try {
    input = await readJsonBody(request, 8192);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    sendJson(response, 400, { error: "Provide an OTP provider request as a JSON object." });
    return;
  }
  if (typeof input.providerApiKey !== "string" || !input.providerApiKey.trim()) {
    sendJson(response, 400, { error: "Enter the OTP provider API key." });
    return;
  }
  const action = input.action;
  const supportedActions = new Set(["getCountries", "getServices"]);
  if (typeof action !== "string" || !supportedActions.has(action)) {
    sendJson(response, 400, { error: "Choose a supported OTP provider action." });
    return;
  }

  const parameters = new URLSearchParams({
    api_key: input.providerApiKey.trim(),
    action
  });
  const requiredByAction = {
    getNumber: ["service", "country"],
    getStatus: ["id"],
    setStatus: ["id", "status"],
    getCountries: [],
    getServices: []
  };
  for (const name of requiredByAction[action]) {
    if (typeof input[name] !== "string" || !input[name].trim()) {
      sendJson(response, 400, { error: `Provide a value for ${name}.` });
      return;
    }
    parameters.set(name, input[name].trim());
  }
  if (action === "getNumber") {
    for (const name of ["operator", "maxPrice"]) {
      if (input[name] !== undefined && input[name] !== "") {
        if (typeof input[name] !== "string" || !input[name].trim()) {
          sendJson(response, 400, { error: `Provide a valid value for ${name}.` });
          return;
        }
        parameters.set(name, input[name].trim());
      }
    }
    if (["6", "9"].includes(parameters.get("operator")) && !parameters.has("maxPrice")) {
      sendJson(response, 400, { error: "maxPrice is required when operator is 6 or 9." });
      return;
    }
  }
  if (action === "setStatus" && !["3", "8"].includes(parameters.get("status"))) {
    sendJson(response, 400, { error: "Use status 3 to retry or 8 to cancel." });
    return;
  }

  const endpoint = new URL("https://otpsell.com/stubs/handler_api.php");
  endpoint.search = parameters.toString();
  try {
    const upstream = await fetch(endpoint, {
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
    const body = await upstream.text();
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch {
    console.error("OTP provider request failed.");
    sendJson(response, 502, { error: "Could not reach the OTP provider." });
  }
}

async function proxyFirebase(response, endpoint) {
  try {
    const upstream = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
    const body = await upstream.text();
    response.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch (error) {
    console.error("Firebase request failed:", error.message);
    sendJson(response, 502, { error: "Could not reach the Firebase database." });
  }
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, "http://localhost");
  if (requestUrl.pathname === "/api/auth/session") {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method Not Allowed");
      return;
    }
    sendJson(response, 200, { authenticated: hasValidAdminSession(request) });
    return;
  }
  if (requestUrl.pathname === "/api/auth/login") {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end("Method Not Allowed");
      return;
    }
    if (!isSameOriginRequest(request)) {
      sendJson(response, 403, { error: "Login requests must come from this dashboard." });
      return;
    }
    if (isLoginRateLimited(request)) {
      sendJson(response, 429, { error: "Too many login attempts. Try again later." });
      return;
    }
    let input;
    try {
      input = await readJsonBody(request, 4096);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
      return;
    }
    if (!input || typeof input.key !== "string" || !hasValidAdminKey(input.key)) {
      recordFailedLogin(request);
      sendJson(response, 401, { error: "The admin key is not valid." });
      return;
    }
    clearFailedLogins(request);
    const session = createAdminSession();
    sendJson(response, 200, { authenticated: true }, {
      "Set-Cookie": adminSessionCookie(
        request,
        session.token,
        session.expiresAt,
        adminSessionDurationSeconds
      )
    });
    return;
  }
  if (requestUrl.pathname === "/api/auth/logout") {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end("Method Not Allowed");
      return;
    }
    if (!isSameOriginRequest(request)) {
      sendJson(response, 403, { error: "Logout requests must come from this dashboard." });
      return;
    }
    sendJson(response, 200, { authenticated: false }, {
      "Set-Cookie": adminSessionCookie(request, "", 0, 0)
    });
    return;
  }

  const isLocalOtpApi = requestUrl.pathname === "/stubs/handler_api.php";
  const isApiRequest = requestUrl.pathname.startsWith("/api/") || isLocalOtpApi;
  const requiresExplicitApiKey = isLocalOtpApi || requestUrl.pathname === "/api/otp-provider";
  if (isApiRequest) {
    const authorized = requiresExplicitApiKey
      ? hasValidApiKey(requestUrl)
      : hasValidAdminSession(request);
    if (!authorized) {
      sendJson(response, 401, {
        error: requiresExplicitApiKey ? "Provide one valid api_key query parameter." : "Admin login is required.",
        code: requiresExplicitApiKey ? "API_KEY_REQUIRED" : "AUTH_REQUIRED"
      });
      return;
    }
    if (!requiresExplicitApiKey
      && !["GET", "HEAD"].includes(request.method)
      && !isSameOriginRequest(request)) {
      sendJson(response, 403, { error: "Dashboard changes must come from this dashboard." });
      return;
    }
  }

  const isLoginAsset = ["/login", "/login.html", "/login.js"].includes(requestUrl.pathname);
  if (isLoginAsset) {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method Not Allowed");
      return;
    }
    if (hasValidAdminSession(request)) {
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
      response.end();
      return;
    }
  } else if (!isApiRequest && !hasValidAdminSession(request)) {
    response.writeHead(303, { Location: "/login", "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (isLocalOtpApi) {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method Not Allowed");
      return;
    }
    await handleLocalOtpRequest(requestUrl, response);
    return;
  }
  if (requestUrl.pathname === "/api/recent-orders") {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method Not Allowed");
      return;
    }
    // Let the dashboard observe OTPs even when no external getStatus poll is running.
    void synchronizeRecentOrderOtps().catch((error) => {
      console.error("Recent order OTP scan failed:", error.message);
    });
    try {
      const orders = await withRotationLock(async () => {
        const state = await readRotationState();
        if (synchronizeNumberReservations(state)) await saveRotationState(state);
        return state.orders
          .slice()
          .sort((left, right) => right.createdAt - left.createdAt)
          .map((order) => ({
            ...order,
            locked: order.receivedOtp !== null
          }));
      });
      sendJson(response, 200, { orders });
    } catch (error) {
      console.error("Could not read recent orders:", error.message);
      sendJson(response, 500, { error: "Could not read recent orders." });
    }
    return;
  }
  if (requestUrl.pathname === "/api/rotation/number-stats") {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method Not Allowed");
      return;
    }
    try {
      const stats = await readRotatingNumberStats();
      if (stats.databaseCount > 0 && stats.scannedDatabases === 0) {
        sendJson(response, 502, {
          ...stats,
          error: "Could not read client records from any configured database."
        });
        return;
      }
      sendJson(response, 200, stats);
    } catch (error) {
      console.error("Could not scan numbers across rotating databases:", error.message);
      sendJson(response, 500, { error: "Could not scan numbers across configured databases." });
    }
    return;
  }
  if (requestUrl.pathname === "/api/rotation") {
    if (request.method === "GET") {
      try {
        const state = await withRotationLock(readRotationState);
        sendJson(response, 200, {
          initialized: state.initialized,
          databaseUrls: state.databaseUrls
        });
      } catch (error) {
        console.error("Could not read database rotation settings:", error.message);
        sendJson(response, 500, { error: "Could not read database rotation settings." });
      }
      return;
    }
    if (request.method === "PUT") {
      let input;
      try {
        input = await readJsonBody(request, maximumRotationRequestBytes);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
        return;
      }
      let validated;
      try {
        validated = await validateAndPingRotatingDatabases(input && input.databaseUrls);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (validated.databaseUrls.length === 0) {
        sendJson(response, 400, {
          error: "No working Firebase databases were found; the saved rotation was not changed.",
          removed: validated.removed
        });
        return;
      }
      try {
        await withRotationLock(async () => {
          const state = await readRotationState();
          for (const serviceState of Object.values(state.serviceUsage)) {
            if (!validated.databaseUrls.includes(serviceState.cursorUrl)) {
              serviceState.cursorUrl = validated.databaseUrls[0];
            }
          }
          state.initialized = true;
          state.databaseUrls = validated.databaseUrls;
          await saveRotationState(state);
        });
        sendJson(response, 200, {
          initialized: true,
          databaseUrls: validated.databaseUrls,
          removed: validated.removed
        });
      } catch (error) {
        console.error("Could not save database rotation settings:", error.message);
        sendJson(response, 500, { error: "Could not save database rotation settings." });
      }
      return;
    }
    response.writeHead(405, { Allow: "GET, PUT" });
    response.end("Method Not Allowed");
    return;
  }
  if (requestUrl.pathname === "/api/services") {
    if (request.method === "GET") {
      try {
        sendJson(response, 200, await readConfiguredServices());
      } catch (error) {
        console.error("Could not read configured services:", error.message);
        sendJson(response, 500, { error: "Could not read configured services." });
      }
      return;
    }
    if (request.method === "PUT") {
      let input;
      try {
        input = await readJsonBody(request, 65536);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
        return;
      }
      const services = input && typeof input === "object" && !Array.isArray(input)
        ? normalizeConfiguredServices(input.services)
        : null;
      const validationError = input && typeof input === "object" && !Array.isArray(input)
        ? validateServiceList(services)
        : "Provide a services object.";
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }
      try {
        await saveConfiguredServices(services);
        sendJson(response, 200, { initialized: true, services });
      } catch (error) {
        console.error("Could not save configured services:", error.message);
        sendJson(response, 500, { error: "Could not save configured services." });
      }
      return;
    }
    response.writeHead(405, { Allow: "GET, PUT" });
    response.end("Method Not Allowed");
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/send-sms") {
    await queueSms(request, response);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/otp-provider") {
    await proxyOtpProvider(request, response);
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end("Method Not Allowed");
    return;
  }

  const staticAssets = {
    "/login": { path: path.join(__dirname, "login.html"), contentType: "text/html; charset=utf-8" },
    "/login.html": { path: path.join(__dirname, "login.html"), contentType: "text/html; charset=utf-8" },
    "/login.js": { path: path.join(__dirname, "login.js"), contentType: "text/javascript; charset=utf-8" },
    "/": { path: dashboardPath, contentType: "text/html; charset=utf-8" },
    "/index.js": { path: clientScriptPath, contentType: "text/javascript; charset=utf-8" },
    "/active-devices": { path: activeDevicesPath, contentType: "text/html; charset=utf-8" },
    "/active-devices.html": { path: activeDevicesPath, contentType: "text/html; charset=utf-8" },
    "/active-devices.js": { path: activeDevicesScriptPath, contentType: "text/javascript; charset=utf-8" },
    "/services": { path: servicesPath, contentType: "text/html; charset=utf-8" },
    "/services.html": { path: servicesPath, contentType: "text/html; charset=utf-8" },
    "/services.js": { path: servicesScriptPath, contentType: "text/javascript; charset=utf-8" },
    "/rotation": { path: rotationPath, contentType: "text/html; charset=utf-8" },
    "/rotation.html": { path: rotationPath, contentType: "text/html; charset=utf-8" },
    "/rotation.js": { path: rotationScriptPath, contentType: "text/javascript; charset=utf-8" },
    "/service-messages": { path: serviceMessagesPath, contentType: "text/html; charset=utf-8" },
    "/service-messages.html": { path: serviceMessagesPath, contentType: "text/html; charset=utf-8" },
    "/service-messages.js": { path: serviceMessagesScriptPath, contentType: "text/javascript; charset=utf-8" },
    "/service-matching.js": { path: serviceMatchingScriptPath, contentType: "text/javascript; charset=utf-8" },
    "/recent-orders": { path: recentOrdersPath, contentType: "text/html; charset=utf-8" },
    "/recent-orders.html": { path: recentOrdersPath, contentType: "text/html; charset=utf-8" },
    "/recent-orders.js": { path: recentOrdersScriptPath, contentType: "text/javascript; charset=utf-8" },
    "/api-client.js": { path: apiClientScriptPath, contentType: "text/javascript; charset=utf-8" },
    "/api-docs": { path: apiDocsPath, contentType: "text/html; charset=utf-8" },
    "/api-docs.html": { path: apiDocsPath, contentType: "text/html; charset=utf-8" }
  };
  const asset = staticAssets[requestUrl.pathname];
  if (asset) {
    try {
      const content = await readFile(asset.path);
      response.writeHead(200, {
        "Content-Type": asset.contentType,
        "Cache-Control": "no-store"
      });
      response.end(content);
    } catch (error) {
      console.error("Could not read dashboard asset:", error.message);
      sendJson(response, 500, { error: "Could not load a dashboard asset." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/config") {
    sendJson(response, 200, { databaseUrl });
    return;
  }

  if (requestUrl.pathname === "/api/sections") {
    const requestedDatabase = getRequestedDatabaseUrl(requestUrl, response);
    if (!requestedDatabase) return;
    await proxyFirebase(response, `${requestedDatabase}/.json?shallow=true`);
    return;
  }

  if (requestUrl.pathname === "/api/data") {
    const sections = requestUrl.searchParams.getAll("section");
    const section = sections[0];
    const shallowValues = requestUrl.searchParams.getAll("shallow");
    if (sections.length !== 1 || !isValidDatabaseKey(section)
      || shallowValues.length > 1 || (shallowValues.length === 1 && shallowValues[0] !== "true")) {
      sendJson(response, 400, { error: "Provide one valid top-level section name and, optionally, shallow=true." });
      return;
    }

    const requestedDatabase = getRequestedDatabaseUrl(requestUrl, response);
    if (!requestedDatabase) return;
    const shallowQuery = shallowValues.length === 1 ? "?shallow=true" : "";
    await proxyFirebase(response, `${requestedDatabase}/${encodeURIComponent(section)}.json${shallowQuery}`);
    return;
  }

  if (requestUrl.pathname === "/api/device-record") {
    const recordKeys = requestUrl.searchParams.getAll("recordKey");
    const recordKey = recordKeys[0];
    if (recordKeys.length !== 1 || !isValidDatabaseKey(recordKey)) {
      sendJson(response, 400, { error: "Provide one valid Firebase record key." });
      return;
    }

    const requestedDatabase = getRequestedDatabaseUrl(requestUrl, response);
    if (!requestedDatabase) return;
    await proxyFirebase(response, `${requestedDatabase}/devices/${encodeURIComponent(recordKey)}.json`);
    return;
  }

  if (requestUrl.pathname === "/api/device-messages") {
    const deviceIds = requestUrl.searchParams.getAll("deviceId");
    const deviceId = deviceIds[0];
    if (deviceIds.length !== 1 || !isValidDatabaseKey(deviceId)) {
      sendJson(response, 400, { error: "Provide one valid device ID." });
      return;
    }

    const requestedDatabase = getRequestedDatabaseUrl(requestUrl, response);
    if (!requestedDatabase) return;
    await proxyFirebase(response, `${requestedDatabase}/messages/${encodeURIComponent(deviceId)}.json`);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found");
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("Request failed:", error.message);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "The dashboard server could not complete the request." });
    } else {
      response.destroy();
    }
  });
});

initializeOrderExpirationTimers().catch((error) => {
  console.error("Could not initialize automatic number cancellations:", error.message);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Firebase Data Dashboard is running at http://127.0.0.1:${port}`);
});





