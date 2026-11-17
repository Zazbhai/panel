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
      && /(?:\{\{OTP\}\}|\[OTP\])/i.test(template.text));
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
        parts.push(codePattern);
      } else if (markerName === "{{ANY}}" || markerName === "[ANY]") {
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
    return new RegExp(parts.join(""), "i");
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
    return matcher.patterns.some((pattern) => pattern.test(text));
  }

  window.serviceMatching = { getEnabledTemplates, matches };
})();
