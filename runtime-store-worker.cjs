"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { RuntimeStore } = require("./runtime-store-core.cjs");
const store = new RuntimeStore(workerData.filename);
parentPort.on("message", ({ id, method, args }) => {
  try {
    const value = store[method](...args);
    parentPort.postMessage({ id, value });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
