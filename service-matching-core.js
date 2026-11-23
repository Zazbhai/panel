"use strict";

function getEnabledTemplates(service) {
  if (!service || typeof service !== "object") return [];
  const templates = Array.isArray(service.templates)
    ? service.templates
    : typeof service.template === "string"
      ? [{ text: service.template, enabled: true }]
      : [];
  return templates.filter((template) => template
    && template.enabled !== false
    && typeof template.text === "string"
      && /(?:\{\{OTP\}\}|\[OTP\])/i.test(template.text)
      // A bare OTP marker has no service-specific signal and matches every
      // message containing a numeric code. Ignore it instead of routing a
      // different app's OTP to this service.
      && !/^[\s\p{P}\p{S}]*(?:\{\{\s*otp\s*\}\}|\[\s*otp\s*\])[\s\p{P}\p{S}]*$/iu
        .test(template.text.trim()));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTemplateText(value) {
  return value.split(/(\s+)/).map((part) =>
    /^\s+$/.test(part) ? "\\s+" : escapeRegExp(part)).join("");
}

function makeTemplatePattern(text, codePattern) {
  const markerPattern = /\{\{OTP\}\}|\[OTP\]|\{\{ANY\}\}|\[ANY\]|\{\{DIGITS:(\d{1,2})\}\}|\[DIGITS:(\d{1,2})\]/gi;
  const parts = [];
  let lastIndex = 0;
  let marker;
  while ((marker = markerPattern.exec(text))) {
    parts.push(escapeTemplateText(text.slice(lastIndex, marker.index)));
    const markerName = marker[0].toUpperCase();
    if (markerName === "{{OTP}}" || markerName === "[OTP]") {
      parts.push(`(${codePattern})`);
    } else if (markerName === "{{ANY}}" || markerName === "[ANY]") {
      parts.push("[\\s\\S]*?");
    } else {
      const digitCount = Number(marker[1] || marker[2]);
      parts.push(digitCount >= 1 && digitCount <= 32
        ? `\\d{${digitCount}}`
        : escapeTemplateText(marker[0]));
    }
    lastIndex = markerPattern.lastIndex;
  }
  parts.push(escapeTemplateText(text.slice(lastIndex)));
  return new RegExp(parts.join(""), "i");
}

function getMatchers(service) {
  const minOtpLength = Number.isInteger(service?.minOtpLength) ? service.minOtpLength : 4;
  const maxOtpLength = Number.isInteger(service?.maxOtpLength) ? service.maxOtpLength : 8;
  if (minOtpLength < 1 || maxOtpLength < minOtpLength || maxOtpLength > 32) return [];
  const codePattern = String.raw`(?<!\d)\d(?:[\s-]?\d){${minOtpLength - 1},${maxOtpLength - 1}}(?!\d)`;
  return getEnabledTemplates(service).map((template) => makeTemplatePattern(template.text, codePattern));
}

function normalizeKeyword(value) {
  return typeof value === "string"
    ? value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : "";
}

function matchByServiceKeyword(service, text, codePattern) {
  const name = normalizeKeyword(service.name);
  if (!name || name.length < 2 || !(` ${normalizeKeyword(text)} `).includes(` ${name} `)) return null;
  const contextPattern = /\b(?:otp|one[\s-]?time(?:\s+password)?|verification|verify|passcode|password|security\s+code|code|pin)\b/gi;
  const codeRegex = new RegExp(codePattern, "g");
  const candidates = [];
  let match;
  while ((match = codeRegex.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    contextPattern.lastIndex = 0;
    let context;
    let distance = Infinity;
    while ((context = contextPattern.exec(text))) {
      const contextEnd = context.index + context[0].length;
      distance = Math.min(distance, contextEnd <= start ? start - contextEnd : context.index >= end ? context.index - end : 0);
    }
    if (distance <= 48) candidates.push({ code: match[0].replace(/\D/g, ""), distance });
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => left.distance - right.distance);
  if (candidates[1] && candidates[0].distance === candidates[1].distance && candidates[0].code !== candidates[1].code) return null;
  return { code: candidates[0].code };
}

function matchServiceMessage(service, text, message = {}) {
  if (!service || typeof text !== "string") return null;
  const senderFilter = typeof service.senderFilter === "string"
    ? service.senderFilter.trim().toLowerCase()
    : "";
  if (senderFilter) {
    const sender = message && (typeof message.sender === "string" || typeof message.sender === "number")
      ? String(message.sender).toLowerCase()
      : "";
    if (!sender.includes(senderFilter)) return null;
  }
  for (const pattern of getMatchers(service)) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      const codes = match.slice(1).map((code) => code.replace(/\D/g, ""));
      if (codes.every((code) => code === codes[0])) return { code: codes[0] };
    }
  }
  const enabledTemplates = getEnabledTemplates(service);
  if (enabledTemplates.some((template) => (template.text.match(/(?:\{\{OTP\}\}|\[OTP\])/gi) || []).length > 1)) return null;
  const minOtpLength = Number.isInteger(service.minOtpLength) ? service.minOtpLength : 4;
  const maxOtpLength = Number.isInteger(service.maxOtpLength) ? service.maxOtpLength : 8;
  if (minOtpLength < 1 || maxOtpLength < minOtpLength || maxOtpLength > 32) return null;
  const codePattern = String.raw`(?<!\d)\d(?:[\s-]?\d){${minOtpLength - 1},${maxOtpLength - 1}}(?!\d)`;
  return matchByServiceKeyword(service, text, codePattern);
}

module.exports = { getEnabledTemplates, matchServiceMessage };
