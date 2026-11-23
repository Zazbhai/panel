"use strict";

const { randomBytes } = require("node:crypto");

const OTP_CONTEXT_PATTERN = /\b(?:otp|one[\s-]?time(?:\s+password)?|verification|verify|passcode|password|security\s+code|code|pin)\b/gi;
const VARIABLE_PATTERN = /<\s*#\s*>|#|\{\s*(\d{1,2})\s*digit\s*\}/gi;
const OTP_PLACEHOLDER_PATTERN = /(?:\{\{OTP\}\}|\[OTP\])/i;
const OTP_ONLY_PATTERN = /^[\s\p{P}\p{S}]*(?:\{\{\s*otp\s*\}\}|\[\s*otp\s*\])[\s\p{P}\p{S}]*$/iu;

function getVariableContextDistance(text, index, length) {
  let distance = Infinity;
  let match;
  OTP_CONTEXT_PATTERN.lastIndex = 0;
  while ((match = OTP_CONTEXT_PATTERN.exec(text))) {
    const gap = match.index + match[0].length <= index
      ? index - (match.index + match[0].length)
      : match.index >= index + length
        ? match.index - (index + length)
        : 0;
    distance = Math.min(distance, gap);
  }
  return distance;
}

function convertSmsFormat(format) {
  if (typeof format !== "string") return null;
  const text = format.trim();
  if (!text || text.length > 5000) return null;

  const variables = [];
  let match;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(text))) {
    if (/^<\s*#\s*>$/i.test(match[0])) continue;
    variables.push({
      index: match.index,
      length: match[0].length,
      distance: getVariableContextDistance(text, match.index, match[0].length)
    });
  }

  const existingOtpMarker = OTP_PLACEHOLDER_PATTERN.test(text);
  const selectedVariable = existingOtpMarker || variables.length === 0
    ? null
    : variables.reduce((best, variable) => variable.distance < best.distance ? variable : best);
  let result = "";
  let lastIndex = 0;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(text))) {
    if (/^<\s*#\s*>$/i.test(match[0])) continue;
    result += text.slice(lastIndex, match.index);
    result += selectedVariable && selectedVariable.index === match.index ? "{{OTP}}" : "{{ANY}}";
    lastIndex = VARIABLE_PATTERN.lastIndex;
  }
  result += text.slice(lastIndex);

  return result.length <= 5000 && OTP_PLACEHOLDER_PATTERN.test(result)
    && !OTP_ONLY_PATTERN.test(result.trim()) ? result : null;
}

function templateKey(text) {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizeServiceName(name) {
  return typeof name === "string" ? name.replace(/\s+/g, "") : name;
}

function normalizeServiceNames(services) {
  const merged = [];
  const indexes = new Map();
  for (const service of services) {
    if (!service || typeof service !== "object" || Array.isArray(service) || typeof service.name !== "string") {
      merged.push(service);
      continue;
    }

    const normalized = {
      ...service,
      name: normalizeServiceName(service.name),
      templates: Array.isArray(service.templates)
        ? service.templates.map((template) => template && typeof template === "object" ? { ...template } : template)
        : service.templates
    };
    const key = normalized.name.toLocaleLowerCase();
    const index = indexes.get(key);
    if (index === undefined || !Array.isArray(merged[index].templates) || !Array.isArray(normalized.templates)) {
      indexes.set(key, merged.length);
      merged.push(normalized);
      continue;
    }

    const existing = merged[index];
    if (typeof existing.enabled === "boolean" && typeof normalized.enabled === "boolean") {
      existing.enabled = existing.enabled || normalized.enabled;
    }
    if (Number.isInteger(existing.minOtpLength) && Number.isInteger(normalized.minOtpLength)) {
      existing.minOtpLength = Math.min(existing.minOtpLength, normalized.minOtpLength);
    }
    if (Number.isInteger(existing.maxOtpLength) && Number.isInteger(normalized.maxOtpLength)) {
      existing.maxOtpLength = Math.max(existing.maxOtpLength, normalized.maxOtpLength);
    }
    if (typeof existing.senderFilter === "string" && typeof normalized.senderFilter === "string"
      && existing.senderFilter.trim().toLocaleLowerCase() !== normalized.senderFilter.trim().toLocaleLowerCase()) {
      existing.senderFilter = "";
    }
    if (typeof existing.sendFullText === "boolean" && typeof normalized.sendFullText === "boolean") {
      existing.sendFullText = existing.sendFullText || normalized.sendFullText;
    }

    const templatesByKey = new Map(existing.templates
      .filter((template) => template && typeof template.text === "string")
      .map((template) => [templateKey(template.text), template]));
    for (const template of normalized.templates) {
      if (!template || typeof template.text !== "string") {
        existing.templates.push(template);
        continue;
      }
      const duplicate = templatesByKey.get(templateKey(template.text));
      if (!duplicate) {
        existing.templates.push(template);
        templatesByKey.set(templateKey(template.text), template);
      } else if (typeof duplicate.enabled === "boolean" && typeof template.enabled === "boolean") {
        duplicate.enabled = duplicate.enabled || template.enabled;
      }
    }
  }
  return merged;
}

function mergeSmsFormats(services, source) {
  if (!Array.isArray(services) || !Array.isArray(source)) {
    throw new Error("SMS formats and configured services must be arrays.");
  }

  const merged = normalizeServiceNames(services);
  const serviceIndexes = new Map(merged.map((service, index) => [service.name.toLocaleLowerCase(), index]));
  const ids = new Set(merged.map((service) => service.id));
  let addedServices = 0;
  let addedTemplates = 0;
  let skippedServices = 0;
  let skippedTemplates = 0;
  let supportedTemplates = 0;
  let duplicateTemplates = 0;
  let unsupportedTemplates = 0;

  for (const entry of source) {
    if (!entry || typeof entry.service !== "string" || !entry.service.trim()
      || entry.service.trim().length > 60 || !Array.isArray(entry.formats)) {
      skippedServices += 1;
      continue;
    }

    const name = normalizeServiceName(entry.service.trim());
    const key = name.toLocaleLowerCase();
    const uniqueTemplates = new Map();
    for (const format of entry.formats) {
      const text = convertSmsFormat(format);
      if (!text) {
        skippedTemplates += 1;
        unsupportedTemplates += 1;
        continue;
      }
      supportedTemplates += 1;
      const normalizedKey = templateKey(text);
      if (uniqueTemplates.has(normalizedKey)) {
        skippedTemplates += 1;
        duplicateTemplates += 1;
        continue;
      }
      uniqueTemplates.set(normalizedKey, { text, enabled: true });
    }

    if (uniqueTemplates.size === 0) {
      skippedServices += 1;
      continue;
    }

    let serviceIndex = serviceIndexes.get(key);
    if (serviceIndex === undefined) {
      let id;
      do {
        id = `sms-${randomBytes(12).toString("hex")}`;
      } while (ids.has(id));
      ids.add(id);
      serviceIndex = merged.length;
      serviceIndexes.set(key, serviceIndex);
      merged.push({
        id,
        name,
        enabled: false,
        templates: [],
        minOtpLength: 4,
        maxOtpLength: 8,
        senderFilter: "",
        sendFullText: false
      });
      addedServices += 1;
    }

    const service = merged[serviceIndex];
    const knownTemplates = new Set(service.templates.map((template) => templateKey(template.text)));
    for (const [normalizedKey, template] of uniqueTemplates) {
      if (knownTemplates.has(normalizedKey)) {
        skippedTemplates += 1;
        duplicateTemplates += 1;
        continue;
      }
      service.templates.push(template);
      knownTemplates.add(normalizedKey);
      addedTemplates += 1;
    }
  }

  return {
    services: merged,
    addedServices,
    addedTemplates,
    supportedTemplates,
    duplicateTemplates,
    unsupportedTemplates,
    skippedServices,
    skippedTemplates
  };
}

module.exports = { convertSmsFormat, mergeSmsFormats, normalizeServiceName, normalizeServiceNames };
