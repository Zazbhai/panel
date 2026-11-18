"use strict";

const { randomBytes } = require("node:crypto");

const OTP_CONTEXT_PATTERN = /\b(?:otp|one[\s-]?time(?:\s+password)?|verification|verify|passcode|password|security\s+code|code|pin)\b/gi;
const VARIABLE_PATTERN = /<\s*#\s*>|#|\{\s*(\d{1,2})\s*digit\s*\}/gi;
const OTP_PLACEHOLDER_PATTERN = /(?:\{\{OTP\}\}|\[OTP\])/i;

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

  return result.length <= 5000 && OTP_PLACEHOLDER_PATTERN.test(result) ? result : null;
}

function templateKey(text) {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function mergeSmsFormats(services, source) {
  if (!Array.isArray(services) || !Array.isArray(source)) {
    throw new Error("SMS formats and configured services must be arrays.");
  }

  const merged = services.map((service) => ({
    ...service,
    templates: service.templates.map((template) => ({ ...template }))
  }));
  const serviceIndexes = new Map(merged.map((service, index) => [service.name.trim().toLocaleLowerCase(), index]));
  const ids = new Set(merged.map((service) => service.id));
  let addedServices = 0;
  let addedTemplates = 0;
  let skippedServices = 0;
  let skippedTemplates = 0;

  for (const entry of source) {
    if (!entry || typeof entry.service !== "string" || !entry.service.trim()
      || entry.service.trim().length > 60 || !Array.isArray(entry.formats)) {
      skippedServices += 1;
      continue;
    }

    const name = entry.service.trim();
    const key = name.toLocaleLowerCase();
    const uniqueTemplates = new Map();
    for (const format of entry.formats) {
      const text = convertSmsFormat(format);
      if (!text) {
        skippedTemplates += 1;
        continue;
      }
      const normalizedKey = templateKey(text);
      if (uniqueTemplates.has(normalizedKey)) {
        skippedTemplates += 1;
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
        senderFilter: ""
      });
      addedServices += 1;
    }

    const service = merged[serviceIndex];
    const knownTemplates = new Set(service.templates.map((template) => templateKey(template.text)));
    for (const [normalizedKey, template] of uniqueTemplates) {
      if (knownTemplates.has(normalizedKey)) {
        skippedTemplates += 1;
        continue;
      }
      service.templates.push(template);
      knownTemplates.add(normalizedKey);
      addedTemplates += 1;
    }
  }

  return { services: merged, addedServices, addedTemplates, skippedServices, skippedTemplates };
}

module.exports = { convertSmsFormat, mergeSmsFormats };
