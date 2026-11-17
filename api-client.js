const isApiPage = ["/api-docs", "/api-docs.html"].includes(window.location.pathname);
let apiKeyInput = null;

const appHeader = document.querySelector(".app-header");
if (appHeader) {
  const logoutButton = document.createElement("button");
  logoutButton.type = "button";
  logoutButton.className = "secondary";
  logoutButton.textContent = "Sign out";
  logoutButton.setAttribute("aria-label", "Sign out of the admin session");
  logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
      const response = await window.fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error(`Sign out failed (HTTP ${response.status}).`);
      window.location.replace("/login");
    } catch (error) {
      logoutButton.disabled = false;
      logoutButton.textContent = "Sign out failed";
      logoutButton.title = error.message;
    }
  });
  appHeader.append(logoutButton);
}

if (isApiPage) {
  const apiKeyPanel = document.createElement("section");
  apiKeyPanel.className = "api-key-panel";
  apiKeyPanel.setAttribute("aria-labelledby", "apiKeyHeading");
  apiKeyPanel.innerHTML = `
    <strong id="apiKeyHeading">API access</strong>
    <label for="dashboardApiKey">Dashboard API key</label>
    <input id="dashboardApiKey" type="password" autocomplete="off" spellcheck="false">
    <button id="applyDashboardApiKey" type="button">Apply key</button>
    <p>Used for this page only. API URLs include your key; do not share them.</p>
    <p id="dashboardApiKeyStatus" role="status" aria-live="polite"></p>
  `;

  const pageHeading = document.querySelector(".page-heading");
  if (pageHeading) pageHeading.after(apiKeyPanel);

  apiKeyInput = document.getElementById("dashboardApiKey");
  const apiKeyStatus = document.getElementById("dashboardApiKeyStatus");
  document.getElementById("applyDashboardApiKey").addEventListener("click", async () => {
    if (!apiKeyInput.value) {
      apiKeyStatus.textContent = "Enter the dashboard API key first.";
      apiKeyStatus.classList.add("error");
      apiKeyInput.focus();
      return;
    }

    try {
      const response = await window.dashboardApiFetch("/api/config");
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body && body.error ? body.error : `Request failed (HTTP ${response.status}).`);
      }
      apiKeyStatus.textContent = "API key accepted for this page.";
      apiKeyStatus.classList.remove("error");
      window.dispatchEvent(new Event("dashboard-api-key-ready"));
    } catch (error) {
      apiKeyStatus.textContent = error.message;
      apiKeyStatus.classList.add("error");
    }
  });
}

window.dashboardApiFetch = function dashboardApiFetch(input, options) {
  const requestUrl = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
    window.location.href
  );
  const isDashboardApi = requestUrl.origin === window.location.origin
    && (requestUrl.pathname.startsWith("/api/")
      || requestUrl.pathname === "/stubs/handler_api.php");
  if (!isDashboardApi) return window.fetch(input, options);
  if (!isApiPage) return window.fetch(input, options);

  const apiKey = apiKeyInput ? apiKeyInput.value : "";
  if (!apiKey) throw new Error("Enter and apply the dashboard API key before making API requests.");
  requestUrl.searchParams.set("api_key", apiKey);

  const requestInput = input instanceof Request
    ? new Request(requestUrl.toString(), input)
    : requestUrl.toString();
  return window.fetch(requestInput, options);
};
