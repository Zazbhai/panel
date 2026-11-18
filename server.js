const { createServer } = require("node:http");
const {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} = require("node:crypto");
const { readFile, writeFile, rename, unlink } = require("node:fs/promises");
const { gzipSync } = require("node:zlib");
const { getEnabledTemplates, matchServiceMessage } = require("./service-matching-core");
const { mergeSmsFormats, normalizeServiceName, normalizeServiceNames } = require("./service-sms-format-import");
const path = require("node:path");

const envFileResult = require("dotenv").config({ path: path.join(__dirname, ".env") });
if (envFileResult.error && envFileResult.error.code !== "ENOENT") {
  throw envFileResult.error;
}

const defaultDatabaseUrl = "https://satanoopfirebase-47068-default-rtdb.firebaseio.com";
const rawDatabaseUrl = process.env.FIREBASE_DATABASE_URL || defaultDatabaseUrl;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const clientScriptPath = path.join(__dirname, "index.js");
const activeDevicesPath = path.join(__dirname, "active-devices.html");
const activeDevicesScriptPath = path.join(__dirname, "active-devices.js");
const dashboardPath = activeDevicesPath;
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
const smsFormatsDataPath = path.join(__dirname, "service-sms-formats.json");
const rotationDataPath = path.join(__dirname, "rotation.json");
const maximumServicesRequestBytes = 16 * 1024 * 1024;
const maximumRotationRequestBytes = 1024 * 1024;
const databasePingConcurrency = 8;
const recentOtpScanConcurrency = 6;
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
const recentOrderOtpScanIntervalMs = 8000;
const activeNumberCacheTtlMs = 30000;
const numberFetchTimeoutMs = 5000;
const activeClientsCacheTtlMs = 3000;
const numberMessagesCacheTtlMs = 500;
const sharedDatabaseErrorTtlMs = 750;
const maximumDatabaseJsonBytes = 4 * 1024 * 1024;
const maximumProviderResponseBytes = 1024 * 1024;
const maximumSharedDatabaseJsonEntryBytes = 1024 * 1024;
const maximumSharedDatabaseJsonCacheBytes = 8 * 1024 * 1024;
const sharedDatabaseJsonCacheLimit = 256;
const maximumConcurrentDatabaseReads = 6;
const slowDatabaseCooldownMs = 30000;
const recentOrdersCacheTtlMs = 3000;
const servicesCacheTtlMs = 5000;
const rotationStateCacheTtlMs = 250;
const failedLoginAttempts = new Map();
const activeNumberCache = new Map();
const slowDatabases = new Map();
const clientStatusCache = new Map();
const serviceAllocationOperations = new Map();
let recentOrdersCache = null;
let configuredServicesCache = null;
let configuredServicesReadPromise = null;
let lastRuntimeCachePruneAt = 0;
const compressedStaticAssets = new Map();
const sharedDatabaseJsonCache = new Map();
const sharedDatabaseJsonInflight = new Map();
const sharedDatabaseJsonErrors = new Map();
let sharedDatabaseJsonCacheBytes = 0;
let activeDatabaseReads = 0;
const queuedDatabaseReads = [];
let rotationSettingsCache = null;
let rotationStateCache = null;
let rotationOperation = Promise.resolve();
let recentOrderOtpScanPromise = null;
let deviceStatsJob = null;

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

function getCompressedStaticAsset(assetPath, content) {
  const contentHash = createHash("sha256").update(content).digest("hex");
  let cached = compressedStaticAssets.get(assetPath);
  if (!cached || cached.contentHash !== contentHash) {
    cached = { contentHash, body: gzipSync(content) };
    compressedStaticAssets.set(assetPath, cached);
  }
  return cached.body;
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
  const normalized = services.map((service) => {
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
  return normalizeServiceNames(normalized);
}

function validateServiceList(services) {
  if (!Array.isArray(services)) return "Provide services as an array.";
  const names = new Set();
  const ids = new Set();
  for (const service of services) {
    if (!service || typeof service !== "object" || Array.isArray(service)
      || typeof service.id !== "string" || !service.id.trim() || service.id.length > 100
      || typeof service.name !== "string" || !service.name.trim() || service.name.length > 60
      || /\s/.test(service.name)
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
      || template.text.length > 5000 || !/(?:\{\{OTP\}\}|\[OTP\])/i.test(template.text)
      || typeof template.enabled !== "boolean")) {
      return "Each template needs message text, an OTP placeholder, and an enabled state.";
    }
    const name = service.name.trim().toLowerCase();
    if (names.has(name)) return "Service names must be unique.";
    if (ids.has(service.id)) return "Service IDs must be unique.";
    names.add(name);
    ids.add(service.id);
  }
  return null;
}

async function loadConfiguredServices() {
  let contents;
  try {
    contents = await readFile(servicesDataPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const value = { initialized: false, services: [] };
      configuredServicesCache = { value, expiresAt: Date.now() + servicesCacheTtlMs };
      return value;
    }
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
  const value = { initialized: true, services };
  configuredServicesCache = { value, expiresAt: Date.now() + servicesCacheTtlMs };
  return value;
}

async function readConfiguredServices() {
  if (configuredServicesCache && configuredServicesCache.expiresAt > Date.now()) {
    return configuredServicesCache.value;
  }
  if (configuredServicesReadPromise) return configuredServicesReadPromise;

  const pending = loadConfiguredServices();
  configuredServicesReadPromise = pending;
  try {
    return await pending;
  } finally {
    if (configuredServicesReadPromise === pending) configuredServicesReadPromise = null;
  }
}

async function saveConfiguredServices(services) {
  await writeJsonAtomically(servicesDataPath, services);
  configuredServicesCache = null;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") console.error("Could not remove temporary data file:", error.message);
    });
  }
}

function normalizeRotatingDatabaseUrls(values, allowEmpty = false) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
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
        return await withDatabaseReadSlot(async () => {
          const response = await fetch(`${url}/clients.json?shallow=true`, {
            signal: AbortSignal.timeout(6000)
          });
          if (!response.ok) return { url, reason: `Firebase returned HTTP ${response.status}` };
          try {
            await readUpstreamJson(response, 1024 * 1024);
          } catch {
            return { url, reason: "Firebase returned invalid or oversized JSON" };
          }
          return { url, working: true };
        });
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

async function pingDatabaseUrl(url) {
  try {
    return await withDatabaseReadSlot(async () => {
      const response = await fetch(`${url}/clients.json?shallow=true`, {
        signal: AbortSignal.timeout(6000)
      });
      if (response.status !== 200) {
        return { ok: false, reason: `Firebase returned HTTP ${response.status}; only HTTP 200 URLs are accepted.` };
      }
      try {
        await readUpstreamJson(response, 1024 * 1024);
      } catch {
        return { ok: false, reason: "Firebase returned invalid or oversized JSON." };
      }
      return { ok: true };
    });
  } catch (error) {
    return {
      ok: false,
      reason: error.name === "TimeoutError"
        ? "Firebase connection timed out."
        : "Firebase connection failed."
    };
  }
}

function normalizeOrderOtpHistory(order) {
  const legacyHistory = order.receivedOtp === null || order.receivedOtp === undefined
    ? []
    : [{ code: order.receivedOtp, receivedAt: order.receivedAt, messageKey: null }];
  const history = order.receivedOtps === undefined ? legacyHistory : order.receivedOtps;
  if (!Array.isArray(history)
    || history.some((entry) => !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof entry.code !== "string"
      || !/^\d{1,32}$/.test(entry.code)
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
  if (!Array.isArray(history)
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
  if (rotationStateCache && rotationStateCache.expiresAt > Date.now()) {
    return cloneRotationState(rotationStateCache.value);
  }
  let contents;
  try {
    contents = await readFile(rotationDataPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const state = { initialized: false, databaseUrls: [databaseUrl], serviceUsage: Object.create(null), orders: [] };
      rotationStateCache = { value: cloneRotationState(state), expiresAt: Date.now() + rotationStateCacheTtlMs };
      return state;
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
  const databaseUrls = normalizeRotatingDatabaseUrls(stored.databaseUrls, true);
  if (!stored.serviceUsage || typeof stored.serviceUsage !== "object" || Array.isArray(stored.serviceUsage)) {
    throw new Error("The database rotation usage data has an invalid format.");
  }
  const serviceUsage = Object.create(null);
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
      cursorUrl: databaseUrls.includes(state.cursorUrl) ? state.cursorUrl : databaseUrls[0] || "",
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
      || !(order.receivedOtp === null || (typeof order.receivedOtp === "string" && /^\d{1,32}$/.test(order.receivedOtp)))
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
  const state = { initialized: true, databaseUrls, serviceUsage, orders };
  rotationStateCache = { value: cloneRotationState(state), expiresAt: Date.now() + rotationStateCacheTtlMs };
  return state;
}

function cloneRotationState(state) {
  return {
    initialized: state.initialized,
    databaseUrls: [...state.databaseUrls],
    serviceUsage: Object.assign(Object.create(null), Object.fromEntries(
      Object.entries(state.serviceUsage).map(([service, usage]) => [service, {
        ...usage,
        usedNumbers: [...usage.usedNumbers]
      }])
    )),
    orders: state.orders.map((order) => ({
      ...order,
      receivedOtps: order.receivedOtps.map((otp) => ({ ...otp })),
      messageHistory: order.messageHistory.map((entry) => ({ ...entry }))
    }))
  };
}

async function saveRotationState(state) {
  await writeJsonAtomically(rotationDataPath, {
    databaseUrls: state.databaseUrls,
    serviceUsage: state.serviceUsage,
    orders: state.orders
  });
  recentOrdersCache = null;
  rotationSettingsCache = null;
  rotationStateCache = { value: cloneRotationState({ ...state, initialized: true }), expiresAt: Date.now() + rotationStateCacheTtlMs };
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

async function withDatabaseReadSlot(operation) {
  if (activeDatabaseReads >= maximumConcurrentDatabaseReads || queuedDatabaseReads.length > 0) {
    if (queuedDatabaseReads.length >= 256) {
      const error = new Error("Firebase request capacity is full.");
      error.status = 503;
      error.retryAfterMs = 1000;
      throw error;
    }
    await new Promise((resolve) => queuedDatabaseReads.push(resolve));
  }
  activeDatabaseReads += 1;
  try {
    return await operation();
  } finally {
    activeDatabaseReads = Math.max(0, activeDatabaseReads - 1);
    queuedDatabaseReads.shift()?.();
  }
}

async function readUpstreamText(response, maximumBytes) {
  const contentLengthHeader = response.headers && typeof response.headers.get === "function"
    ? response.headers.get("content-length")
    : null;
  const contentLength = Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    const error = new Error("Upstream response exceeded the configured size limit.");
    error.code = "RESPONSE_TOO_LARGE";
    throw error;
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      const error = new Error("Upstream response exceeded the configured size limit.");
      error.code = "RESPONSE_TOO_LARGE";
      throw error;
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buffer = Buffer.from(chunk.value);
      totalBytes += buffer.length;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        const error = new Error("Upstream response exceeded the configured size limit.");
        error.code = "RESPONSE_TOO_LARGE";
        throw error;
      }
      chunks.push(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readUpstreamJson(response, maximumBytes) {
  const text = await readUpstreamText(response, maximumBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Upstream returned invalid JSON.");
  }
}

async function fetchDatabaseJson(endpoint, timeoutMs = 15000, parentSignal = null, onResponseBytes = null) {
  return withDatabaseReadSlot(async () => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortForParent = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", abortForParent, { once: true });
    }
    try {
      const response = await fetch(endpoint, { signal: controller.signal });
      if (!response.ok) {
        const error = new Error("Firebase request failed.");
        error.status = response.status;
        const retryAfter = response.headers && typeof response.headers.get === "function"
          ? response.headers.get("retry-after")
          : null;
        if (retryAfter) {
          const retryAfterSeconds = Number(retryAfter);
          error.retryAfterMs = Number.isFinite(retryAfterSeconds)
            ? Math.max(0, retryAfterSeconds * 1000)
            : Math.max(0, Date.parse(retryAfter) - Date.now());
        }
        throw error;
      }
      try {
        const contentLengthHeader = response.headers && typeof response.headers.get === "function"
          ? response.headers.get("content-length")
          : null;
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maximumDatabaseJsonBytes) {
          const error = new Error("Firebase response exceeded the configured size limit.");
          error.code = "RESPONSE_TOO_LARGE";
          throw error;
        }
        if (!response.body?.getReader) {
          onResponseBytes?.(Number.isFinite(contentLength) ? contentLength : 0);
          return await response.json();
        }
        const reader = response.body.getReader();
        const chunks = [];
        let totalBytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const buffer = Buffer.from(chunk.value);
            totalBytes += buffer.length;
            if (totalBytes > maximumDatabaseJsonBytes) {
              await reader.cancel();
              const error = new Error("Firebase response exceeded the configured size limit.");
              error.code = "RESPONSE_TOO_LARGE";
              throw error;
            }
            chunks.push(buffer);
          }
        } finally {
          reader.releaseLock();
        }
        onResponseBytes?.(totalBytes);
        return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
      } catch (error) {
        if (error.code === "RESPONSE_TOO_LARGE") throw error;
        if (error.name === "AbortError" || error.name === "TimeoutError") throw error;
        throw new Error("Firebase returned invalid JSON.");
      }
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error("Firebase request timed out.");
        timeoutError.name = "TimeoutError";
        timeoutError.code = "UPSTREAM_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
    }
  });
}

function deleteSharedDatabaseCacheEntry(key) {
  const cached = sharedDatabaseJsonCache.get(key);
  if (!cached) return;
  sharedDatabaseJsonCacheBytes = Math.max(0, sharedDatabaseJsonCacheBytes - cached.bytes);
  sharedDatabaseJsonCache.delete(key);
}

function pruneSharedDatabaseJsonCache(now = Date.now()) {
  for (const [key, entry] of sharedDatabaseJsonCache) {
    if (entry.expiresAt <= now) deleteSharedDatabaseCacheEntry(key);
  }
  for (const [key, entry] of sharedDatabaseJsonErrors) {
    if (entry.expiresAt <= now) sharedDatabaseJsonErrors.delete(key);
  }
  while (sharedDatabaseJsonCache.size > sharedDatabaseJsonCacheLimit
    || sharedDatabaseJsonCacheBytes > maximumSharedDatabaseJsonCacheBytes) {
    const first = sharedDatabaseJsonCache.keys().next();
    if (first.done) break;
    deleteSharedDatabaseCacheEntry(first.value);
  }
  while (sharedDatabaseJsonErrors.size > sharedDatabaseJsonCacheLimit) {
    const first = sharedDatabaseJsonErrors.keys().next();
    if (first.done) break;
    sharedDatabaseJsonErrors.delete(first.value);
  }
}

function subscribeToSharedDatabaseRead(entry, parentSignal) {
  entry.subscribers += 1;
  let abortListener = null;
  const subscriberAbort = parentSignal && new Promise((resolve, reject) => {
    abortListener = () => {
      const error = new Error("Database read was cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    if (parentSignal.aborted) abortListener();
    else parentSignal.addEventListener("abort", abortListener, { once: true });
  });
  const result = subscriberAbort
    ? Promise.race([entry.promise, subscriberAbort])
    : entry.promise;
  return result.finally(() => {
    if (parentSignal && abortListener) {
      parentSignal.removeEventListener("abort", abortListener);
    }
    entry.subscribers = Math.max(0, entry.subscribers - 1);
    if (!entry.settled && entry.subscribers === 0) entry.controller.abort();
  });
}

async function fetchSharedDatabaseJson(endpoint, timeoutMs, ttlMs, parentSignal = null) {
  const now = Date.now();
  const cached = sharedDatabaseJsonCache.get(endpoint);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) deleteSharedDatabaseCacheEntry(endpoint);

  const recentError = sharedDatabaseJsonErrors.get(endpoint);
  if (recentError && recentError.expiresAt > now) throw recentError.error;
  if (recentError) sharedDatabaseJsonErrors.delete(endpoint);

  const pending = sharedDatabaseJsonInflight.get(endpoint);
  if (pending) return subscribeToSharedDatabaseRead(pending, parentSignal);

  let responseBytes = 0;
  const entry = { controller: new AbortController(), subscribers: 0, settled: false, promise: null };
  entry.promise = fetchDatabaseJson(endpoint, timeoutMs, entry.controller.signal, (bytes) => {
    responseBytes = bytes;
  })
    .then((value) => {
      sharedDatabaseJsonErrors.delete(endpoint);
      if (responseBytes <= maximumSharedDatabaseJsonEntryBytes) {
        deleteSharedDatabaseCacheEntry(endpoint);
        sharedDatabaseJsonCache.set(endpoint, {
          value,
          bytes: responseBytes,
          expiresAt: Date.now() + ttlMs
        });
        sharedDatabaseJsonCacheBytes += responseBytes;
        pruneSharedDatabaseJsonCache();
      }
      return value;
    })
    .catch((error) => {
      if (entry.controller.signal.aborted) throw error;
      const cooldownMs = Math.max(
        sharedDatabaseErrorTtlMs,
        Math.min(error.retryAfterMs || 0, 10000)
      );
      sharedDatabaseJsonErrors.set(endpoint, {
        error,
        expiresAt: Date.now() + cooldownMs
      });
      pruneSharedDatabaseJsonCache();
      throw error;
    })
    .finally(() => {
      entry.settled = true;
      if (sharedDatabaseJsonInflight.get(endpoint) === entry) {
        sharedDatabaseJsonInflight.delete(endpoint);
      }
    });
  const request = entry.promise;
  sharedDatabaseJsonInflight.set(endpoint, entry);
  return subscribeToSharedDatabaseRead(entry, parentSignal);
}

function cacheActiveNumber(database, candidate) {
  const key = `${database}|${candidate.deviceId}`;
  activeNumberCache.set(key, {
    number: candidate.number,
    expiresAt: Date.now() + activeNumberCacheTtlMs
  });
  if (activeNumberCache.size > 5000) {
    const iterator = activeNumberCache.keys();
    while (activeNumberCache.size > 4000) {
      const next = iterator.next();
      if (next.done) break;
      activeNumberCache.delete(next.value);
    }
  }
}

async function readActiveNumbers(database, isAvailable = () => true, parentSignal = null) {
  const clients = await fetchSharedDatabaseJson(
    `${database}/clients.json`,
    numberFetchTimeoutMs,
    activeClientsCacheTtlMs
  );
  if (parentSignal?.aborted) return { numbers: [], messageReadFailures: 0 };
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

  const numbers = new Map();
  let messageReadFailures = 0;
  let upstreamError = null;
  const batchController = new AbortController();
  const abortForParent = () => batchController.abort();
  if (parentSignal) {
    if (parentSignal.aborted) batchController.abort();
    else parentSignal.addEventListener("abort", abortForParent, { once: true });
  }
  const now = Date.now();
  const uncachedClients = [];
  for (const [deviceId] of activeClients) {
    const key = `${database}|${deviceId}`;
    const cached = activeNumberCache.get(key);
    if (cached && cached.expiresAt > now) {
      if (cached.number) {
        const candidate = { deviceId, number: cached.number };
        numbers.set(cached.number, candidate);
        if (isAvailable({ ...candidate, database })) {
          if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
          return { numbers: [candidate], messageReadFailures };
        }
      }
      continue;
    }
    uncachedClients.push([deviceId]);
  }
  const offset = randomInt(Math.max(1, uncachedClients.length));
  const candidates = uncachedClients.length
    ? uncachedClients.map((_, index) => uncachedClients[(offset + index) % uncachedClients.length])
    : [];
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = candidates.slice(index, index + 8);
    const reads = batch.map(async ([deviceId]) => ({
      deviceId,
      number: getLatestCarrierNumber(await fetchSharedDatabaseJson(
        database + "/messages/" + encodeURIComponent(deviceId) + ".json",
        numberFetchTimeoutMs,
        numberMessagesCacheTtlMs,
        batchController.signal
      ))
    }));
    try {
      const available = await Promise.any(reads.map(async (read) => {
        const candidate = await read;
        cacheActiveNumber(database, candidate);
        if (candidate.number && isAvailable({ ...candidate, database })) {
          batchController.abort();
          return candidate;
        }
        throw new Error("No eligible number in this device record.");
      }));
      return { numbers: [available], messageReadFailures };
    } catch {
      // No eligible number in this batch; inspect its results for recycling and errors.
    }
    const results = await Promise.allSettled(reads);
    for (const result of results) {
      if (result.status === "rejected") {
        messageReadFailures += 1;
        if (!upstreamError && (result.reason?.status || result.reason?.code)) {
          upstreamError = result.reason;
        }
      } else if (result.value.number && !numbers.has(result.value.number)) {
        cacheActiveNumber(database, result.value);
        numbers.set(result.value.number, result.value);
      } else if (result.status === "fulfilled") {
        cacheActiveNumber(database, result.value);
      }
    }
    if (parentSignal?.aborted) {
      if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
      return { numbers: [...numbers.values()], messageReadFailures, upstreamError };
    }
    if ([...numbers.values()].some(isAvailable)) {
      if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
      return { numbers: [...numbers.values()], messageReadFailures };
    }
  }
  if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
  return { numbers: [...numbers.values()], messageReadFailures, upstreamError };
}

function recordSlowDatabase(database, error) {
  const message = error?.name === "TimeoutError" || error?.name === "AbortError"
    ? "Database timed out"
    : "Database request failed";
  slowDatabases.set(database, { expiresAt: Date.now() + slowDatabaseCooldownMs, message });
}

async function readRotatingDeviceStats() {
  const databaseUrls = await withRotationLock(async () => {
    const state = await readRotationState();
    return [...state.databaseUrls];
  });
  const failedDatabases = [];
  const missingDatabaseUrls = [];
  let scannedDatabases = 0;
  let deviceCount = 0;
  let activeDeviceCount = 0;

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
        const status = result.reason && result.reason.status;
        const reason = status === 404
          ? "clients.json was not found (HTTP 404); removed from rotation."
          : result.reason.message;
        failedDatabases.push({ url, reason });
        if (status === 404) missingDatabaseUrls.push(url);
        continue;
      }
      const records = result.value.records;
      if (records === null) {
        missingDatabaseUrls.push(url);
        continue;
      }
      if (records !== null && (typeof records !== "object" || Array.isArray(records))) {
        failedDatabases.push({ url, reason: "Firebase returned an invalid clients list." });
        continue;
      }
      scannedDatabases += 1;
      if (!records) continue;
      for (const [deviceId, client] of Object.entries(records)) {
        if (!isValidDatabaseKey(deviceId)) continue;
        deviceCount += 1;
        if (client && typeof client === "object" && !Array.isArray(client)
          && client.status === true) {
          activeDeviceCount += 1;
        }
      }
    }
  }

  const removedDatabases = missingDatabaseUrls.length
    ? await withRotationLock(async () => {
      const state = await readRotationState();
      const missing = new Set(missingDatabaseUrls);
      const removed = state.databaseUrls.filter((url) => missing.has(url));
      if (!removed.length) return [];
      state.databaseUrls = state.databaseUrls.filter((url) => !missing.has(url));
      for (const serviceState of Object.values(state.serviceUsage)) {
        if (!state.databaseUrls.includes(serviceState.cursorUrl)) {
          serviceState.cursorUrl = state.databaseUrls[0] || "";
        }
      }
      await saveRotationState(state);
      return removed;
    })
    : [];

  return {
    databaseCount: databaseUrls.length,
    remainingDatabaseCount: databaseUrls.length - removedDatabases.length,
    scannedDatabases,
    failedDatabases,
    removedDatabases,
    deviceCount,
    activeDeviceCount,
    offlineDeviceCount: deviceCount - activeDeviceCount
  };
}

async function runRotatingDeviceStatsJob(jobId) {
  try {
    const result = await readRotatingDeviceStats();
    deviceStatsJob = {
      id: jobId,
      status: "completed",
      result,
      error: result.failedDatabases.length > 0 && result.scannedDatabases === 0
        ? "Could not read clients.json from any configured database."
        : null,
      finishedAt: Date.now()
    };
  } catch (error) {
    console.error("Could not count devices across rotating databases:", error.message);
    deviceStatsJob = {
      id: jobId,
      status: "failed",
      result: null,
      error: "Could not count devices across configured databases.",
      finishedAt: Date.now()
    };
  }
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

async function readActiveNumberInventories(service, rotationState) {
  const configuredUrls = rotationState.databaseUrls;
  const serviceState = Object.hasOwn(rotationState.serviceUsage, service) ? rotationState.serviceUsage[service] : {
    cursorUrl: configuredUrls[0], usedNumbers: [], cycle: 0
  };
  const startIndex = Math.max(0, configuredUrls.indexOf(serviceState.cursorUrl));
  const orderedUrls = configuredUrls.map((_, index) => configuredUrls[(startIndex + index) % configuredUrls.length]);
  const usedNumbers = new Set(serviceState.usedNumbers);
  const lockedNumbers = new Set(rotationState.orders
    .filter((order) => order.service === service && order.receivedOtp !== null)
    .map((order) => order.number));
  const isAvailable = (candidate) => !usedNumbers.has(candidate.number)
    && !lockedNumbers.has(candidate.number)
    && !reservedNumbers.has(candidate.number);
  const now = Date.now();
  const healthyUrls = orderedUrls.filter((database) => (slowDatabases.get(database)?.expiresAt || 0) <= now);
  const scanUrls = healthyUrls.length
    ? healthyUrls
    : orderedUrls.slice().sort((left, right) =>
      (slowDatabases.get(left)?.expiresAt || 0) - (slowDatabases.get(right)?.expiresAt || 0)).slice(0, 1);
  const inventories = [];
  const failures = [];
  let complete = scanUrls.length === orderedUrls.length;
  let stoppedEarly = false;
  const controller = new AbortController();
  let nextIndex = 0;
  let foundAvailable = false;
  const scanDatabase = async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= scanUrls.length) return;
      const database = scanUrls[index];
      try {
        const inventory = { database, ...await readActiveNumbers(database, isAvailable, controller.signal) };
        if (controller.signal.aborted) return;
        inventories.push(inventory);
        if (inventory.numbers.some(isAvailable)) {
          foundAvailable = true;
          stoppedEarly = true;
          complete = false;
          controller.abort();
          return;
        }
        if (inventory.messageReadFailures > 0) {
          const error = new Error("Some device message reads failed.");
          recordSlowDatabase(database, error);
          failures.push({ database, error });
          complete = false;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        recordSlowDatabase(database, error);
        failures.push({ database, error });
        complete = false;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(databasePingConcurrency, scanUrls.length) },
    scanDatabase
  ));
  if (foundAvailable) complete = false;
  return { inventories, complete, stoppedEarly, failures };
}

function findAvailableNumberCandidate(service, rotationState, inventories, allowRecycle = true) {
  const configuredUrls = rotationState.databaseUrls;
  const serviceState = Object.hasOwn(rotationState.serviceUsage, service) ? rotationState.serviceUsage[service] : {
    cursorUrl: configuredUrls[0], usedNumbers: [], cycle: 0
  };
  const startIndex = Math.max(0, configuredUrls.indexOf(serviceState.cursorUrl));
  const orderedUrls = configuredUrls.map((_, index) => configuredUrls[(startIndex + index) % configuredUrls.length]);
  const inventoryByUrl = new Map(inventories.map((inventory) => [inventory.database, inventory]));
  const orderedInventories = orderedUrls.map((database) => inventoryByUrl.get(database)).filter(Boolean);
  const usedNumbers = new Set(serviceState.usedNumbers);
  const lockedNumbers = new Set(rotationState.orders
    .filter((order) => order.service === service && order.receivedOtp !== null)
    .map((order) => order.number));

  for (const inventory of orderedInventories) {
    const { database } = inventory;
    const available = inventory.numbers.filter((candidate) =>
      !usedNumbers.has(candidate.number)
      && !lockedNumbers.has(candidate.number)
      && !reservedNumbers.has(candidate.number));
    if (available.length > 0) {
      return { database, candidate: available[randomInt(available.length)], serviceState };
    }
  }

  const failedInventory = orderedInventories.find((inventory) => inventory.messageReadFailures > 0);
  if (failedInventory) {
    const error = new Error(`Could not read every active client in database ${failedInventory.database}.`);
    error.status = failedInventory.upstreamError?.status;
    error.retryAfterMs = failedInventory.upstreamError?.retryAfterMs;
    error.code = failedInventory.upstreamError?.code;
    throw error;
  }

  const allNumbers = new Set(orderedInventories.flatMap((inventory) =>
    inventory.numbers.map((candidate) => candidate.number)));
  if (!allowRecycle) return null;
  const recyclableNumbers = [...allNumbers].filter((number) => !lockedNumbers.has(number));
  if (recyclableNumbers.length === 0) return null;
  if (recyclableNumbers.some((number) => !usedNumbers.has(number))) return null;

  const recycledServiceState = {
    cursorUrl: serviceState.cursorUrl,
    usedNumbers: [],
    cycle: serviceState.cycle + 1
  };
  for (const inventory of orderedInventories) {
    const available = inventory.numbers.filter((candidate) =>
      !lockedNumbers.has(candidate.number) && !reservedNumbers.has(candidate.number));
    if (available.length > 0) {
      return {
        database: inventory.database,
        candidate: available[randomInt(available.length)],
        serviceState: recycledServiceState
      };
    }
  }
  rotationState.serviceUsage[service] = recycledServiceState;
  return null;
}

async function withServiceAllocationLock(service, operation) {
  const previous = serviceAllocationOperations.get(service) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  serviceAllocationOperations.set(service, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (serviceAllocationOperations.get(service) === current) {
      serviceAllocationOperations.delete(service);
    }
  }
}

async function findAvailableActiveNumber(service) {
  return withServiceAllocationLock(service, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await withRotationLock(async () => {
        const state = await readRotationState();
        if (synchronizeNumberReservations(state)) await saveRotationState(state);
        return state;
      });
      const snapshotUsage = JSON.stringify(snapshot.serviceUsage[service] || null);
      const inventoryScan = await readActiveNumberInventories(service, snapshot);
      const result = await withRotationLock(async () => {
        const state = await readRotationState();
        if (synchronizeNumberReservations(state)) await saveRotationState(state);
        if (JSON.stringify(state.databaseUrls) !== JSON.stringify(snapshot.databaseUrls)
          || JSON.stringify(state.serviceUsage[service] || null) !== snapshotUsage) {
          return { retry: true };
        }
        const previousUsage = JSON.stringify(state.serviceUsage[service] || null);
        const candidate = findAvailableNumberCandidate(
          service, state, inventoryScan.inventories, inventoryScan.complete
        );
        if (!candidate) {
          if (inventoryScan.stoppedEarly) return { retry: true };
          if (inventoryScan.failures.length > 0) {
            const upstreamError = inventoryScan.failures[0].error;
            const error = new Error("One or more Firebase databases could not be read.");
            error.status = upstreamError?.status;
            error.retryAfterMs = upstreamError?.retryAfterMs;
            error.code = upstreamError?.code;
            throw error;
          }
          if (JSON.stringify(state.serviceUsage[service] || null) !== previousUsage) {
            await saveRotationState(state);
          }
          return { reservation: null };
        }
        return {
          reservation: await reserveNumber(
            service, candidate.database, candidate.candidate, candidate.serviceState, state
          )
        };
      });
      if (!result.retry) return result.reservation;
    }
    throw new Error("Number allocation changed repeatedly. Please retry.");
  });
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
    : entry.code === match.code && entry.receivedAt === match.receivedAt);
  if (duplicate) return false;
  order.receivedOtps.push({
    code: match.code,
    receivedAt: match.receivedAt,
    messageKey: match.messageKey || null
  });
  order.receivedOtps.sort((left, right) => left.receivedAt - right.receivedAt);
  const latest = order.receivedOtps.at(-1);
  order.receivedOtp = latest.code;
  order.receivedAt = latest.receivedAt;
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
    const cacheNow = Date.now();
    if (cacheNow - lastRuntimeCachePruneAt > 60000) {
      for (const [key, entry] of clientStatusCache) {
        if (entry.expiresAt <= cacheNow) clientStatusCache.delete(key);
      }
      for (const [key, entry] of activeNumberCache) {
        if (entry.expiresAt <= cacheNow) activeNumberCache.delete(key);
      }
      for (const [key, entry] of slowDatabases) {
        if (entry.expiresAt <= cacheNow) slowDatabases.delete(key);
      }
      lastRuntimeCachePruneAt = cacheNow;
    }
    const activeOrderIds = new Set(snapshot.map((order) => order.orderId));
    for (const orderId of recentOrderOtpChecks.keys()) {
      if (!activeOrderIds.has(orderId)) recentOrderOtpChecks.delete(orderId);
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
      .map((service) => [normalizeServiceName(service.name).toLowerCase(), service]));
    const now = Date.now();
    const candidates = snapshot.filter((order) => {
      const lastCheck = recentOrderOtpChecks.get(order.orderId) || 0;
      return now - lastCheck >= recentOrderOtpScanIntervalMs;
    });
    if (!candidates.length) return;

    const matches = [];
    const numberStatusUpdates = [];
    const groups = new Map();
    for (const order of candidates) {
      const key = JSON.stringify([order.databaseUrl, order.deviceId]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(order);
    }
    const scanDevice = async ([groupKey, orders]) => {
      for (const order of orders) recentOrderOtpChecks.set(order.orderId, now);
      const [databaseUrl, deviceId] = JSON.parse(groupKey);
      const clientStatusKey = groupKey;
      const cachedStatus = clientStatusCache.get(clientStatusKey);
      let numberActive;
      if (cachedStatus && cachedStatus.expiresAt > Date.now()) {
        numberActive = cachedStatus.numberActive;
      } else {
        try {
      const client = await fetchSharedDatabaseJson(
            `${databaseUrl}/clients/${encodeURIComponent(deviceId)}.json`,
            8000,
            1000
          );
          numberActive = client?.status === true;
          clientStatusCache.set(clientStatusKey, { numberActive, expiresAt: Date.now() + recentOrderOtpScanIntervalMs });
        } catch (error) {
          console.error(`Could not check active status for recent order ${orders[0].orderId}:`, error.message);
        }
      }
      if (numberActive !== undefined) {
        for (const order of orders) numberStatusUpdates.push({ orderId: order.orderId, numberActive });
      }
      const matchingOrders = orders.map((order) => ({
        order,
        service: services.get(normalizeServiceName(order.service.trim()).toLowerCase())
      })).filter((entry) => entry.service);
      if (!matchingOrders.length) return;
      try {
        const messages = await fetchSharedDatabaseJson(
          `${databaseUrl}/messages/${encodeURIComponent(deviceId)}.json`,
          8000,
          numberMessagesCacheTtlMs
        );
        for (const { order, service } of matchingOrders) {
          const knownMessageKeys = new Set((order.messageHistory || [])
            .map((entry) => entry.key));
          const knownKeys = new Set((order.receivedOtps || [])
            .map((entry) => entry.messageKey)
            .filter(Boolean));
          const knownFallbacks = new Set((order.receivedOtps || [])
            .filter((entry) => !entry.messageKey)
            .map((entry) => `${entry.code}:${entry.receivedAt}`));
          const untilTimestamp = Math.min(Date.now(), order.expiresAt);
          for (const message of findMatchingMessages(messages, order.createdAt, service, untilTimestamp)) {
            if (knownMessageKeys.has(message.key)) continue;
            if (!knownKeys.has(message.key)
              && !knownFallbacks.has(`${message.code}:${message.timestamp}`)) {
              matches.push({ orderId: order.orderId, message });
            }
          }
        }
      } catch (error) {
        console.error(`Could not scan messages for recent order ${orders[0].orderId}:`, error.message);
      }
    };
    const deviceGroups = [...groups.entries()];
    for (let index = 0; index < deviceGroups.length; index += recentOtpScanConcurrency) {
      await Promise.all(deviceGroups.slice(index, index + recentOtpScanConcurrency).map(scanDevice));
    }
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

  if (action === "getHealth") {
    sendText(response, 200, "OK");
    return;
  }
  if (action === "getBalance") {
    sendText(response, 200, "ACCESS_BALANCE:1");
    return;
  }

  if (action === "getNumber") {
    const services = requestUrl.searchParams.getAll("service");
    if (services.length !== 1 || !services[0].trim() || services[0].trim().length > 60) {
      sendText(response, 400, "BAD_SERVICE");
      return;
    }
    const service = normalizeServiceName(services[0].trim()).toLowerCase();
    let configuredServices;
    try {
      configuredServices = await readConfiguredServices();
    } catch (error) {
      console.error("Could not read configured services:", error.message);
      sendJson(response, 500, { error: "Could not read configured services." });
      return;
    }
    if (!configuredServices.services.some((item) => normalizeServiceName(item.name).toLowerCase() === service
      && item.enabled === true && getEnabledTemplates(item).length > 0)) {
      sendText(response, 200, "BAD_SERVICE");
      return;
    }
    let reservation;
    try {
      reservation = await findAvailableActiveNumber(service);
    } catch (error) {
      console.error("Could not select an active client number:", error.message);
      const temporarilyUnavailable = [429, 500, 502, 503, 504].includes(error.status)
        || error.name === "AbortError" || error.name === "TimeoutError";
      const headers = error.retryAfterMs > 0
        ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) }
        : {};
      sendJson(response, temporarilyUnavailable ? 503 : 502, {
        error: error.code === "RESPONSE_TOO_LARGE"
          ? "Firebase response exceeded the 4 MB safety limit."
          : temporarilyUnavailable
            ? "The configured databases are temporarily unavailable. Retry shortly."
            : "Could not select an active-client number from the configured databases.",
        code: error.code === "RESPONSE_TOO_LARGE"
          ? "UPSTREAM_RESPONSE_TOO_LARGE"
          : "UPSTREAM_UNAVAILABLE"
      }, headers);
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
  if (reservation.expiresAt <= Date.now()) {
    sendText(response, 200, reservation.receivedOtp !== null
      ? `STATUS_OK:${reservation.receivedOtp}`
      : "STATUS_CANCEL");
    return;
  }
  if (action === "getStatus") {
    let messages;
    try {
      messages = await fetchSharedDatabaseJson(
        `${reservation.databaseUrl}/messages/${encodeURIComponent(reservation.deviceId)}.json`,
        5000,
        numberMessagesCacheTtlMs
      );
    } catch (error) {
      const temporarilyUnavailable = [429, 500, 502, 503, 504].includes(error.status)
        || error.name === "AbortError" || error.name === "TimeoutError";
      if (!temporarilyUnavailable) {
        console.error("Could not read messages for a number order:", error.message);
      }
      if (reservation.receivedOtp !== null) {
        sendText(response, 200, `STATUS_OK:${reservation.receivedOtp}`);
        return;
      }
      const headers = error.retryAfterMs > 0
        ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) }
        : {};
      sendJson(response, temporarilyUnavailable ? 503 : 502, {
        error: error.code === "RESPONSE_TOO_LARGE"
          ? "Firebase message data exceeded the 4 MB safety limit."
          : temporarilyUnavailable
            ? "The active client database is temporarily unavailable. Retry shortly."
            : "Could not read SMS messages from the active client.",
        code: error.code === "RESPONSE_TOO_LARGE"
          ? "UPSTREAM_RESPONSE_TOO_LARGE"
          : "UPSTREAM_UNAVAILABLE"
      }, headers);
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
      && normalizeServiceName(service.name).toLowerCase()
        === normalizeServiceName(reservation.service).toLowerCase());
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
  let device;
  try {
    device = await withDatabaseReadSlot(async () => {
      const upstream = await fetch(
        `${requestedDatabase}/devices/${encodeURIComponent(deviceId)}.json`,
        { signal }
      );
      if (!upstream.ok) {
        const error = new Error(`Could not verify the sender device (Firebase HTTP ${upstream.status}).`);
        error.status = upstream.status;
        throw error;
      }
      return readUpstreamJson(upstream, 1024 * 1024);
    });
  } catch (error) {
    console.error("Could not verify SMS sender:", error.message);
    sendJson(response, error.status === 429 ? 503 : 502, {
      error: error.status === 429
        ? "Firebase is temporarily rate limiting requests. Retry shortly."
        : "Could not verify the sender device in Firebase.",
      ...(error.status === 429 ? { code: "UPSTREAM_UNAVAILABLE" } : {})
    }, error.status === 429 ? { "Retry-After": "1" } : {});
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
    const { existing, etag } = await withDatabaseReadSlot(async () => {
      const upstream = await fetch(taskUrl, {
        headers: { "X-Firebase-ETag": "true" },
        signal
      });
      if (!upstream.ok) {
        const error = new Error(`Could not check the new SMS task key (Firebase HTTP ${upstream.status}).`);
        error.status = upstream.status;
        throw error;
      }
      return {
        existing: await readUpstreamJson(upstream, 65536),
        etag: upstream.headers.get("etag")
      };
    });
    if (existing !== null) {
      sendJson(response, 409, { error: "The generated SMS task ID already exists; nothing was overwritten. Please submit again." });
      return;
    }
    if (!etag) {
      sendJson(response, 502, { error: "Firebase did not provide an ETag, so the task was not written." });
      return;
    }

    const writeResponse = await withDatabaseReadSlot(async () => {
      const upstream = await fetch(taskUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag
        },
        body: JSON.stringify(task),
        signal
      });
      const detail = await readUpstreamText(upstream, 65536);
      return { status: upstream.status, ok: upstream.ok, detail };
    });
    if (writeResponse.status === 412) {
      sendJson(response, 409, { error: "The SMS task key changed before writing; nothing was overwritten." });
      return;
    }
    if (!writeResponse.ok) {
      console.error(`Firebase SMS queue write failed (HTTP ${writeResponse.status}):`, writeResponse.detail.slice(0, 500));
      const throttled = writeResponse.status === 429;
      sendJson(response, throttled ? 503 : writeResponse.status, {
        error: throttled ? "Firebase is temporarily rate limiting requests. Retry shortly."
          : `Firebase rejected the SMS task (HTTP ${writeResponse.status}).`,
        ...(throttled ? { code: "UPSTREAM_UNAVAILABLE" } : {})
      }, throttled ? { "Retry-After": "1" } : {});
      return;
    }
    sendJson(response, 201, { id, deviceId, status: "pending" });
  } catch (error) {
    console.error("Could not queue SMS task:", error.message);
    const temporarilyUnavailable = error.status === 429 || error.status === 503;
    sendJson(response, temporarilyUnavailable ? 503 : 502, {
      error: temporarilyUnavailable
        ? "Firebase is temporarily busy. Retry shortly."
        : "Could not confirm the SMS task write. Check Send SMS records before retrying.",
      ...(temporarilyUnavailable ? { code: "UPSTREAM_UNAVAILABLE" } : {})
    }, temporarilyUnavailable ? { "Retry-After": String(Math.ceil((error.retryAfterMs || 1000) / 1000)) } : {});
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
    const result = await withDatabaseReadSlot(async () => {
      const upstream = await fetch(endpoint, {
        redirect: "error",
        signal: AbortSignal.timeout(15000)
      });
      return {
        status: upstream.status,
        contentType: upstream.headers.get("content-type") || "text/plain; charset=utf-8",
        body: await readUpstreamText(upstream, maximumProviderResponseBytes)
      };
    });
    response.writeHead(result.status, {
      "Content-Type": result.contentType,
      "Cache-Control": "no-store"
    });
    response.end(result.body);
  } catch (error) {
    console.error("OTP provider request failed.");
    sendJson(response, error.status === 503 ? 503 : 502, {
      error: error.status === 503 ? "The request queue is temporarily full. Retry shortly."
        : "Could not reach the OTP provider.",
      ...(error.status === 503 ? { code: "UPSTREAM_UNAVAILABLE" } : {})
    }, error.status === 503 ? { "Retry-After": "1" } : {});
  }
}

async function proxyFirebase(response, endpoint) {
  try {
    const result = await withDatabaseReadSlot(async () => {
      const upstream = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
      return { status: upstream.status, body: await readUpstreamText(upstream, maximumDatabaseJsonBytes) };
    });
    response.writeHead(result.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(result.body);
  } catch (error) {
    console.error("Firebase request failed:", error.message);
    const tooLarge = error.code === "RESPONSE_TOO_LARGE";
    const busy = error.status === 503;
    sendJson(response, busy ? 503 : 502, {
      error: tooLarge
        ? "Firebase response exceeded the 4 MB limit. Request a smaller data section."
        : busy ? "Firebase request capacity is temporarily full. Retry shortly."
          : "Could not reach the Firebase database.",
      ...(tooLarge ? { code: "UPSTREAM_RESPONSE_TOO_LARGE" }
        : busy ? { code: "UPSTREAM_UNAVAILABLE" } : {})
    }, busy ? { "Retry-After": "1" } : {});
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
  const requiresExplicitApiKey = isLocalOtpApi
    || requestUrl.pathname === "/api/otp-provider"
    || requestUrl.pathname === "/api/addDatabaseUrl"
    || requestUrl.pathname === "/api/health"
    || requestUrl.pathname === "/api/balance";
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

  if (["/api/health", "/api/balance"].includes(requestUrl.pathname)) {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method Not Allowed");
      return;
    }
    sendJson(response, 200, requestUrl.pathname === "/api/health"
      ? { status: "ok" }
      : { balance: 1, mock: true });
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
    // Recent orders serve saved data only. Upstream OTP checks happen exclusively
    // in the getStatus handler for a specific order id, on demand.
    if (recentOrdersCache && recentOrdersCache.expiresAt > Date.now()) {
      sendJson(response, 200, recentOrdersCache.value);
      return;
    }
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
      const value = { orders };
      recentOrdersCache = { value, expiresAt: Date.now() + recentOrdersCacheTtlMs };
      sendJson(response, 200, value);
    } catch (error) {
      console.error("Could not read recent orders:", error.message);
      sendJson(response, 500, { error: "Could not read recent orders." });
    }
    return;
  }
  if (requestUrl.pathname === "/api/rotation/device-stats") {
    if (request.method === "GET") {
      sendJson(response, 200, deviceStatsJob || { status: "idle" });
      return;
    }
    if (request.method === "POST") {
      if (!deviceStatsJob || deviceStatsJob.status !== "running") {
        const jobId = randomBytes(12).toString("hex");
        const previousResult = deviceStatsJob?.result || deviceStatsJob?.previousResult || null;
        deviceStatsJob = { id: jobId, status: "running", startedAt: Date.now(), previousResult };
        setImmediate(() => { void runRotatingDeviceStatsJob(jobId); });
      }
      sendJson(response, 202, deviceStatsJob);
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.writeHead(405, { Allow: "GET, POST" });
      response.end("Method Not Allowed");
      return;
    }
    return;
  }
  if (requestUrl.pathname === "/api/addDatabaseUrl") {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end("Method Not Allowed");
      return;
    }
    let input;
    try {
      input = await readJsonBody(request, 4096);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
      return;
    }
    if (!input || typeof input.databaseUrl !== "string") {
      sendJson(response, 400, { error: "Provide one Firebase databaseUrl." });
      return;
    }
    try {
      const database = input.databaseUrl.trim();
      if (!database || database.length > 2048) {
        throw new Error("The Firebase databaseUrl is empty or too long.");
      }
      const normalized = normalizeDatabaseUrl(database);
      const ping = await pingDatabaseUrl(normalized);
      if (!ping.ok) {
        sendJson(response, 502, { error: ping.reason, databaseUrl: normalized });
        return;
      }
      const result = await withRotationLock(async () => {
        const state = await readRotationState();
        const alreadyExists = state.databaseUrls.includes(normalized);
        if (!alreadyExists) {
          state.databaseUrls.push(normalized);
          await saveRotationState(state);
        }
        return {
          databaseUrl: normalized,
          added: !alreadyExists,
          databaseUrls: state.databaseUrls
        };
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }
  if (requestUrl.pathname === "/api/rotation") {
    if (request.method === "GET") {
      if (rotationSettingsCache && rotationSettingsCache.expiresAt > Date.now()) {
        sendJson(response, 200, rotationSettingsCache.value);
        return;
      }
      try {
        const state = await withRotationLock(readRotationState);
        const value = {
          initialized: state.initialized,
          databaseUrls: state.databaseUrls
        };
        rotationSettingsCache = { value, expiresAt: Date.now() + recentOrdersCacheTtlMs };
        sendJson(response, 200, value);
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
        input = await readJsonBody(request, maximumServicesRequestBytes);
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
  if (requestUrl.pathname === "/api/services/import-sms-formats") {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end("Method Not Allowed");
      return;
    }
    try {
      const configured = await readConfiguredServices();
      const source = JSON.parse(await readFile(smsFormatsDataPath, "utf8"));
      if (!Array.isArray(source)) throw new Error("The SMS formats file must contain an array.");
      const imported = mergeSmsFormats(configured.services, source);
      const validationError = validateServiceList(imported.services);
      if (validationError) throw new Error(`Imported services are invalid: ${validationError}`);
      if (imported.addedServices > 0 || imported.addedTemplates > 0) {
        await saveConfiguredServices(imported.services);
      }
      sendJson(response, 200, {
        initialized: true,
        sourceServices: source.length,
        sourceFormats: source.reduce((total, entry) =>
          total + (Array.isArray(entry?.formats) ? entry.formats.length : 0), 0),
        ...imported
      });
    } catch (error) {
      console.error("Could not import SMS formats:", error.message);
      sendJson(response, 500, { error: "Could not import SMS formats." });
    }
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
      const acceptsGzip = /(?:^|,|\s)gzip(?:\s|,|$)/i.test(request.headers["accept-encoding"] || "");
      if (!acceptsGzip) {
        response.writeHead(200, {
          "Content-Type": asset.contentType,
          "Cache-Control": "no-store"
        });
        response.end(content);
        return;
      }
      const compressed = getCompressedStaticAsset(asset.path, content);
      response.writeHead(200, {
        "Content-Type": asset.contentType,
        "Content-Encoding": "gzip",
        "Vary": "Accept-Encoding",
        "Cache-Control": "no-store"
      });
      response.end(compressed);
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

server.listen(port, host, () => {
  console.log(`Firebase Data Dashboard is listening on ${host}:${port}`);
});





