"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { convertSmsFormat } = require("../service-sms-format-import");
const { cleanFile } = require("./clean-otp-only-formats.cjs");
const fixture = require("./server-fixture.cjs");

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "otp-cleanup-"));
  try {
    const file = path.join(directory, "services.json");
    const original = JSON.stringify([
      { name: "Swiggy", enabled: true, templates: [
        { text: "{{OTP}}", enabled: true }, { text: "[otp] <>", enabled: false },
        { text: "Swiggy code {{OTP}}", enabled: true },
        { text: "<Swiggy> {{OTP}}", enabled: true }
      ] },
      { name: "Only", enabled: true, templates: [{ text: "<#> {{OTP}}", enabled: true }] },
      { name: "Legacy", enabled: true, template: "{{otp}}" }
    ]);
    fs.writeFileSync(file, original);
    const run = (apply = false) => cleanFile(file, apply);
    assert.equal(run().templatesRemoved, 4);
    assert.equal(fs.readFileSync(file, "utf8"), original, "Preview must not write");
    assert.equal(run(true).templatesRemoved, 4);
    const cleaned = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(cleaned[0].templates.map((t) => t.text),
      ["Swiggy code {{OTP}}", "<Swiggy> {{OTP}}"], "Service text must survive cleanup");
    assert.equal(cleaned[1].enabled, false);
    assert.deepEqual(cleaned[1].templates, []);
    assert.equal(cleaned[2].template, undefined);
    assert.equal(cleaned[2].enabled, false);
    const backup = fs.readdirSync(directory).find((name) => name.includes(".backup-"));
    assert.equal(fs.readFileSync(path.join(directory, backup), "utf8"), original);
    assert.equal(run(true).templatesRemoved, 0);
    assert.equal(fs.readdirSync(directory).length, 2, "No-op cleanup must not create backups");
    for (const text of ["{{OTP}}", "[otp]", "<#> {{OTP}}", "{{OTP}} <>"])
      assert.equal(convertSmsFormat(text), null, "Import must not recreate catch-all templates");
    assert.equal(convertSmsFormat("<Swiggy> {{OTP}}"), "<Swiggy> {{OTP}}");
    const f = fixture();
    const disabled = { id: "cleaned", name: "Only", enabled: false, templates: [],
      minOtpLength: 4, maxOtpLength: 8, senderFilter: "", sendFullText: false };
    assert.equal(f.context.validateServiceList([disabled]), null,
      "Disabled cleaned services must not invalidate the entire services config");
    assert(f.context.validateServiceList([{ ...disabled, enabled: true }]));
    console.log("PASS: preview, backup, removal, preservation, disabling, repeat cleanup, import guards and config validation.");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
