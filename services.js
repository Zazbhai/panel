const storageKey = "firebase-dashboard.services.v1";
const serviceForm = document.getElementById("serviceForm");
const serviceIdInput = document.getElementById("serviceId");
const serviceNameInput = document.getElementById("serviceName");
const templateList = document.getElementById("templateList");
const templateCount = document.getElementById("templateCount");
const configuredServiceCount = document.getElementById("configuredServiceCount");
const addTemplateButton = document.getElementById("addTemplateButton");
const minOtpLengthInput = document.getElementById("minOtpLength");
const maxOtpLengthInput = document.getElementById("maxOtpLength");
const senderFilterInput = document.getElementById("senderFilter");
const serviceList = document.getElementById("serviceList");
const serviceStatus = document.getElementById("serviceStatus");
const serviceSearch = document.getElementById("serviceSearch");
const serviceResultCount = document.getElementById("serviceResultCount");
const showMoreServices = document.getElementById("showMoreServices");
const addServiceButton = document.getElementById("addServiceButton");
const enableAllServicesButton = document.getElementById("enableAllServicesButton");
const importSmsFormatsButton = document.getElementById("importSmsFormatsButton");
const serviceActionStatus = document.getElementById("serviceActionStatus");
const serviceEditorDialog = document.getElementById("serviceEditorDialog");
const cancelEditButton = document.getElementById("cancelEditButton");
const cancelEditTextButton = document.getElementById("cancelEditTextButton");
const saveServiceButton = document.getElementById("saveServiceButton");
const SERVICE_BATCH_SIZE = 6;
const SERVICE_SEARCH_DELAY = 120;
const serviceSearchIndex = new WeakMap();
let templateEditorSequence = 0;
let visibleServiceLimit = SERVICE_BATCH_SIZE;
let servicesImporting = false;
let serviceSearchTimer = null;

function setStatus(message, isError) {
  serviceStatus.textContent = message;
  serviceStatus.classList.toggle("error", Boolean(isError));
}

function normalizeService(service) {
  const { template: legacyTemplate, ...rest } = service;
  const normalized = {
    ...rest,
    templates: Array.isArray(service.templates)
      ? service.templates.map((template) => ({
        text: template && typeof template.text === "string" ? template.text : "",
        enabled: !template || template.enabled !== false
      }))
      : typeof legacyTemplate === "string"
        ? [{ text: legacyTemplate, enabled: true }]
        : [],
    minOtpLength: Number.isInteger(service.minOtpLength) ? service.minOtpLength : 4,
    maxOtpLength: Number.isInteger(service.maxOtpLength) ? service.maxOtpLength : 8,
    senderFilter: typeof service.senderFilter === "string" ? service.senderFilter : ""
  };
  serviceSearchIndex.set(normalized, [normalized.name, normalized.senderFilter,
    ...normalized.templates.map((template) => template.text)]
    .join(" ").toLocaleLowerCase());
  return normalized;
}

function serviceNameKey(name) {
  return name.replace(/\s+/g, "").toLocaleLowerCase();
}

function readServices() {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return [];
    const value = JSON.parse(stored);
    if (!Array.isArray(value)) throw new Error("Saved services data is invalid.");
    return value.filter((service) => service
      && typeof service.id === "string"
      && typeof service.name === "string"
      && typeof service.enabled === "boolean")
      .map(normalizeService);
  } catch (error) {
    setStatus(`Could not read saved services: ${error.message}`, true);
    return [];
  }
}

let services = readServices();
let servicesReady = false;
let servicesSaving = false;
let servicesSyncing = false;

function updateEnableAllServicesButton() {
  enableAllServicesButton.disabled = !servicesReady || servicesSyncing || servicesSaving
    || servicesImporting || services.every((service) => service.enabled);
}

async function writeServicesToServer(nextServices) {
  const response = await window.dashboardApiFetch("/api/services", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ services: nextServices })
  });
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(`The server returned invalid services data (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(result && result.error
      ? result.error
      : `Could not save services (HTTP ${response.status}).`);
  }
}

async function saveServices(nextServices) {
  if (!servicesReady) throw new Error("Services are still loading. Try again shortly.");
  if (servicesImporting) throw new Error("SMS formats are being imported. Try again shortly.");
  if (servicesSyncing || servicesSaving) throw new Error("Services are syncing or saving. Try again shortly.");
  const focusedControl = document.activeElement;
  const focusedServiceId = focusedControl.closest(".service-card")?.dataset.serviceId;
  const focusedAction = focusedControl.dataset.serviceAction;
  try {
    servicesSaving = true;
    updateEnableAllServicesButton();
    serviceForm.setAttribute("aria-busy", "true");
    serviceList.setAttribute("aria-busy", "true");
    serviceForm.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    serviceList.querySelectorAll("button, input").forEach((control) => { control.disabled = true; });
    await writeServicesToServer(nextServices);
    services = nextServices;
    renderServices();
    try {
      localStorage.setItem(storageKey, JSON.stringify(services));
    } catch (error) {
      // The server save succeeded even if private browsing blocks the cache.
    }
  } finally {
    servicesSaving = false;
    updateEnableAllServicesButton();
    serviceForm.removeAttribute("aria-busy");
    serviceList.removeAttribute("aria-busy");
    serviceForm.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    serviceList.querySelectorAll("button, input").forEach((control) => { control.disabled = false; });
    if (focusedServiceId && focusedAction && document.activeElement === document.body) {
      const card = Array.from(serviceList.children).find((item) => item.dataset.serviceId === focusedServiceId);
      const control = card && Array.from(card.querySelectorAll("[data-service-action]")).find((item) => item.dataset.serviceAction === focusedAction);
      (control || serviceNameInput).focus();
    }
  }
}

async function initializeServices() {
  if (servicesSyncing || servicesSaving || servicesImporting) return;
  servicesSyncing = true;
  servicesReady = false;
  serviceList.setAttribute("aria-busy", "true");
  const showLoading = !services.length;
  if (showLoading) {
    serviceSearch.disabled = true;
    showServiceSkeletons();
    serviceActionStatus.textContent = "Loading services…";
    serviceActionStatus.classList.remove("error");
    serviceActionStatus.setAttribute("data-loading", "");
  }
  updateEnableAllServicesButton();
  try {
    const response = await window.dashboardApiFetch("/api/services");
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`The server returned invalid services data (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(result && result.error
        ? result.error
        : `Could not load services (HTTP ${response.status}).`);
    }
    if (result.initialized) {
      services = result.services.map(normalizeService);
      renderServices();
      try {
        localStorage.setItem(storageKey, JSON.stringify(services));
      } catch (error) {
        // Server data remains usable when browser storage is unavailable.
      }
    } else {
      await writeServicesToServer(services);
      renderServices();
    }
    servicesReady = true;
    updateEnableAllServicesButton();
    setStatus("Services loaded.", false);
    if (showLoading) serviceActionStatus.textContent = "";
  } catch (error) {
    if (showLoading) {
      renderServices();
      serviceActionStatus.textContent = `Could not sync services: ${error.message}`;
      serviceActionStatus.classList.add("error");
    }
    setStatus(`Could not sync services: ${error.message}`, true);
  } finally {
    servicesSyncing = false;
    serviceList.removeAttribute("aria-busy");
    if (showLoading) {
      serviceSearch.disabled = false;
      serviceActionStatus.removeAttribute("data-loading");
    }
    updateEnableAllServicesButton();
  }
}

async function refreshServicesFromServer() {
  if (servicesSyncing || servicesSaving || servicesImporting || document.visibilityState !== "visible") return;
  if (!servicesReady) {
    await initializeServices();
    return;
  }
  servicesSyncing = true;
  updateEnableAllServicesButton();
  try {
    const response = await window.dashboardApiFetch("/api/services");
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`The server returned invalid services data (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(result && result.error
        ? result.error
        : `Could not load services (HTTP ${response.status}).`);
    }
    if (!result.initialized) return;
    if (JSON.stringify(result.services) !== JSON.stringify(services)) {
      services = result.services.map(normalizeService);
      renderServices();
      try {
        localStorage.setItem(storageKey, JSON.stringify(services));
      } catch (error) {
        throw new Error(`Services updated from the server, but the browser cache could not update: ${error.message}`);
      }
      setStatus("Services updated.", false);
    } else if (serviceStatus.classList.contains("error")) {
      setStatus("Services loaded.", false);
    }
  } catch (error) {
    setStatus(`Could not refresh services: ${error.message}`, true);
  } finally {
    servicesSyncing = false;
    updateEnableAllServicesButton();
  }
}

function resetForm() {
  serviceForm.reset();
  serviceIdInput.value = "";
  minOtpLengthInput.value = "4";
  maxOtpLengthInput.value = "8";
  senderFilterInput.value = "";
  renderTemplateEditors([{ text: "", enabled: true }]);
  saveServiceButton.textContent = "Save service";
  cancelEditButton.hidden = true;
  document.getElementById("editorHeading").textContent = "Add a service";
  if (serviceEditorDialog.open) serviceEditorDialog.close();
}

function openEditor(service = null) {
  if (service) {
    serviceIdInput.value = service.id;
    serviceNameInput.value = service.name;
    renderTemplateEditors(service.templates);
    minOtpLengthInput.value = String(service.minOtpLength);
    maxOtpLengthInput.value = String(service.maxOtpLength);
    senderFilterInput.value = service.senderFilter;
    saveServiceButton.textContent = "Update service";
    cancelEditButton.hidden = false;
    document.getElementById("editorHeading").textContent = `Edit ${service.name}`;
  } else {
    serviceIdInput.value = "";
    serviceNameInput.value = "";
    minOtpLengthInput.value = "4";
    maxOtpLengthInput.value = "8";
    senderFilterInput.value = "";
    renderTemplateEditors([{ text: "", enabled: true }]);
    saveServiceButton.textContent = "Save service";
    cancelEditButton.hidden = false;
    document.getElementById("editorHeading").textContent = "Add a service";
  }
  setStatus("", false);
  serviceEditorDialog.showModal();
  (service ? templateList.querySelector("textarea") : serviceNameInput).focus();
}

function makeServiceCard(service) {
  const card = document.createElement("article");
  card.className = "service-card";
  card.dataset.serviceId = service.id;

  const heading = document.createElement("div");
  heading.className = "service-title";
  const name = document.createElement("strong");
  name.textContent = service.name;
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "enabled-control";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.setAttribute("role", "switch");
  checkbox.dataset.serviceAction = "toggle";
  checkbox.checked = service.enabled;
  checkbox.setAttribute("aria-label", `Enable ${service.name}`);
  checkbox.addEventListener("change", async () => {
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    const nextServices = services.map((item) => item.id === service.id
      ? { ...item, enabled }
      : item);
    try {
      await saveServices(nextServices);
      setStatus(`${service.name} ${enabled ? "enabled" : "disabled"}.`, false);
    } catch (error) {
      checkbox.checked = service.enabled;
      setStatus(error.message, true);
    } finally {
      checkbox.disabled = false;
    }
  });
  enabledLabel.append(checkbox, document.createTextNode(service.enabled ? "Enabled" : "Disabled"));
  heading.append(name, enabledLabel);

  const templates = document.createElement("div");
  templates.className = "service-template-list";
  templates.hidden = true;
  const templateToggle = document.createElement("button");
  templateToggle.type = "button";
  templateToggle.className = "template-preview-toggle quiet";
  templateToggle.setAttribute("aria-expanded", "false");
  templateToggle.textContent = `${service.templates.length} template${service.templates.length === 1 ? "" : "s"}`;
  templateToggle.addEventListener("click", () => {
    templates.hidden = !templates.hidden;
    templateToggle.setAttribute("aria-expanded", String(!templates.hidden));
  });
  service.templates.forEach((item, index) => {
    const template = document.createElement("div");
    template.className = "service-template-item";
    const label = document.createElement("strong");
    label.textContent = `Template ${index + 1} · ${item.enabled ? "Enabled" : "Disabled"}`;
    const text = document.createElement("p");
    text.className = "service-template";
    text.textContent = item.text.replace(/\{\{OTP\}\}|\[OTP\]/gi, "[OTP]");
    template.append(label, text);
    templates.append(template);
  });
  const summary = document.createElement("div");
  summary.className = "service-pattern-summary";
  const templateCountLabel = document.createElement("span");
  templateCountLabel.className = "service-template-count";
  templateCountLabel.textContent = `${service.templates.length} pattern${service.templates.length === 1 ? "" : "s"}`;
  const preview = document.createElement("p");
  preview.className = "service-template-preview";
  const firstTemplate = service.templates.find((item) => item.enabled !== false) || service.templates[0];
  preview.textContent = firstTemplate
    ? firstTemplate.text.replace(/\{\{OTP\}\}|\[OTP\]/gi, "[OTP]")
    : "No message pattern configured";
  summary.append(templateCountLabel, preview);
  const settings = document.createElement("p");
  settings.className = "service-settings-summary";
  settings.textContent = `OTP length: ${service.minOtpLength}–${service.maxOtpLength} digits${service.senderFilter ? ` · Sender contains: ${service.senderFilter}` : ""}`;

  const actions = document.createElement("div");
  actions.className = "service-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "secondary";
  edit.dataset.serviceAction = "edit";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openEditor(service));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.dataset.serviceAction = "remove";
  remove.textContent = "Remove";
  remove.addEventListener("click", async () => {
    const confirmed = await window.dashboardUI.confirm({
      title: `Remove ${service.name}?`,
      description: "This removes the service and all of its message templates from the configured list.",
      confirmLabel: "Remove service",
      danger: true
    });
    if (!confirmed) return;
    try {
      await saveServices(services.filter((item) => item.id !== service.id));
      setStatus(`${service.name} removed.`, false);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  actions.append(edit, remove);
  card.append(heading, summary, settings, actions);
  return card;
}

function renderServices() {
  updateEnableAllServicesButton();
  const query = serviceSearch.value.trim().toLocaleLowerCase();
  const filtered = query
    ? services.filter((service) => {
      let indexed = serviceSearchIndex.get(service);
      if (indexed === undefined) {
        indexed = [service.name, service.senderFilter, ...service.templates.map((template) => template.text)]
          .join(" ").toLocaleLowerCase();
        serviceSearchIndex.set(service, indexed);
      }
      return indexed.includes(query);
    })
    : services;
  const visible = filtered.slice(0, visibleServiceLimit);
  configuredServiceCount.textContent = query
    ? `${filtered.length} of ${services.length} services`
    : `${services.length} service${services.length === 1 ? "" : "s"}`;
  serviceResultCount.textContent = query
    ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}`
    : `${filtered.length} available`;
  if (services.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No services yet. Add a template, then enable it to monitor messages.";
    serviceList.replaceChildren(empty);
    showMoreServices.hidden = true;
    return;
  }
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "hint service-empty";
    empty.textContent = "No services match that search.";
    serviceList.replaceChildren(empty);
  } else {
    serviceList.replaceChildren(...visible.map(makeServiceCard));
  }
  showMoreServices.hidden = visible.length >= filtered.length;
}

function showServiceSkeletons() {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < SERVICE_BATCH_SIZE; index += 1) {
    const card = document.createElement("div");
    card.className = "service-loading-card data-loading-skeleton";
    card.setAttribute("aria-hidden", "true");
    card.innerHTML = "<span></span><span></span><span></span><span></span>";
    fragment.append(card);
  }
  serviceList.replaceChildren(fragment);
}

function addTemplateEditor(template = { text: "", enabled: true }) {
  const index = templateList.children.length + 1;
  const sequence = ++templateEditorSequence;
  const inputId = sequence === 1 ? "messageTemplate" : `messageTemplate-${sequence}`;
  const row = document.createElement("div");
  row.className = "template-editor";

  const label = document.createElement("label");
  label.className = "field";
  label.setAttribute("aria-label", `Template ${index} message`);
  const messageTemplateInput = document.createElement("textarea");
  messageTemplateInput.id = inputId;
  messageTemplateInput.rows = 5;
  messageTemplateInput.maxLength = 5000;
  messageTemplateInput.required = true;
  messageTemplateInput.placeholder = "Paste a sample message with its code";
  messageTemplateInput.value = template.text;
  messageTemplateInput.setAttribute("aria-label", `Template ${index} message`);
  label.append(messageTemplateInput);

  row.id = `template-editor-${sequence}`;
  const heading = document.createElement("div");
  heading.className = "template-editor-heading";
  const title = document.createElement("span");
  title.className = "template-editor-title";
  title.textContent = `Template ${index}`;
  const headingActions = document.createElement("div");
  headingActions.className = "template-heading-actions";
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "enabled-control template-enabled-control";
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.dataset.templateEnabled = "";
  enabledInput.checked = template.enabled !== false;
  enabledInput.setAttribute("aria-label", `Match template ${index}`);
  enabledLabel.append(enabledInput, document.createTextNode("Match"));
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "quiet template-remove";
  removeButton.dataset.templateAction = "remove";
  removeButton.setAttribute("aria-label", `Remove template ${index}`);
  removeButton.title = "Remove template";
  removeButton.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-.9 14H5.9L5 6m5 4v6m4-6v6"/></svg>';
  headingActions.append(enabledLabel, removeButton);
  heading.append(title, headingActions);

  const actions = document.createElement("div");
  actions.className = "template-editor-actions";
  const markButton = document.createElement("button");
  markButton.type = "button";
  markButton.className = "secondary";
  markButton.dataset.templateAction = "mark";
  markButton.textContent = "Mark selected code as OTP";

  actions.append(markButton);
  row.append(heading, label, actions);
  templateList.append(row);
  templateCount.textContent = templateList.children.length;
  updateTemplateRemoveButtons();
}

function updateTemplateRemoveButtons() {
  const removeButtons = templateList.querySelectorAll('[data-template-action="remove"]');
  removeButtons.forEach((button) => { button.disabled = removeButtons.length === 1; });
}

function renderTemplateEditors(templates) {
  templateList.replaceChildren();
  templateEditorSequence = 0;
  const items = Array.isArray(templates) && templates.length > 0
    ? templates
    : [{ text: "", enabled: true }];
  items.forEach((template) => addTemplateEditor(template));
}

function markSelectedOtp(messageTemplateInput) {
  const start = messageTemplateInput.selectionStart;
  const end = messageTemplateInput.selectionEnd;
  if (start === end) {
    setStatus("Select only the sample code in the message first.", true);
    return;
  }

  const current = messageTemplateInput.value;
  const selected = current.slice(start, end);
  const selectedDigits = selected.replace(/\D/g, "");
  if (!/^\d(?:[\d\s-]*\d)?$/.test(selected) || selectedDigits.length < 1 || selectedDigits.length > 32) {
    setStatus("Select only a numeric sample code containing 1 to 32 digits.", true);
    return;
  }
  if (/(?:\{\{OTP\}\}|\[OTP\])/i.test(current)) {
    setStatus("A template can contain only one OTP placeholder.", true);
    return;
  }

  const repeatedCode = new RegExp(`(?<!\\d)${Array.from(selectedDigits).join("[\\s-]?")}(?!\\d)`, "g");
  messageTemplateInput.value = current.replace(repeatedCode, "{{OTP}}");
  setStatus("Sample code and matching copies replaced by OTP placeholders.", false);
}

templateList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-template-action]");
  if (!button) return;
  const row = button.closest(".template-editor");
  if (button.dataset.templateAction === "mark") {
    markSelectedOtp(row.querySelector("textarea"));
  } else if (button.dataset.templateAction === "remove") {
    row.remove();
    Array.from(templateList.children).forEach((item, index) => {
      const title = item.querySelector(".template-editor-title");
      title.textContent = `Template ${index + 1}`;
      item.querySelector("[data-template-enabled]").setAttribute("aria-label", `Match template ${index + 1}`);
      item.querySelector("[data-template-action=remove]").setAttribute("aria-label", `Remove template ${index + 1}`);
    });
    templateCount.textContent = templateList.children.length;
    updateTemplateRemoveButtons();
  }
});

addTemplateButton.addEventListener("click", () => addTemplateEditor());

serviceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!servicesReady) {
    setStatus("Services are still loading. Try again shortly.", true);
    return;
  }
  const name = serviceNameInput.value.replace(/\s+/g, "");
  serviceNameInput.value = name;
  if (!name) {
    setStatus("Enter a service name.", true);
    return;
  }
  const minOtpLength = Number(minOtpLengthInput.value);
  const maxOtpLength = Number(maxOtpLengthInput.value);
  if (!Number.isInteger(minOtpLength) || !Number.isInteger(maxOtpLength)
    || minOtpLength < 1 || maxOtpLength < minOtpLength || maxOtpLength > 32) {
    setStatus("Set a valid OTP digit range from 1 to 32 digits.", true);
    return;
  }
  const templates = Array.from(templateList.querySelectorAll(".template-editor")).map((row) => ({
    text: row.querySelector("textarea").value.trim(),
    enabled: row.querySelector("[data-template-enabled]").checked
  }));
  if (templates.some((template) => !/(?:\{\{OTP\}\}|\[OTP\])/i.test(template.text))) {
    setStatus("Mark a sample code as an OTP placeholder in each template.", true);
    return;
  }

  const existing = services.find((service) => service.id === serviceIdInput.value);
  const duplicate = services.find((service) =>
    service.id !== serviceIdInput.value && serviceNameKey(service.name) === serviceNameKey(name));
  if (duplicate) {
    setStatus(`A service named "${duplicate.name}" already exists.`, true);
    return;
  }
  const nextServices = existing
    ? services.map((service) => service.id === existing.id
      ? {
        ...service,
        name,
        templates,
        minOtpLength,
        maxOtpLength,
        senderFilter: senderFilterInput.value.trim()
      }
      : service)
    : [...services, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      templates,
      minOtpLength,
      maxOtpLength,
      senderFilter: senderFilterInput.value.trim(),
      enabled: false
    }];

  try {
    await saveServices(nextServices);
    resetForm();
    setStatus(`${name} saved. Enable it when you want to show matching messages.`, false);
  } catch (error) {
    setStatus(error.message, true);
  }
});

addServiceButton.addEventListener("click", () => openEditor());
enableAllServicesButton.addEventListener("click", async () => {
  if (!servicesReady || servicesSyncing || servicesSaving || servicesImporting) {
    serviceActionStatus.textContent = "Services are still syncing. Try again shortly.";
    serviceActionStatus.classList.add("error");
    return;
  }
  const disabledCount = services.filter((service) => !service.enabled).length;
  if (disabledCount === 0) {
    updateEnableAllServicesButton();
    return;
  }

  enableAllServicesButton.disabled = true;
  try {
    const confirmed = await window.dashboardUI.confirm({
      title: "Enable all services?",
      description: `This enables all ${disabledCount} currently disabled services. Their message templates will be used to match messages.`,
      confirmLabel: "Enable all"
    });
    if (!confirmed) return;
    await saveServices(services.map((service) => ({ ...service, enabled: true })));
    serviceActionStatus.textContent = `Enabled ${disabledCount} service${disabledCount === 1 ? "" : "s"}.`;
    serviceActionStatus.classList.remove("error");
  } catch (error) {
    serviceActionStatus.textContent = `Could not enable all services: ${error.message}`;
    serviceActionStatus.classList.add("error");
  } finally {
    updateEnableAllServicesButton();
  }
});
importSmsFormatsButton.addEventListener("click", async () => {
  if (!servicesReady || servicesSyncing || servicesSaving || servicesImporting) {
    serviceActionStatus.textContent = "Services are still syncing. Try importing again shortly.";
    serviceActionStatus.classList.add("error");
    return;
  }

  servicesImporting = true;
  updateEnableAllServicesButton();
  importSmsFormatsButton.disabled = true;
  addServiceButton.disabled = true;
  serviceForm.setAttribute("aria-busy", "true");
  serviceList.setAttribute("aria-busy", "true");
  serviceForm.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  serviceList.querySelectorAll("button, input").forEach((control) => { control.disabled = true; });
  serviceActionStatus.textContent = "Importing services and templates...";
  serviceActionStatus.classList.remove("error");
  try {
    const response = await window.dashboardApiFetch("/api/services/import-sms-formats", { method: "POST" });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`The server returned invalid import data (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(result && result.error
        ? result.error
        : `Could not import SMS formats (HTTP ${response.status}).`);
    }
    if (!result || !Array.isArray(result.services)) {
      throw new Error("The server returned invalid imported services.");
    }

    services = result.services.map(normalizeService);
    visibleServiceLimit = SERVICE_BATCH_SIZE;
    renderServices();
    try {
      localStorage.setItem(storageKey, JSON.stringify(services));
    } catch (error) {
      // The server save succeeded even if private browsing blocks the cache.
    }
    const summary = `Read ${result.sourceServices} source services and ${result.sourceFormats} formats. Added ${result.addedServices} services and ${result.addedTemplates} patterns; ${result.duplicateTemplates} supported patterns were already configured, and ${result.unsupportedTemplates} formats had no usable OTP marker. ${result.services.length} services are available; search or use Show more to browse them.`;
    serviceActionStatus.textContent = summary;
    serviceActionStatus.classList.remove("error");
  } catch (error) {
    serviceActionStatus.textContent = `Could not import SMS formats: ${error.message}`;
    serviceActionStatus.classList.add("error");
  } finally {
    servicesImporting = false;
    updateEnableAllServicesButton();
    serviceForm.removeAttribute("aria-busy");
    serviceList.removeAttribute("aria-busy");
    serviceForm.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    serviceList.querySelectorAll("button, input").forEach((control) => { control.disabled = false; });
    addServiceButton.disabled = false;
    importSmsFormatsButton.disabled = false;
  }
});
serviceSearch.addEventListener("input", () => {
  window.clearTimeout(serviceSearchTimer);
  serviceSearchTimer = window.setTimeout(() => {
    visibleServiceLimit = SERVICE_BATCH_SIZE;
    renderServices();
  }, SERVICE_SEARCH_DELAY);
});
showMoreServices.addEventListener("click", () => {
  const previousVisible = serviceList.querySelectorAll(".service-card").length;
  visibleServiceLimit += SERVICE_BATCH_SIZE;
  renderServices();
  const nextCard = serviceList.querySelectorAll(".service-card")[previousVisible];
  if (nextCard) { nextCard.tabIndex = -1; nextCard.focus(); }
});
serviceEditorDialog.addEventListener("click", (event) => {
  if (event.target === serviceEditorDialog) resetForm();
});
cancelEditButton.addEventListener("click", resetForm);
cancelEditTextButton.addEventListener("click", resetForm);
renderTemplateEditors([{ text: "", enabled: true }]);
if (services.length) renderServices();
initializeServices();
setInterval(refreshServicesFromServer, 10000);
