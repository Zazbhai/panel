"use strict";
const { DatabaseSync } = require("node:sqlite");
const { randomBytes } = require("node:crypto");

class RuntimeStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    // A claim never waits long enough for a request to outlive its allocation SLA.
    this.db.exec("PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);"
      + "CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,service TEXT NOT NULL,number TEXT NOT NULL,database_url TEXT NOT NULL,device_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,received_otp TEXT,received_at INTEGER,number_active INTEGER NOT NULL DEFAULT 0);"
      + "CREATE INDEX IF NOT EXISTS orders_recent ON orders(created_at DESC,id DESC);"
      + "CREATE INDEX IF NOT EXISTS orders_number ON orders(number);"
      + "CREATE INDEX IF NOT EXISTS orders_service ON orders(service);"
      + "CREATE INDEX IF NOT EXISTS orders_device ON orders(device_id);"
      + "CREATE INDEX IF NOT EXISTS orders_expiry ON orders(status,expires_at);"
      + "CREATE INDEX IF NOT EXISTS orders_received ON orders(received_at DESC);"
      + "CREATE INDEX IF NOT EXISTS orders_demand ON orders(created_at DESC,service);"
      + "CREATE TABLE IF NOT EXISTS otps(order_id TEXT NOT NULL REFERENCES orders(id),key TEXT NOT NULL,code TEXT NOT NULL,received_at INTEGER NOT NULL,message_key TEXT,PRIMARY KEY(order_id,key));"
      + "CREATE INDEX IF NOT EXISTS otps_recent ON otps(received_at DESC);"
      + "CREATE TABLE IF NOT EXISTS messages(order_id TEXT NOT NULL REFERENCES orders(id),key TEXT NOT NULL,timestamp INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(order_id,key));"
      + "CREATE TABLE IF NOT EXISTS service_locks(service TEXT NOT NULL,number TEXT NOT NULL,locked_at INTEGER NOT NULL,PRIMARY KEY(service,number));"
      + "CREATE TABLE IF NOT EXISTS message_owners(database_url TEXT NOT NULL,device_id TEXT NOT NULL,message_key TEXT NOT NULL,order_id TEXT NOT NULL,PRIMARY KEY(database_url,device_id,message_key));"
      + "CREATE TABLE IF NOT EXISTS leases(number TEXT PRIMARY KEY,order_id TEXT NOT NULL,expires_at INTEGER NOT NULL);"
      + "CREATE INDEX IF NOT EXISTS leases_expiry ON leases(expires_at);"
      + "CREATE TABLE IF NOT EXISTS service_cycles(service TEXT PRIMARY KEY,cycle INTEGER NOT NULL,cursor_url TEXT NOT NULL);"
      + "CREATE TABLE IF NOT EXISTS service_usage(service TEXT NOT NULL,number TEXT NOT NULL,cycle INTEGER NOT NULL,PRIMARY KEY(service,number));"
      + "CREATE TABLE IF NOT EXISTS numbers(database_url TEXT NOT NULL,device_id TEXT NOT NULL,number TEXT NOT NULL,verified_at INTEGER NOT NULL,online INTEGER NOT NULL,checked_at INTEGER NOT NULL,PRIMARY KEY(database_url,device_id));"
      + "CREATE TABLE IF NOT EXISTS database_checks(database_url TEXT PRIMARY KEY,checked_at INTEGER NOT NULL);"
      + "CREATE INDEX IF NOT EXISTS numbers_ready ON numbers(online,verified_at DESC,checked_at DESC);"
      + "CREATE INDEX IF NOT EXISTS numbers_by_database ON numbers(database_url,online,verified_at,checked_at,number);"
      + "CREATE INDEX IF NOT EXISTS numbers_service_candidates ON numbers(online,checked_at,verified_at,database_url,number);");
    this.db.exec("CREATE INDEX IF NOT EXISTS numbers_ready_claim ON numbers(checked_at DESC,number) WHERE online=1;");
    const now = Date.now();
    this.db.prepare("DELETE FROM leases WHERE expires_at<=?").run(now);
    this.db.prepare("UPDATE orders SET status='expired',number_active=0 WHERE status='active' AND expires_at<=?").run(now);
    const duplicate = this.db.prepare("SELECT 1 FROM orders WHERE status='active' GROUP BY number HAVING COUNT(*)>1 LIMIT 1").get();
    if (duplicate) {
      throw new Error("Runtime storage contains duplicate active orders for a number; allocation stopped to protect customers.");
    }
    // The leases table is already unique, but this independently prevents any
    // code path or migration from inserting two active orders for one number.
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS orders_one_active_number ON orders(number) WHERE status='active';");
    this.prepared = new Map();
  }
  sql(text) {
    if (!this.prepared.has(text)) this.prepared.set(text, this.db.prepare(text));
    return this.prepared.get(text);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  metadata() {
    const row = this.sql("SELECT value FROM meta WHERE key='rotation'").get();
    return row ? JSON.parse(row.value) : null;
  }
  setMetadata(state) {
    this.sql("INSERT INTO meta VALUES('rotation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ initialized: state.initialized !== false, databaseUrls: state.databaseUrls }));
  }
  initialize(state) {
    return this.transaction(() => {
      if (this.metadata()) return false;
      this.setMetadata(state);
      for (const [service, usage] of Object.entries(state.serviceUsage || {})) {
        this.sql("INSERT OR IGNORE INTO service_cycles VALUES(?,?,?)").run(service, usage.cycle, usage.cursorUrl);
        for (const number of usage.usedNumbers) {
          this.sql("INSERT OR IGNORE INTO service_usage VALUES(?,?,?)").run(service, number, usage.cycle);
        }
      }
      for (const order of state.orders || []) this.importOrder(order);
      return true;
    });
  }
  importOrder(order) {
    const inserted = this.sql("INSERT OR IGNORE INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      order.orderId, order.service, order.number, order.databaseUrl, order.deviceId,
      order.createdAt, order.expiresAt, order.status, order.receivedOtp, order.receivedAt, Number(order.numberActive === true)
    );
    if (!inserted.changes && !this.sql("SELECT 1 FROM orders WHERE id=?").get(order.orderId)) {
      throw new Error("Runtime storage rejected a second active order for the same number.");
    }
    if (order.receivedOtp != null || order.receivedOtps?.length) this.lock(order.service, order.number, order.receivedAt || order.createdAt);
    for (const otp of order.receivedOtps || []) {
      this.insertOtp(order.orderId, otp);
      if (otp.messageKey) this.sql("INSERT OR IGNORE INTO message_owners VALUES(?,?,?,?)")
        .run(order.databaseUrl, order.deviceId, otp.messageKey, order.orderId);
    }
    for (const item of order.messageHistory || []) {
      this.sql("INSERT OR IGNORE INTO messages VALUES(?,?,?,?)")
        .run(order.orderId, item.key, item.timestamp, JSON.stringify(item.message));
      this.sql("INSERT OR IGNORE INTO message_owners VALUES(?,?,?,?)")
        .run(order.databaseUrl, order.deviceId, item.key, order.orderId);
    }
    this.sql("INSERT OR IGNORE INTO numbers VALUES(?,?,?,?,0,0)")
      .run(order.databaseUrl, order.deviceId, order.number, 0);
    if (order.status === "active" && order.receivedOtp === null && order.expiresAt > Date.now()) {
      this.sql("INSERT INTO leases VALUES(?,?,?) ON CONFLICT(number) DO NOTHING")
        .run(order.number, order.orderId, order.expiresAt);
    }
  }
  lock(service, number, timestamp) {
    this.sql("INSERT OR IGNORE INTO service_locks VALUES(?,?,?)").run(service, number, timestamp);
  }
  insertOtp(id, otp) {
    const key = otp.messageKey || JSON.stringify([otp.code, otp.receivedAt]);
    return this.sql("INSERT OR IGNORE INTO otps VALUES(?,?,?,?,?)")
      .run(id, key, otp.code, otp.receivedAt, otp.messageKey || null).changes;
  }
  expire(now = Date.now()) {
    this.sql("DELETE FROM leases WHERE expires_at<=?").run(now);
    this.sql("UPDATE orders SET status='expired',number_active=0 WHERE status='active' AND expires_at<=?").run(now);
  }
  allocationState(service) {
    this.expire();
    const cycle = this.sql("SELECT * FROM service_cycles WHERE service=?").get(service);
    const usedNumbers = cycle ? this.sql("SELECT number FROM service_usage WHERE service=? AND cycle=?")
      .all(service, cycle.cycle).map((row) => row.number) : [];
    return { ...this.metadata(), serviceUsage: cycle ? { [service]: { cycle: cycle.cycle, cursorUrl: cycle.cursor_url, usedNumbers } } : {},
      orders: this.sql("SELECT number FROM service_locks WHERE service=?").all(service)
        .map((row) => ({ service, number: row.number, receivedOtp: "locked" })),
      reserved: this.sql("SELECT number FROM leases WHERE expires_at>?").all(Date.now()).map((row) => row.number) };
  }
  saveSnapshot(state) {
    return this.transaction(() => {
      this.setMetadata(state);
      for (const order of state.orders) {
        this.importOrder(order);
        this.sql("UPDATE orders SET status=?,received_otp=?,received_at=?,number_active=? WHERE id=?")
          .run(order.status, order.receivedOtp, order.receivedAt, Number(order.numberActive === true), order.orderId);
        if (order.status !== "active") this.releaseOrder(order.orderId);
      }
      this.expire();
    });
  }
  decode(row, history = true, now = Date.now()) {
    if (!row) return null;
    const order = {
      orderId: row.id, service: row.service, number: row.number, databaseUrl: row.database_url,
      deviceId: row.device_id, createdAt: row.created_at, expiresAt: row.expires_at,
      status: row.status === "active" && row.expires_at <= now ? "expired" : row.status,
      receivedOtp: row.received_otp, receivedAt: row.received_at,
      numberActive: row.expires_at > now && ["active", "completed"].includes(row.status) && Boolean(row.number_active),
      locked: row.received_otp !== null
    };
    if (history) {
      order.receivedOtps = this.sql("SELECT code,received_at AS receivedAt,message_key AS messageKey FROM otps WHERE order_id=? ORDER BY received_at").all(row.id);
      order.messageHistory = this.sql("SELECT key,timestamp,payload FROM messages WHERE order_id=? ORDER BY timestamp")
        .all(row.id).map((item) => ({ key: item.key, timestamp: item.timestamp, message: JSON.parse(item.payload) }));
    }
    return order;
  }
  getOrder(id) { return this.decode(this.sql("SELECT * FROM orders WHERE id=?").get(id)); }
  rebuySource({ oldOrderId }) {
    const row = this.sql("SELECT id,service,number,database_url,device_id,created_at,expires_at,status,received_otp,received_at,number_active "
      + "FROM orders WHERE id=?").get(oldOrderId);
    const metadata = this.metadata();
    if (!row) return { order: null, sourceConfigured: false };
    return {
      order: this.decode(row, false),
      sourceConfigured: Boolean(metadata?.databaseUrls.includes(row.database_url))
    };
  }
  rebuyOrder({ oldOrderId, now = Date.now(), duration = 600000, onlineTtl = 300000, mappingTtl = 86400000 }) {
    return this.transaction(() => {
      this.expire(now);
      const old = this.sql("SELECT * FROM orders WHERE id=?").get(oldOrderId);
      if (!old) return { ok: false, code: "REBUY_ORDER_NOT_FOUND" };
      if (old.status === "active") return { ok: false, code: "REBUY_ORDER_ACTIVE" };
      if (old.received_otp !== null) return { ok: false, code: "REBUY_NUMBER_LOCKED" };
      const metadata = this.metadata();
      if (!metadata?.databaseUrls.includes(old.database_url)) {
        return { ok: false, code: "REBUY_SOURCE_NOT_CONFIGURED" };
      }
      // The caller has just confirmed this original device online. Persist the
      // probe and claim the reused number in this one SQLite transaction.
      const refreshed = this.sql("UPDATE numbers SET online=1,checked_at=? WHERE database_url=? AND device_id=? AND number=?")
        .run(now, old.database_url, old.device_id, old.number);
      if (!refreshed.changes) return { ok: false, code: "REBUY_SOURCE_OFFLINE" };
      this.sql("INSERT INTO database_checks VALUES(?,?) ON CONFLICT(database_url) DO UPDATE SET checked_at=excluded.checked_at")
        .run(old.database_url, now);
      const stored = this.sql("SELECT * FROM numbers WHERE database_url=? AND device_id=?")
        .get(old.database_url, old.device_id);
      if (!stored || stored.number !== old.number || stored.online !== 1
        || stored.checked_at <= now - onlineTtl || stored.verified_at <= now - mappingTtl) {
        return { ok: false, code: "REBUY_SOURCE_OFFLINE" };
      }
      if (this.sql("SELECT 1 FROM service_locks WHERE service=? AND number=?")
        .get(old.service, old.number)) {
        return { ok: false, code: "REBUY_NUMBER_LOCKED" };
      }
      if (this.sql("SELECT 1 FROM leases WHERE number=? AND expires_at>?")
        .get(old.number, now)) {
        return { ok: false, code: "REBUY_NUMBER_BUSY" };
      }
      const cycle = this.sql("SELECT cycle,cursor_url FROM service_cycles WHERE service=?")
        .get(old.service);
      const orderId = randomBytes(12).toString("hex");
      this.sql("INSERT INTO orders VALUES(?,?,?,?,?,?,?,'active',NULL,NULL,1)")
        .run(orderId, old.service, old.number, old.database_url, old.device_id, now, now + duration);
      this.sql("INSERT INTO leases VALUES(?,?,?)").run(old.number, orderId, now + duration);
      this.sql("INSERT INTO service_cycles VALUES(?,?,?) ON CONFLICT(service) DO UPDATE SET cursor_url=excluded.cursor_url")
        .run(old.service, cycle?.cycle || 0, old.database_url);
      this.sql("INSERT INTO service_usage VALUES(?,?,?) ON CONFLICT(service,number) DO UPDATE SET cycle=excluded.cycle")
        .run(old.service, old.number, cycle?.cycle || 0);
      return { ok: true, order: this.getOrder(orderId) };
    });
  }
  orderFilter({ search = "", status = "", from = null, to = null } = {}) {
    const parts = ["1=1"], args = [];
    if (search) {
      const term = String(search).trim();
      const lowerTerm = term.toLowerCase();
      // Number and order-ID lookups are the common search cases. Use indexed
      // equality instead of scanning and lowercasing every order row. Keep the
      // contains search for service/device fragments and multi-word queries.
      if (/^\d{7,15}$/.test(term)) {
        parts.push("number=?");
        args.push(term);
      } else if (/^[a-f0-9]{24,64}$/i.test(term)) {
        parts.push("id=?");
        args.push(term);
      } else {
        parts.push("instr(lower(id||' '||service||' '||number||' '||device_id),?)>0");
        args.push(lowerTerm);
      }
    }
    if (status === "number-active") { parts.push("number_active=1 AND status IN ('active','completed') AND expires_at>?"); args.push(Date.now()); }
    else if (status === "expired") { parts.push("(status='expired' OR (status='active' AND expires_at<=?))"); args.push(Date.now()); }
    else if (status === "active") { parts.push("status='active' AND expires_at>?"); args.push(Date.now()); }
    else if (status) { parts.push("status=?"); args.push(status); }
    if (from !== null) { parts.push("created_at>=?"); args.push(from); }
    if (to !== null) { parts.push("created_at<?"); args.push(to); }
    return { where: parts.join(" AND "), args };
  }
  getRecentOrders(options = {}) {
    const result = this.recent(options);
    const { where, args } = this.orderFilter(options);
    const now = Date.now();
    const stats = this.sql("SELECT COUNT(*) AS total,COALESCE(SUM(status='active' AND expires_at>?),0) AS waiting,COALESCE(SUM(status='completed'),0) AS completed,"
      + "COUNT(DISTINCT CASE WHEN number_active=1 AND status IN ('active','completed') AND expires_at>? THEN number END) AS active FROM orders WHERE " + where)
      .get(now, now, ...args);
    return { ...result, stats };
  }
  latestMessages() {
    const rows = this.sql("SELECT o.*,p.code AS otp_code,p.received_at AS otp_received_at,p.message_key AS otp_message_key "
      + "FROM otps p JOIN orders o ON o.id=p.order_id ORDER BY p.received_at DESC LIMIT 6").all();
    return { orders: rows.map((row) => {
      const order = this.decode(row, false);
      const otp = { code: row.otp_code, receivedAt: row.otp_received_at, messageKey: row.otp_message_key };
      order.receivedOtp = otp.code;
      order.receivedAt = otp.receivedAt;
      order.receivedOtps = [otp];
      order.messageHistory = row.otp_message_key
        ? this.sql("SELECT key,timestamp,payload FROM messages WHERE order_id=? AND key=?").all(row.id, row.otp_message_key)
          .map((item) => ({ key: item.key, timestamp: item.timestamp, message: JSON.parse(item.payload) }))
        : [];
      return order;
    }) };
  }
  recent({ limit = 6, before = null, ...filters } = {}) {
    limit = Math.min(2000, Math.max(1, Number(limit) || 500));
    const { where, args } = this.orderFilter(filters);
    const rows = before
      ? this.sql("SELECT * FROM orders WHERE " + where + " AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?")
        .all(...args, before.createdAt, before.createdAt, before.orderId, limit + 1)
      : this.sql("SELECT * FROM orders WHERE " + where + " ORDER BY created_at DESC,id DESC LIMIT ?").all(...args, limit + 1);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return { orders: selected.map((row) => this.decode(row)), hasMore,
      nextCursor: hasMore ? { createdAt: last.created_at, orderId: last.id } : null };
  }
  remember({ database, deviceId, number, online = true, now = Date.now(), verifiedAt = now }) {
    if (!/^\d{10}$/.test(number)) return;
    this.sql("INSERT INTO numbers VALUES(?,?,?,?,?,?) ON CONFLICT(database_url,device_id) DO UPDATE SET number=excluded.number,verified_at=excluded.verified_at,online=excluded.online,checked_at=excluded.checked_at")
      .run(database, deviceId, number, verifiedAt, Number(online), now);
  }
  rememberBatch(entries) {
    return this.transaction(() => { for (const entry of entries) this.remember(entry); });
  }
  mappings(database) {
    return this.sql("SELECT device_id AS deviceId,number,verified_at AS verifiedAt FROM numbers WHERE database_url=? AND verified_at>?")
      .all(database, Date.now() - 86400000);
  }
  advanceCycle({ service, databases, now = Date.now(), mappingTtl = 86400000 }) {
    return this.transaction(() => {
      const state = this.sql("SELECT cycle,cursor_url FROM service_cycles WHERE service=?").get(service);
      const cycle = state?.cycle || 0;
      const pool = JSON.stringify(databases);
      const ready = this.sql("SELECT COUNT(DISTINCT n.number) AS total,"
        + "SUM(CASE WHEN u.number IS NULL THEN 1 ELSE 0 END) AS unused "
        + "FROM numbers n LEFT JOIN service_usage u ON u.service=? AND u.number=n.number AND u.cycle=? "
        + "WHERE n.verified_at>? AND n.database_url IN (SELECT value FROM json_each(?)) "
        + "AND NOT EXISTS(SELECT 1 FROM service_locks l WHERE l.service=? AND l.number=n.number) "
        + "AND NOT EXISTS(SELECT 1 FROM leases r WHERE r.number=n.number AND r.expires_at>?)")
        .get(service, cycle, now - mappingTtl, pool, service, now);
      if (!ready.total || ready.unused) return false;
      const nextCycle = cycle + 1;
      this.sql("INSERT INTO service_cycles VALUES(?,?,?) ON CONFLICT(service) DO UPDATE SET cycle=excluded.cycle")
        .run(service, nextCycle, state?.cursor_url || databases[0] || "");
      return true;
    });
  }
  markOnline({ database, deviceId, online, now = Date.now() }) {
    // Device sweeps often see the same status repeatedly. Avoid rewriting the
    // row more than once per freshness window unless the online flag changed.
    const refreshBefore = now - 8000;
    this.sql("UPDATE numbers SET online=?,checked_at=? WHERE database_url=? AND device_id=? AND (online!=? OR checked_at<=?)")
      .run(Number(online), now, database, deviceId, Number(online), refreshBefore);
  }
  markOnlineBatch(entries) {
    return this.transaction(() => { for (const entry of entries) this.markOnline(entry); });
  }
  markDatabaseOnline({ database, onlineDeviceIds = [], now = Date.now(), preserveOnEmpty = false }) {
    if (onlineDeviceIds.length === 0 && preserveOnEmpty
      && this.sql("SELECT 1 FROM numbers WHERE database_url=? LIMIT 1").get(database)) return 0;
    const ids = JSON.stringify(onlineDeviceIds);
    const changes = this.sql("UPDATE numbers SET online=(device_id IN (SELECT value FROM json_each(?))),checked_at=? "
      + "WHERE database_url=? AND (online!=(device_id IN (SELECT value FROM json_each(?))) OR checked_at<=?)")
      .run(ids, now, database, ids, now - 8000).changes;
    this.sql("INSERT INTO database_checks VALUES(?,?) ON CONFLICT(database_url) DO UPDATE SET checked_at=excluded.checked_at")
      .run(database, now);
    return changes;
  }
  verifiedDatabases({ databases = [], now = Date.now(), ttl = 10000 } = {}) {
    if (!databases.length) return [];
    return this.sql("SELECT database_url AS database FROM database_checks WHERE checked_at>? AND database_url IN (SELECT value FROM json_each(?))")
      .all(now - ttl, JSON.stringify(databases)).map((row) => row.database);
  }
  databaseCheckTimes({ databases = [] } = {}) {
    if (!databases.length) return [];
    return this.sql("SELECT database_url AS database,checked_at AS checkedAt FROM database_checks "
      + "WHERE database_url IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(databases));
  }
  topOrderedServices({ services = [], since = Date.now() - 86400000, now = Date.now(), limit = 5 } = {}) {
    if (!services.length) return [];
    return this.sql("SELECT service,COUNT(*) AS orders FROM orders "
      + "WHERE created_at>=? AND created_at<=? AND service IN (SELECT value FROM json_each(?)) "
      + "GROUP BY service ORDER BY orders DESC,service LIMIT ?")
      .all(since, now, JSON.stringify(services), Math.min(10, Math.max(1, limit)));
  }
  readyStockCount({ service, databases = null, now = Date.now(), onlineTtl = 30000,
    mappingTtl = 86400000, limit = 5000 }) {
    databases ||= this.metadata()?.databaseUrls || [];
    if (!databases.length) return 0;
    const cycle = this.sql("SELECT cycle FROM service_cycles WHERE service=?").get(service)?.cycle || 0;
    // Count only numbers the atomic ready claim can actually use, and stop at
    // the refill target instead of copying/sorting thousands of device records.
    return this.sql("SELECT COUNT(*) AS n FROM (SELECT DISTINCT n.number FROM numbers n "
      + "JOIN database_checks d ON d.database_url=n.database_url "
      + "WHERE n.online=1 AND n.checked_at>? AND n.verified_at>? AND d.checked_at>? "
      + "AND n.database_url IN (SELECT value FROM json_each(?)) "
      + "AND NOT EXISTS(SELECT 1 FROM service_usage u WHERE u.service=? AND u.number=n.number AND u.cycle=?) "
      + "AND NOT EXISTS(SELECT 1 FROM service_locks l WHERE l.service=? AND l.number=n.number) "
      + "AND NOT EXISTS(SELECT 1 FROM leases r WHERE r.number=n.number AND r.expires_at>?) LIMIT ?)")
      .get(now - onlineTtl, now - mappingTtl, now - onlineTtl, JSON.stringify(databases),
        service, cycle, service, now, Math.min(5000, Math.max(1, limit))).n;
  }
  recordDatabaseCheck({ database, now = Date.now() }) {
    this.sql("INSERT INTO database_checks VALUES(?,?) ON CONFLICT(database_url) DO UPDATE SET checked_at=excluded.checked_at")
      .run(database, now);
  }
  inventoryProgress({ databases = [] } = {}) {
    if (!databases.length) return { checkedDatabases: 0, mappings: 0 };
    const checkedDatabases = this.sql("SELECT COUNT(*) AS count FROM database_checks WHERE database_url IN (SELECT value FROM json_each(?))")
      .get(JSON.stringify(databases)).count;
    const mappings = this.sql("SELECT COUNT(*) AS count FROM numbers WHERE database_url IN (SELECT value FROM json_each(?))")
      .get(JSON.stringify(databases)).count;
    return { checkedDatabases, mappings };
  }
  databasesWithMappings({ databases = [] } = {}) {
    if (!databases.length) return [];
    return this.sql("SELECT DISTINCT database_url AS database FROM numbers WHERE database_url IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(databases)).map((row) => row.database);
  }
  databaseInventoryOrder({ databases = [] } = {}) {
    if (!databases.length) return [];
    return this.sql("SELECT database_url AS database,COUNT(*) AS mappings,SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) AS online,MAX(checked_at) AS last_checked FROM numbers WHERE database_url IN (SELECT value FROM json_each(?)) GROUP BY database_url ORDER BY online DESC,mappings DESC,last_checked DESC")
      .all(JSON.stringify(databases));
  }
  databaseStockSummary({ now = Date.now(), onlineTtl = 10000 } = {}) {
    const databases = this.metadata()?.databaseUrls || [];
    if (!databases.length) return [];
    return this.sql("WITH configured AS (SELECT value AS database_url FROM json_each(?)), "
      + "per_number AS (SELECT n.database_url,n.number,MAX(CASE "
      + "WHEN l.number IS NOT NULL THEN 4 "
      + "WHEN n.verified_at<=? OR n.checked_at<=? OR COALESCE(d.checked_at,0)<=? THEN 1 "
      + "WHEN n.online=1 THEN 3 ELSE 2 END) AS state "
      + "FROM numbers n LEFT JOIN leases l ON l.number=n.number AND l.expires_at>? "
      + "LEFT JOIN database_checks d ON d.database_url=n.database_url "
      + "WHERE n.database_url IN (SELECT database_url FROM configured) GROUP BY n.database_url,n.number), "
      + "counts AS (SELECT database_url,COUNT(*) AS savedNumbers,"
      + "COUNT(CASE WHEN state=3 THEN 1 END) AS online,"
      + "COUNT(CASE WHEN state=4 THEN 1 END) AS reserved,"
      + "COUNT(CASE WHEN state=2 THEN 1 END) AS offline,"
      + "COUNT(CASE WHEN state=1 THEN 1 END) AS needsCheck "
      + "FROM per_number GROUP BY database_url) "
      + "SELECT c.database_url AS database,COALESCE(n.savedNumbers,0) AS savedNumbers,"
      + "COALESCE(n.online,0) AS online,COALESCE(n.reserved,0) AS reserved,"
      + "COALESCE(n.offline,0) AS offline,COALESCE(n.needsCheck,0) AS needsCheck,"
      + "d.checked_at AS checkedAt FROM configured c "
      + "LEFT JOIN counts n ON n.database_url=c.database_url "
      + "LEFT JOIN database_checks d ON d.database_url=c.database_url "
      + "ORDER BY savedNumbers DESC,c.database_url")
      .all(JSON.stringify(databases), now - 86400000, now - onlineTtl, now - onlineTtl, now);
  }
  refreshDatabaseInventory({ database, onlineDeviceIds = [], now = Date.now() }) {
    return this.transaction(() => {
      // Do not erase a populated database on a transient empty clients.json
      // response. A later successful sweep or device check can update it.
      if (onlineDeviceIds.length === 0
        && this.sql("SELECT 1 FROM numbers WHERE database_url=? LIMIT 1").get(database)) {
        return this.sql("SELECT COUNT(*) AS count FROM numbers WHERE database_url=?").get(database).count;
      }
      const ids = JSON.stringify(onlineDeviceIds);
      this.sql("UPDATE numbers SET online=(device_id IN (SELECT value FROM json_each(?))),checked_at=? WHERE database_url=?")
        .run(ids, now, database);
      this.sql("INSERT INTO database_checks VALUES(?,?) ON CONFLICT(database_url) DO UPDATE SET checked_at=excluded.checked_at")
        .run(database, now);
      return this.sql("SELECT COUNT(*) AS count FROM numbers WHERE database_url=?").get(database).count;
    });
  }
  releaseOrder(orderId) {
    this.sql("DELETE FROM leases WHERE order_id=?").run(orderId);
  }
  stockSummary({ now = Date.now(), onlineTtl = 10000 } = {}) {
    const databases = this.metadata()?.databaseUrls || [];
    // Multiple device records can report the same number. Count it once and
    // prefer a current online observation over offline or stale observations.
    const counts = this.sql("WITH stock AS ("
      + "SELECT n.number,MAX(CASE WHEN l.number IS NOT NULL THEN 4 "
      + "WHEN n.verified_at<=? OR n.checked_at<=? THEN 1 "
      + "WHEN n.online=1 THEN 3 ELSE 2 END) AS state "
      + "FROM numbers n LEFT JOIN leases l ON l.number=n.number AND l.expires_at>? "
      + "WHERE n.database_url IN (SELECT value FROM json_each(?)) GROUP BY n.number) "
      + "SELECT COUNT(*) AS total,COUNT(CASE WHEN state=3 THEN 1 END) AS online,"
      + "COUNT(CASE WHEN state=4 THEN 1 END) AS reserved,"
      + "COUNT(CASE WHEN state=2 THEN 1 END) AS offline,"
      + "COUNT(CASE WHEN state=1 THEN 1 END) AS needsCheck FROM stock")
      .get(now - 86400000, now - onlineTtl, now, JSON.stringify(databases));
    return { ...counts, databaseCount: databases.length, checkedAt: now };
  }
  stockSnapshot(options = {}) {
    // One read transaction gives totals and progress from the same WAL snapshot.
    this.db.exec("BEGIN");
    try {
      const summary = this.stockSummary(options);
      const metadata = this.metadata();
      const progress = this.inventoryProgress({ databases: metadata?.databaseUrls || [] });
      const priority = this.sql("SELECT value FROM meta WHERE key='priority_stock'").get();
      this.db.exec("COMMIT");
      return { ...summary, inventoryProgress: progress,
        priorityStock: priority ? JSON.parse(priority.value) : null };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  savePriorityStockState(state) {
    this.sql("INSERT INTO meta VALUES('priority_stock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(state));
  }
  claimReady({ service, now = Date.now(), onlineTtl = 10000, mappingTtl = 86400000, ...options }) {
    return this.transaction(() => {
      now = Math.max(now, Date.now());
      if (Date.now() >= (options.deadline ?? Infinity)) {
        const error = new Error("Number allocation deadline exceeded.");
        error.code = "ALLOCATION_TIMEOUT";
        throw error;
      }
      const databases = this.metadata()?.databaseUrls || [];
      if (!databases.length) return null;
      const currentCycle = this.sql("SELECT cycle FROM service_cycles WHERE service=?").get(service)?.cycle || 0;
      // Select and claim under the same write lock: parallel PM2 processes
      // never race over a copied 2,000-row candidate queue on the ready path.
      // Numbers attempted in an older no-OTP cycle are valid fallback stock;
      // only numbers attempted in the current cycle are excluded. Fresh,
      // never-tried numbers are ordered first.
      const row = this.sql("SELECT n.database_url,n.device_id,n.number FROM numbers n "
        + "JOIN database_checks d ON d.database_url=n.database_url "
        + "LEFT JOIN service_usage current_usage ON current_usage.service=? AND current_usage.number=n.number AND current_usage.cycle=? "
        + "WHERE n.online=1 AND n.checked_at>? AND n.verified_at>? AND d.checked_at>? "
        + "AND n.database_url IN (SELECT value FROM json_each(?)) "
        + "AND current_usage.number IS NULL "
        + "AND NOT EXISTS(SELECT 1 FROM service_locks l WHERE l.service=? AND l.number=n.number) "
        + "AND NOT EXISTS(SELECT 1 FROM leases r WHERE r.number=n.number AND r.expires_at>?) "
        + "ORDER BY CASE WHEN EXISTS(SELECT 1 FROM service_usage u WHERE u.service=? AND u.number=n.number) THEN 1 ELSE 0 END,"
        + "n.checked_at DESC,n.number LIMIT 1")
        .get(service, currentCycle, now - onlineTtl, now - mappingTtl, now - onlineTtl,
          JSON.stringify(databases), service, now, service);
      if (!row) return null;
      this.expire(now);
      return this.claimWithinTransaction({ ...options, service, now, onlineTtl, mappingTtl,
        candidate: { database: row.database_url, deviceId: row.device_id, number: row.number } });
    });
  }
  candidates({ service, databases, now = Date.now(), mappingTtl = 86400000, onlineTtl = 30000, limit = 32, offset = 0, freshOnly = false, includeOffline = false }) {
    // Numbers already attempted in the current service cycle are excluded.
    // Once every eligible number has been attempted, advanceCycle moves to a
    // new cycle and these no-OTP numbers become the final fallback candidates.
    // OTP-bearing numbers remain excluded forever by service_locks.
    const query = "WITH candidates AS (SELECT n.*,c.cycle AS current_cycle,u.cycle AS used_cycle,"
      + "ROW_NUMBER() OVER(PARTITION BY n.database_url ORDER BY n.checked_at DESC,n.number) AS database_rank "
      + "FROM numbers n "
      + "LEFT JOIN service_cycles c ON c.service=? "
      + "LEFT JOIN service_usage u ON u.service=? AND u.number=n.number "
      + "WHERE " + (freshOnly ? "(n.online=1 AND n.checked_at>?) " : (includeOffline ? "1=1 " : "(n.online=1 OR n.checked_at<=?) "))
      + "AND n.verified_at>? AND n.database_url IN (SELECT value FROM json_each(?)) "
      + "AND NOT EXISTS(SELECT 1 FROM service_locks l WHERE l.service=? AND l.number=n.number) "
      + "AND (u.cycle IS NULL OR u.cycle<>COALESCE(c.cycle,0)) "
      + "AND NOT EXISTS(SELECT 1 FROM leases r WHERE r.number=n.number AND r.expires_at>?) ) "
      // Fresh numbers (no service_usage row) always precede numbers recycled
      // from an earlier cycle. Within each group, interleave databases so one
      // slow project cannot dominate the bounded online-check batch.
      + "SELECT * FROM candidates ORDER BY CASE WHEN used_cycle IS NULL THEN 0 ELSE 1 END,database_rank,checked_at DESC LIMIT ? OFFSET ?";
    const args = freshOnly || !includeOffline
      ? [service, service, now - onlineTtl, now - mappingTtl, JSON.stringify(databases), service, now, limit, Math.max(0, offset)]
      : [service, service, now - mappingTtl, JSON.stringify(databases), service, now, limit, Math.max(0, offset)];
    return this.sql(query).all(...args)
      .map((row) => ({ database: row.database_url, deviceId: row.device_id, number: row.number,
        verifiedAt: row.verified_at, checkedAt: row.checked_at,
        // A number used in an earlier cycle is a fallback. It is deliberately
        // returned after unused numbers and must be rechecked online at claim.
        reused: row.used_cycle !== null && row.used_cycle !== row.current_cycle }));
  }
  claim(options) {
    return this.transaction(() => {
      this.expire(options.now ?? Date.now());
      return this.claimWithinTransaction(options);
    });
  }
  claimAny({ service, candidates = [], ...options }) {
    return this.transaction(() => {
      this.expire(options.now ?? Date.now());
      for (const candidate of candidates) {
        const order = this.claimWithinTransaction({ ...options, service, candidate });
        if (order) return order;
      }
      return null;
    });
  }
  claimWithinTransaction({ service, candidate, now = Date.now(), duration = 600000, deadline = Infinity, mappingTtl = 86400000, onlineTtl = 3000 }) {
    if (Date.now() >= deadline) {
      const error = new Error("Number allocation deadline exceeded.");
      error.code = "ALLOCATION_TIMEOUT"; throw error;
    }
    const meta = this.metadata();
    if (!meta?.databaseUrls.includes(candidate.database)) return null;
    if (this.sql("SELECT 1 FROM service_locks WHERE service=? AND number=?").get(service, candidate.number)) return null;
    const currentCycle = this.sql("SELECT cycle FROM service_cycles WHERE service=?").get(service)?.cycle || 0;
    const used = this.sql("SELECT cycle FROM service_usage WHERE service=? AND number=?").get(service, candidate.number);
    if (used?.cycle === currentCycle) return null;
    if (this.sql("SELECT 1 FROM leases WHERE number=? AND expires_at>?").get(candidate.number, now)) return null;
    const stored = this.sql("SELECT * FROM numbers WHERE database_url=? AND device_id=?").get(candidate.database, candidate.deviceId);
    if (!stored || stored.number !== candidate.number || !stored.online
      || stored.verified_at <= now - mappingTtl || stored.checked_at <= now - onlineTtl) return null;
    const cycleState = this.sql("SELECT * FROM service_cycles WHERE service=?").get(service);
    const cycle = cycleState?.cycle || 0;
    const id = randomBytes(12).toString("hex");
    this.sql("DELETE FROM leases WHERE number=? AND expires_at<=?").run(candidate.number, now);
    this.sql("INSERT INTO orders VALUES(?,?,?,?,?,?,?,'active',NULL,NULL,1)")
      .run(id, service, candidate.number, candidate.database, candidate.deviceId, now, now + duration);
    this.sql("INSERT INTO leases VALUES(?,?,?)").run(candidate.number, id, now + duration);
    this.sql("INSERT INTO service_cycles VALUES(?,?,?) ON CONFLICT(service) DO UPDATE SET cycle=excluded.cycle,cursor_url=excluded.cursor_url")
      .run(service, cycle, candidate.database);
    this.sql("INSERT INTO service_usage VALUES(?,?,?) ON CONFLICT(service,number) DO UPDATE SET cycle=excluded.cycle")
      .run(service, candidate.number, cycle);
    const order = this.getOrder(id);
    if (Date.now() >= deadline) {
      const error = new Error("Number allocation deadline exceeded.");
      error.code = "ALLOCATION_TIMEOUT"; throw error;
    }
    return order;
  }
  receive({ id, matches, now = Date.now() }) {
    return this.transaction(() => {
      const row = this.sql("SELECT * FROM orders WHERE id=?").get(id);
      if (!row || !["active", "completed"].includes(row.status) || row.expires_at <= now) return this.decode(row);
      for (const match of matches) {
        if (match.timestamp < row.created_at || match.timestamp > Math.min(now, row.expires_at)) continue;
        const owner = this.sql("SELECT order_id FROM message_owners WHERE database_url=? AND device_id=? AND message_key=?")
          .get(row.database_url, row.device_id, match.key);
        if (owner && owner.order_id !== id) continue;
        this.sql("INSERT OR IGNORE INTO message_owners VALUES(?,?,?,?)").run(row.database_url, row.device_id, match.key, id);
        this.insertOtp(id, { code: match.code, receivedAt: match.timestamp, messageKey: match.key });
        this.sql("INSERT OR IGNORE INTO messages VALUES(?,?,?,?)")
          .run(id, match.key, match.timestamp, JSON.stringify(match.message));
        this.lock(row.service, row.number, match.timestamp);
      }
      const latest = this.sql("SELECT code,received_at FROM otps WHERE order_id=? ORDER BY received_at DESC LIMIT 1").get(id);
      if (latest && (row.received_otp !== latest.code || row.received_at !== latest.received_at)) {
        this.sql("UPDATE orders SET status='completed',received_otp=?,received_at=? WHERE id=?")
          .run(latest.code, latest.received_at, id);
      }
      if (latest) this.releaseOrder(id);
      return this.getOrder(id);
    });
  }
  setStatus({ id, status }) {
    return this.transaction(() => {
      this.expire();
      const order = this.getOrder(id);
      if (!order) return "NO_ACTIVATION";
      if (order.status !== "active") return "STATUS_CANCEL";
      if (status === "8") {
        this.sql("UPDATE orders SET status='cancelled',number_active=0 WHERE id=?").run(id);
        this.sql("DELETE FROM leases WHERE order_id=?").run(id);
        return "ACCESS_CANCEL";
      }
      return "ACCESS_RETRY_GET";
    });
  }
  updateOrderState({ id, numberActive, matches = [], now = Date.now() }) {
    let row = this.sql("SELECT * FROM orders WHERE id=?").get(id);
    if (!row) return null;
    if (row.expires_at <= now && row.status === "active") {
      this.sql("UPDATE orders SET status='expired',number_active=0 WHERE id=?").run(id);
      this.releaseOrder(id);
      row = this.sql("SELECT * FROM orders WHERE id=?").get(id);
    } else if (typeof numberActive === "boolean" && row.status !== "cancelled" && row.status !== "expired") {
      this.sql("UPDATE orders SET number_active=? WHERE id=?").run(Number(numberActive), id);
    }
    if (["active", "completed"].includes(row.status) && row.expires_at > now) this.receive({ id, matches, now });
    return this.getOrder(id);
  }
  snapshot() {
    const meta = this.metadata();
    const serviceUsage = Object.create(null);
    for (const row of this.sql("SELECT * FROM service_cycles").all()) {
      serviceUsage[row.service] = { cursorUrl: row.cursor_url, cycle: row.cycle,
        usedNumbers: this.sql("SELECT number FROM service_usage WHERE service=? AND cycle=?")
          .all(row.service, row.cycle).map((item) => item.number) };
    }
    const orders = this.sql("SELECT * FROM orders ORDER BY created_at").all().map((row) => this.decode(row));
    return { ...meta, serviceUsage, orders };
  }
  close() { this.db.close(); }
  ping() { return true; }
}
module.exports = { RuntimeStore };
