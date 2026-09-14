/*
 * DOM-based JSON highlighting. Values are written with textContent so
 * untrusted JWT payloads and generated manifests cannot inject HTML.
 */

const USED_ACTIVATION_KEYS = new Set([
  "oauthUrl",
  "appUrl",
  "webexapisBaseUrl",
  "refreshToken",
  "orgName",
]);

function appendText(parent, text, className) {
  if (!text) {
    return;
  }
  const node = document.createElement("span");
  if (className) {
    node.className = className;
  }
  node.textContent = text;
  parent.append(node);
}

function renderValue(parent, value, indent, highlightKeys) {
  if (value === null) {
    appendText(parent, "null", "json-null");
    return;
  }
  if (typeof value === "boolean") {
    appendText(parent, String(value), "json-boolean");
    return;
  }
  if (typeof value === "number") {
    appendText(parent, Number.isFinite(value) ? String(value) : "null", "json-number");
    return;
  }
  if (typeof value === "string") {
    appendText(parent, JSON.stringify(value), "json-string");
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      appendText(parent, "[]", "json-punctuation");
      return;
    }
    appendText(parent, "[", "json-punctuation");
    value.forEach((item, index) => {
      const line = document.createElement("span");
      line.className = "json-line";
      appendText(line, "  ".repeat(indent + 1));
      renderValue(line, item, indent + 1, highlightKeys);
      if (index < value.length - 1) {
        appendText(line, ",", "json-punctuation");
      }
      parent.append(line);
    });
    appendText(parent, `${"  ".repeat(indent)}]`, "json-punctuation");
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) {
      appendText(parent, "{}", "json-punctuation");
      return;
    }
    appendText(parent, "{", "json-punctuation");
    keys.forEach((key, index) => {
      const line = document.createElement("span");
      const used = highlightKeys.has(key);
      line.className = used ? "json-line json-line--used" : "json-line";
      if (used) {
        line.title = "Used by this web app";
      }
      appendText(line, "  ".repeat(indent + 1));
      appendText(line, JSON.stringify(key), "json-key");
      appendText(line, ": ", "json-punctuation");
      renderValue(line, value[key], indent + 1, highlightKeys);
      if (index < keys.length - 1) {
        appendText(line, ",", "json-punctuation");
      }
      parent.append(line);
    });
    appendText(parent, `${"  ".repeat(indent)}}`, "json-punctuation");
    return;
  }
  appendText(parent, JSON.stringify(String(value)), "json-string");
}

export function renderJsonPreview(target, value, { highlightUsedKeys = false } = {}) {
  if (!target) {
    return;
  }
  target.replaceChildren();
  try {
    renderValue(
      target,
      value,
      0,
      highlightUsedKeys ? USED_ACTIVATION_KEYS : new Set(),
    );
  } catch {
    target.textContent = "";
    appendText(target, String(value));
  }
}

export { USED_ACTIVATION_KEYS };
