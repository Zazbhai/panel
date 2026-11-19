// Load backend functions with synthetic storage and networking. Never starts server.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

module.exports = function serverFixture() {
  const serverPath = path.join(__dirname, "..", "server.js");
  const localRequire = createRequire(serverPath);
  const source = fs.readFileSync(serverPath, "utf8");
  const startup = source.lastIndexOf("const server = createServer(");
  assert(startup > 0);
  const apiKey = "synthetic-api-key-".repeat(3);
  const files = new Map([
    [path.join(path.dirname(serverPath), "rotation.json"), JSON.stringify({
      databaseUrls: ["https://fixture.firebaseio.com"], serviceUsage: {}, orders: []
    })],
    [path.join(path.dirname(serverPath), "services.json"), "[]"],
    [path.join(path.dirname(serverPath), "service-sms-formats.json"), "[]"]
  ]);
  const requests = [];
  const readCounts = new Map();
  const fixture = { apiKey, files, requests, readCounts, fetch: null };
  const context = vm.createContext({
    require(name) {
      if (name === "./runtime-store.cjs") return {
        AsyncRuntimeStore: class {
          constructor() {
            const { RuntimeStore } = localRequire("./runtime-store-core.cjs");
            this.store = new RuntimeStore(":memory:");
            fixture.runtime = this.store;
          }
          async call(method, ...args) { return this.store[method](...args); }
          async close() { this.store.close(); }
        }
      };
      if (name === "dotenv") return { config: () => ({}) };
      if (name === "node:fs/promises") return {
        async readFile(file) {
          readCounts.set(file, (readCounts.get(file) || 0) + 1);
          if (!files.has(file)) throw Object.assign(new Error("Missing fixture file"), { code: "ENOENT" });
          return files.get(file);
        },
        async writeFile(file, contents, options) {
          if (options?.flag === "wx" && files.has(file)) throw Object.assign(new Error("Exists"), { code: "EEXIST" });
          files.set(file, contents);
        },
        async rename(from, to) { assert(files.has(from)); files.set(to, files.get(from)); files.delete(from); },
        async unlink(file) { files.delete(file); }
      };
      return localRequire(name);
    },
    __dirname: path.dirname(serverPath),
    process: { env: { DASHBOARD_API_KEY: apiKey, DASHBOARD_ADMIN_KEY: "synthetic-admin-key-".repeat(3) } },
    Buffer, URL, AbortSignal, AbortController, console, setImmediate,
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    fetch: async (url, options) => {
      requests.push(url);
      assert(fixture.fetch, `Unexpected upstream request: ${url}`);
      return fixture.fetch(url, options);
    }
  });
  vm.runInContext(source.slice(0, startup), context);
  fixture.context = context;
  fixture.rotation = () => fixture.runtime?.metadata() ? fixture.runtime.snapshot() : JSON.parse(files.get(path.join(path.dirname(serverPath), "rotation.json")));
  fixture.setRotation = (state) => files.set(path.join(path.dirname(serverPath), "rotation.json"), JSON.stringify(state));
  fixture.request = async (url, { method = "GET", body, admin = false } = {}) => {
    const result = {};
    const session = admin ? context.createAdminSession().token : null;
    const request = {
      url, method, headers: {
        host: "panel.test", origin: "http://panel.test",
        ...(session ? { cookie: `dashboard_admin_session=${session}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); }
    };
    await context.handleRequest(request, {
      writeHead(status, headers) { result.status = status; result.headers = headers; },
      end(contents) { result.body = contents; }
    });
    return result;
  };
  return fixture;
};
