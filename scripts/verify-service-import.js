"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const serverFixture = require("./server-fixture.cjs");
const { convertSmsFormat, normalizeServiceNames } = require("../service-sms-format-import");

async function main() {
  assert.equal(convertSmsFormat(`Your OTP ${"# ".repeat(650)}`), null);
  const collapsed = normalizeServiceNames([
    {
      id: "spaced-name",
      name: "Sample App",
      enabled: true,
      templates: [{ text: "Code {{OTP}}", enabled: true }],
      minOtpLength: 6,
      maxOtpLength: 6,
      senderFilter: "SAMPLE"
    },
    {
      id: "compact-name",
      name: "SampleApp",
      enabled: false,
      templates: [{ text: "Other {{OTP}}", enabled: true }],
      minOtpLength: 4,
      maxOtpLength: 8,
      senderFilter: ""
    }
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].name, "SampleApp");
  assert.equal(collapsed[0].enabled, true);
  assert.equal(collapsed[0].minOtpLength, 4);
  assert.equal(collapsed[0].maxOtpLength, 8);
  assert.equal(collapsed[0].templates.length, 2);
  assert.equal(collapsed[0].senderFilter, "");

  const fixture = serverFixture();
  const serverDirectory = path.dirname(path.join(__dirname, "..", "server.js"));
  const servicesPath = path.join(serverDirectory, "services.json");
  const formatsPath = path.join(serverDirectory, "service-sms-formats.json");
  const existing = [{
    id: "existing-service",
    name: "Existing App",
    enabled: true,
    templates: [{ text: "Your OTP {{OTP}} is ready.", enabled: true }],
    minOtpLength: 6,
    maxOtpLength: 6,
    senderFilter: "EXISTING"
  }];
  const formats = [
    {
      service: "Existing App",
      formats: [
        "Your OTP is #",
        "Your code # expires in # minutes.",
        "your otp is #"
      ]
    },
    {
      service: "New App",
      formats: [
        "Use {6digit} for New App.",
        " use {6digit} for new app. ",
        "New App"
      ]
    },
    {
      service: "Oversize App",
      formats: [`Your OTP ${"# ".repeat(650)}`]
    }
  ];
  fixture.files.set(servicesPath, JSON.stringify(existing));
  fixture.files.set(formatsPath, JSON.stringify(formats));

  const first = await fixture.request("/api/services/import-sms-formats", { method: "POST", admin: true });
  assert.equal(first.status, 200);
  const imported = JSON.parse(first.body);
  assert.equal(imported.addedServices, 1);
  assert.equal(imported.addedTemplates, 3);
  assert.equal(imported.skippedTemplates, 4);
  assert.equal(imported.skippedServices, 1);
  assert.equal(imported.sourceServices, 3);
  assert.equal(imported.sourceFormats, 7);
  assert.equal(imported.supportedTemplates, 5);
  assert.equal(imported.duplicateTemplates, 2);
  assert.equal(imported.unsupportedTemplates, 2);

  const existingService = imported.services.find((service) => service.id === "existing-service");
  assert.equal(existingService.name, "ExistingApp");
  assert.equal(existingService.enabled, true);
  assert.equal(existingService.minOtpLength, 6);
  assert.equal(existingService.senderFilter, "EXISTING");
  assert.deepEqual(existingService.templates.map((template) => template.text), [
    "Your OTP {{OTP}} is ready.",
    "Your OTP is {{OTP}}",
    "Your code {{OTP}} expires in {{ANY}} minutes."
  ]);
  const newService = imported.services.find((service) => service.name === "NewApp");
  assert.equal(newService.enabled, false);
  assert.equal(newService.templates.length, 1);
  assert.equal(newService.templates[0].text, "Use {{OTP}} for New App.");
  assert.equal(imported.services.some((service) => service.name === "Oversize App"), false);

  const saved = JSON.parse(fixture.files.get(servicesPath));
  assert.equal(saved.length, 2);
  const second = await fixture.request("/api/services/import-sms-formats", { method: "POST", admin: true });
  assert.equal(second.status, 200);
  const repeated = JSON.parse(second.body);
  assert.equal(repeated.addedServices, 0);
  assert.equal(repeated.addedTemplates, 0);
  assert.equal(repeated.services.length, 2);
  assert.equal(repeated.services.reduce((total, service) => total + service.templates.length, 0), 4);

  const actualSource = require("../service-sms-formats.json");
  const actualServices = require("../services.json");
  const { mergeSmsFormats } = require("../service-sms-format-import");
  const actualImport = mergeSmsFormats(actualServices, actualSource);
  const repeatedImport = mergeSmsFormats(actualImport.services, actualSource);
  const serializedSize = Buffer.byteLength(JSON.stringify(actualImport.services), "utf8");
  const savedFixture = serverFixture();
  savedFixture.files.set(servicesPath, JSON.stringify(actualServices));
  const readSavedServices = await savedFixture.request("/api/services", { admin: true });
  assert.equal(readSavedServices.status, 200);
  const normalizedServices = JSON.parse(readSavedServices.body).services;
  assert(normalizedServices.every((service) => !/\s/.test(service.name)));
  assert.equal(new Set(normalizedServices.map((service) => service.name.toLowerCase())).size, normalizedServices.length);
  assert.equal(repeatedImport.addedServices, 0);
  assert.equal(repeatedImport.addedTemplates, 0);
  assert(serializedSize < 16 * 1024 * 1024, `Merged services exceed API request limit: ${serializedSize} bytes`);
  const names = new Set();
  for (const service of actualImport.services) {
    assert(!/\s/.test(service.name), `Service name contains whitespace: ${service.name}`);
    assert(!names.has(service.name.trim().toLowerCase()), `Duplicate service name: ${service.name}`);
    names.add(service.name.trim().toLowerCase());
    const templates = new Set();
    for (const template of service.templates) {
      const key = template.text.trim().replace(/\s+/g, " ").toLowerCase();
      assert(!templates.has(key), `Duplicate template for ${service.name}`);
      templates.add(key);
      assert(template.text.length <= 5000, `Template exceeds the service limit: ${service.name}`);
      assert(/(?:\{\{OTP\}\}|\[OTP\])/i.test(template.text), `Template has no OTP marker: ${service.name}`);
    }
  }
  console.log(`PASS: merge is idempotent and duplicate-free; full source import adds ${actualImport.addedServices} services and ${actualImport.addedTemplates} templates (${serializedSize} bytes).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
