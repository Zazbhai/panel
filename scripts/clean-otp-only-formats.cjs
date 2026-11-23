#!/usr/bin/env node
"use strict";
// Preview by default. Use --apply to remove templates that contain only {{OTP}}
// (and optional whitespace/punctuation). Affected services with no valid format
// left are disabled to prevent catch-all OTP routing.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const otpOnly = /^[\s\p{P}\p{S}]*(?:\{\{\s*otp\s*\}\}|\[\s*otp\s*\])[\s\p{P}\p{S}]*$/iu;
const hasOtp = (text) => /(?:\{\{\s*otp\s*\}\}|\[\s*otp\s*\])/i.test(text);

function cleanFile(servicesPath, apply = false) {
  const original = fs.readFileSync(servicesPath, "utf8");
  const services = JSON.parse(original.replace(/^\uFEFF/, ""));
  if (!Array.isArray(services)) throw new Error("Expected a services array. No data was changed.");
  const changes = [];
  let removed = 0;
  for (const service of services) {
    if (!service || typeof service !== "object") continue;
    const field = Array.isArray(service.templates) ? "templates"
      : Array.isArray(service.formats) ? "formats" : "templates";
    const templates = Array.isArray(service[field]) ? service[field] : [];
    const textOf = (item) => typeof item === "string" ? item : item?.text;
    const bad = templates.filter((item) => typeof textOf(item) === "string"
      && otpOnly.test(textOf(item).replace(/\s+/g, " ").trim()));
    const badLegacy = typeof service.template === "string" && otpOnly.test(service.template.trim());
    if (!bad.length && !badLegacy) continue;
    const badSet = new Set(bad);
    const kept = templates.filter((item) => !badSet.has(item));
    const validLeft = kept.filter((item) => {
      const text = textOf(item);
      return text && (typeof item === "string" || item.enabled !== false) && hasOtp(text);
    });
    changes.push({ service: service.name || service.service || service.id, field, removed: bad.length + Number(badLegacy),
      remainingValidTemplates: validLeft.length, willDisable: validLeft.length === 0 });
    removed += bad.length + Number(badLegacy);
    if (apply) {
      service[field] = kept;
      if (badLegacy) delete service.template;
      if (!validLeft.length) service.enabled = false;
    }
  }
  let backup = null;
  if (apply && removed) {
    const suffix = randomBytes(4).toString("hex");
    backup = servicesPath + ".backup-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + suffix;
    fs.writeFileSync(backup, original, { flag: "wx" });
    const temporary = servicesPath + "." + suffix + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(services, null, 2) + "\n", { flag: "wx" });
      fs.renameSync(temporary, servicesPath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return { servicesScanned: services.length, templatesRemoved: removed, changes, backup };
}

function main(args) {
  const fileIndex = args.indexOf("--file");
  const unexpected = args.find((arg, index) => {
    if (arg === "--apply") return false;
    if (arg === "--file") return fileIndex !== index;
    if (fileIndex >= 0 && index === fileIndex + 1) return false;
    return true;
  });
  if (unexpected || (fileIndex >= 0 && (!args[fileIndex + 1] || args[fileIndex + 1].startsWith("--")))) {
    throw new Error("Usage: node scripts/clean-otp-only-formats.cjs [--file services.json] [--apply]");
  }
  const servicesPath = fileIndex >= 0 ? path.resolve(args[fileIndex + 1]) : path.join(__dirname, "..", "services.json");
  const apply = args.includes("--apply");
  const result = cleanFile(servicesPath, apply);
  if (result.backup) console.log("Backup written: " + result.backup);
  console.log(JSON.stringify({ mode: apply ? "apply" : "preview", ...result, backup: undefined }, null, 2));
  if (!apply) console.log("Preview only. Re-run with --apply to remove these templates.");
}

module.exports = { cleanFile };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
