import {
  buildManifest,
  manifestFileName,
  stringifyManifest,
} from "./manifest.js";
import { renderJsonPreview } from "./json-preview.js";
import {
  PREVIEW_CLIENT_ID,
  PREVIEW_CLIENT_SECRET,
  PREVIEW_CHART_TIMES,
  PREVIEW_DEVICES,
  PREVIEW_MANIFEST_ID,
  PREVIEW_MESSAGES,
  PREVIEW_NOW,
  PREVIEW_ORG_NAME,
  PREVIEW_WORKSPACES,
  buildPreviewJwt,
  isDemoCredentials,
  readPreviewMode,
} from "./preview.js";
import { createDemoIntegration } from "./demo.js";
import {
  activateQueue,
  clearRequestLog,
  createAccessToken,
  createTokenStore,
  decodeActivationJwt,
  describeNetworkError,
  executeXapiCommand,
  getRequestLog,
  isJwtShape,
  listDevices,
  listWorkspaces,
  lookupName,
  pollQueue,
  primeRequestLogForPreview,
  redactActivationPayload,
} from "./webex.js";

// The real webex.js functions, grouped so runMonitor() can swap in the
// simulated demo client (demo.js) without branching its own control flow.
const realWebexClient = {
  createAccessToken,
  listWorkspaces,
  listDevices,
  activateQueue,
  pollQueue,
  executeXapiCommand,
  getRequestLog,
};

const previewMode = readPreviewMode();

const config = window.APP_CONFIG ?? {};
const MAX_FEED_ITEMS = 200;
const AMBIENT_TEMPERATURE_KEY = "RoomAnalytics.AmbientTemperature";
const PEOPLE_COUNT_CURRENT_KEY = "RoomAnalytics.PeopleCount.Current";
const PEOPLE_COUNT_NEGATIVE_ONE_HINT =
  "A value of -1 means people count isn't available right now. Possible causes:\n" +
  "• PeopleCountOutOfCall is set to Off and the device isn't in a call\n" +
  "• The device's CameraLid is closed\n" +
  "• The device is in standby with the camera off";
const HIGHLIGHT_STATUS_KEYS = [
  PEOPLE_COUNT_CURRENT_KEY,
  "RoomAnalytics.PeoplePresence",
  "Standby.State",
  "SystemUnit.State.NumberOfActiveCalls",
  AMBIENT_TEMPERATURE_KEY,
  "RoomAnalytics.RelativeHumidity",
  "Bookings.Availability.Status",
];

const MONITOR_POLL_RETRY_MS = 10_000;
const POLL_METER_MS = 20_000;
const POLL_METER_PREVIEW_ELAPSED_MS = 8_000;
const CHART_WINDOW_MINUTES = 60;
const CHART_MIN_Y_MAX = 4;
const CHART_TICK_MINUTES = 10;
const CHART_REFRESH_MS = 60_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const DEMO_PANEL_ID = "workspace-integrations-demo";
const DEMO_PANEL_NAME = "Workspace Integration Demo";
const DEMO_PANEL_XML = `<Extensions>
  <Version>1.11</Version>
  <Panel>
    <Order>1</Order>
    <PanelId>${DEMO_PANEL_ID}</PanelId>
    <Type>Home</Type>
    <Icon>Lightbulb</Icon>
    <Name>${DEMO_PANEL_NAME}</Name>
    <ActivityType>Custom</ActivityType>
  </Panel>
</Extensions>`;
const DEMO_PANEL_ALERT_TEXT =
  "Hello there from the Workspace Integration Demo web app \u{1F44B}";
const SEARCH_DEBOUNCE_MS = 350;
const PANEL_LIST_ARGUMENTS = {
  ActivityType: "Custom",
  Exclude: "CustomizationPackage",
};

function findInstalledDemoPanel(body) {
  const panelField = body?.result?.Extensions?.Panel;
  if (!panelField) {
    return null;
  }
  const panels = Array.isArray(panelField) ? panelField : [panelField];
  return panels.find((panel) => panel?.PanelId === DEMO_PANEL_ID) || null;
}

(function initHeader() {
  const product = document.getElementById("app-product");
  const sourceLink = document.getElementById("source-link");

  if (product && config.title) {
    product.textContent = config.title;
  }
  if (config.title) {
    document.title = config.title;
  }
  if (sourceLink && config.repoUrl) {
    sourceLink.href = config.repoUrl;
  }
})();

(function initThemeSelect() {
  const root = document.documentElement;
  const select = document.getElementById("theme-select");
  const button = document.getElementById("theme-select-button");
  const menu = document.getElementById("theme-select-menu");
  const label = document.getElementById("theme-select-label");
  const currentIcon = document.getElementById("theme-select-current-icon");

  if (!select || !button || !menu || !label || !currentIcon) {
    return;
  }

  const options = Array.from(menu.querySelectorAll(".theme-select-option"));
  const META = {
    system: { label: "System", icon: "icon-laptop-regular" },
    light: { label: "Light", icon: "icon-brightness-high-filled" },
    dark: { label: "Dark", icon: "icon-quiet-hours-presence-filled" },
  };
  const ICON_CLASSES = Object.values(META).map((meta) => meta.icon);

  const readChoice = () => {
    const theme = readHashParams().get("theme");
    return theme === "light" || theme === "dark" ? theme : "system";
  };

  const applyTheme = (choice) => {
    const dark =
      choice === "dark" ||
      (choice === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.remove(
      "mds-theme-stable-lightWebex",
      "mds-theme-stable-darkWebex",
    );
    root.classList.add(
      dark ? "mds-theme-stable-darkWebex" : "mds-theme-stable-lightWebex",
    );
    root.style.colorScheme = dark ? "dark" : "light";
  };

  const syncButton = (choice) => {
    const meta = META[choice] || META.system;
    label.textContent = meta.label;
    currentIcon.classList.remove(...ICON_CLASSES);
    currentIcon.classList.add(meta.icon);
    options.forEach((option) => {
      option.setAttribute(
        "aria-selected",
        String(option.dataset.themeChoice === choice),
      );
    });
  };

  const setChoice = (choice) => {
    const params = readHashParams();
    if (choice === "system") {
      params.delete("theme");
    } else {
      params.set("theme", choice);
    }
    writeHashParams(params);
    applyTheme(choice);
    syncButton(choice);
  };

  const openMenu = () => {
    menu.hidden = false;
    select.dataset.open = "true";
    button.setAttribute("aria-expanded", "true");
  };

  const closeMenu = () => {
    menu.hidden = true;
    select.dataset.open = "false";
    button.setAttribute("aria-expanded", "false");
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) {
      openMenu();
    } else {
      closeMenu();
    }
  });

  options.forEach((option) => {
    option.addEventListener("click", () => {
      setChoice(option.dataset.themeChoice);
      closeMenu();
      button.focus();
    });
  });

  document.addEventListener("click", (event) => {
    if (!select.contains(event.target)) {
      closeMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      closeMenu();
      button.focus();
    }
  });

  syncButton(readChoice());
})();

(function initTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  if (!tabs.length) {
    return;
  }

  const activate = (tab) => {
    tabs.forEach((current) => {
      const selected = current === tab;
      current.setAttribute("aria-selected", String(selected));
      current.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(current.dataset.tabTarget);
      if (panel) {
        panel.hidden = !selected;
      }
    });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
        return;
      }
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      next.focus();
      activate(next);
    });
  });
})();

(function initCreateIntegration() {
  const displayName = document.getElementById("manifest-name");
  const vendor = document.getElementById("manifest-vendor");
  const email = document.getElementById("manifest-email");
  const description = document.getElementById("manifest-description");
  const preview = document.getElementById("manifest-preview");
  const previewWrap = document.getElementById("manifest-pre");
  const toggleButton = document.getElementById("toggle-manifest");
  const downloadButton = document.getElementById("download-manifest");
  const status = document.getElementById("create-status");

  if (
    !displayName ||
    !vendor ||
    !email ||
    !description ||
    !preview ||
    !downloadButton
  ) {
    return;
  }

  const defaults = {
    displayName: config.title || "Workspace Integrations Demo",
    vendor: config.vendor || "WXSD",
    email: config.email || "wxsd@external.cisco.com",
    description:
      "Monitors Webex workspace devices and displays live xStatus and xEvent notifications.",
  };

  displayName.value = defaults.displayName;
  vendor.value = defaults.vendor;
  email.value = defaults.email;
  description.value = defaults.description;

  let manifestOpen = previewMode === "create";

  const values = () => ({
    displayName: displayName.value,
    vendor: vendor.value,
    email: email.value,
    description: description.value,
    descriptionUrl: config.pagesBaseUrl || "",
    activationUrl: config.pagesBaseUrl || "",
    id: previewMode === "create" ? PREVIEW_MANIFEST_ID : "",
  });

  const setStatus = (message, kind = "") => {
    if (!status) return;
    status.textContent = message;
    if (kind) {
      status.dataset.kind = kind;
    } else {
      delete status.dataset.kind;
    }
  };

  const syncManifestToggle = () => {
    if (!previewWrap || !toggleButton) {
      return;
    }
    previewWrap.hidden = !manifestOpen;
    toggleButton.textContent = manifestOpen ? "Hide manifest" : "Show manifest";
    toggleButton.setAttribute("aria-expanded", String(manifestOpen));
  };

  const updatePreview = () => {
    renderJsonPreview(preview, buildManifest(values()));
  };

  toggleButton?.addEventListener("click", () => {
    manifestOpen = !manifestOpen;
    syncManifestToggle();
  });

  for (const input of [displayName, vendor, email, description]) {
    input.addEventListener("input", updatePreview);
  }
  updatePreview();
  syncManifestToggle();

  downloadButton.addEventListener("click", () => {
    const manifest = buildManifest(values());
    const fileName = manifestFileName(manifest);
    const blob = new Blob([stringifyManifest(manifest)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    renderJsonPreview(preview, manifest);
    setStatus(
      `Downloaded ${fileName}. Continue on Control Hub Setup to upload it, then paste the Client ID, Client Secret, and activation code on the next tab.`,
      "success",
    );
  });
})();

function setStatusEl(element, message, kind = "") {
  if (!element) return;
  element.textContent = message;
  if (kind) {
    element.dataset.kind = kind;
  } else {
    delete element.dataset.kind;
  }
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

function readHashParams() {
  const raw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(raw);
}

function writeHashParams(params) {
  const next = params.toString();
  const url =
    window.location.pathname +
    window.location.search +
    (next ? `#${next}` : "");
  history.replaceState(null, "", url);
}

function encodeBase64Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodeBase64Json(encoded) {
  const binary = atob(String(encoded || "").trim());
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function formatFeedValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatCompactNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// Webex reports RoomAnalytics.AmbientTemperature in Celsius; show both units.
function formatTemperatureValue(value) {
  const celsius = Number(value);
  if (!Number.isFinite(celsius)) {
    return String(value);
  }
  const fahrenheit = (celsius * 9) / 5 + 32;
  return `${formatCompactNumber(celsius)}°C (${formatCompactNumber(fahrenheit)}°F)`;
}

const REFRESH_TOKEN_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
const REFRESH_TOKEN_RESET_COOLDOWN_HOURS = 24;

function formatApproxDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const days = seconds / 86400;
  if (days >= 1) {
    const rounded = Math.round(days * 10) / 10;
    return `~${formatCompactNumber(rounded)} day${rounded === 1 ? "" : "s"}`;
  }
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return `~${formatCompactNumber(hours)} hour${hours === 1 ? "" : "s"}`;
}

function formatExpiryTimestamp(ms) {
  return `${formatTime(ms)} UTC`;
}

// Explains access/refresh token lifetimes below the "Get an access token"
// response: the access token's expires_in, and the refresh token's 90-day
// expiry, which only resets on use and only if the previous reset was at
// least 24 hours earlier.
function createTokenLifetimeNote(entry) {
  const expiresIn = Number(entry?.responseBody?.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }
  const receivedAt = entry.receivedAt || Date.now();
  const accessExpiresAt = receivedAt + expiresIn * 1000;
  const refreshExpiresAt = receivedAt + REFRESH_TOKEN_LIFETIME_SECONDS * 1000;

  const note = createElement("div", "token-note");
  const header = createElement("div", "token-note__header");
  const icon = createElement("span", "icon icon-info-circle-regular");
  icon.setAttribute("aria-hidden", "true");
  header.append(
    icon,
    createElement(
      "p",
      "token-note__title",
      "Token lifetimes & the refresh-token reset rule",
    ),
  );
  note.append(header);

  const timeline = document.createElement("dl");
  timeline.className = "token-note__timeline";
  const addTimelineRow = (label, value) => {
    timeline.append(
      createElement("dt", "token-note__timeline-label", label),
      createElement("dd", "token-note__timeline-value", value),
    );
  };
  addTimelineRow(
    "This Access Token",
    `Expires in ${expiresIn.toLocaleString("en-US")}s (${formatApproxDuration(expiresIn)}) at ${formatExpiryTimestamp(accessExpiresAt)}`,
  );
  addTimelineRow(
    "This Refresh token",
    `Expires (if not reset before) in ${REFRESH_TOKEN_LIFETIME_SECONDS.toLocaleString("en-US")}s (~90 days) at ${formatExpiryTimestamp(refreshExpiresAt)}`,
  );
  note.append(timeline);

  const faq = document.createElement("dl");
  faq.className = "token-note__faq";
  const addFaq = (question, answer) => {
    faq.append(
      createElement("dt", "token-note__faq-question", question),
      createElement("dd", "token-note__faq-answer", answer),
    );
  };
  addFaq(
    "How long does this Access Token last?",
    `Exactly ${expiresIn.toLocaleString("en-US")} seconds (${formatApproxDuration(expiresIn)}) from this response — see "expires_in" above.`,
  );
  addFaq(
    "How long does the Refresh Token last?",
    "Up to 90 days. But every time it's used to generate a new Access Token — like this request just did — its 90-day expiry resets.",
  );
  addFaq(
    "Does every Access Token generated reset the Refresh Tokens 90-day clock?",
    `No. The reset only happens if the previous reset was at least ${REFRESH_TOKEN_RESET_COOLDOWN_HOURS} hours earlier. Generate several access tokens the same day and the refresh token's expiry won't move until you try again a day later.`,
  );
  addFaq(
    "So what's the rule for keeping a Refresh Token alive indefinitely?",
    "Use it to generate a new access token no sooner than 24 hours after its last reset, and no later than 90 days after its last reset.",
  );
  addFaq(
    "Does the Refresh Token ever change?",
    "Yes, however this is very unlikely as this may only happen if the associated Webex Org was to undergo a regional migration.",
  );
  note.append(faq);

  return note;
}

// Groups dotted status paths (e.g. "RoomAnalytics.PeopleCount.Current") into
// a tree by their "." segments, so related statuses render together under a
// shared group heading instead of as a flat list of full paths.
function buildStatusTree(entries) {
  const root = { name: "", children: new Map() };
  for (const [path, value] of entries) {
    const segments = String(path).split(".").filter(Boolean);
    if (!segments.length) {
      continue;
    }
    let node = root;
    segments.forEach((segment, index) => {
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
      if (index === segments.length - 1) {
        node.hasValue = true;
        node.value = value;
        node.fullPath = path;
      }
    });
  }
  return root;
}

function formatStatusTreeValue(node) {
  return node.fullPath === AMBIENT_TEMPERATURE_KEY
    ? formatTemperatureValue(node.value)
    : formatFeedValue(node.value);
}

// RoomAnalytics.PeopleCount.Current reports -1 when the device can't count
// people right now (camera off/closed, standby, or out-of-call counting
// disabled) rather than "zero people" — flag that with an inline hint.
function createStatusTreeHint(node) {
  if (node.fullPath !== PEOPLE_COUNT_CURRENT_KEY || Number(node.value) !== -1) {
    return null;
  }
  const hint = createElement("span", "status-tree__hint", "ⓘ");
  hint.title = PEOPLE_COUNT_NEGATIVE_ONE_HINT;
  hint.tabIndex = 0;
  return hint;
}

function createStatusTreeValueLine(node) {
  const value = createElement(
    "span",
    "status-tree__value",
    formatStatusTreeValue(node),
  );
  const hint = createStatusTreeHint(node);
  if (!hint) {
    return value;
  }
  const line = createElement("span", "status-tree__value-line");
  line.append(value, hint);
  return line;
}

function renderStatusTreeNode(node, removed) {
  if (!node.children.size) {
    const row = createElement(
      "div",
      removed
        ? "status-tree__row status-tree__row--removed"
        : "status-tree__row",
    );
    row.append(createElement("span", "status-tree__key", node.name));
    if (!removed) {
      row.append(createStatusTreeValueLine(node));
    }
    return row;
  }

  const group = createElement("div", "status-tree__group");
  const title = createElement("div", "status-tree__group-title");
  title.append(createElement("span", "status-tree__group-name", node.name));
  if (node.hasValue && !removed) {
    title.append(createStatusTreeValueLine(node));
  }
  group.append(title);

  const children = createElement("div", "status-tree__children");
  for (const child of node.children.values()) {
    children.append(renderStatusTreeNode(child, removed));
  }
  group.append(children);
  return group;
}

// Renders a flat [path, value] entry list (dotted xStatus paths, or plain
// keys, which just fall out as single-segment "groups") as a grouped tree.
function renderStatusTree(entries, { removed = false } = {}) {
  const tree = createElement("div", "status-tree");
  const root = buildStatusTree(entries);
  for (const child of root.children.values()) {
    tree.append(renderStatusTreeNode(child, removed));
  }
  return tree;
}

// Updates a "Show X" / "Hide X" disclosure button in place: swaps its eye
// icon (matching the feed's raw-notification toggle) and label text, and
// keeps aria-expanded in sync.
function syncShowHideButton(button, isOpen, { showLabel, hideLabel }) {
  if (!button) {
    return;
  }
  const icon = button.querySelector(".icon");
  if (icon) {
    icon.className = isOpen
      ? "icon icon-hide-regular"
      : "icon icon-show-regular";
  }
  const label = button.querySelector(".icon-button__label");
  if (label) {
    label.textContent = isOpen ? hideLabel : showLabel;
  }
  button.setAttribute("aria-expanded", String(isOpen));
}

// Renders a JSON value inside a <pre><code> using the same syntax-highlighted
// style as the manifest/payload/request views elsewhere in this app.
function createJsonPre(value, options, extraClass = "") {
  const pre = document.createElement("pre");
  pre.className = extraClass
    ? `code-output__command ${extraClass}`
    : "code-output__command";
  const code = document.createElement("code");
  pre.append(code);
  renderJsonPreview(code, value, options);
  return pre;
}

// Feed raw-JSON views wrap instead of scrolling horizontally — the activity
// feed sits in a fixed-width column and shouldn't need sideways scrolling.
function createWrappedJsonPre(value) {
  return createJsonPre(value, undefined, "code-output__command--wrap");
}

const HTTP_METHOD_CLASSES = {
  GET: "http-method--get",
  POST: "http-method--post",
  PATCH: "http-method--patch",
  PUT: "http-method--put",
  DELETE: "http-method--delete",
};

function httpMethodClass(method) {
  return (
    HTTP_METHOD_CLASSES[String(method || "").toUpperCase()] ||
    "http-method--other"
  );
}

// Response fields that feed into a later step, called out the same way the
// decoded activation JWT highlights the keys this app actually uses.
const RESPONSE_HIGHLIGHT_KEYS = {
  token: new Set(["access_token", "refresh_token", "expires_in"]),
  activate: new Set(["pollUrl"]),
  poll: new Set(["pollUrl", "messages"]),
  workspaces: new Set(["items"]),
  devices: new Set(["items"]),
  panelSave: new Set(),
  panelClicked: new Set(),
  panelRemove: new Set(),
};

// Cloud xAPI commands previewed below "Install demo panel" before any real
// or demo request has been sent for them.
const PANEL_ACTION_COMMANDS = {
  panelSave: "UserInterface.Extensions.Panel.Save",
  panelClicked: "UserInterface.Extensions.Panel.Clicked",
  panelRemove: "UserInterface.Extensions.Panel.Remove",
};

function createHeadersBlock(headers) {
  const pre = document.createElement("pre");
  pre.className = "api-exchange__headers";
  pre.textContent = Object.entries(headers || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return pre;
}

function createApiExchangeBlock(kind, label) {
  const block = createElement(
    "div",
    `api-exchange__block api-exchange__block--${kind}`,
  );
  block.append(createElement("p", "api-exchange__block-label", label));
  return block;
}

function createRequestBlock(entry, { preview = false } = {}) {
  const block = createApiExchangeBlock(
    "request",
    preview ? "Request (preview)" : "Request",
  );
  const line = createElement("div", "api-exchange__line");
  line.append(
    createElement(
      "span",
      `http-method ${httpMethodClass(entry.method)}`,
      entry.method || "GET",
    ),
    createElement("code", "api-exchange__url", entry.url),
  );
  block.append(line, createHeadersBlock(entry.headers));
  if (entry.body !== undefined && entry.body !== null) {
    block.append(createJsonPre(entry.body));
  }
  return block;
}

function createResponseBlock(entry, logKey) {
  const block = createApiExchangeBlock("response", "Response");
  const line = createElement("div", "api-exchange__line");
  if (entry.error) {
    line.append(
      createElement("span", "http-status http-status--error", "Network error"),
    );
    block.append(line, createElement("p", "api-exchange__error", entry.error));
    return block;
  }
  const ok = entry.status >= 200 && entry.status < 300;
  line.append(
    createElement(
      "span",
      `http-status ${ok ? "http-status--ok" : "http-status--error"}`,
      String(entry.status),
    ),
  );
  block.append(line);
  block.append(
    createJsonPre(entry.responseBody, {
      highlightKeys: RESPONSE_HIGHLIGHT_KEYS[logKey] || new Set(),
      highlightTitle: "Used in the next step",
    }),
  );
  return block;
}

// Used alongside a request preview: no real exchange has happened yet, so
// there's nothing to show but the reason why.
function createPendingResponseBlock(pendingMessage) {
  const block = createApiExchangeBlock("response", "Response");
  block.append(createElement("p", "api-exchange__pending", pendingMessage));
  return block;
}

function omitFalseFullSync(message) {
  if (!message || typeof message !== "object" || message.isFullSync === true) {
    return message;
  }
  const copy = { ...message };
  delete copy.isFullSync;
  return copy;
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function createSvgElement(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null && value !== "") {
      node.setAttribute(key, String(value));
    }
  }
  return node;
}

function startOfMinuteUtc(value) {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  date.setUTCSeconds(0, 0);
  date.setUTCMilliseconds(0);
  return date.getTime();
}

function niceYMax(value) {
  const n = Math.max(CHART_MIN_Y_MAX, Math.ceil(Number(value) || 0));
  if (n <= 4) return 4;
  if (n <= 6) return 6;
  if (n <= 8) return 8;
  if (n <= 10) return 10;
  return Math.ceil(n / 5) * 5;
}

function formatChartClock(ms) {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

const PREVIEW_REQUEST_HEADERS = {
  Authorization: "Bearer ***",
  Accept: "application/json",
};

// Populates the "Show requests" panels with a realistic redacted exchange
// for the README screenshot fixture (?preview=monitor), the same shape a
// real or demo session records, so screenshots never show "Not sent yet."
function buildPreviewRequestLog() {
  const payload = decodeActivationJwt(buildPreviewJwt());
  const receivedAt = Date.parse(PREVIEW_NOW);
  const pollUrl = `${payload.appUrl}/queue`;

  primeRequestLogForPreview("token", {
    method: "POST",
    url: payload.oauthUrl,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: {
      grant_type: "refresh_token",
      client_id: PREVIEW_CLIENT_ID,
      client_secret: "***",
      refresh_token: "***",
    },
    status: 200,
    responseBody: {
      access_token: "[redacted]",
      refresh_token: "[redacted]",
      expires_in: 64800,
    },
    receivedAt,
  });

  primeRequestLogForPreview("workspaces", {
    method: "GET",
    url: `${payload.webexapisBaseUrl}/workspaces?max=100`,
    headers: PREVIEW_REQUEST_HEADERS,
    status: 200,
    responseBody: { items: PREVIEW_WORKSPACES },
    receivedAt,
  });

  primeRequestLogForPreview("activate", {
    method: "PATCH",
    url: payload.appUrl,
    headers: {
      Authorization: "Bearer ***",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: { provisioningState: "completed", queue: { state: "enabled" } },
    status: 200,
    responseBody: {
      provisioningState: "completed",
      queue: { state: "enabled", pollUrl },
    },
    receivedAt,
  });

  primeRequestLogForPreview("poll", {
    method: "GET",
    url: pollUrl,
    headers: PREVIEW_REQUEST_HEADERS,
    status: 200,
    responseBody: { messages: PREVIEW_MESSAGES, queue: { pollUrl } },
    receivedAt,
  });

  primeRequestLogForPreview("devices", {
    method: "GET",
    url: `${payload.webexapisBaseUrl}/devices?max=100&type=roomdesk&capability=xapi`,
    headers: PREVIEW_REQUEST_HEADERS,
    status: 200,
    responseBody: { items: PREVIEW_DEVICES },
    receivedAt,
  });

  const panelHeaders = {
    Authorization: "Bearer ***",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  primeRequestLogForPreview("panelSave", {
    method: "POST",
    url: `${payload.webexapisBaseUrl}/xapi/command/UserInterface.Extensions.Panel.Save`,
    headers: panelHeaders,
    body: {
      deviceId: "device-board-pro",
      arguments: { PanelId: DEMO_PANEL_ID },
      body: DEMO_PANEL_XML,
    },
    status: 200,
    responseBody: {},
    receivedAt,
  });
  primeRequestLogForPreview("panelClicked", {
    method: "POST",
    url: `${payload.webexapisBaseUrl}/xapi/command/UserInterface.Extensions.Panel.Clicked`,
    headers: panelHeaders,
    body: {
      deviceId: "device-board-pro",
      arguments: { PanelId: DEMO_PANEL_ID },
    },
    status: 200,
    responseBody: {},
    receivedAt,
  });
  primeRequestLogForPreview("panelRemove", {
    method: "POST",
    url: `${payload.webexapisBaseUrl}/xapi/command/UserInterface.Extensions.Panel.Remove`,
    headers: panelHeaders,
    body: {
      deviceId: "device-board-pro",
      arguments: { PanelId: DEMO_PANEL_ID },
    },
    status: 200,
    responseBody: {},
    receivedAt,
  });
}

// Screenshot-only: ?preview=monitor&focus=<key> hides every top-level
// monitor-tab block except the ones listed, so a capture can zoom in on one
// feature instead of the whole tab.
const PREVIEW_FOCUS_SECTION_IDS = {
  activation: ["activation-requests-section"],
  "long-polling": ["poll-requests-section"],
  discovery: ["panel-install", "discovery-requests-section"],
  overview: ["message-chart-section", "monitor-columns"],
};

(function initMonitor() {
  const clientIdInput = document.getElementById("client-id");
  const clientSecretInput = document.getElementById("client-secret");
  const activationInput = document.getElementById("activation-code");
  const activateForm = document.getElementById("activate-form");
  const hiddenNotice = document.getElementById("activate-hidden-notice");
  const decodedBox = document.getElementById("decoded-summary");
  const decodedPre = document.getElementById("decoded-pre");
  const decodedBody = document.getElementById("decoded-body");
  const togglePayload = document.getElementById("toggle-payload");
  const demoIntegrationButton = document.getElementById("demo-integration");
  const startButton = document.getElementById("start-monitor");
  const stopButton = document.getElementById("stop-monitor");
  const bookmarkButton = document.getElementById("bookmark-integration");
  const monitorStatus = document.getElementById("monitor-status");
  const workspaceGrid = document.getElementById("workspace-grid");
  const activityFeed = document.getElementById("activity-feed");
  const feedNewMessagesButton = document.getElementById("feed-new-messages");
  const statsRow = document.getElementById("monitor-stats");
  const pollStatusPill = document.getElementById("poll-status-pill");
  const pollMeter = document.getElementById("poll-meter");
  const pollMeterTrack = document.getElementById("poll-meter-track");
  const pollMeterFill = document.getElementById("poll-meter-fill");
  const messageChartSection = document.getElementById("message-chart-section");
  const messageChart = document.getElementById("message-chart");
  const toggleActivationRequests = document.getElementById(
    "toggle-activation-requests",
  );
  const activationRequestsBody = document.getElementById(
    "activation-requests-body",
  );
  const requestTokenEl = document.getElementById("request-token");
  const requestActivateEl = document.getElementById("request-activate");
  const togglePollRequests = document.getElementById("toggle-poll-requests");
  const pollRequestsBody = document.getElementById("poll-requests-body");
  const requestPollEl = document.getElementById("request-poll");
  const toggleDiscoveryRequests = document.getElementById(
    "toggle-discovery-requests",
  );
  const discoveryRequestsBody = document.getElementById(
    "discovery-requests-body",
  );
  const requestWorkspacesEl = document.getElementById("request-workspaces");
  const requestDevicesEl = document.getElementById("request-devices");
  const requestPanelSaveEl = document.getElementById("request-panel-save");
  const requestPanelClickedEl = document.getElementById(
    "request-panel-clicked",
  );
  const requestPanelRemoveEl = document.getElementById("request-panel-remove");
  const panelInstall = document.getElementById("panel-install");
  const deviceSearch = document.getElementById("device-search");
  const deviceSearchForm = document.getElementById("device-search-form");
  const deviceResults = document.getElementById("device-search-results");

  if (
    !clientIdInput ||
    !clientSecretInput ||
    !activationInput ||
    !startButton ||
    !stopButton ||
    !workspaceGrid ||
    !activityFeed
  ) {
    return;
  }

  const state = {
    running: false,
    demoMode: false,
    webexClient: realWebexClient,
    controller: null,
    tokenStore: null,
    webexapisBaseUrl: "",
    workspaceById: Object.create(null),
    deviceById: Object.create(null),
    panelStatusByDevice: Object.create(null),
    workspaceStatusExpanded: Object.create(null),
    latestByWorkspace: Object.create(null),
    feed: [],
    feedFollowLatest: true,
    messageCount: 0,
    messageTimes: [],
    orgName: "",
    lastPollAt: null,
    monitorLoaded: false,
    pollStartedAt: 0,
    payloadOpen: previewMode === "activate",
    deviceSearchSubmitted: false,
    activationRequestsOpen: false,
    pollRequestsOpen: false,
    discoveryRequestsOpen: false,
  };

  let searchTimer = 0;
  let chartTimer = 0;
  let pollMeterRaf = 0;

  const readCredentials = () => ({
    clientId: clientIdInput.value.trim(),
    clientSecret: clientSecretInput.value.trim(),
    activationCode: activationInput.value.trim(),
  });

  const allFieldsFilled = () => {
    const { clientId, clientSecret, activationCode } = readCredentials();
    return Boolean(clientId && clientSecret && isJwtShape(activationCode));
  };

  const setFieldsDisabled = (disabled) => {
    clientIdInput.disabled = disabled;
    clientSecretInput.disabled = disabled;
    activationInput.disabled = disabled;
  };

  const setCredentialsVisible = (visible) => {
    if (activateForm) {
      activateForm.hidden = !visible;
    }
    if (hiddenNotice) {
      hiddenNotice.hidden = visible;
    }
  };

  const syncButtons = () => {
    const ready = allFieldsFilled();
    startButton.disabled = state.running || !ready;
    stopButton.disabled = !state.running;
    if (bookmarkButton) {
      bookmarkButton.disabled = !ready;
    }
  };

  const consumeHashCredentials = () => {
    const params = readHashParams();
    const encoded = params.get("credentials");
    params.delete("credentials");
    writeHashParams(params);
    if (!encoded) {
      return null;
    }
    try {
      const parsed = decodeBase64Json(encoded);
      const clientId = String(parsed?.clientId || "").trim();
      const clientSecret = String(parsed?.clientSecret || "").trim();
      const activationCode = String(
        parsed?.activationCode || parsed?.activationToken || "",
      ).trim();
      if (!clientId || !clientSecret || !isJwtShape(activationCode)) {
        return null;
      }
      return { clientId, clientSecret, activationCode };
    } catch {
      return null;
    }
  };

  const writeBookmarkUrl = () => {
    if (!allFieldsFilled()) {
      return;
    }
    const params = readHashParams();
    params.set("credentials", encodeBase64Json(readCredentials()));
    writeHashParams(params);
    setStatusEl(
      monitorStatus,
      "Page URL updated. Bookmark this page now. The saved link includes Client ID, Client Secret, and the activation code for this demo.",
      "success",
    );
  };

  const syncPayloadToggle = () => {
    if (!decodedPre || !togglePayload) {
      return;
    }
    decodedPre.hidden = !state.payloadOpen;
    syncShowHideButton(togglePayload, state.payloadOpen, {
      showLabel: "Show payload",
      hideLabel: "Hide payload",
    });
  };

  const syncActivationRequestsToggle = () => {
    if (!activationRequestsBody || !toggleActivationRequests) {
      return;
    }
    activationRequestsBody.hidden = !state.activationRequestsOpen;
    syncShowHideButton(toggleActivationRequests, state.activationRequestsOpen, {
      showLabel: "Show requests",
      hideLabel: "Hide requests",
    });
  };

  const syncPollRequestsToggle = () => {
    if (!pollRequestsBody || !togglePollRequests) {
      return;
    }
    pollRequestsBody.hidden = !state.pollRequestsOpen;
    syncShowHideButton(togglePollRequests, state.pollRequestsOpen, {
      showLabel: "Show requests",
      hideLabel: "Hide requests",
    });
  };

  const syncDiscoveryRequestsToggle = () => {
    if (!discoveryRequestsBody || !toggleDiscoveryRequests) {
      return;
    }
    discoveryRequestsBody.hidden = !state.discoveryRequestsOpen;
    syncShowHideButton(toggleDiscoveryRequests, state.discoveryRequestsOpen, {
      showLabel: "Show requests",
      hideLabel: "Hide requests",
    });
  };

  // Cloud xAPI panel commands show a placeholder request built from known
  // constants (panel ID, panel XML) before any device has actually
  // triggered one, so there's always something to discuss.
  const buildPanelActionPreview = (logKey) => {
    const command = PANEL_ACTION_COMMANDS[logKey];
    if (!command) {
      return null;
    }
    const baseUrl = (
      state.webexapisBaseUrl || "https://webexapis.com/v1"
    ).replace(/\/$/, "");
    const body = {
      deviceId: "<deviceId>",
      arguments: { PanelId: DEMO_PANEL_ID },
    };
    if (logKey === "panelSave") {
      body.body = DEMO_PANEL_XML;
    }
    return {
      method: "POST",
      url: `${baseUrl}/xapi/command/${command}`,
      headers: {
        Authorization: "Bearer ***",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    };
  };

  const renderRequestEntry = (target, logKey, pendingMessage) => {
    if (!target) {
      return;
    }
    target.replaceChildren();
    const entry = state.webexClient.getRequestLog(logKey);
    if (!entry) {
      const preview = buildPanelActionPreview(logKey);
      if (preview) {
        target.append(
          createRequestBlock(preview, { preview: true }),
          createPendingResponseBlock(pendingMessage),
        );
        return;
      }
      target.append(
        createElement("p", "api-exchange__pending", pendingMessage),
      );
      return;
    }
    target.append(
      createRequestBlock(entry),
      createResponseBlock(entry, logKey),
    );
    if (logKey === "token" && !entry.error) {
      const note = createTokenLifetimeNote(entry);
      if (note) {
        target.append(note);
      }
    }
  };

  const renderActivationRequests = () => {
    renderRequestEntry(
      requestTokenEl,
      "token",
      "Not sent yet. Click Activate & Monitor to see the live request and response.",
    );
    renderRequestEntry(requestWorkspacesEl, "workspaces", "Not sent yet.");
    renderRequestEntry(requestActivateEl, "activate", "Not sent yet.");
  };

  const renderPollRequests = () => {
    renderRequestEntry(requestPollEl, "poll", "Not sent yet.");
  };

  const renderDiscoveryRequests = () => {
    renderRequestEntry(requestDevicesEl, "devices", "Not sent yet.");
    renderRequestEntry(
      requestPanelSaveEl,
      "panelSave",
      "Not sent yet. Search for a device below and click Save demo panel.",
    );
    renderRequestEntry(
      requestPanelClickedEl,
      "panelClicked",
      "Not sent yet. Click Trigger panel clicked on an installed device above.",
    );
    renderRequestEntry(
      requestPanelRemoveEl,
      "panelRemove",
      "Not sent yet. Click Delete panel on an installed device above.",
    );
  };

  const renderDecoded = () => {
    const code = activationInput.value.trim();
    if (!decodedBox || !decodedBody) {
      return;
    }
    if (!isJwtShape(code)) {
      decodedBox.hidden = true;
      decodedBody.replaceChildren();
      return;
    }
    try {
      const payload = decodeActivationJwt(code);
      renderJsonPreview(decodedBody, redactActivationPayload(payload), {
        highlightUsedKeys: true,
      });
      decodedBox.hidden = false;
      syncPayloadToggle();
    } catch (error) {
      decodedBody.replaceChildren();
      decodedBody.textContent =
        error.message || "Unable to decode activation code.";
      decodedBox.hidden = false;
      syncPayloadToggle();
    }
  };

  const setPanelInstallVisible = (visible) => {
    if (panelInstall) {
      panelInstall.hidden = !visible;
    }
  };

  const setDemoButtonVisible = (visible) => {
    if (demoIntegrationButton) {
      demoIntegrationButton.hidden = !visible;
    }
  };

  const setMessageChartVisible = (visible) => {
    if (messageChartSection) {
      messageChartSection.hidden = !visible;
    }
  };

  const chartNow = () => {
    if (previewMode === "monitor" && state.lastPollAt) {
      return new Date(state.lastPollAt);
    }
    return new Date();
  };

  const recordReceivedMessage = (message) => {
    const parsed = Date.parse(message?.timestamp);
    state.messageTimes.push(Number.isFinite(parsed) ? parsed : Date.now());
    state.messageCount += 1;
  };

  const messageBuckets = () => {
    const end = startOfMinuteUtc(chartNow());
    const oldest = end - (CHART_WINDOW_MINUTES - 1) * 60_000;
    state.messageTimes = state.messageTimes.filter((time) => time >= oldest);
    const counts = Array(CHART_WINDOW_MINUTES).fill(0);
    for (const time of state.messageTimes) {
      const index = Math.floor((startOfMinuteUtc(time) - oldest) / 60_000);
      if (index >= 0 && index < CHART_WINDOW_MINUTES) {
        counts[index] += 1;
      }
    }
    return { end, oldest, counts };
  };

  const stopChartTimer = () => {
    window.clearInterval(chartTimer);
    chartTimer = 0;
  };

  const startChartTimer = () => {
    stopChartTimer();
    if (previewMode === "monitor") {
      return;
    }
    chartTimer = window.setInterval(() => {
      renderMessageChart();
    }, CHART_REFRESH_MS);
  };

  const renderMessageChart = () => {
    if (!messageChart) {
      return;
    }
    messageChart.replaceChildren();
    if (!state.running && state.messageTimes.length === 0) {
      return;
    }

    const { oldest, counts } = messageBuckets();
    const peak = counts.reduce((max, count) => Math.max(max, count), 0);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const yMax = niceYMax(peak);
    const width = 640;
    const height = 240;
    const pad = { top: 12, right: 12, bottom: 32, left: 36 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const xAt = (index) =>
      pad.left + (index / (CHART_WINDOW_MINUTES - 1)) * plotW;
    const yAt = (count) => pad.top + plotH - (count / yMax) * plotH;

    const svg = createSvgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
    });
    svg.setAttribute(
      "aria-label",
      `Messages received in the last hour: ${total}. Peak ${peak} in one minute.`,
    );

    const yTicks = [0, yMax / 2, yMax];
    for (const tick of yTicks) {
      const y = yAt(tick);
      svg.appendChild(
        createSvgElement("line", {
          class: "message-chart__grid",
          x1: String(pad.left),
          y1: String(y),
          x2: String(width - pad.right),
          y2: String(y),
        }),
      );
      const label = createSvgElement("text", {
        class: "message-chart__tick",
        x: String(pad.left - 8),
        y: String(y + 4),
        "text-anchor": "end",
      });
      label.textContent = String(tick);
      svg.appendChild(label);
    }

    const points = counts.map((count, index) => `${xAt(index)},${yAt(count)}`);
    const area = [
      `${xAt(0)},${yAt(0)}`,
      ...points,
      `${xAt(CHART_WINDOW_MINUTES - 1)},${yAt(0)}`,
    ].join(" ");
    svg.appendChild(
      createSvgElement("polygon", {
        class: "message-chart__area",
        points: area,
      }),
    );
    svg.appendChild(
      createSvgElement("polyline", {
        class: "message-chart__line",
        points: points.join(" "),
      }),
    );

    const tickMinutes = [];
    for (
      let minute = 0;
      minute < CHART_WINDOW_MINUTES;
      minute += CHART_TICK_MINUTES
    ) {
      tickMinutes.push(minute);
    }
    if (tickMinutes[tickMinutes.length - 1] !== CHART_WINDOW_MINUTES - 1) {
      tickMinutes.push(CHART_WINDOW_MINUTES - 1);
    }
    for (const minute of tickMinutes) {
      const x = xAt(minute);
      const anchor =
        minute === 0
          ? "start"
          : minute === CHART_WINDOW_MINUTES - 1
            ? "end"
            : "middle";
      const tick = createSvgElement("text", {
        class: "message-chart__tick",
        x: String(x),
        y: String(height - 8),
        "text-anchor": anchor,
      });
      tick.textContent = formatChartClock(oldest + minute * 60_000);
      svg.appendChild(tick);
    }

    const caption = createElement("p", "message-chart__caption");
    const infoIcon = createElement("span", "icon icon-info-circle-regular");
    infoIcon.setAttribute("aria-hidden", "true");
    caption.append(
      infoIcon,
      document.createTextNode("Messages fetched by the integration"),
    );
    messageChart.append(svg, caption);
  };

  const renderPollStatus = () => {
    if (!pollStatusPill) {
      return;
    }
    if (!state.monitorLoaded) {
      pollStatusPill.hidden = true;
      pollStatusPill.textContent = "";
      pollStatusPill.className = "poll-status-pill";
      return;
    }
    const polling = Boolean(state.running);
    const prefix = state.demoMode ? "Demo · " : "";
    pollStatusPill.hidden = false;
    pollStatusPill.textContent = polling
      ? `${prefix}Polling`
      : `${prefix}Stopped`;
    pollStatusPill.className = polling
      ? "poll-status-pill poll-status-pill--polling"
      : "poll-status-pill poll-status-pill--stopped";
  };

  const stopPollMeter = () => {
    state.pollStartedAt = 0;
    if (pollMeterRaf) {
      cancelAnimationFrame(pollMeterRaf);
      pollMeterRaf = 0;
    }
    if (pollMeter) {
      pollMeter.hidden = true;
    }
    if (pollMeterFill) {
      pollMeterFill.style.width = "0%";
    }
    pollMeterTrack?.setAttribute("aria-valuenow", "0");
  };

  const startPollMeter = (elapsedMs = 0) => {
    if (!pollMeter || !pollMeterFill) {
      return;
    }
    state.pollStartedAt = Date.now() - Math.max(0, elapsedMs);
    pollMeter.hidden = false;
    if (pollMeterRaf) {
      cancelAnimationFrame(pollMeterRaf);
    }
    const tick = () => {
      if (!state.pollStartedAt) {
        return;
      }
      let elapsed = Date.now() - state.pollStartedAt;
      if (previewMode === "monitor" && elapsed >= POLL_METER_MS) {
        state.pollStartedAt = Date.now();
        elapsed = 0;
      }
      const clamped = Math.min(POLL_METER_MS, Math.max(0, elapsed));
      pollMeterFill.style.width = `${(clamped / POLL_METER_MS) * 100}%`;
      pollMeterTrack?.setAttribute(
        "aria-valuenow",
        String(Math.round(clamped / 1000)),
      );
      pollMeterRaf = requestAnimationFrame(tick);
    };
    tick();
  };

  const renderStats = () => {
    if (!statsRow) return;
    statsRow.replaceChildren();
    if (!state.running && state.messageCount === 0) {
      statsRow.hidden = true;
      renderPollStatus();
      return;
    }
    statsRow.hidden = false;
    const items = [
      ["Organization", state.orgName || "Unknown"],
      ["Workspaces loaded", String(Object.keys(state.workspaceById).length)],
      ["Notifications", String(state.messageCount)],
      [
        "Last poll",
        state.lastPollAt ? formatTime(state.lastPollAt) : "Waiting",
      ],
    ];
    for (const [label, value] of items) {
      const chip = createElement("div", "stat-chip");
      chip.append(
        createElement("span", "stat-chip__label", label),
        createElement("span", "stat-chip__value", value),
      );
      statsRow.append(chip);
    }
    renderPollStatus();
  };

  const renderWorkspaces = () => {
    workspaceGrid.replaceChildren();
    const ids = Object.keys(state.latestByWorkspace);
    if (!ids.length) {
      workspaceGrid.append(
        createElement(
          "p",
          "empty-hint",
          state.running
            ? "Waiting for device notifications. Webex can take up to 10 minutes after activation before events start flowing."
            : "Workspace cards appear here after the integration is activated.",
        ),
      );
      return;
    }

    ids
      .sort((left, right) => {
        const leftName = lookupName(state.workspaceById, left, "Workspace");
        const rightName = lookupName(state.workspaceById, right, "Workspace");
        return leftName.localeCompare(rightName);
      })
      .forEach((workspaceId) => {
        const latest = state.latestByWorkspace[workspaceId];
        const card = createElement("article", "workspace-card");
        const copy = createElement("div", "workspace-card__copy");
        const workspaceName = lookupName(
          state.workspaceById,
          workspaceId,
          "Workspace",
        );
        const productName = latest.deviceId
          ? deviceProduct(latest.deviceId) || "RoomOS device"
          : "Device pending";
        const titleEl = createElement(
          "h3",
          "workspace-card__title",
          workspaceName,
        );
        titleEl.title = workspaceName;
        const productEl = createElement(
          "p",
          "workspace-card__product",
          productName,
        );
        productEl.title = productName;
        copy.append(titleEl, productEl);
        card.append(copy);

        const statuses = latest.statuses || Object.create(null);
        const allKeys = Object.keys(statuses);
        const highlightedKeys = HIGHLIGHT_STATUS_KEYS.filter(
          (key) => statuses[key] !== undefined,
        );
        const extraKeys = allKeys.filter(
          (key) => !HIGHLIGHT_STATUS_KEYS.includes(key),
        );
        const expanded = Boolean(state.workspaceStatusExpanded[workspaceId]);
        const visibleKeys = expanded ? allKeys : highlightedKeys;
        if (visibleKeys.length) {
          card.append(
            renderStatusTree(visibleKeys.map((key) => [key, statuses[key]])),
          );
        }
        if (extraKeys.length) {
          const moreToggle = createElement(
            "button",
            "secondary-button status-tree__more-toggle",
            expanded ? "Show less" : `Show ${extraKeys.length} more`,
          );
          moreToggle.type = "button";
          moreToggle.setAttribute("aria-expanded", String(expanded));
          moreToggle.addEventListener("click", () => {
            state.workspaceStatusExpanded[workspaceId] = !expanded;
            renderWorkspaces();
          });
          card.append(moreToggle);
        }
        if (latest.lastEvent) {
          card.append(
            createElement(
              "p",
              "workspace-card__event",
              `Last event: ${latest.lastEvent}`,
            ),
          );
        }
        if (latest.updatedAt) {
          card.append(
            createElement(
              "p",
              "workspace-card__updated",
              `Updated ${formatTime(latest.updatedAt)}`,
            ),
          );
        }
        workspaceGrid.append(card);
      });
  };

  const renderFeed = () => {
    activityFeed.replaceChildren();
    if (!state.feed.length) {
      activityFeed.append(
        createElement(
          "p",
          "empty-hint",
          "Live xStatus and xEvent notifications will appear here.",
        ),
      );
      return;
    }

    for (const item of state.feed) {
      const article = createElement(
        "article",
        item.special ? "feed-item feed-item--panel" : "feed-item",
      );
      const header = createElement("header", "feed-item__header");
      const copy = createElement("div", "feed-item__copy");
      const feedProductName = item.deviceProduct || "RoomOS device";
      const feedWorkspaceEl = createElement(
        "strong",
        "feed-item__workspace",
        item.workspaceName,
      );
      feedWorkspaceEl.title = item.workspaceName;
      const feedProductEl = createElement(
        "p",
        "feed-item__product",
        feedProductName,
      );
      feedProductEl.title = feedProductName;
      copy.append(feedWorkspaceEl, feedProductEl);
      const toggle = createElement(
        "button",
        "icon-button secondary-button feed-item__raw-toggle",
      );
      toggle.type = "button";
      toggle.setAttribute(
        "aria-label",
        item.rawOpen ? "Show formatted notification" : "Show raw notification",
      );
      toggle.setAttribute(
        "title",
        item.rawOpen ? "Show formatted" : "Show raw",
      );
      toggle.setAttribute("aria-pressed", String(Boolean(item.rawOpen)));
      const icon = createElement(
        "span",
        item.rawOpen ? "icon icon-hide-regular" : "icon icon-show-regular",
      );
      icon.setAttribute("aria-hidden", "true");
      toggle.append(icon);
      toggle.addEventListener("click", () => {
        item.rawOpen = !item.rawOpen;
        renderFeed();
      });
      header.append(copy, toggle);

      const pills = createElement("div", "feed-item__pills");
      const isStatus = item.type === "status";
      pills.append(
        createElement(
          "span",
          isStatus
            ? "feed-item__type feed-item__type--status"
            : "feed-item__type feed-item__type--events",
          isStatus ? "Status" : "Events",
        ),
      );
      if (item.special) {
        pills.append(createAlertActionPill());
      }
      if (item.isFullSync) {
        pills.append(
          createElement(
            "span",
            "feed-item__type feed-item__type--sync",
            "Full Sync",
          ),
        );
      }

      const body = item.rawOpen
        ? createWrappedJsonPre(omitFalseFullSync(item.raw))
        : createFeedContent(item);
      article.append(
        header,
        pills,
        body,
        createElement("time", "feed-item__time", item.time),
      );
      activityFeed.append(article);
    }
  };

  const FEED_SCROLL_TOP_EPSILON = 4;

  const setFeedNewMessagesVisible = (visible) => {
    if (!feedNewMessagesButton) {
      return;
    }
    feedNewMessagesButton.hidden = !visible;
  };

  // Called only when new poll messages are prepended to the feed. If the
  // reader is scrolled to the top, follow the latest message down there;
  // otherwise leave their scroll position alone and surface the "New
  // messages" button instead of yanking the view out from under them.
  const applyFeedUpdate = () => {
    if (!activityFeed) {
      renderFeed();
      return;
    }
    const followLatest = state.feedFollowLatest;
    const prevScrollTop = activityFeed.scrollTop;
    const prevScrollHeight = activityFeed.scrollHeight;
    renderFeed();
    if (followLatest) {
      activityFeed.scrollTop = 0;
      setFeedNewMessagesVisible(false);
    } else {
      activityFeed.scrollTop =
        prevScrollTop + (activityFeed.scrollHeight - prevScrollHeight);
      setFeedNewMessagesVisible(true);
    }
  };

  const createFeedSection = (title, child, extraClass = "") => {
    const section = createElement(
      "section",
      extraClass ? `feed-section ${extraClass}` : "feed-section",
    );
    section.append(createElement("h4", "feed-section__title", title), child);
    return section;
  };

  const createEventBlock = (event) => {
    const block = createElement("div", "feed-event");
    block.append(createElement("p", "feed-event__key", event?.key || "Event"));
    const value = event?.value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value).filter(
        ([key]) => key !== "timestamp",
      );
      if (entries.length) {
        block.append(renderStatusTree(entries));
      }
    } else if (value !== undefined && value !== null && value !== "") {
      block.append(renderStatusTree([["Value", value]]));
    }
    return block;
  };

  const createFeedContent = (item) => {
    const content = createElement("div", "feed-item__content");
    if (item.note) {
      content.append(createElement("p", "feed-item__note", item.note));
    }
    if (item.updated && Object.keys(item.updated).length) {
      content.append(
        createFeedSection(
          "Updated",
          renderStatusTree(Object.entries(item.updated)),
          "feed-section--updated",
        ),
      );
    }
    if (Array.isArray(item.removed) && item.removed.length) {
      content.append(
        createFeedSection(
          "Removed",
          renderStatusTree(
            item.removed.map((key) => [String(key), undefined]),
            {
              removed: true,
            },
          ),
          "feed-section--removed",
        ),
      );
    }
    if (Array.isArray(item.events) && item.events.length) {
      const list = createElement("div", "feed-events");
      for (const event of item.events) {
        list.append(createEventBlock(event));
      }
      content.append(createFeedSection("Events", list, "feed-section--events"));
    }
    if (item.details && Object.keys(item.details).length) {
      content.append(
        createFeedSection(
          "Details",
          renderStatusTree(Object.entries(item.details)),
        ),
      );
    }
    if (!content.childNodes.length) {
      content.append(createWrappedJsonPre(omitFalseFullSync(item.raw)));
    }
    return content;
  };

  const eventValue = (event) =>
    event?.value && typeof event.value === "object" ? event.value : {};

  const isDemoPanelClick = (event) =>
    event?.key === "UserInterface.Extensions.Panel.Clicked" &&
    String(eventValue(event).PanelId || "") === DEMO_PANEL_ID;

  const sendPanelAlert = (deviceId, value) => {
    if (
      previewMode ||
      !state.tokenStore ||
      !state.webexapisBaseUrl ||
      !deviceId
    ) {
      return;
    }
    const args = {
      Duration: 60,
      Text: DEMO_PANEL_ALERT_TEXT,
      Title: DEMO_PANEL_NAME,
    };
    const peripheralId = String(value.PeripheralId || "").trim();
    const target = String(value.Target || "").trim();
    if (peripheralId) {
      args.PeripheralId = peripheralId;
    }
    if (target === "OSD" || target === "Controller") {
      args.Target = target;
    }
    void (async () => {
      try {
        const accessToken = await state.tokenStore.getAccessToken(
          state.controller?.signal,
        );
        await state.webexClient.executeXapiCommand({
          baseUrl: state.webexapisBaseUrl,
          accessToken,
          command: "UserInterface.Message.Alert.Display",
          deviceId,
          arguments: args,
          signal: state.controller?.signal,
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          return;
        }
        setStatusEl(
          monitorStatus,
          `Could not display the on-device alert (${error.message}).`,
          "warning",
        );
      }
    })();
  };

  const matchingDevices = () => {
    const query = (deviceSearch?.value || "").trim().toLowerCase();
    const devices = Object.values(state.deviceById);
    return devices.filter((device) => {
      const workspaceName = lookupName(
        state.workspaceById,
        device.workspaceId,
        "",
      );
      const haystack = [device.product, workspaceName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return !query || haystack.includes(query);
    });
  };

  const deviceProduct = (deviceId) => {
    const product = deviceId && state.deviceById[deviceId]?.product;
    return typeof product === "string" ? product.trim() : "";
  };

  const createMomentumIcon = (name) => {
    const icon = createElement("span", `icon ${name}`);
    icon.setAttribute("aria-hidden", "true");
    return icon;
  };

  const createAlertActionPill = () => {
    const pill = createElement("span", "feed-item__action");
    pill.setAttribute(
      "aria-label",
      "Message Alert Display: panel, cloud upload, device alert",
    );
    const icons = createElement("span", "feed-item__action-icons");
    icons.append(
      createMomentumIcon("icon-integrations-regular"),
      createMomentumIcon("icon-next-regular"),
      createMomentumIcon("icon-cloud-upload-regular"),
      createMomentumIcon("icon-next-regular"),
      createMomentumIcon("icon-endpoint-warning-regular"),
    );
    pill.append(document.createTextNode("Message Alert Display"), icons);
    return pill;
  };

  const buildFeedItem = ({
    message,
    type,
    special = false,
    raw,
    note = "",
    updated = null,
    removed = null,
    events = null,
    details = null,
  }) => ({
    time: formatTime(message.timestamp || Date.now()),
    workspaceName: lookupName(
      state.workspaceById,
      message.workspaceId,
      "Workspace",
    ),
    deviceProduct: deviceProduct(message.deviceId),
    type,
    special,
    isFullSync: message.isFullSync === true,
    note,
    updated,
    removed,
    events,
    details,
    raw: raw || message,
    rawOpen: false,
  });

  const saveDemoPanel = async (device) => {
    if (!state.tokenStore || !state.webexapisBaseUrl || !device?.id) {
      setStatusEl(
        monitorStatus,
        "Activate the integration before saving the demo panel.",
        "error",
      );
      return;
    }
    const workspaceName = lookupName(
      state.workspaceById,
      device.workspaceId,
      "Workspace",
    );
    try {
      const accessToken = await state.tokenStore.getAccessToken(
        state.controller?.signal,
      );
      await state.webexClient.executeXapiCommand({
        baseUrl: state.webexapisBaseUrl,
        accessToken,
        command: "UserInterface.Extensions.Panel.Save",
        deviceId: device.id,
        arguments: { PanelId: DEMO_PANEL_ID },
        body: DEMO_PANEL_XML,
        signal: state.controller?.signal,
      });
      state.panelStatusByDevice[device.id] = { status: "installed" };
      setStatusEl(
        monitorStatus,
        `Saved the ${DEMO_PANEL_NAME} button on ${workspaceName}. Tap it on the device to send a Panel.Clicked event.`,
        "success",
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
      setStatusEl(
        monitorStatus,
        `Could not save the demo panel on ${workspaceName} (${error.message}).`,
        "error",
      );
    } finally {
      renderDiscoveryRequests();
      renderDeviceSearch();
    }
  };

  const triggerDemoPanelClick = async (device) => {
    if (!state.tokenStore || !state.webexapisBaseUrl || !device?.id) {
      return;
    }
    const workspaceName = lookupName(
      state.workspaceById,
      device.workspaceId,
      "Workspace",
    );
    try {
      const accessToken = await state.tokenStore.getAccessToken(
        state.controller?.signal,
      );
      await state.webexClient.executeXapiCommand({
        baseUrl: state.webexapisBaseUrl,
        accessToken,
        command: "UserInterface.Extensions.Panel.Clicked",
        deviceId: device.id,
        arguments: { PanelId: DEMO_PANEL_ID },
        signal: state.controller?.signal,
      });
      setStatusEl(
        monitorStatus,
        `Sent a Panel.Clicked event for ${DEMO_PANEL_NAME} on ${workspaceName}.`,
        "success",
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
      setStatusEl(
        monitorStatus,
        `Could not trigger the panel click on ${workspaceName} (${error.message}).`,
        "error",
      );
    } finally {
      renderDiscoveryRequests();
    }
  };

  const removeDemoPanel = async (device) => {
    if (!state.tokenStore || !state.webexapisBaseUrl || !device?.id) {
      return;
    }
    const workspaceName = lookupName(
      state.workspaceById,
      device.workspaceId,
      "Workspace",
    );
    try {
      const accessToken = await state.tokenStore.getAccessToken(
        state.controller?.signal,
      );
      await state.webexClient.executeXapiCommand({
        baseUrl: state.webexapisBaseUrl,
        accessToken,
        command: "UserInterface.Extensions.Panel.Remove",
        deviceId: device.id,
        arguments: { PanelId: DEMO_PANEL_ID },
        signal: state.controller?.signal,
      });
      state.panelStatusByDevice[device.id] = { status: "not-installed" };
      setStatusEl(
        monitorStatus,
        `Removed the ${DEMO_PANEL_NAME} button from ${workspaceName}.`,
        "success",
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
      setStatusEl(
        monitorStatus,
        `Could not remove the demo panel on ${workspaceName} (${error.message}).`,
        "error",
      );
    } finally {
      renderDiscoveryRequests();
      renderDeviceSearch();
    }
  };

  // Queries UserInterface.Extensions.List over the Cloud xAPI to find out
  // whether this device already has the demo panel installed, so the
  // results list can offer Trigger/Delete instead of Save.
  const checkPanelStatus = async (device) => {
    if (!state.tokenStore || !state.webexapisBaseUrl || !device?.id) {
      return;
    }
    state.panelStatusByDevice[device.id] = { status: "loading" };
    try {
      const accessToken = await state.tokenStore.getAccessToken(
        state.controller?.signal,
      );
      const { body } = await state.webexClient.executeXapiCommand({
        baseUrl: state.webexapisBaseUrl,
        accessToken,
        command: "UserInterface.Extensions.List",
        deviceId: device.id,
        arguments: PANEL_LIST_ARGUMENTS,
        signal: state.controller?.signal,
      });
      state.panelStatusByDevice[device.id] = {
        status: findInstalledDemoPanel(body) ? "installed" : "not-installed",
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        delete state.panelStatusByDevice[device.id];
        return;
      }
      state.panelStatusByDevice[device.id] = {
        status: "error",
        message: error.message,
      };
    }
    renderDeviceSearch();
  };

  const ensurePanelStatus = (device) => {
    if (!device?.id || state.panelStatusByDevice[device.id]) {
      return;
    }
    void checkPanelStatus(device);
  };

  const renderDeviceSearch = () => {
    if (!deviceResults) {
      return;
    }
    deviceResults.replaceChildren();
    if (!state.running || !state.deviceSearchSubmitted) {
      return;
    }
    const devices = Object.values(state.deviceById);
    if (!devices.length) {
      deviceResults.append(
        createElement(
          "p",
          "empty-hint",
          "No RoomOS devices with xAPI were returned. Confirm spark-admin:devices_read is granted and the integration is activated.",
        ),
      );
      return;
    }
    const matches = matchingDevices();
    if (!matches.length) {
      deviceResults.append(
        createElement("p", "empty-hint", "No devices match that search."),
      );
      return;
    }
    const canCheckPanels = Boolean(state.tokenStore && state.webexapisBaseUrl);
    for (const device of matches) {
      const row = createElement("div", "device-result");
      const copy = createElement("div", "device-result__copy");
      copy.append(
        createElement(
          "strong",
          "device-result__name",
          lookupName(state.workspaceById, device.workspaceId, "Workspace"),
        ),
        createElement(
          "span",
          "device-result__product",
          typeof device.product === "string" && device.product.trim()
            ? device.product.trim()
            : "RoomOS device",
        ),
      );

      // A pre-seeded status (e.g. the README screenshot fixture) is honored
      // even without a real token store; otherwise it's checked live.
      let panelStatus = state.panelStatusByDevice[device.id];
      if (!panelStatus) {
        if (canCheckPanels) {
          ensurePanelStatus(device);
          panelStatus = state.panelStatusByDevice[device.id] || {
            status: "loading",
          };
        } else {
          panelStatus = { status: "not-installed" };
        }
      }

      const actions = createElement("div", "device-result__actions");
      if (panelStatus.status === "loading") {
        actions.setAttribute("aria-busy", "true");
        actions.setAttribute(
          "aria-label",
          `Checking whether ${DEMO_PANEL_NAME} is installed`,
        );
        actions.append(
          createElement("span", "skeleton-button"),
          createElement("span", "skeleton-button skeleton-button--sm"),
        );
      } else if (panelStatus.status === "installed") {
        const triggerButton = createElement(
          "button",
          "secondary-button",
          "Trigger panel clicked",
        );
        triggerButton.type = "button";
        triggerButton.addEventListener("click", () => {
          void triggerDemoPanelClick(device);
        });

        const removeButton = createElement(
          "button",
          "secondary-button",
          "Delete panel",
        );
        removeButton.type = "button";
        removeButton.addEventListener("click", () => {
          void removeDemoPanel(device);
        });

        actions.append(
          createElement(
            "span",
            "panel-status-pill panel-status-pill--installed",
            "Installed",
          ),
          triggerButton,
          removeButton,
        );
      } else {
        if (panelStatus.status === "error") {
          actions.append(
            createElement(
              "span",
              "panel-status-pill panel-status-pill--error",
              "Status unknown",
            ),
          );
        }
        const saveButton = createElement(
          "button",
          "secondary-button",
          "Save demo panel",
        );
        saveButton.type = "button";
        saveButton.addEventListener("click", () => {
          void saveDemoPanel(device);
        });
        actions.append(saveButton);
      }

      row.append(copy, actions);
      deviceResults.append(row);
    }
  };

  const submitDeviceSearch = () => {
    state.deviceSearchSubmitted = true;
    renderDeviceSearch();
  };

  const applyMessage = (message) => {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "healthCheck") {
      return;
    }

    const workspaceId = message.workspaceId || "unknown";
    if (!state.latestByWorkspace[workspaceId]) {
      state.latestByWorkspace[workspaceId] = {
        statuses: Object.create(null),
        deviceId: message.deviceId || "",
        lastEvent: "",
        updatedAt: message.timestamp || new Date().toISOString(),
      };
    }
    const latest = state.latestByWorkspace[workspaceId];
    latest.updatedAt = message.timestamp || new Date().toISOString();
    if (message.deviceId) {
      latest.deviceId = message.deviceId;
    }

    let special = false;
    let note = "";
    let updated = null;
    let removed = null;
    let events = null;
    let details = null;
    if (message.type === "status") {
      updated = message.changes?.updated || {};
      removed = Array.isArray(message.changes?.removed)
        ? message.changes.removed
        : [];
      for (const [key, value] of Object.entries(updated)) {
        latest.statuses[key] = value;
      }
      for (const key of removed) {
        delete latest.statuses[key];
      }
      if (!Object.keys(updated).length) {
        updated = null;
      }
      if (!removed.length) {
        removed = null;
      }
    } else if (message.type === "events" || Array.isArray(message.events)) {
      events = Array.isArray(message.events) ? message.events : [];
      if (events[0]?.key) {
        latest.lastEvent = events[0].key;
      }
      const demoClicks = events.filter(isDemoPanelClick);
      if (demoClicks.length) {
        special = true;
        note = `Panel ${DEMO_PANEL_ID} clicked. Sending an on-screen alert to the device.`;
        events = demoClicks;
        for (const click of demoClicks) {
          sendPanelAlert(message.deviceId, eventValue(click));
        }
        const others = Array.isArray(message.events)
          ? message.events.filter((event) => !isDemoPanelClick(event))
          : [];
        if (others.length) {
          recordReceivedMessage(message);
          state.feed.unshift(
            buildFeedItem({
              message,
              type: message.type || "events",
              events: others,
              raw: { ...message, events: others },
            }),
          );
        }
      }
    } else {
      const copy = { ...message };
      delete copy.appId;
      delete copy.orgId;
      delete copy.isFullSync;
      details = Object.keys(copy).length ? copy : null;
    }

    recordReceivedMessage(message);
    state.feed.unshift(
      buildFeedItem({
        message,
        type: special ? "events" : message.type || "events",
        special,
        note,
        updated,
        removed,
        events,
        details,
      }),
    );
    if (state.feed.length > MAX_FEED_ITEMS) {
      state.feed.length = MAX_FEED_ITEMS;
    }
    renderMessageChart();
  };

  const indexRecords = (records, target) => {
    for (const record of records) {
      if (record?.id) {
        target[record.id] = record;
      }
    }
  };

  const stopMonitor = (message, kind = "") => {
    state.running = false;
    state.tokenStore = null;
    state.webexapisBaseUrl = "";
    if (state.controller) {
      state.controller.abort();
      state.controller = null;
    }
    setFieldsDisabled(false);
    setCredentialsVisible(true);
    setPanelInstallVisible(false);
    setMessageChartVisible(false);
    setDemoButtonVisible(true);
    stopChartTimer();
    stopPollMeter();
    state.payloadOpen = false;
    state.deviceSearchSubmitted = false;
    state.messageTimes = [];
    window.clearTimeout(searchTimer);
    if (deviceSearch) {
      deviceSearch.value = "";
    }
    syncPayloadToggle();
    syncButtons();
    renderStats();
    renderMessageChart();
    renderDeviceSearch();
    if (message) {
      setStatusEl(monitorStatus, message, kind);
    }
  };

  const beginMonitoringUi = () => {
    state.payloadOpen = false;
    state.deviceSearchSubmitted = false;
    window.clearTimeout(searchTimer);
    if (deviceSearch) {
      deviceSearch.value = "";
    }
    setFieldsDisabled(true);
    setCredentialsVisible(false);
    setPanelInstallVisible(true);
    setMessageChartVisible(true);
    setDemoButtonVisible(false);
    startChartTimer();
    syncPayloadToggle();
    syncButtons();
    renderDecoded();
    renderWorkspaces();
    renderFeed();
    renderStats();
    renderMessageChart();
    renderDeviceSearch();
    renderActivationRequests();
    renderPollRequests();
    renderDiscoveryRequests();
  };

  const runMonitor = async () => {
    const { clientId, clientSecret, activationCode } = readCredentials();
    if (!clientId || !clientSecret || !activationCode) {
      setStatusEl(
        monitorStatus,
        "Enter the Client ID, Client Secret, and Activation Code.",
        "error",
      );
      return;
    }
    if (clientId.length < 8 || clientSecret.length < 8) {
      setStatusEl(
        monitorStatus,
        "Client ID and Client Secret look too short. Paste the values from Control Hub.",
        "error",
      );
      return;
    }

    const isDemo = isDemoCredentials(clientId, clientSecret, activationCode);

    state.controller = new AbortController();
    const { signal } = state.controller;
    state.running = true;
    state.demoMode = isDemo;
    state.webexClient = isDemo ? createDemoIntegration() : realWebexClient;
    state.tokenStore = null;
    state.webexapisBaseUrl = "";
    state.workspaceById = Object.create(null);
    state.deviceById = Object.create(null);
    state.panelStatusByDevice = Object.create(null);
    state.workspaceStatusExpanded = Object.create(null);
    state.latestByWorkspace = Object.create(null);
    state.feed = [];
    state.feedFollowLatest = true;
    setFeedNewMessagesVisible(false);
    state.messageCount = 0;
    state.messageTimes = [];
    state.lastPollAt = null;
    state.monitorLoaded = false;
    stopPollMeter();
    clearRequestLog();
    beginMonitoringUi();

    try {
      setStatusEl(monitorStatus, "Decoding activation code…");
      const payload = decodeActivationJwt(activationCode);
      state.orgName = payload.orgName || "";
      state.webexapisBaseUrl = payload.webexapisBaseUrl;
      renderDecoded();
      renderStats();

      setStatusEl(monitorStatus, "Requesting an access token…");
      const tokens = await state.webexClient.createAccessToken({
        oauthUrl: payload.oauthUrl,
        clientId,
        clientSecret,
        refreshToken: payload.refreshToken,
        signal,
      });
      const tokenStore = createTokenStore(tokens, {
        oauthUrl: payload.oauthUrl,
        clientId,
        clientSecret,
      });
      state.tokenStore = tokenStore;
      renderActivationRequests();

      setStatusEl(
        monitorStatus,
        "Activating the integration and enabling long polling…",
      );
      const activateToken = await tokenStore.getAccessToken(signal);
      const activated = await state.webexClient.activateQueue(
        payload.appUrl,
        activateToken,
        signal,
      );
      let pollUrl = activated.pollUrl;
      renderActivationRequests();

      // Workspaces (and devices) are only discovered once the integration is
      // actually activated, not before.
      setStatusEl(monitorStatus, "Loading workspaces…");
      try {
        const accessToken = await tokenStore.getAccessToken(signal);
        const [workspaces, devices] = await Promise.all([
          state.webexClient.listWorkspaces(
            payload.webexapisBaseUrl,
            accessToken,
            signal,
          ),
          state.webexClient
            .listDevices(payload.webexapisBaseUrl, accessToken, signal)
            .catch(() => []),
        ]);
        indexRecords(workspaces, state.workspaceById);
        indexRecords(devices, state.deviceById);
        renderDeviceSearch();
      } catch (error) {
        setStatusEl(
          monitorStatus,
          `Workspace lookup failed (${error.message}). Notifications will still be collected using workspace IDs.`,
          "warning",
        );
      }
      renderStats();
      renderActivationRequests();
      renderDiscoveryRequests();

      setStatusEl(
        monitorStatus,
        isDemo
          ? "Demo integration activated. Simulating device status and events…"
          : "Integration activated. Listening for device status and events…",
        "success",
      );
      state.monitorLoaded = true;
      renderPollStatus();

      while (state.running && !signal.aborted) {
        try {
          const pollToken = await tokenStore.getAccessToken(signal);
          startPollMeter();
          const result = await state.webexClient.pollQueue(
            pollUrl,
            pollToken,
            signal,
          );
          pollUrl = result.pollUrl;
          state.lastPollAt = new Date();
          for (const message of result.messages) {
            applyMessage(message);
          }
          if (result.messages.length) {
            renderWorkspaces();
            applyFeedUpdate();
          }
          renderStats();
          renderMessageChart();
          renderPollRequests();
        } catch (error) {
          stopPollMeter();
          renderPollRequests();
          if (signal.aborted) {
            break;
          }
          setStatusEl(
            monitorStatus,
            `Poll failed: ${error.message}. Retrying shortly…`,
            "warning",
          );
          await new Promise((resolve) => {
            const timer = window.setTimeout(resolve, MONITOR_POLL_RETRY_MS);
            signal.addEventListener(
              "abort",
              () => {
                window.clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      }
      stopPollMeter();
    } catch (error) {
      if (signal.aborted) {
        stopMonitor("Monitoring stopped.", "");
        return;
      }
      stopMonitor(describeNetworkError(error), "error");
      return;
    }

    if (!state.running) {
      renderStats();
    }
  };

  togglePayload?.addEventListener("click", () => {
    state.payloadOpen = !state.payloadOpen;
    syncPayloadToggle();
  });

  toggleActivationRequests?.addEventListener("click", () => {
    state.activationRequestsOpen = !state.activationRequestsOpen;
    syncActivationRequestsToggle();
  });

  togglePollRequests?.addEventListener("click", () => {
    state.pollRequestsOpen = !state.pollRequestsOpen;
    syncPollRequestsToggle();
  });

  toggleDiscoveryRequests?.addEventListener("click", () => {
    state.discoveryRequestsOpen = !state.discoveryRequestsOpen;
    syncDiscoveryRequestsToggle();
  });

  activityFeed?.addEventListener("scroll", () => {
    const atTop = activityFeed.scrollTop <= FEED_SCROLL_TOP_EPSILON;
    state.feedFollowLatest = atTop;
    if (atTop) {
      setFeedNewMessagesVisible(false);
    }
  });

  feedNewMessagesButton?.addEventListener("click", () => {
    state.feedFollowLatest = true;
    activityFeed.scrollTop = 0;
    setFeedNewMessagesVisible(false);
  });

  activationInput.addEventListener("input", () => {
    renderDecoded();
    syncButtons();
  });
  clientIdInput.addEventListener("input", () => {
    syncButtons();
  });
  clientSecretInput.addEventListener("input", () => {
    syncButtons();
  });
  deviceSearch?.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    if (!(deviceSearch.value || "").trim()) {
      return;
    }
    searchTimer = window.setTimeout(() => {
      submitDeviceSearch();
    }, SEARCH_DEBOUNCE_MS);
  });
  deviceSearchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    window.clearTimeout(searchTimer);
    submitDeviceSearch();
  });

  startButton.addEventListener("click", () => {
    if (state.running) return;
    void runMonitor();
  });

  stopButton.addEventListener("click", () => {
    window.clearTimeout(searchTimer);
    stopMonitor("Monitoring stopped.", "");
  });

  bookmarkButton?.addEventListener("click", () => {
    writeBookmarkUrl();
  });

  demoIntegrationButton?.addEventListener("click", () => {
    clientIdInput.value = PREVIEW_CLIENT_ID;
    clientSecretInput.value = PREVIEW_CLIENT_SECRET;
    activationInput.value = buildPreviewJwt();
    renderDecoded();
    syncButtons();
  });

  const bookmarkedCredentials = consumeHashCredentials();
  if (bookmarkedCredentials && !previewMode) {
    document.getElementById("tab-monitor")?.click();
    clientIdInput.value = bookmarkedCredentials.clientId;
    clientSecretInput.value = bookmarkedCredentials.clientSecret;
    activationInput.value = bookmarkedCredentials.activationCode;
    renderDecoded();
  }

  if (previewMode === "setup") {
    document.getElementById("tab-setup")?.click();
  }

  if (previewMode === "activate" || previewMode === "monitor") {
    document.getElementById("tab-monitor")?.click();
    clientIdInput.value = PREVIEW_CLIENT_ID;
    clientSecretInput.value = PREVIEW_CLIENT_SECRET;
    activationInput.value = buildPreviewJwt();
    renderDecoded();
  }

  if (previewMode === "monitor") {
    document
      .querySelector("#monitor .step-actions")
      ?.setAttribute("hidden", "");
    document.querySelector("#monitor > p")?.setAttribute("hidden", "");

    indexRecords(PREVIEW_WORKSPACES, state.workspaceById);
    indexRecords(PREVIEW_DEVICES, state.deviceById);
    state.orgName = PREVIEW_ORG_NAME;
    state.running = true;
    state.monitorLoaded = true;
    state.lastPollAt = new Date(PREVIEW_NOW);
    setCredentialsVisible(false);
    setPanelInstallVisible(true);
    setMessageChartVisible(true);
    setDemoButtonVisible(false);
    state.payloadOpen = false;
    if (decodedBox) {
      decodedBox.hidden = true;
    }
    state.panelStatusByDevice["device-board-pro"] = { status: "installed" };
    const previewFocus = new URLSearchParams(window.location.search).get(
      "focus",
    );
    if (deviceSearch && previewFocus === "discovery") {
      // Narrow the results to the one device with a saved panel, so the
      // focused screenshot isn't a wall of every demo device.
      deviceSearch.value = "Board Room";
    }
    submitDeviceSearch();
    for (const timestamp of PREVIEW_CHART_TIMES) {
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed)) {
        state.messageTimes.push(parsed);
      }
    }
    for (const message of PREVIEW_MESSAGES) {
      applyMessage(message);
    }
    setStatusEl(
      monitorStatus,
      "Integration activated. Listening for device status and events…",
      "success",
    );
    startPollMeter(POLL_METER_PREVIEW_ELAPSED_MS);

    buildPreviewRequestLog();
  }

  syncPayloadToggle();
  syncActivationRequestsToggle();
  syncPollRequestsToggle();
  syncDiscoveryRequestsToggle();
  syncButtons();
  renderWorkspaces();
  renderFeed();
  renderStats();
  renderDeviceSearch();
  renderActivationRequests();
  renderPollRequests();
  renderDiscoveryRequests();

  // ?focus=<key> narrows the screenshot to one feature (see
  // PREVIEW_FOCUS_SECTION_IDS) instead of the whole Activate & Monitor tab.
  // Runs last so it isn't undone by the renders above.
  if (previewMode === "monitor") {
    const focus = new URLSearchParams(window.location.search).get("focus");
    const keepIds = PREVIEW_FOCUS_SECTION_IDS[focus];
    if (keepIds) {
      const keep = new Set(keepIds);
      document
        .querySelectorAll(
          "#monitor > .monitor-section, #monitor > .monitor-columns",
        )
        .forEach((block) => {
          if (!keep.has(block.id)) {
            block.setAttribute("hidden", "");
          }
        });
      document.getElementById("monitor-stats")?.setAttribute("hidden", "");
      monitorStatus?.setAttribute("hidden", "");
      hiddenNotice?.setAttribute("hidden", "");
    }
  }
})();
