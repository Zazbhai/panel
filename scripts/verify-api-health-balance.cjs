// Exercise the real request handler without starting a server or reading Firebase.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const serverPath = path.join(__dirname, "..", "server.js");
const serverRequire = createRequire(serverPath);
const source = fs.readFileSync(serverPath, "utf8");
const startup = source.lastIndexOf("const server = createServer(");
assert(startup > 0, "Server startup boundary was not found");
const apiKey = "synthetic-api-key-".repeat(3);
const context = vm.createContext({
  require(name) {
    if (name === "dotenv") return { config: () => ({}) };
    if (name === "node:fs/promises") {
      return {
        readFile() { throw new Error("Unexpected file read"); },
        writeFile() { throw new Error("Unexpected file write"); }
      };
    }
    return serverRequire(name);
  },
  __dirname: path.dirname(serverPath),
  process: { env: { DASHBOARD_API_KEY: apiKey, DASHBOARD_ADMIN_KEY: "synthetic-admin-key-".repeat(3) } },
  Buffer, URL, console,
  fetch() { throw new Error("Unexpected network request"); }
});
vm.runInContext(source.slice(0, startup), context);

async function request(url, method = "GET") {
  const result = {};
  await context.handleRequest({ url, method, headers: {} }, {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(body) { result.body = body; }
  });
  return result;
}

(async () => {
  for (const [route, expected] of [
    ["/api/health", { status: "ok" }],
    ["/api/balance", { balance: 1, mock: true }]
  ]) {
    assert.equal((await request(route)).status, 401);
    assert.equal((await request(`${route}?api_key=wrong`)).status, 401);
    assert.equal((await request(`${route}?api_key=${apiKey}&api_key=${apiKey}`)).status, 401);
    const url = `${route}?api_key=${apiKey}`;
    const result = await request(url);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), expected);
    assert.equal(result.headers["Cache-Control"], "no-store");
    const invalidMethod = await request(url, "POST");
    assert.equal(invalidMethod.status, 405);
    assert.equal(invalidMethod.headers.Allow, "GET");
    assert.equal((await request(url)).body, result.body);
  }
  for (const [action, expected] of [["getHealth", "OK"], ["getBalance", "ACCESS_BALANCE:1"]]) {
    const url = `/stubs/handler_api.php?action=${action}&api_key=${apiKey}`;
    const result = await request(url);
    assert.equal(result.status, 200);
    assert.equal(result.body, expected);
    assert.equal((await request(url, "POST")).status, 405);
  }
  console.log("PASS: health/balance authentication, methods, responses, fixed balance and handler actions; no network or data access.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
