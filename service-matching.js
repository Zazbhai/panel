(() => {
  const matcherCache = new WeakMap();

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

  function hasServiceOtpKeyword(service, text, codePattern) {
    const normalize = (value) => typeof value === "string"
      ? value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
      : "";
    const name = normalize(service.name);
    if (!name || name.length < 2 || !(` ${normalize(text)} `).includes(` ${name} `)) return false;
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
    if (!candidates.length) return false;
    candidates.sort((left, right) => left.distance - right.distance);
    return !(candidates[1] && candidates[0].distance === candidates[1].distance && candidates[0].code !== candidates[1].code);
  }

  function matches(service, text, message) {
    if (!service || typeof service !== "object" || typeof text !== "string") return false;
    let matcher = matcherCache.get(service);
    if (!matcher) {
      const senderFilter = typeof service.senderFilter === "string"
        ? service.senderFilter.trim().toLowerCase()
        : "";
      const minOtpLength = Number.isInteger(service.minOtpLength)
        ? service.minOtpLength
        : 4;
      const maxOtpLength = Number.isInteger(service.maxOtpLength)
        ? service.maxOtpLength
        : 8;
      if (minOtpLength < 1 || maxOtpLength < minOtpLength || maxOtpLength > 32) return false;
      const codePattern = String.raw`(?<!\d)\d(?:[\s-]?\d){${minOtpLength - 1},${maxOtpLength - 1}}(?!\d)`;
      matcher = {
        senderFilter,
        patterns: getEnabledTemplates(service).map((template) =>
          makeTemplatePattern(template.text, codePattern))
      };
      matcherCache.set(service, matcher);
    }

    if (matcher.senderFilter) {
      const sender = message && (typeof message.sender === "string" || typeof message.sender === "number")
        ? String(message.sender).toLowerCase()
        : "";
      if (!sender.includes(matcher.senderFilter)) return false;
    }
    const matched = matcher.patterns.some((pattern) => {
      const match = pattern.exec(text);
      if (!match?.[1]) return false;
      const codes = match.slice(1).map((code) => code.replace(/\D/g, ""));
      return codes.every((code) => code === codes[0]);
    });
    if (matched) return true;
    if (getEnabledTemplates(service).some((template) =>
      (template.text.match(/(?:\{\{OTP\}\}|\[OTP\])/gi) || []).length > 1)) return false;
    const minOtpLength = Number.isInteger(service.minOtpLength) ? service.minOtpLength : 4;
    const maxOtpLength = Number.isInteger(service.maxOtpLength) ? service.maxOtpLength : 8;
    if (minOtpLength < 1 || maxOtpLength < minOtpLength || maxOtpLength > 32) return false;
    const codePattern = String.raw`(?<!\d)\d(?:[\s-]?\d){${minOtpLength - 1},${maxOtpLength - 1}}(?!\d)`;
    return hasServiceOtpKeyword(service, text, codePattern);
  }

  window.serviceMatching = { getEnabledTemplates, matches };
})();
