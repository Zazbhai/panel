const { createServer } = require("node:http");
const {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} = require("node:crypto");
const { readFile, writeFile, rename, unlink, open } = require("node:fs/promises");
const { gzipSync } = require("node:zlib");
const { getEnabledTemplates, matchServiceMessage } = require("./service-matching-core");
const { mergeSmsFormats, normalizeServiceName, normalizeServiceNames } = require("./service-sms-format-import");
const path = require("node:path");
const { AsyncRuntimeStore } = require("./runtime-store.cjs");

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
const stocksPath = path.join(__dirname, "stocks.html");
const stocksScriptPath = path.join(__dirname, "stocks.js");
const serviceMessagesPath = path.join(__dirname, "service-messages.html");
const serviceMessagesScriptPath = path.join(__dirname, "service-messages.js");
const serviceMatchingScriptPath = path.join(__dirname, "service-matching.js");
const recentOrdersPath = path.join(__dirname, "recent-orders.html");
const recentOrdersScriptPath = path.join(__dirname, "recent-orders.js");
const servicesDataPath = path.join(__dirname, "services.json");
const smsFormatsDataPath = path.join(__dirname, "service-sms-formats.json");
const rotationDataPath = path.join(__dirname, "rotation.json");
const runtimeDataPath = path.join(__dirname, "runtime.sqlite");
const inventoryWorkerLockPath = path.join(__dirname, ".inventory-worker.lock");
let runtimeStorePromise = null;
const maximumServicesRequestBytes = 16 * 1024 * 1024;
const maximumRotationRequestBytes = 1024 * 1024;
const databasePingConcurrency = readPositiveIntegerEnv("NUMBER_DATABASE_CONCURRENCY", 16, 1, 64);
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
const activeNumberCacheTtlMs = 30000;
const numberFetchTimeoutMs = 30000;
const numberStatusCheckTimeoutMs = readPositiveIntegerEnv("NUMBER_STATUS_CHECK_TIMEOUT_MS", 1500, 500, 10000);
const numberStatusCheckDatabaseLimit = readPositiveIntegerEnv("NUMBER_STATUS_CHECK_DATABASE_LIMIT", 64, 1, 128);
// A full sweep spans many databases; keep each verified status usable long
// enough for the leader to complete its next rolling pass.
const activeClientsCacheTtlMs = readPositiveIntegerEnv("ACTIVE_CLIENT_STATUS_TTL_MS", 300000, 10000, 900000);
const numberMessagesCacheTtlMs = 1000;
const sharedDatabaseErrorTtlMs = 750;
const maximumDatabaseJsonBytes = 4 * 1024 * 1024;
const maximumProviderResponseBytes = 1024 * 1024;
const maximumSharedDatabaseJsonEntryBytes = 1024 * 1024;
const maximumSharedDatabaseJsonCacheBytes = 8 * 1024 * 1024;
const sharedDatabaseJsonCacheLimit = 256;
const maximumConcurrentDatabaseReads = readPositiveIntegerEnv("MAX_CONCURRENT_DATABASE_READS", 32, 1, 64);
const backgroundDatabaseReadLimit = Math.max(1, maximumConcurrentDatabaseReads - Math.min(2, maximumConcurrentDatabaseReads - 1));
const numberStatusCheckConcurrency = Math.max(1, Math.min(3, maximumConcurrentDatabaseReads));
const numberStatusCheckDeviceConcurrency = readPositiveIntegerEnv(
  "NUMBER_STATUS_CHECK_DEVICE_CONCURRENCY", 4, 1, 16
);
const numberMappingPrefetchConcurrency = readPositiveIntegerEnv("NUMBER_MAPPING_PREFETCH_CONCURRENCY", 30, 1, 32);
const numberMappingPrefetchIntervalMs = readPositiveIntegerEnv("NUMBER_MAPPING_PREFETCH_INTERVAL_MS", 15000, 5000, 300000);
const numberMappingPrefetchTaskTimeoutMs = readPositiveIntegerEnv(
  "NUMBER_MAPPING_PREFETCH_TASK_TIMEOUT_MS", 12000, 3000, 120000
);
const numberMappingPrefetchWatchdogMs = readPositiveIntegerEnv(
  "NUMBER_MAPPING_PREFETCH_WATCHDOG_MS", 180000, 30000, 600000
);
const numberMappingDiscoveryConcurrency = readPositiveIntegerEnv(
  "NUMBER_MAPPING_DISCOVERY_CONCURRENCY", 2, 1, 8
);
const numberMappingDiscoveryTaskTimeoutMs = readPositiveIntegerEnv(
  "NUMBER_MAPPING_DISCOVERY_TASK_TIMEOUT_MS", 60000, 10000, 300000
);
const numberReadyQueueWaitMs = readPositiveIntegerEnv("NUMBER_READY_QUEUE_WAIT_MS", 100, 10, 1000);
const numberPoolDatabaseConcurrency = readPositiveIntegerEnv("NUMBER_POOL_DATABASE_CONCURRENCY", 2, 1, 8);
const priorityStockDatabaseConcurrency = readPositiveIntegerEnv(
  "PRIORITY_STOCK_DATABASE_CONCURRENCY", 8, 1, 16
);
const priorityStockDatabaseLimit = readPositiveIntegerEnv(
  "PRIORITY_STOCK_DATABASE_LIMIT", 512, 8, 512
);
const priorityStockScanCandidates = readPositiveIntegerEnv(
  "PRIORITY_STOCK_SCAN_CANDIDATES", 256, 32, 2000
);
const numberMappingDeviceConcurrency = readPositiveIntegerEnv(
  "NUMBER_MAPPING_DEVICE_CONCURRENCY",
  Math.max(1, Math.min(4, backgroundDatabaseReadLimit)),
  1, 16
);
const maximumConcurrentProviderReads = readPositiveIntegerEnv("MAX_CONCURRENT_PROVIDER_READS", 16, 1, 64);
const slowDatabaseCooldownMs = 30000;
const recentOrdersCacheTtlMs = 3000;
const servicesCacheTtlMs = 5000;
const rotationStateCacheTtlMs = 250;
const numberPoolSize = readPositiveIntegerEnv("NUMBER_POOL_SIZE", 2000, 1, 5000);
const numberPoolWorkerCount = readPositiveIntegerEnv("NUMBER_POOL_WORKERS", 4, 1, 32);
const numberReadyQueueSize = readPositiveIntegerEnv("NUMBER_READY_QUEUE_SIZE", 2000, 16, 5000);
const numberReadyQueueRefillThreshold = Math.max(1, Math.floor(numberReadyQueueSize / 4));
const numberPoolClaimCandidates = readPositiveIntegerEnv("NUMBER_POOL_CLAIM_CANDIDATES", 2000, 32, 4000);
const numberPoolMaxCandidatePages = readPositiveIntegerEnv("NUMBER_POOL_MAX_CANDIDATE_PAGES", 256, 2, 4096);
const numberPoolRefillThreshold = Math.max(1, Math.floor(numberPoolSize / 4));
const numberPoolWarmServices = readPositiveIntegerEnv("NUMBER_POOL_WARM_SERVICES", 8, 0, 128);
const requestedNumberPoolServices = new Set();
const numberPoolRefillCooldownMs = readPositiveIntegerEnv("NUMBER_POOL_REFILL_COOLDOWN_MS", 1000, 250, 30000);
const numberPoolEmptyCooldownMs = readPositiveIntegerEnv("NUMBER_POOL_EMPTY_COOLDOWN_MS", 5000, 1000, 60000);
const numberPoolWarmupIntervalMs = readPositiveIntegerEnv("NUMBER_POOL_WARMUP_INTERVAL_MS", 10000, 1000, 60000);
const priorityStockWorkerCount = readPositiveIntegerEnv("PRIORITY_STOCK_WORKERS", 10, 1, 10);
const priorityStockTarget = readPositiveIntegerEnv("PRIORITY_STOCK_TARGET", 2000, 1, 5000);
const priorityStockIntervalMs = readPositiveIntegerEnv("PRIORITY_STOCK_INTERVAL_MS", 5000, 1000, 60000);
const priorityStockJobTimeoutMs = readPositiveIntegerEnv("PRIORITY_STOCK_JOB_TIMEOUT_MS", 120000, 1000, 300000);
// Allow a cold API allocation to wait up to thirty seconds for a slow database
// read. Warm-pool requests still return immediately; this only affects cold
// discovery and explicit NUMBER_REQUEST_TIMEOUT_MS overrides.
const numberRequestTimeoutMs = readPositiveIntegerEnv("NUMBER_REQUEST_TIMEOUT_MS", 30000, 1000, 30000);
const failedLoginAttempts = new Map();
const activeNumberCache = new Map();
const numberPools = new Map();
const readyNumberQueues = new Map();
const readyNumberQueueLoads = new Map();
const readyNumberQueueRefreshAfter = new Map();
const activeNumberPoolRefills = new Map();
const numberPoolFailures = new Map();
const serviceAllocationOperations = new Map();
const slowDatabases = new Map();
// A compact freshness marker for clients.json. Large clients.json payloads are
// intentionally excluded from the shared object cache, but their online state
// still remains valid for the short allocation window after a pool scan.
const activeClientsSnapshotFreshUntil = new Map();
const activeClientOnlineIds = new Map();
let recentOrdersCache = null;
let stockSummaryCache = null;
let stockSummaryPending = null;
let numberMappingPrefetchPromise = null;
let numberMappingPrefetchAbortController = null;
let numberMappingPrefetchLastProgressAt = 0;
let numberMappingPrefetchRunId = 0;
let numberPoolWarmupPromise = null;
let numberPoolWarmupTimer = null;
let priorityStockTimer = null;
let priorityStockPromise = null;
let priorityServiceRankCache = null;
let priorityStockScanCursor = 0;
const priorityStockServices = new Set();
let priorityStockState = { status: "idle", checkedAt: null, services: [] };
let numberMappingPrefetchWatchdogTimer = null;
let inventoryWorkerLockHandle = null;
let numberMappingPrefetchState = {
  status: "idle", total: 0, completed: 0, failed: 0, mappings: 0,
  discoveryTotal: 0, discoveryCompleted: 0, startedAt: null, completedAt: null
};
let configuredServicesCache = null;
let configuredServicesReadPromise = null;
const compressedStaticAssets = new Map();
const sharedDatabaseJsonCache = new Map();
const sharedDatabaseJsonInflight = new Map();
const sharedDatabaseJsonErrors = new Map();
let sharedDatabaseJsonCacheBytes = 0;
let activeDatabaseReads = 0;
const queuedDatabaseReads = [];
let databaseReadSequence = 0;
let activeProviderReads = 0;
const queuedProviderReads = [];
let rotationSettingsCache = null;
let rotationStateCache = null;
let rotationOperation = Promise.resolve();
let deviceStatsJob = null;

function readPositiveIntegerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) return fallback;
  return value;
}

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

function makeAbortError(message = "The number request timed out before a number was reserved.") {
  const error = new Error(message);
  error.name = "TimeoutError";
  error.code = "ALLOCATION_TIMEOUT";
  error.status = 503;
  error.retryAfterMs = 1000;
  return error;
}

function isTemporaryUpstreamError(error) {
  return [429, 500, 502, 503, 504].includes(error?.status)
    || ["AbortError", "TimeoutError"].includes(error?.name)
    || error?.name === "TypeError"
    || error?.code === "UPSTREAM_TIMEOUT";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeAbortError();
}

function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    // The operation may already have rejected before this wrapper sees the
    // cancellation. Observe that rejection even though the caller stops now.
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(makeAbortError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(makeAbortError());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      cleanup();
      resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
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
      senderFilter: service.senderFilter === undefined ? "" : service.senderFilter,
      sendFullText: service.sendFullText === true
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
      || !Array.isArray(service.templates) || (service.enabled === true && service.templates.length === 0)
      || !Number.isInteger(service.minOtpLength) || service.minOtpLength < 1 || service.minOtpLength > 32
      || !Number.isInteger(service.maxOtpLength) || service.maxOtpLength < service.minOtpLength || service.maxOtpLength > 32
      || typeof service.senderFilter !== "string" || service.senderFilter.length > 100
      || typeof service.sendFullText !== "boolean"
      || typeof service.enabled !== "boolean") {
      return "Each service needs a name, enabled state, templates, OTP length range, sender filter, and full text setting.";
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
  priorityServiceRankCache = null;
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

async function validateAndPingRotatingDatabases(values, knownValues = []) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Provide at least one database URL.");
  }
  const databaseUrls = [];
  const seen = new Set();
  const removed = [];
  const deferred = [];
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

  const knownUrls = new Set(Array.isArray(knownValues) ? knownValues : []);
  const hasNewUrl = databaseUrls.some((url) => !knownUrls.has(url));
  const urlsToCheck = hasNewUrl && knownUrls.size
    ? databaseUrls.filter((url) => !knownUrls.has(url))
    : databaseUrls;
  const checks = [];
  for (let index = 0; index < urlsToCheck.length; index += databasePingConcurrency) {
    const batch = urlsToCheck.slice(index, index + databasePingConcurrency);
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
      // A database can be temporarily unavailable and recover later. Keep it
      // in rotation, but place it after currently working databases.
      deferred.push({ url: check.url, reason: check.reason });
    }
  }
  // Adding one database to a large existing rotation should not require a
  // network ping for every already accepted URL. Existing URLs are retained
  // in the submitted order; only the newly added URLs need validation.
  if (hasNewUrl && knownUrls.size) {
    workingUrls.push(...databaseUrls.filter((url) => knownUrls.has(url)));
  }
  const deferredSet = new Set(deferred.map((item) => item.url));
  const workingSet = new Set(workingUrls);
  const orderedWorkingUrls = databaseUrls.filter((url) => workingSet.has(url));
  const orderedDeferredUrls = databaseUrls.filter((url) => deferredSet.has(url));
  return {
    databaseUrls: [...orderedWorkingUrls, ...orderedDeferredUrls],
    removed,
    deferred
  };
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
      || !/^[A-Za-z0-9]{1,32}$/.test(entry.code)
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

async function readLegacyRotationState() {
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
      || !(order.receivedOtp === null || (typeof order.receivedOtp === "string" && /^[A-Za-z0-9]{1,32}$/.test(order.receivedOtp)))
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
  const state = { initialized: true, databaseUrls, serviceUsage, orders, runtimeStoreVersion: stored.runtimeStoreVersion };
  rotationStateCache = { value: cloneRotationState(state), expiresAt: Date.now() + rotationStateCacheTtlMs };
  return state;
}

function cloneRotationState(state) {
  return {
    initialized: state.initialized,
    runtimeStoreVersion: state.runtimeStoreVersion,
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

async function getRuntimeStore() {
  if (!runtimeStorePromise) {
    runtimeStorePromise = (async () => {
      const legacy = await readLegacyRotationState();
      const store = new AsyncRuntimeStore(runtimeDataPath);
      try {
        if (legacy.runtimeStoreVersion === 1 && !await store.call("metadata")) {
          throw new Error("runtime.sqlite is missing or empty after migration. Restore the runtime database backup to preserve permanent service locks.");
        }
        await store.call("initialize", legacy);
        // Keep the pre-migration JSON as a rollback/backup copy. Never overwrite it.
        if (legacy.orders.length || Object.keys(legacy.serviceUsage).length) {
          try {
            await writeFile(path.join(__dirname, "rotation.pre-sqlite.json"),
              await readFile(rotationDataPath, "utf8"), { flag: "wx" });
          } catch (error) { if (error.code !== "EEXIST") throw error; }
        }
        const metadata = await store.call("metadata");
        if (legacy.initialized) {
          // rotation.json remains the editable list of databases. Orders/locks are SQLite-owned.
          metadata.databaseUrls = legacy.databaseUrls;
          metadata.initialized = true;
          await store.call("setMetadata", metadata);
          await writeRotationSettings(metadata);
        }
        rotationStateCache = null;
        return store;
      } catch (error) {
        await store.close().catch(() => {});
        throw error;
      }
    })();
  }
  return runtimeStorePromise;
}

async function writeRotationSettings(state) {
  await writeJsonAtomically(rotationDataPath, {
    databaseUrls: state.databaseUrls, serviceUsage: {}, orders: [], runtimeStoreVersion: 1
  });
}

async function readRotationState() {
  return (await getRuntimeStore()).call("snapshot");
}

async function readRotationMetadata() {
  return (await getRuntimeStore()).call("metadata");
}

async function saveRotationState(state) {
  const store = await getRuntimeStore();
  await store.call("saveSnapshot", state);
  await writeRotationSettings(state);
  recentOrdersCache = null;
  rotationSettingsCache = null;
  rotationStateCache = null;
}

async function saveRotationMetadata(state) {
  // Settings changes never load or rewrite order history.
  await writeRotationSettings(state);
  await (await getRuntimeStore()).call("setMetadata", { ...state, initialized: true });
  rotationSettingsCache = null;
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
  let latestNumber = null;
  let latestTimestamp = null;
  let latestKey = null;
  for (const [key, message] of Object.entries(messages)) {
    if (!message || typeof message !== "object" || Array.isArray(message)
      || /\bjoin[\s\W_]*telegram\b/i.test(getMessageText(message))) continue;
    const timestamp = getMessageTimestamp(key, message);
    const number = extractCarrierNumber(message);
    if (!number) continue;
    if (latestNumber === null
      || (timestamp !== null && (latestTimestamp === null || timestamp > latestTimestamp))
      || (timestamp === latestTimestamp && String(key).localeCompare(String(latestKey), undefined, { numeric: true }) > 0)) {
      latestNumber = number;
      latestTimestamp = timestamp;
      latestKey = key;
    }
  }
  return latestNumber;
}

async function initializeOrderExpirationTimers() {
  await (await getRuntimeStore()).call("expire");
  // Expiry is indexed and checked at claim/read time; no per-order timers or JSON rewrites.
  if (!await acquireInventoryWorkerLock()) return;
  setTimeout(startPriorityStockWorkers, 800).unref();
  if (!priorityStockTimer) {
    priorityStockTimer = setInterval(startPriorityStockWorkers, priorityStockIntervalMs);
    priorityStockTimer.unref();
  }
  setTimeout(startNumberMappingPrefetch, 1000).unref();
  const mappingRefreshTimer = setInterval(startNumberMappingPrefetch, numberMappingPrefetchIntervalMs);
  mappingRefreshTimer.unref();
  if (!numberMappingPrefetchWatchdogTimer) {
    numberMappingPrefetchWatchdogTimer = setInterval(
      monitorNumberMappingPrefetch, Math.min(10000, Math.max(1000, Math.floor(numberMappingPrefetchWatchdogMs / 3)))
    );
    numberMappingPrefetchWatchdogTimer.unref();
  }
  setTimeout(startNumberPoolWarmup, 1200).unref();
  if (!numberPoolWarmupTimer) {
    numberPoolWarmupTimer = setInterval(startNumberPoolWarmup, numberPoolWarmupIntervalMs);
    numberPoolWarmupTimer.unref();
  }
}

async function acquireInventoryWorkerLock() {
  if (inventoryWorkerLockHandle) return true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      inventoryWorkerLockHandle = await open(inventoryWorkerLockPath, "wx");
      await inventoryWorkerLockHandle.writeFile(`${process.pid}\n`, "utf8");
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") return false;
      let ownerPid = 0;
      try { ownerPid = Number((await readFile(inventoryWorkerLockPath, "utf8")).trim()); } catch { /* retry below */ }
      if (ownerPid && ownerPid !== process.pid) {
        try { process.kill(ownerPid, 0); return false; } catch { /* stale lock */ }
      }
      await unlink(inventoryWorkerLockPath).catch(() => {});
    }
  }
  return false;
}


async function prefetchAllNumberMappings() {
  const runController = new AbortController();
  numberMappingPrefetchAbortController = runController;
  numberMappingPrefetchLastProgressAt = Date.now();
  const rotation = await waitForAbortable(readRotationMetadata(), runController.signal);
  const databases = [...rotation.databaseUrls];
  const store = await waitForAbortable(getRuntimeStore(), runController.signal);
  const [ordered, checkTimes, progress] = await Promise.all([
    waitForAbortable(store.call("databaseInventoryOrder", { databases }), runController.signal),
    waitForAbortable(store.call("databaseCheckTimes", { databases }), runController.signal),
    waitForAbortable(store.call("inventoryProgress", { databases }), runController.signal)
  ]);
  const orderRank = new Map(ordered.map((item, index) => [item.database, index]));
  databases.sort((left, right) => {
    const leftRank = orderRank.get(left);
    const rightRank = orderRank.get(right);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
  numberMappingPrefetchState = {
    status: databases.length ? "running" : "complete",
    total: databases.length, completed: 0, failed: 0, mappings: progress.mappings || 0,
    discoveryTotal: databases.length, discoveryCompleted: 0,
    startedAt: Date.now(), completedAt: databases.length ? null : Date.now()
  };
  if (!databases.length) return;
  const freshUntil = Date.now() - activeClientsCacheTtlMs;
  const checkedAtByDatabase = new Map(checkTimes.map((item) => [item.database, item.checkedAt]));
  // A complete sweep can take longer than one freshness window. Continue from
  // databases whose durable status is stale instead of rescanning fresh ones.
  const pendingDatabases = databases.filter((database) =>
    (checkedAtByDatabase.get(database) || 0) <= freshUntil);
  numberMappingPrefetchState.completed = databases.length - pendingDatabases.length;
  let refreshedMappingCount = 0;
  const failedDatabases = new Set();
  let nextDatabase = 0;
  const refreshDatabase = async () => {
    while (nextDatabase < pendingDatabases.length) {
      throwIfAborted(runController.signal);
      const databaseIndex = nextDatabase++;
      const database = pendingDatabases[databaseIndex];
      let failed = false;
      const taskController = new AbortController();
      const abortTask = () => taskController.abort();
      const taskTimeout = setTimeout(() => taskController.abort(), numberMappingPrefetchTaskTimeoutMs);
      runController.signal.addEventListener("abort", abortTask, { once: true });
      try {
        const clientsEndpoint = `${database}/clients.json`;
        deleteSharedDatabaseCacheEntry(clientsEndpoint);
        sharedDatabaseJsonErrors.delete(clientsEndpoint);
        const clients = await fetchSharedDatabaseJson(
          clientsEndpoint, numberStatusCheckTimeoutMs, numberMappingPrefetchIntervalMs,
          taskController.signal, 1
        );
        throwIfAborted(runController.signal);
        if (!clients || typeof clients !== "object" || Array.isArray(clients)) {
          throw new Error("Firebase returned an invalid clients list.");
        }
        const cached = sharedDatabaseJsonCache.get(`${database}/clients.json`);
        const checkedAt = Date.now();
        const expiresAt = cached?.expiresAt > checkedAt ? cached.expiresAt : checkedAt + activeClientsCacheTtlMs;
        const onlineIds = rememberActiveClientIds(database, clients, expiresAt);
        const mappingCount = await waitForAbortable(store.call("refreshDatabaseInventory", {
          database, onlineDeviceIds: [...onlineIds], now: checkedAt
        }), taskController.signal);
        refreshedMappingCount += mappingCount;
      } catch (error) {
        if (runController.signal.aborted) throw error;
        failed = true;
        failedDatabases.add(database);
        const reason = error?.status ? `HTTP ${error.status}` : error?.code || error?.name || "request failed";
        console.warn(`Inventory status refresh failed for database ${databaseIndex + 1}/${databases.length}: ${reason}`);
      } finally {
        clearTimeout(taskTimeout);
        runController.signal.removeEventListener("abort", abortTask);
        numberMappingPrefetchState.completed += 1;
        if (failed) numberMappingPrefetchState.failed += 1;
        numberMappingPrefetchLastProgressAt = Date.now();
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(numberMappingPrefetchConcurrency, pendingDatabases.length) }, refreshDatabase
  ));
  numberMappingPrefetchState.status = "discovering";
  let discoveryNext = 0;
  let discoveryFailures = 0;
  const discoverDatabase = async () => {
    while (discoveryNext < databases.length) {
      throwIfAborted(runController.signal);
      const database = databases[discoveryNext++];
      const taskController = new AbortController();
      const abortTask = () => taskController.abort();
      const taskTimeout = setTimeout(() => taskController.abort(), numberMappingDiscoveryTaskTimeoutMs);
      runController.signal.addEventListener("abort", abortTask, { once: true });
      try {
        const discovery = await waitForAbortable(readActiveNumbers(
          database,
          () => true,
          taskController.signal,
          2,
          null,
          true,
          async (entries, checkedAt) => {
            const mappings = entries.filter((entry) => entry.number).map((entry) => ({
              database,
              deviceId: entry.deviceId,
              number: entry.number,
              online: true,
              now: checkedAt,
              verifiedAt: checkedAt
            }));
            if (!mappings.length) return;
            await store.call("rememberBatch", mappings);
            numberMappingPrefetchState.mappings += mappings.length;
            numberMappingPrefetchLastProgressAt = Date.now();
          },
          1,
          true
        ), taskController.signal);
        if (discovery.messageReadFailures > 0) {
          discoveryFailures += 1;
          if (!failedDatabases.has(database)) {
            failedDatabases.add(database);
            numberMappingPrefetchState.failed += 1;
          }
        }
      } catch (error) {
        if (runController.signal.aborted) throw error;
        discoveryFailures += 1;
        if (!failedDatabases.has(database)) {
          failedDatabases.add(database);
          numberMappingPrefetchState.failed += 1;
        }
        console.warn("Number mapping discovery failed for database " + database + ": "
          + (error?.status ? "HTTP " + error.status : error?.code || error?.name || "request failed"));
      } finally {
        clearTimeout(taskTimeout);
        runController.signal.removeEventListener("abort", abortTask);
        numberMappingPrefetchState.discoveryCompleted += 1;
        numberMappingPrefetchLastProgressAt = Date.now();
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(numberMappingDiscoveryConcurrency, databases.length) }, discoverDatabase
  ));
  numberMappingPrefetchState.mappings = Math.max(
    progress.mappings || 0, refreshedMappingCount, numberMappingPrefetchState.mappings || 0
  );
  numberMappingPrefetchState.status = numberMappingPrefetchState.failed || discoveryFailures ? "partial" : "complete";
  numberMappingPrefetchState.completedAt = Date.now();
}

function startNumberMappingPrefetch() {
  if (numberMappingPrefetchPromise) return numberMappingPrefetchPromise;
  numberMappingPrefetchRunId += 1;
  const runId = numberMappingPrefetchRunId;
  numberMappingPrefetchPromise = prefetchAllNumberMappings()
    .catch((error) => {
      if (error?.code === "ALLOCATION_TIMEOUT" || error?.name === "AbortError") {
        console.warn(`Inventory prefetch run ${runId} was interrupted; it will restart automatically.`);
      } else {
        console.error("Could not prefetch number mappings:", error.message);
      }
      numberMappingPrefetchState.status = "failed";
      numberMappingPrefetchState.failed = Math.max(1, numberMappingPrefetchState.failed);
      numberMappingPrefetchState.completedAt = Date.now();
    })
    .finally(() => {
      numberMappingPrefetchAbortController = null;
      numberMappingPrefetchPromise = null;
    });
  return numberMappingPrefetchPromise;
}

function monitorNumberMappingPrefetch() {
  if (!numberMappingPrefetchPromise || !numberMappingPrefetchAbortController) return;
  if (Date.now() - numberMappingPrefetchLastProgressAt <= numberMappingPrefetchWatchdogMs) return;
  console.warn(`Inventory prefetch stalled after ${numberMappingPrefetchState.completed}/${numberMappingPrefetchState.total}; restarting.`);
  numberMappingPrefetchAbortController.abort();
}

async function warmNumberPools() {
  if (numberPoolWarmServices === 0) return;
  // Let the all-database mapping sweep finish first. Running service scans
  // against the same Firebase projects at startup starves customer reads.
  if (numberMappingPrefetchPromise) await numberMappingPrefetchPromise;
  const [configured, rotationState] = await Promise.all([
    readConfiguredServices(),
    readRotationMetadata()
  ]);
  if (!rotationState.databaseUrls.length) return;
  const configuredNames = configured.services
    .filter((service) => service?.enabled === true && getEnabledTemplates(service).length > 0)
    .map((service) => normalizeServiceName(service.name).toLowerCase());
  const services = configuredNames.slice(0, numberPoolWarmServices);
  // A customer-requested service is warmed on demand. Avoid scanning every
  // configured service at startup; with hundreds of databases that creates a
  // large message-read wave and starves normal API traffic.
  for (const service of requestedNumberPoolServices) {
    if (!services.includes(service)) services.push(service);
  }
  let nextService = 0;
  const worker = async () => {
    while (nextService < services.length) {
      const service = services[nextService++];
      await refillNumberPool(service);
    }
  };
  await Promise.all(Array.from({ length: Math.min(numberPoolWorkerCount, services.length) }, worker));
}

function startNumberPoolWarmup() {
  if (numberPoolWarmupPromise) return numberPoolWarmupPromise;
  numberPoolWarmupPromise = warmNumberPools()
    .catch((error) => console.error("Could not warm number pools:", error.message))
    .finally(() => { numberPoolWarmupPromise = null; });
  return numberPoolWarmupPromise;
}

function selectPriorityStockDatabases(databaseUrls, ranked, limit) {
  const all = [...new Set([...ranked, ...databaseUrls])];
  if (all.length <= limit) return all;
  const fixedCount = Math.min(Math.ceil(limit / 4), ranked.length);
  const fixed = ranked.slice(0, fixedCount);
  const rotating = all.filter((database) => !fixed.includes(database));
  const rotatingCount = Math.max(0, limit - fixed.length);
  const offset = rotating.length ? priorityStockScanCursor % rotating.length : 0;
  priorityStockScanCursor = rotating.length
    ? (offset + rotatingCount) % rotating.length
    : 0;
  const window = Array.from({ length: Math.min(rotatingCount, rotating.length) }, (_, index) =>
    rotating[(offset + index) % rotating.length]
  );
  return [...fixed, ...window];
}

async function runPriorityStockWorkers() {
  priorityStockState.status = "running";
  const rankController = new AbortController();
  const rankTimeout = setTimeout(() => rankController.abort(), priorityStockJobTimeoutMs);
  let ranked;
  try {
    if (!priorityServiceRankCache || priorityServiceRankCache.expiresAt <= Date.now()) {
      const [store, configured] = await waitForAbortable(Promise.all([
        getRuntimeStore(), readConfiguredServices()
      ]), rankController.signal);
      const enabled = configured.services.filter((service) =>
        service.enabled === true && getEnabledTemplates(service).length > 0)
        .map((service) => normalizeServiceName(service.name).toLowerCase());
      ranked = await waitForAbortable(store.call("topOrderedServices", {
        services: enabled, since: Date.now() - 86400000, limit: 10
      }), rankController.signal);
      priorityServiceRankCache = { services: ranked, expiresAt: Date.now() + 60000 };
      priorityStockServices.clear();
      for (const item of ranked) priorityStockServices.add(item.service);
    } else ranked = priorityServiceRankCache.services;
  } finally { clearTimeout(rankTimeout); }
  const services = ranked.map((item) => ({
    service: item.service, orders: item.orders, target: priorityStockTarget,
    ready: null, status: "queued"
  }));
  priorityStockState.services = services;
  let next = 0;
  const worker = async () => {
    while (next < services.length) {
      const item = services[next++];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), priorityStockJobTimeoutMs);
      item.status = "refilling";
      try {
        const count = await waitForAbortable(refillNumberPool(item.service, controller.signal, {
          priority: true, target: priorityStockTarget
        }), controller.signal);
        item.ready = Number.isInteger(count) ? count : null;
        item.status = item.ready === null ? "retrying" : item.ready >= item.target ? "ready" : "low";
      } catch (error) {
        item.status = "retrying";
        console.warn("Priority stock refill interrupted for " + item.service + ": "
          + (error.code || error.name || "worker error"));
      } finally { clearTimeout(timeout); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(priorityStockWorkerCount, services.length) }, worker));
  priorityStockState.status = "waiting";
  priorityStockState.checkedAt = Date.now();
}

function startPriorityStockWorkers() {
  if (priorityStockPromise) return priorityStockPromise;
  // Independent of the full rotation pass: busy services can refill while
  // discovery and ordinary service warmups continue in their own lanes.
  priorityStockPromise = runPriorityStockWorkers().catch((error) => {
    priorityStockState.status = "retrying";
    console.warn("Priority stock worker failed; retrying on the next tick:",
      error.code || error.name || "worker error");
  }).then(async () => {
    // Publish once per completed pass so all PM2 API processes report the same
    // leader's worker status, without per-request storage reads.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), priorityStockJobTimeoutMs);
    try {
      const store = await waitForAbortable(getRuntimeStore(), controller.signal);
      await waitForAbortable(store.call("savePriorityStockState", priorityStockState), controller.signal);
    } catch (error) {
      console.warn("Could not save priority stock progress:", error.code || error.name || "storage error");
    } finally { clearTimeout(timeout); }
  }).finally(() => { priorityStockPromise = null; });
  return priorityStockPromise;
}

function drainDatabaseReadQueue() {
  while (queuedDatabaseReads.length && activeDatabaseReads < maximumConcurrentDatabaseReads) {
    const index = queuedDatabaseReads.findIndex((entry) =>
      entry.priority === 0 || activeDatabaseReads < backgroundDatabaseReadLimit);
    if (index < 0) break;
    const [entry] = queuedDatabaseReads.splice(index, 1);
    activeDatabaseReads += 1;
    entry.resume();
  }
}

async function withDatabaseReadSlot(operation, signal = null, priority = 0) {
  throwIfAborted(signal);
  if (activeDatabaseReads >= maximumConcurrentDatabaseReads
    || (priority > 0 && activeDatabaseReads >= backgroundDatabaseReadLimit)
    || queuedDatabaseReads.length > 0) {
    if (queuedDatabaseReads.length >= 2048) {
      const error = new Error("Firebase request capacity is full.");
      error.status = 503;
      error.retryAfterMs = 1000;
      throw error;
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve, resume: null, priority, sequence: databaseReadSequence++ };
      const resume = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = queuedDatabaseReads.indexOf(entry);
        if (index < 0) return;
        queuedDatabaseReads.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(makeAbortError());
        drainDatabaseReadQueue();
      };
      entry.resume = resume;
      queuedDatabaseReads.push(entry);
      queuedDatabaseReads.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else drainDatabaseReadQueue();
    });
  } else {
    activeDatabaseReads += 1;
  }
  try {
    throwIfAborted(signal);
    return await operation();
  } finally {
    activeDatabaseReads = Math.max(0, activeDatabaseReads - 1);
    drainDatabaseReadQueue();
  }
}

// Provider traffic has its own small pool so a burst of Firebase message
// polling cannot consume every slot and return local 503s to API clients.
async function withProviderReadSlot(operation, signal = null) {
  throwIfAborted(signal);
  if (activeProviderReads >= maximumConcurrentProviderReads || queuedProviderReads.length > 0) {
    if (queuedProviderReads.length >= 2048) {
      const error = new Error("Provider request capacity is full.");
      error.status = 503;
      error.retryAfterMs = 1000;
      throw error;
    }
    await new Promise((resolve, reject) => {
      const resume = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = queuedProviderReads.indexOf(resume);
        if (index < 0) return;
        queuedProviderReads.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(makeAbortError("The provider request timed out while waiting for capacity."));
      };
      queuedProviderReads.push(resume);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } else {
    activeProviderReads += 1;
  }
  try {
    throwIfAborted(signal);
    return await operation();
  } finally {
    const next = queuedProviderReads.shift();
    if (next) next();
    else activeProviderReads = Math.max(0, activeProviderReads - 1);
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

async function fetchDatabaseJson(endpoint, timeoutMs = 15000, parentSignal = null, onResponseBytes = null, priority = 0) {
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
  }, parentSignal, priority);
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

async function fetchSharedDatabaseJson(endpoint, timeoutMs, ttlMs, parentSignal = null, priority = 0) {
  const now = Date.now();
  const cached = sharedDatabaseJsonCache.get(endpoint);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) deleteSharedDatabaseCacheEntry(endpoint);

  const recentError = sharedDatabaseJsonErrors.get(endpoint);
  if (recentError && recentError.expiresAt > now) throw recentError.error;
  if (recentError) sharedDatabaseJsonErrors.delete(endpoint);

  const pending = sharedDatabaseJsonInflight.get(endpoint);
  if (pending && !pending.settled && !pending.controller.signal.aborted
    && pending.priority <= priority) {
    return subscribeToSharedDatabaseRead(pending, parentSignal);
  }
  // A background inventory scan may have cancelled its own last subscriber
  // after finding a different candidate. Never attach a status API request to
  // that doomed fetch; start a fresh read for the live caller instead.
  if (pending && sharedDatabaseJsonInflight.get(endpoint) === pending) {
    sharedDatabaseJsonInflight.delete(endpoint);
  }

  let responseBytes = 0;
  const entry = { controller: new AbortController(), subscribers: 0, settled: false, priority, promise: null };
  entry.promise = fetchDatabaseJson(endpoint, timeoutMs, entry.controller.signal, (bytes) => {
    responseBytes = bytes;
  }, priority)
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
        isTemporaryUpstreamError(error) ? numberPoolEmptyCooldownMs : 0,
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
    verifiedAt: Date.now(),
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

function rememberActiveClientIds(database, clients, expiresAt) {
  const onlineIds = new Set();
  if (clients && typeof clients === "object" && !Array.isArray(clients)) {
    for (const [deviceId, client] of Object.entries(clients)) {
      if (isValidDatabaseKey(deviceId) && client && typeof client === "object"
        && !Array.isArray(client) && client.status === true) {
        onlineIds.add(deviceId);
      }
    }
  }
  activeClientOnlineIds.delete(database);
  activeClientOnlineIds.set(database, { onlineIds, checkedIds: null, complete: true, expiresAt });
  while (activeClientOnlineIds.size > 500) {
    activeClientOnlineIds.delete(activeClientOnlineIds.keys().next().value);
  }
  return onlineIds;
}

async function readActiveNumbers(database, isAvailable = () => true, parentSignal = null, requiredCandidates = 1, excludedNumbers = null, scanAll = false, onDiscover = null, readPriority = scanAll ? 1 : 0, preserveEmptySnapshot = false) {
  const clients = await fetchSharedDatabaseJson(
    `${database}/clients.json`,
    numberFetchTimeoutMs,
    activeClientsCacheTtlMs,
    parentSignal,
    readPriority
  );
  const snapshotCheckedAt = Date.now();
  const cachedClients = sharedDatabaseJsonCache.get(`${database}/clients.json`);
  const snapshotExpiresAt = cachedClients?.expiresAt > Date.now()
    ? cachedClients.expiresAt
    : Date.now() + activeClientsCacheTtlMs;
  throwIfAborted(parentSignal);
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
  rememberActiveClientIds(database, clients, snapshotExpiresAt);
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
  // Known mappings survive restarts and are shared across services. A scan must not
  // download the same device's SMS history just to rediscover its phone number.
  const store = await getRuntimeStore();
  const knownMappings = await store.call("mappings", database);
  // Record the successful clients snapshot even for a previously unmapped
  // database, so mappings discovered below immediately qualify for ready stock.
  const activeIds = new Set(activeClients.map(([id]) => id));
  await store.call("markDatabaseOnline", {
    database, onlineDeviceIds: [...activeIds], now: snapshotCheckedAt, preserveOnEmpty: preserveEmptySnapshot
  });
  activeClientsSnapshotFreshUntil.set(database, snapshotExpiresAt);
  if (activeClients.length === 0) {
    if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
    return { numbers: [], messageReadFailures: 0 };
  }
  const durableMappings = new Map(knownMappings
    .map((item) => [item.deviceId, { number: item.number, verifiedAt: item.verifiedAt, expiresAt: item.verifiedAt + 86400000 }]));
  for (const [deviceId] of activeClients) {
    const key = `${database}|${deviceId}`;
    const memory = activeNumberCache.get(key);
    const cached = memory?.expiresAt > now ? memory : durableMappings.get(deviceId);
    if (cached && cached.expiresAt > now) {
      if (cached.number) {
        const candidate = { deviceId, number: cached.number, verifiedAt: cached.verifiedAt };
        numbers.set(cached.number, candidate);
        const eligible = (value) => isAvailable(value) && !excludedNumbers?.has(value.number);
        if (!scanAll && requiredCandidates <= 1 && eligible({ ...candidate, database })) {
          if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
          return { numbers: [candidate], messageReadFailures };
        }
      }
      continue;
    }
    uncachedClients.push([deviceId]);
  }
  if (!scanAll && requiredCandidates > 1
    && [...numbers.values()].filter((candidate) => isAvailable(candidate) && !excludedNumbers?.has(candidate.number)).length >= requiredCandidates) {
    if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
    return { numbers: [...numbers.values()], messageReadFailures };
  }
  const offset = randomInt(Math.max(1, uncachedClients.length));
  const candidates = uncachedClients.length
    ? uncachedClients.map((_, index) => uncachedClients[(offset + index) % uncachedClients.length])
    : [];
  let messageReads = 0;
  if (scanAll) {
    let nextDevice = 0;
    const scanDevice = async () => {
      while (!batchController.signal.aborted && nextDevice < candidates.length) {
        const [deviceId] = candidates[nextDevice++];
        let candidate;
        try {
          candidate = {
            deviceId,
            number: getLatestCarrierNumber(await fetchSharedDatabaseJson(
              `${database}/messages/${encodeURIComponent(deviceId)}.json`,
              numberFetchTimeoutMs, numberMessagesCacheTtlMs, batchController.signal, readPriority
            ))
          };
        } catch (error) {
          if (batchController.signal.aborted) return;
          messageReadFailures += 1;
          if (!upstreamError && (error.status || error.code)) upstreamError = error;
          continue;
        }
        if (batchController.signal.aborted) return;
        cacheActiveNumber(database, candidate);
        if (!candidate.number) continue;
        numbers.set(candidate.number, candidate);
        if (typeof onDiscover === "function") {
          await onDiscover([candidate], snapshotCheckedAt);
        }
      }
    };
    try {
      await Promise.all(Array.from(
        { length: Math.min(numberMappingDeviceConcurrency, candidates.length) }, scanDevice
      ));
      return { numbers: [...numbers.values()], messageReadFailures, upstreamError };
    } finally {
      batchController.abort();
      parentSignal?.removeEventListener("abort", abortForParent);
    }
  }
  for (let index = 0; index < candidates.length;) {
    const batchSize = requiredCandidates > 1 ? Math.min(8, 48 - messageReads) : 8;
    if (batchSize <= 0) break;
    const batch = candidates.slice(index, index + batchSize);
    index += batch.length;
    messageReads += batch.length;
    const reads = batch.map(async ([deviceId]) => ({
      deviceId,
      number: getLatestCarrierNumber(await fetchSharedDatabaseJson(
        database + "/messages/" + encodeURIComponent(deviceId) + ".json",
        numberFetchTimeoutMs,
        numberMessagesCacheTtlMs,
        batchController.signal,
        readPriority
      ))
    }));
    if (!scanAll && requiredCandidates <= 1) try {
      const available = await Promise.any(reads.map(async (read) => {
        const candidate = await read;
        cacheActiveNumber(database, candidate);
        if (candidate.number
          && isAvailable({ ...candidate, database })
          && !excludedNumbers?.has(candidate.number)) {
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
    const discovered = [];
    for (const result of results) {
      if (result.status === "rejected") {
        messageReadFailures += 1;
        if (!upstreamError && (result.reason?.status || result.reason?.code)) {
          upstreamError = result.reason;
        }
      } else if (result.value.number && !numbers.has(result.value.number)) {
        cacheActiveNumber(database, result.value);
        numbers.set(result.value.number, result.value);
        discovered.push(result.value);
      } else if (result.status === "fulfilled") {
        cacheActiveNumber(database, result.value);
      }
    }
    if (discovered.length && typeof onDiscover === "function") {
      await onDiscover(discovered, snapshotCheckedAt);
    }
    if (parentSignal?.aborted) {
      if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
      return { numbers: [...numbers.values()], messageReadFailures, upstreamError };
    }
    if (!scanAll && [...numbers.values()].filter((candidate) =>
      isAvailable(candidate) && !excludedNumbers?.has(candidate.number)).length >= requiredCandidates) {
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

function requestNumberPoolRefresh(service) {
  if (typeof service !== "string" || !service) return;
  void refillNumberPool(service);
}

async function readRotatingDeviceStats() {
  const databaseUrls = await withRotationLock(async () => {
    const state = await readRotationMetadata();
    return [...state.databaseUrls];
  });
  const failedDatabases = [];
  const failedDatabaseUrls = [];
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
          ? "clients.json was not found (HTTP 404); deferred to the end of rotation."
          : result.reason.message;
        failedDatabases.push({ url, reason });
        failedDatabaseUrls.push(url);
        continue;
      }
      const records = result.value.records;
      if (records === null) {
        failedDatabaseUrls.push(url);
        failedDatabases.push({ url, reason: "clients.json is missing; deferred to the end of rotation." });
        continue;
      }
      if (records !== null && (typeof records !== "object" || Array.isArray(records))) {
        failedDatabases.push({ url, reason: "Firebase returned an invalid clients list." });
        failedDatabaseUrls.push(url);
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

  const deferredDatabaseUrls = failedDatabaseUrls.length
    ? await withRotationLock(async () => {
      const state = await readRotationMetadata();
      const failed = new Set(failedDatabaseUrls);
      const reordered = [
        ...state.databaseUrls.filter((url) => !failed.has(url)),
        ...state.databaseUrls.filter((url) => failed.has(url))
      ];
      if (reordered.join("\n") !== state.databaseUrls.join("\n")) {
        state.databaseUrls = reordered;
        await saveRotationMetadata(state);
      }
      return state.databaseUrls.filter((url) => failed.has(url));
    })
    : [];

  return {
    databaseCount: databaseUrls.length,
    remainingDatabaseCount: databaseUrls.length,
    scannedDatabases,
    failedDatabases,
    removedDatabases: [],
    deferredDatabases: deferredDatabaseUrls,
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

async function readActiveNumberInventories(service, rotationState, requiredCandidates = 1, excludedNumbers = null, parentSignal = null, background = false, scanAll = false, readPriority = background ? 1 : 0, databaseConcurrency = numberPoolDatabaseConcurrency) {
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
  const unavailableReservations = new Set(rotationState.reserved || reservedNumbers.keys());
  const isAvailable = (candidate) => !usedNumbers.has(candidate.number)
    && !lockedNumbers.has(candidate.number)
    && !unavailableReservations.has(candidate.number);
  const now = Date.now();
  const healthyUrls = orderedUrls.filter((database) => (slowDatabases.get(database)?.expiresAt || 0) <= now);
  const scanUrls = healthyUrls.length
    ? healthyUrls
    : orderedUrls.slice().sort((left, right) =>
      (slowDatabases.get(left)?.expiresAt || 0) - (slowDatabases.get(right)?.expiresAt || 0)).slice(0, 1);
  const inventories = [];
  const discoveryStore = background ? await getRuntimeStore() : null;
  const failures = [];
  let complete = scanUrls.length === orderedUrls.length;
  let stoppedEarly = false;
  const controller = new AbortController();
  const abortForParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortForParent, { once: true });
  }
  let nextIndex = 0;
  let foundAvailable = false;
  let availableCandidateCount = 0;
  const scanDatabase = async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= scanUrls.length) return;
      const database = scanUrls[index];
      try {
        const inventory = {
          database,
          ...await readActiveNumbers(database, isAvailable, controller.signal, requiredCandidates, excludedNumbers, scanAll,
            discoveryStore ? async (entries, checkedAt) => {
              throwIfAborted(controller.signal);
              await discoveryStore.call("rememberBatch", entries.filter((entry) => entry.number).map((entry) => ({
                database, deviceId: entry.deviceId, number: entry.number, now: checkedAt, verifiedAt: checkedAt
              })));
            } : null, readPriority)
        };
        if (controller.signal.aborted) return;
        inventories.push(inventory);
        availableCandidateCount += inventory.numbers.filter((candidate) =>
          isAvailable(candidate) && !excludedNumbers?.has(candidate.number)).length;
        if (availableCandidateCount >= requiredCandidates) {
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
    { length: Math.min(requiredCandidates > 1 ? databaseConcurrency : databasePingConcurrency, scanUrls.length) },
    scanDatabase
  ));
  if (parentSignal) parentSignal.removeEventListener("abort", abortForParent);
  throwIfAborted(parentSignal);
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

async function rememberInventories(store, inventories) {
  const entries = inventories.flatMap((inventory) => inventory.numbers
    .filter((candidate) => candidate.number)
    .map((candidate) => ({ database: inventory.database, deviceId: candidate.deviceId, number: candidate.number, verifiedAt: candidate.verifiedAt })));
  if (entries.length) await store.call("rememberBatch", entries);
}

async function withServiceAllocationLock(service, operation, signal = null) {
  const previous = serviceAllocationOperations.get(service) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const current = previous.then(() => turn);
  serviceAllocationOperations.set(service, current);
  current.then(() => {
    if (serviceAllocationOperations.get(service) === current) serviceAllocationOperations.delete(service);
  });
  try {
    await waitForAbortable(previous, signal);
    throwIfAborted(signal);
    return await operation();
  } finally {
    release();
  }
}

async function fillNumberPool(service, parentSignal = null, preparation = {}) {
  throwIfAborted(parentSignal);
  const store = await waitForAbortable(getRuntimeStore(), parentSignal);
  const call = (method, ...args) => waitForAbortable(store.call(method, ...args), parentSignal);
  const { databaseUrls } = await call("metadata");
  if (!databaseUrls.length) return 0;
  const target = preparation.target || numberPoolRefillThreshold;
  const options = { service, databases: databaseUrls, limit: target,
    onlineTtl: activeClientsCacheTtlMs, freshOnly: true };
  const readyCountForService = () => preparation.priority
    ? call("readyStockCount", options)
    : call("candidates", options).then((items) => items.length);
  const preparedCount = await readyCountForService();
  if (preparedCount >= target) return preparedCount;
  // Advance service cycles during background preparation, so a pool of used
  // but unlocked numbers is ready for fallback before an API call arrives.
  if (await call("advanceCycle", { service, databases: databaseUrls })) {
    const recycledCount = await readyCountForService();
    if (recycledCount >= target) return recycledCount;
  }
  const state = await call("allocationState", service);
  let scanState = state;
  if (preparation.priority && databaseUrls.length > priorityStockDatabaseLimit) {
    const inventoryOrder = await call("databaseInventoryOrder", { databases: databaseUrls });
    const ranked = inventoryOrder.map((item) => item.database);
    const selected = selectPriorityStockDatabases(databaseUrls, ranked, priorityStockDatabaseLimit);
    scanState = { ...state, databaseUrls: selected };
  }
  const scanCandidates = preparation.priority
    ? Math.min(priorityStockScanCandidates, Math.max(numberPoolSize, target))
    : Math.max(numberPoolSize, target);
  const scan = await readActiveNumberInventories(service, scanState, scanCandidates,
    null, parentSignal, true, preparation.priority ? false : true, preparation.priority ? 1 : 2,
    preparation.priority ? priorityStockDatabaseConcurrency : numberPoolDatabaseConcurrency);
  throwIfAborted(parentSignal);
  await waitForAbortable(rememberInventories(store, scan.inventories), parentSignal);
  let readyCount = await readyCountForService();
  if (readyCount < target
    && await call("advanceCycle", { service, databases: databaseUrls })) {
    readyCount = await readyCountForService();
  }
  if (scan.failures.length && readyCount < target && !preparation.priority) {
    const error = scan.failures[0].error || new Error("The configured databases could not be checked.");
    error.status ||= 503;
    error.code ||= "UPSTREAM_UNAVAILABLE";
    error.retryAfterMs ||= 1000;
    throw error;
  }
  return readyCount;
}

function readyNumberKey(candidate) {
  return `${candidate.database}|${candidate.deviceId}|${candidate.number}`;
}

async function refreshReadyNumberQueue(service, store = null) {
  const key = normalizeServiceName(service).toLowerCase();
  const active = readyNumberQueueLoads.get(key);
  if (active) return active;
  const load = (async () => {
    const runtime = store || await getRuntimeStore();
    const metadata = await runtime.call("metadata");
    if (!metadata?.databaseUrls?.length) { readyNumberQueues.set(key, []); return 0; }
    const candidates = await runtime.call("candidates", {
      service: key, databases: metadata.databaseUrls, limit: numberReadyQueueSize,
      onlineTtl: activeClientsCacheTtlMs, freshOnly: true
    });
    const verifiedDatabases = new Set(await runtime.call("verifiedDatabases", {
      databases: metadata.databaseUrls, ttl: activeClientsCacheTtlMs
    }));
    // `candidates` comes from the shared SQLite inventory. Its online flag and
    // checked_at are durable, so API workers can use status verified by the
    // background leader even when their own in-memory snapshot is empty.
    const verifiedCandidates = candidates.filter((candidate) => candidate.reused !== true
      && verifiedDatabases.has(candidate.database));
    const queue = readyNumberQueues.get(key) || [];
    const seen = new Set(queue.map((candidate) => readyNumberKey(candidate)));
    for (const candidate of verifiedCandidates) {
      const candidateKey = readyNumberKey(candidate);
      if (seen.has(candidateKey)) continue;
      seen.add(candidateKey);
      queue.push(candidate);
    }
    readyNumberQueues.set(key, queue);
    return queue.length;
  })().finally(() => {
    readyNumberQueueLoads.delete(key);
  });
  readyNumberQueueLoads.set(key, load);
  return load;
}

function requestReadyNumberQueueRefresh(service) {
  const now = Date.now();
  if ((readyNumberQueueRefreshAfter.get(service) || 0) > now) return;
  readyNumberQueueRefreshAfter.set(service, now + numberPoolRefillCooldownMs);
  void refreshReadyNumberQueue(service).catch((error) => {
    if (error?.status !== 503) console.error(`Could not refresh ready number queue for ${service}:`, error.message);
  });
}

// Keep one discovery job per service so warmups can fetch from multiple services
// in parallel without duplicate scans for the same service. The shared Firebase
// read gate still caps total upstream work.
function refillNumberPool(service, parentSignal = null, preparation = {}) {
  const key = normalizeServiceName(service).toLowerCase();
  if (priorityStockServices.has(key)) preparation = { ...preparation, priority: true, target: priorityStockTarget };
  const active = activeNumberPoolRefills.get(key);
  if (active) {
    if (preparation.priority !== true) return active;
    const target = preparation.target || priorityStockTarget;
    return active.then((result) => {
      if (Number.isInteger(result) && result >= target) return result;
      return refillNumberPool(key, parentSignal, preparation);
    });
  }
  const pool = numberPools.get(key) || { retryAt: 0 };
  if (pool.retryAt > Date.now() && preparation.priority !== true) return Promise.resolve(pool.lastResult);
  pool.retryAt = Date.now() + numberPoolRefillCooldownMs;
  numberPools.set(key, pool);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) abort();
  const timeout = setTimeout(abort, priorityStockJobTimeoutMs);
  const target = preparation.target || numberPoolRefillThreshold;
  const refill = new Promise((resolve) => setImmediate(resolve))
    .then(() => waitForAbortable(fillNumberPool(key, controller.signal, preparation), controller.signal))
    .then((result) => {
      pool.lastResult = result;
      requestReadyNumberQueueRefresh(key);
      numberPoolFailures.delete(key);
      pool.retryAt = Date.now() + (result >= target
        ? numberPoolRefillCooldownMs
        : numberPoolEmptyCooldownMs);
      return result;
    })
    .catch((error) => {
      pool.lastResult = null;
      pool.retryAt = Date.now() + Math.max(numberPoolEmptyCooldownMs, error.retryAfterMs || 0);
      numberPoolFailures.set(key, {
        error,
        expiresAt: Date.now() + Math.max(1000, error.retryAfterMs || 5000)
      });
      console.error(`Could not refill number inventory for ${key}:`, error.message);
      return null;
    })
    .finally(() => {
      clearTimeout(timeout);
      controller.abort();
      parentSignal?.removeEventListener("abort", abort);
      activeNumberPoolRefills.delete(key);
    });
  activeNumberPoolRefills.set(key, refill);
  return refill;
}

async function refreshCandidateDatabaseStatus(store, service, database, candidates, signal) {
  let snapshot = activeClientOnlineIds.get(database);
  if (snapshot && snapshot.expiresAt <= Date.now()) {
    activeClientOnlineIds.delete(database);
    snapshot = null;
  }
  if (snapshot) {
    if (!snapshot.complete) {
      const knownOnlineCandidates = candidates.filter((candidate) => snapshot.checkedIds.has(candidate.deviceId)
        && snapshot.onlineIds.has(candidate.deviceId));
      if (knownOnlineCandidates.length) return knownOnlineCandidates;
      snapshot = null;
    }
    if (snapshot?.complete) {
      await store.call("markDatabaseOnline", {
        database, onlineDeviceIds: [...snapshot.onlineIds], now: Date.now()
      });
      return store.call("candidates", {
        service, databases: [database], limit: numberPoolClaimCandidates,
        onlineTtl: activeClientsCacheTtlMs, freshOnly: true
      });
    }
  }

  // A whole clients.json can be slow and large on production databases. Verify
  // only the already-saved device IDs, racing a small parallel group.
  const controller = new AbortController();
  const abortForParent = () => controller.abort();
  signal?.addEventListener("abort", abortForParent, { once: true });
  if (signal?.aborted) controller.abort();
  let upstreamError = null;
  let nextCandidate = 0;
  const onlineCandidates = [];
  const checkCandidate = async () => {
    while (!controller.signal.aborted && nextCandidate < candidates.length && !onlineCandidates.length) {
      const candidate = candidates[nextCandidate++];
      try {
        const client = await fetchSharedDatabaseJson(
          `${database}/clients/${encodeURIComponent(candidate.deviceId)}.json`,
          numberStatusCheckTimeoutMs, activeClientsCacheTtlMs, controller.signal
        );
        const online = client?.status === true;
        await store.call("markOnline", { ...candidate, online });
        const checkedAt = Date.now();
        let partial = activeClientOnlineIds.get(database);
        if (!partial || partial.expiresAt <= checkedAt || partial.complete) {
          partial = { onlineIds: new Set(), checkedIds: new Set(), complete: false,
            expiresAt: checkedAt + activeClientsCacheTtlMs };
        }
        partial.checkedIds.add(candidate.deviceId);
        if (online) partial.onlineIds.add(candidate.deviceId);
        else partial.onlineIds.delete(candidate.deviceId);
        activeClientOnlineIds.set(database, partial);
        while (activeClientOnlineIds.size > 500) {
          activeClientOnlineIds.delete(activeClientOnlineIds.keys().next().value);
        }
        if (online) {
          onlineCandidates.push(candidate);
          controller.abort();
        }
      } catch (error) {
        if (!controller.signal.aborted && (error.status || error.code || error.name === "TimeoutError")) {
          upstreamError ||= error;
        }
      }
    }
  };
  try {
    await Promise.all(Array.from(
      { length: Math.min(numberStatusCheckDeviceConcurrency, candidates.length) }, checkCandidate
    ));
    if (onlineCandidates.length) return onlineCandidates;
    if (upstreamError) throw upstreamError;
    return [];
  } finally {
    signal?.removeEventListener("abort", abortForParent);
    controller.abort();
  }
}

async function findAvailableActiveNumber(
  service,
  signal = null,
  onCommit = null,
  deadline = Date.now() + numberRequestTimeoutMs,
  options = {}
) {
  const cachedOnly = options.cachedOnly === true;
  return (async () => {
    throwIfAborted(signal);
    const store = await waitForAbortable(getRuntimeStore(), signal);
    // Shared, recently verified stock must be tried before queue maintenance,
    // candidate pagination, or any Firebase read. Selection and lease creation
    // happen together inside SQLite so other PM2 processes see the claim.
    const finishReadyCommit = onCommit?.();
    let readyOrder;
    try {
      readyOrder = await store.call("claimReady", {
        service, deadline: deadline - 100, duration: numberReservationDurationMs,
        onlineTtl: activeClientsCacheTtlMs
      });
    } finally {
      if (typeof finishReadyCommit === "function") finishReadyCommit(Boolean(readyOrder));
    }
    if (readyOrder) {
      recentOrdersCache = null;
      requestNumberPoolRefresh(service);
      return readyOrder;
    }
    const claimCandidatesAtomically = async (candidates) => {
      throwIfAborted(signal);
      const finishCommit = onCommit?.();
      let order;
      try {
        order = await store.call("claimAny", {
          service, candidates, deadline: deadline - 100, now: Date.now(),
          duration: numberReservationDurationMs, onlineTtl: activeClientsCacheTtlMs
        });
      } finally {
        if (typeof finishCommit === "function") finishCommit(Boolean(order));
      }
      if (order) {
        recentOrdersCache = null;
        requestReadyNumberQueueRefresh(service);
      }
      return order;
    };
    const queueKey = normalizeServiceName(service).toLowerCase();
    let readyQueue = readyNumberQueues.get(queueKey) || [];
    if (readyQueue.length < numberReadyQueueRefillThreshold) {
      const refresh = refreshReadyNumberQueue(queueKey, store).catch(() => null);
      if (!readyQueue.length) {
        await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, numberReadyQueueWaitMs))]);
      }
      readyQueue = readyNumberQueues.get(queueKey) || [];
    }
    while (readyQueue.length) {
      const queuedCandidate = readyQueue.shift();
      const queuedOrder = await claimCandidatesAtomically([queuedCandidate]);
      if (queuedOrder) return queuedOrder;
    }
    const tryInventory = async () => {
      const metadata = await store.call("metadata");
      const verifiedDatabases = new Set(await store.call("verifiedDatabases", {
        databases: metadata.databaseUrls, ttl: activeClientsCacheTtlMs
      }));
      let lastVerificationError = null;
      let databasesChecked = 0;
      const candidateDatabaseUrls = () => metadata.databaseUrls.filter((database) =>
        (slowDatabases.get(database)?.expiresAt || 0) <= Date.now());
      const claimCandidates = async (candidates) => {
        if (!candidates.length) return null;
        throwIfAborted(signal);
        const finish = (order) => {
          requestNumberPoolRefresh(service);
          if (order && (readyNumberQueues.get(queueKey)?.length || 0) < numberReadyQueueRefillThreshold) {
            requestReadyNumberQueueRefresh(queueKey);
          }
          return order;
        };

        // A fresh pool snapshot already confirmed these devices are online.
        const freshCutoff = Date.now() - activeClientsCacheTtlMs;
        const freshCandidates = candidates.filter((candidate) =>
          candidate.reused !== true && verifiedDatabases.has(candidate.database)
          && Number(candidate.checkedAt) > freshCutoff);
        const freshOrder = freshCandidates.length
          ? await claimCandidatesAtomically(freshCandidates)
          : null;
        if (freshOrder) return finish(freshOrder);

        // Race a small set of status checks. A slow device must not hold up an
        // already-confirmed candidate, and losing reads should leave the queue.
        const staleCandidates = candidates
          .filter((candidate) => !freshCandidates.includes(candidate));
        // Interleave databases before verification. A large stock table often
        // contains many mappings from one database; checking only its first
        // few rows can make an unavailable database look like an empty pool.
        const byDatabase = new Map();
        for (const candidate of staleCandidates) {
          const list = byDatabase.get(candidate.database) || [];
          list.push(candidate);
          byDatabase.set(candidate.database, list);
        }
        const selectedGroups = [...byDatabase.entries()].slice(
          0, Math.max(0, numberStatusCheckDatabaseLimit - databasesChecked)
        );
        if (!selectedGroups.length) return null;
        const verificationController = new AbortController();
        const abortVerification = () => verificationController.abort();
        signal?.addEventListener("abort", abortVerification, { once: true });
        if (signal?.aborted) abortVerification();
        let verifiedAny = false;
        const checks = new Map();
        const checkedDatabaseUrls = new Set();
        let nextGroup = 0;
        const startNextCheck = () => {
          if (verificationController.signal.aborted || nextGroup >= selectedGroups.length) return;
          const index = nextGroup++;
          const [database, databaseCandidates] = selectedGroups[index];
          if (!checkedDatabaseUrls.has(database)) {
            checkedDatabaseUrls.add(database);
            databasesChecked += 1;
          }
          checks.set(index, (async () => {
            try {
              const onlineCandidates = await refreshCandidateDatabaseStatus(
                store, service, database, databaseCandidates, verificationController.signal
              );
              return { candidates: onlineCandidates, database, databaseCandidates, index };
            } catch (error) {
              if (!verificationController.signal.aborted) {
                lastVerificationError ||= error;
                recordSlowDatabase(database, error);
              }
              return { candidates: [], index };
            }
          })());
        };
        try {
          for (let index = 0; index < numberStatusCheckConcurrency; index += 1) startNextCheck();
          while (checks.size) {
            const verified = await Promise.race(checks.values());
            checks.delete(verified.index);
            throwIfAborted(signal);
            // Claims remain serial and atomic. If another service wins this
            // number, consume the next ready check instead of failing early.
            if (verified.candidates.length) {
              verifiedAny = true;
              const order = await claimCandidatesAtomically(verified.candidates);
              if (order) return finish(order);
              const issuedDeviceIds = new Set(verified.candidates.map((candidate) => candidate.deviceId));
              const remaining = verified.databaseCandidates.filter((candidate) => !issuedDeviceIds.has(candidate.deviceId));
              if (remaining.length) selectedGroups.push([verified.database, remaining]);
            }
            // A finished empty or failed check immediately frees its lane.
            // Other slow databases need not finish before we try the next.
            startNextCheck();
          }
        } finally {
          signal?.removeEventListener("abort", abortVerification);
          verificationController.abort();
        }
        // Every verified candidate may have been claimed by another request.
        // Let the outer page loop fetch the next stock page instead of
        // exposing a transient contention error as a customer-facing 503.
        return null;
      };
      const triedPages = new Set();
      const maximumPages = Math.max(numberPoolMaxCandidatePages,
        Math.ceil(numberPoolClaimCandidates / numberPoolRefillThreshold));
      for (let page = 0; page < maximumPages; page += 1) {
        if (Date.now() >= deadline - 250) break;
        const eligibleDatabases = candidateDatabaseUrls();
        if (!eligibleDatabases.length) break;
        const candidates = await store.call("candidates", {
          service, databases: eligibleDatabases, limit: numberPoolClaimCandidates, includeOffline: true,
          offset: page * numberPoolClaimCandidates
        });
        const signature = candidates.map((candidate) => candidate.database + "|" + candidate.deviceId + "|" + candidate.number).join("\n");
        if (!signature || triedPages.has(signature)) break;
        triedPages.add(signature);
        const order = await claimCandidates(candidates);
        if (order) return order;
        if (databasesChecked >= numberStatusCheckDatabaseLimit) break;
      }
      const eligibleDatabases = candidateDatabaseUrls();
      if (!eligibleDatabases.length) {
        if (lastVerificationError) throw lastVerificationError;
        return null;
      }
      if (!await store.call("advanceCycle", { service, databases: eligibleDatabases })) {
        if (lastVerificationError && !candidateDatabaseUrls().length) throw lastVerificationError;
        return null;
      }
      const candidates = await store.call("candidates", {
        service, databases: eligibleDatabases, limit: numberPoolClaimCandidates, includeOffline: true
      });
      return claimCandidates(candidates);
    };
    let order = await tryInventory();
    if (order) return order;
    throwIfAborted(signal);
    // Number discovery is performed by background refills. Keep this
    // request path limited to the persisted candidate pool; never block a
    // caller while scanning the rotating Firebase databases.
    if (!cachedOnly) {
      order = await withServiceAllocationLock(service, async () => {
        // Another cold request may have completed discovery while this request
        // waited; recheck its shared pool before starting another Firebase scan.
        const readyOrder = await tryInventory();
        if (readyOrder) return readyOrder;
        const state = await store.call("allocationState", service);
        const scan = await readActiveNumberInventories(service, state, 1, null, signal);
        throwIfAborted(signal);
        await rememberInventories(store, scan.inventories);
        const allocated = await tryInventory();
        if (allocated) return allocated;
        if (scan.failures.length) throw scan.failures[0].error;
        return null;
      }, signal);
      if (order) return order;
    }
    // API allocation is deliberately mapping-only: never read message history
    // while a customer is waiting. Background refills extract and persist new
    // number mappings; this request only checks the saved device online state.
    // A customer request never starts message-history discovery. The startup
    // warmup and low-stock refill hooks keep this inventory populated ahead of
    // demand.
    return null;
  })();
}

function findMatchingMessages(messages, afterTimestamp, service, untilTimestamp = Infinity) {
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) return [];
  const entries = Object.entries(messages)
    .filter(([key, message]) => message
      && typeof message === "object"
      && !Array.isArray(message)
      && !/\bjoin[\s\W_]*telegram\b/i.test(getMessageText(message))
      && (() => {
        const timestamp = getMessageTimestamp(key, message);
        return timestamp !== null && timestamp >= afterTimestamp && timestamp <= untilTimestamp;
      })())
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

function getStoredOrderMessageText(order) {
  const history = Array.isArray(order?.messageHistory) ? order.messageHistory : [];
  const latestOtp = Array.isArray(order?.receivedOtps) ? order.receivedOtps.at(-1) : null;
  const entry = latestOtp?.messageKey
    ? history.find((item) => item && item.key === latestOtp.messageKey)
    : history.find((item) => getMessageText(item?.message || {}).includes(order?.receivedOtp || ""));
  return getMessageText(entry?.message || {});
}

async function getStatusOkText(order) {
  let sendFullText = false;
  try {
    const configured = await readConfiguredServices();
    const service = configured.services.find((item) => item
      && typeof item.name === "string"
      && normalizeServiceName(item.name).toLowerCase()
        === normalizeServiceName(order.service).toLowerCase());
    sendFullText = service?.sendFullText === true;
  } catch {
    // Keep the legacy OTP response if service settings cannot be read.
  }
  const value = sendFullText ? getStoredOrderMessageText(order) : "";
  return `STATUS_OK:${value || order.receivedOtp}`;
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
    const allocationDeadline = Date.now() + numberRequestTimeoutMs;
    const allocationController = new AbortController();
    let allocationTimer = setTimeout(() => allocationController.abort(), numberRequestTimeoutMs);
    const beginReservationCommit = () => {
      throwIfAborted(allocationController.signal);
      clearTimeout(allocationTimer);
      // Do not report a timeout while an atomic claim is committing. If the
      // claim loses a race, restore the original deadline before trying again.
      return (committed) => {
        if (committed) return;
        const remainingMs = allocationDeadline - Date.now();
        if (remainingMs <= 0) allocationController.abort();
        else allocationTimer = setTimeout(() => allocationController.abort(), remainingMs);
      };
    };
    let configuredServices;
    try {
      configuredServices = await waitForAbortable(readConfiguredServices(), allocationController.signal);
      throwIfAborted(allocationController.signal);
    } catch (error) {
      clearTimeout(allocationTimer);
      if (error.code === "ALLOCATION_TIMEOUT" || Date.now() >= allocationDeadline) {
        sendText(response, 200, "NO_NUMBERS");
        return;
      }
      console.error("Could not read configured services:", error.message);
      sendJson(response, 500, { error: "Could not read configured services." });
      return;
    }
    if (!configuredServices.services.some((item) => normalizeServiceName(item.name).toLowerCase() === service
      && item.enabled === true && getEnabledTemplates(item).length > 0)) {
      clearTimeout(allocationTimer);
      sendText(response, 200, "BAD_SERVICE");
      return;
    }
    requestedNumberPoolServices.add(service);
    // Refresh stale saved mappings before demand exhausts the prepared pool.
    // This runs in the background and coalesces per service; allocation still
    // verifies a candidate online immediately before it is reserved.
    requestNumberPoolRefresh(service);
    let reservation;
    try {
      reservation = await waitForAbortable(
        findAvailableActiveNumber(service, allocationController.signal, beginReservationCommit, allocationDeadline, { cachedOnly: true }),
        allocationController.signal
      );
      throwIfAborted(allocationController.signal);
    } catch (error) {
      if (error.code === "ALLOCATION_TIMEOUT" || Date.now() >= allocationDeadline) {
        sendText(response, 200, "NO_NUMBERS");
        return;
      }
      const temporarilyUnavailable = isTemporaryUpstreamError(error);
      if (error.code !== "ALLOCATION_CONTENTION" && !temporarilyUnavailable) {
        console.error("Could not select an active client number:", error.message);
      }
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
          : error.code === "ALLOCATION_CONTENTION"
            ? "ALLOCATION_CONTENTION"
            : "UPSTREAM_UNAVAILABLE"
      }, headers);
      return;
    } finally {
      clearTimeout(allocationTimer);
    }
    if (!reservation) {
      const poolFailure = numberPoolFailures.get(service);
      if (poolFailure && poolFailure.expiresAt > Date.now()) {
        const error = poolFailure.error;
        const retryAfterMs = Math.max(1000, error.retryAfterMs || 1000);
        sendJson(response, 503, {
          error: "The configured databases are temporarily unavailable. Retry shortly.",
          code: "UPSTREAM_UNAVAILABLE"
        }, { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) });
        return;
      }
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
      // Cancel/retry decisions run inside one SQLite transaction.
      result = await (await getRuntimeStore()).call("setStatus", { id: orderIds[0], status: statuses[0] });
      recentOrdersCache = null;
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
    // Indexed single-order read: expiry handled inside SQLite, no state reload.
    reservation = await (await getRuntimeStore()).call("getOrder", orderIds[0]);
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
      ? await getStatusOkText(reservation)
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
      const temporarilyUnavailable = isTemporaryUpstreamError(error);
      const alreadyCooling = (slowDatabases.get(reservation.databaseUrl)?.expiresAt || 0) > Date.now();
      if (error.code !== "RESPONSE_TOO_LARGE") {
        recordSlowDatabase(reservation.databaseUrl, error);
        activeClientsSnapshotFreshUntil.delete(reservation.databaseUrl);
        requestNumberPoolRefresh(reservation.service);
      }
      if (!temporarilyUnavailable || (error.name === "TypeError" && !alreadyCooling)) {
        console.error("Could not read messages for a number order:", error.message);
      }
      if (reservation.receivedOtp !== null) {
        sendText(response, 200, await getStatusOkText(reservation));
        return;
      }
      const retryAfterMs = error.retryAfterMs || (temporarilyUnavailable ? 1000 : 0);
      const headers = retryAfterMs > 0
        ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
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
        : await getStatusOkText(reservation));
      return;
    }
    const matches = findMatchingMessages(
      messages,
      reservation.createdAt,
      orderService,
      Math.min(Date.now(), reservation.expiresAt)
    );
    if (!matches.length && reservation.receivedOtp !== null) {
      sendText(response, 200, await getStatusOkText(reservation));
      return;
    }
    if (!matches.length) {
      sendText(response, 200, "STATUS_WAIT_CODE");
      return;
    }
    let updatedOrder;
    try {
      updatedOrder = await (await getRuntimeStore()).call("updateOrderState", {
        id: orderIds[0], matches
      });
      if (updatedOrder) recentOrdersCache = null;
    } catch (error) {
      console.error("Could not save an OTP received for a number order:", error.message);
      sendJson(response, 500, { error: "Could not save the received OTP." });
      return;
    }
    if (updatedOrder && updatedOrder.receivedOtp !== null) {
      sendText(response, 200, await getStatusOkText(updatedOrder));
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
    const result = await withProviderReadSlot(async () => {
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

function refreshStockSummarySnapshot() {
  if (stockSummaryPending) return stockSummaryPending;
  stockSummaryPending = getRuntimeStore()
    .then((store) => store.call("stockSnapshot", { onlineTtl: activeClientsCacheTtlMs }))
    .then((value) => {
      const progress = value.inventoryProgress;
      const mappingPrefetch = { ...numberMappingPrefetchState };
      mappingPrefetch.total = value.databaseCount;
      mappingPrefetch.mappings = progress?.mappings || 0;
      // On another PM2 process the local prefetch state may be idle. Report
      // durable progress there without mixing previous passes into a live run.
      if (mappingPrefetch.status === "idle") {
        mappingPrefetch.completed = progress?.checkedDatabases || 0;
      }
      const { inventoryProgress, ...summary } = value;
      stockSummaryCache = { value: { ...summary, mappingPrefetch }, expiresAt: Date.now() + 3000 };
      return stockSummaryCache.value;
    })
    .finally(() => { stockSummaryPending = null; });
  return stockSummaryPending;
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
  if (requestUrl.pathname === "/api/stocks") {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method Not Allowed");
      return;
    }
    try {
      if (stockSummaryCache?.value) {
        if (stockSummaryCache.expiresAt <= Date.now()) {
          void refreshStockSummarySnapshot().catch((error) => {
            console.warn("Stock snapshot refresh failed:", error.code || error.name || "storage error");
          });
        }
        sendJson(response, 200, { ...stockSummaryCache.value,
          stale: stockSummaryCache.expiresAt <= Date.now() });
      } else {
        sendJson(response, 200, { ...await refreshStockSummarySnapshot(), stale: false });
      }
    } catch (error) {
      console.warn("Initial stock snapshot failed:", error.code || error.name || "storage error");
      sendJson(response, 503, { error: "Stock totals are temporarily unavailable.", code: "STOCK_READ_FAILED" }, { "Retry-After": "3" });
    }
    return;
  }
  if (requestUrl.pathname === "/api/recent-orders") {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method Not Allowed");
      return;
    }
    // Saved data only; no Firebase scans are triggered by this endpoint.
    try {
      const params = requestUrl.searchParams;
      const options = {
        limit: Math.min(2000, Math.max(1, Number(params.get("limit")) || 6)),
        search: (params.get("search") || "").trim().slice(0, 200), status: params.get("status") || "",
        from: params.has("from") ? Number(params.get("from")) : null,
        to: params.has("to") ? Number(params.get("to")) : null,
        before: params.has("before") ? JSON.parse(params.get("before")) : null
      };
      if ((options.from !== null && !Number.isFinite(options.from))
        || (options.to !== null && !Number.isFinite(options.to))
        || (options.before && (!Number.isFinite(options.before.createdAt) || typeof options.before.orderId !== "string"))) {
        sendJson(response, 400, { error: "Invalid order range or cursor." }); return;
      }
      const savedFeed = params.get("source") === "saved";
      const key = JSON.stringify([savedFeed, options]);
      if (recentOrdersCache?.key === key && recentOrdersCache.expiresAt > Date.now()) {
        sendJson(response, 200, recentOrdersCache.value); return;
      }
      const store = await getRuntimeStore();
      const value = savedFeed ? await store.call("latestMessages") : await store.call("getRecentOrders", options);
      recentOrdersCache = { key, value, expiresAt: Date.now() + recentOrdersCacheTtlMs };
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
        const state = await readRotationMetadata();
        const alreadyExists = state.databaseUrls.includes(normalized);
        if (!alreadyExists) {
          state.databaseUrls.push(normalized);
          await saveRotationMetadata(state);
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
        const state = await withRotationLock(readRotationMetadata);
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
        const current = await readRotationMetadata();
        validated = await validateAndPingRotatingDatabases(input && input.databaseUrls, current.databaseUrls);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (validated.databaseUrls.length === 0) {
        sendJson(response, 400, {
          error: "No valid Firebase database URLs were provided; the saved rotation was not changed.",
          removed: validated.removed
        });
        return;
      }
      try {
        await withRotationLock(async () => {
          const state = await readRotationMetadata();
          state.initialized = true;
          state.databaseUrls = validated.databaseUrls;
          await saveRotationMetadata(state);
        });
        sendJson(response, 200, {
          initialized: true,
          databaseUrls: validated.databaseUrls,
          removed: validated.removed,
          deferred: validated.deferred
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
    "/stocks": { path: stocksPath, contentType: "text/html; charset=utf-8" },
    "/stocks.html": { path: stocksPath, contentType: "text/html; charset=utf-8" },
    "/stocks.js": { path: stocksScriptPath, contentType: "text/javascript; charset=utf-8" },
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





