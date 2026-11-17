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
    && template.text.includes("{{OTP}}"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTemplateText(value) {
  return value.split(/(\s+)/).map((part) =>
    /^\s+$/.test(part) ? "\\s+" : escapeRegExp(part)).join("");
}

function makeTemplatePattern(text, codePattern) {
  const markerPattern = /\{\{OTP\}\}|\{\{ANY\}\}|\{\{DIGITS:(\d{1,2})\}\}/g;
  const parts = [];
  let lastIndex = 0;
  let marker;
  let capturedOtp = false;
  while ((marker = markerPattern.exec(text))) {
    parts.push(escapeTemplateText(text.slice(lastIndex, marker.index)));
    if (marker[0] === "{{OTP}}") {
      parts.push(capturedOtp ? `(?:${codePattern})` : `(${codePattern})`);
      capturedOtp = true;
    } else if (marker[0] === "{{ANY}}") {
      parts.push("\\S+?");
    } else {
      const digitCount = Number(marker[1]);
      parts.push(digitCount >= 1 && digitCount <= 32
        ? `\\d{${digitCount}}`
        : escapeTemplateText(marker[0]));
    }
    lastIndex = markerPattern.lastIndex;
  }
  parts.push(escapeTemplateText(text.slice(lastIndex)));
  return new RegExp(`^${parts.join("")}$`, "i");
}

function getMatchers(service) {
  const minOtpLength = Number.isInteger(service?.minOtpLength) ? service.minOtpLength : 4;
  const maxOtpLength = Number.isInteger(service?.maxOtpLength) ? service.maxOtpLength : 8;
  if (minOtpLength < 1 || maxOtpLength < minOtpLength || maxOtpLength > 32) return [];
  const codePattern = String.raw`\d(?:[\s-]?\d){${minOtpLength - 1},${maxOtpLength - 1}}`;
  return getEnabledTemplates(service).map((template) => makeTemplatePattern(template.text, codePattern));
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
    if (match && match[1]) return { code: match[1].replace(/\D/g, "") };
  }
  return null;
}

module.exports = { getEnabledTemplates, matchServiceMessage };
