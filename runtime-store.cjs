"use strict";
const path = require("node:path");
const { Worker } = require("node:worker_threads");

// SQLite work (including migration and fsync) runs outside the HTTP event loop.
class AsyncRuntimeStore {
  constructor(filename) {
    this.pending = new Map();
    this.inflightReads = new Map();
    this.sequence = 0;
    this.failure = null;
    this.worker = new Worker(path.join(__dirname, "runtime-store-worker.cjs"), { workerData: { filename } });
    this.ready = this.call("ping");
    this.worker.on("message", ({ id, value, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (!this.pending.size) this.worker.unref();
      if (error) request.reject(Object.assign(new Error(error.message), { code: error.code, status: error.status }));
      else request.resolve(value);
    });
    const fail = (error) => {
      this.failure = error;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) => fail(new Error(`Runtime storage worker stopped (${code}).`)));
    if (!this.pending.size) this.worker.unref();
  }
  call(method, ...args) {
    if (method === "claimReady" || method === "refreshDatabaseInventory") return this.retryTransaction(method, args);
    // Status polling can produce many identical reads for the same order.
    // Share one worker request among concurrent callers instead of filling the
    // IPC queue with duplicate SQLite work.
    const key = method === "getOrder" && typeof args[0] === "string"
      ? `${method}:${args[0]}`
      : null;
    if (key && this.inflightReads.has(key)) return this.inflightReads.get(key);
    const request = this.send(method, args);
    if (!key) return request;
    const shared = request.finally(() => {
      if (this.inflightReads.get(key) === shared) this.inflightReads.delete(key);
    });
    this.inflightReads.set(key, shared);
    return shared;
  }
  async retryTransaction(method, args) {
    // Another PM2 process can briefly own the WAL write lock. A failed BEGIN
    // (or rolled-back claim) is safe to retry; do not retry other storage errors.
    const deadline = args[0]?.deadline ?? Date.now() + 1000;
    for (let attempt = 0; ; attempt++) {
      try { return await this.send(method, args); }
      catch (error) {
        const busy = error.code === "ERR_SQLITE_ERROR" && /database is (locked|busy)/i.test(error.message);
        if (!busy) throw error;
        if (attempt >= 2 || Date.now() + 30 >= deadline) {
          error.status = 503;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
      }
    }
  }
  send(method, args) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 2048) return Promise.reject(Object.assign(new Error("Runtime storage is busy."), { status: 503 }));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.ref();
      this.worker.postMessage({ id, method, args });
    });
  }
  async close() {
    await this.call("close");
    await this.worker.terminate();
  }
}
module.exports = { AsyncRuntimeStore };
