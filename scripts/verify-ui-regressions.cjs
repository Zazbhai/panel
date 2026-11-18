const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function pageFixture(file, boundary) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", disabled: false, classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, removeAttribute() {}, addEventListener() {},
      querySelectorAll: () => []
    });
    return elements.get(id);
  };
  const requests = [];
  const fixture = { elements, element, requests, response: null };
  const context = vm.createContext({
    document: { getElementById: element, querySelector: () => null },
    window: { dashboardApiFetch: async (url) => { requests.push(url); return fixture.response(url); } },
    URL, URLSearchParams, Date, Intl, console
  });
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const index = source.indexOf(boundary);
  assert(index > 0, `Missing script boundary in ${file}`);
  vm.runInContext(source.slice(0, index), context);
  fixture.context = context;
  return fixture;
}

(async () => {
  {
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, {
        value: "", textContent: "", classList: { add() {}, remove() {} },
        handlers: {}, setAttribute() {}, focus() {},
        addEventListener(name, handler) { this.handlers[name] = handler; }
      });
      return elements.get(id);
    };
    const requested = [];
    const context = vm.createContext({
      URL, Request,
      document: { querySelector: () => null, createElement: () => element("section"), getElementById: element },
      window: { location: { pathname: "/api-docs", href: "http://panel.test/api-docs", origin: "http://panel.test" },
        fetch: async (url) => {
          requested.push(String(url));
          return { ok: false, status: 401, json: async () => ({ error: "Invalid API key" }) };
        }
      }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "api-client.js"), "utf8"), context);
    element("dashboardApiKey").value = "wrong-key";
    await element("applyDashboardApiKey").handlers.click();
    assert.equal(new URL(requested[0]).pathname, "/api/health");
    assert.equal(element("dashboardApiKeyStatus").textContent, "Invalid API key");
  }
  {
    const f = pageFixture("service-messages.js", 'refreshButton.addEventListener("click"');
    vm.runInContext("renderServiceMessages = () => {}; updateServiceFilter = () => {};", f.context);
    const orders = Array.from({ length: 8 }, (_, index) => ({
      orderId: `order-${index}`, service: "Deleted service", deviceId: `device-${index}`,
      receivedOtps: [{ code: "123456", receivedAt: 1700000000000 + index, messageKey: null }]
    }));
    f.response = async (url) => {
      const data = url.startsWith("/api/recent-orders") ? { orders } : { services: [] };
      return { ok: true, text: async () => JSON.stringify(data) };
    };
    f.element("refreshButton").disabled = false;
    await f.context.loadServiceMessages(true);
    assert.equal(f.element("totalMessageCount").textContent, 6);
    assert(f.requests.includes("/api/recent-orders?source=saved"));
    assert(!f.requests.some((url) => /api\/(config|data|device-messages)/.test(url)));
    const items = f.context.getLatestOtpMessages(orders, []);
    assert.equal(items.length, 6);
    assert.equal(items[0].orderId, "order-7");
    f.response = async (url) => {
      if (url === "/api/services") throw new Error("Service configuration unavailable");
      return { ok: true, text: async () => JSON.stringify({ orders }) };
    };
    await f.context.loadServiceMessages(true);
    assert.equal(f.element("totalMessageCount").textContent, 6);
  }
  {
    const f = pageFixture("recent-orders.js", 'refreshOrdersButton.addEventListener("click"');
    vm.runInContext("renderOrderMessages = () => {};", f.context);
    const now = Date.now();
    const order = { orderId: "saved", createdAt: now - 10000, expiresAt: now + 10000,
      service: "Edited or deleted", messageHistory: [
        { key: "sms-one", timestamp: now - 5000, message: { body: "Original template code 123456" } }
      ] };
    await f.context.loadOrderMessages(order);
    assert.equal(f.context.getSavedOrderMessages(order).length, 1);
    assert.equal(vm.runInContext('orderMessageStates.get("saved").entries.length', f.context), 1);
    assert.equal(f.requests.length, 0, "Saved messages should not require current service templates");
  }
  console.log("PASS: latest six saved OTPs survive disabled/deleted/unavailable services; saved feed does not trigger Firebase; saved order messages remain visible.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
