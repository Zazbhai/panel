"use strict";
const path = require("node:path");
const { Worker } = require("node:worker_threads");

// SQLite work (including migration and fsync) runs outside the HTTP event loop.
class AsyncRuntimeStore {
  constructor(filename) {
    this.pending = new Map();
    this.sequence = 0;
    this.failure = null;
    this.worker = new Worker(path.join(__dirname, "runtime-store-worker.cjs"), { workerData: { filename } });
    this.ready = this.call("ping");
    this.worker.on("message", ({ id, value, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (!this.pending.size) this.worker.unref();
      if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }));
      else request.resolve(value);
    });
    const fail = (error) => {
      this.failure = error;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) => fail(new Error(`Runtime storage worker stopped (${code}).`)));
    this.worker.unref();
  }
  call(method, ...args) {
    return this.send(method, args);
  }
  send(method, args) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 256) return Promise.reject(Object.assign(new Error("Runtime storage is busy."), { status: 503 }));
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
