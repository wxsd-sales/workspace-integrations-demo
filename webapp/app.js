import { buildManifest, manifestFileName, stringifyManifest } from "./manifest.js";
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
  readPreviewMode,
} from "./preview.js";
import {
  activateQueue,
  createAccessToken,
  createTokenStore,
  decodeActivationJwt,
  describeNetworkError,
  executeXapiCommand,
  isJwtShape,
  listDevices,
  listWorkspaces,
  lookupName,
  pollQueue,
  redactActivationPayload,
} from "./webex.js";

const previewMode = readPreviewMode();

const config = window.APP_CONFIG ?? {};
const MAX_FEED_ITEMS = 200;
const HIGHLIGHT_STATUS_KEYS = [
  "RoomAnalytics.PeopleCount.Current",
  "RoomAnalytics.PeoplePresence",
  "Standby.State",
  "SystemUnit.State.NumberOfActiveCalls",
  "RoomAnalytics.AmbientTemperature",
  "RoomAnalytics.RelativeHumidity",
  "Bookings.Availability.Status",
];

const MONITOR_POLL_RETRY_MS = 10_000;
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

  if (!displayName || !vendor || !email || !description || !preview || !downloadButton) {
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
    window.location.pathname + window.location.search + (next ? `#${next}` : "");
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

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
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
  const startButton = document.getElementById("start-monitor");
  const stopButton = document.getElementById("stop-monitor");
  const bookmarkButton = document.getElementById("bookmark-integration");
  const monitorStatus = document.getElementById("monitor-status");
  const workspaceGrid = document.getElementById("workspace-grid");
  const activityFeed = document.getElementById("activity-feed");
  const statsRow = document.getElementById("monitor-stats");
  const messageChartSection = document.getElementById("message-chart-section");
  const messageChart = document.getElementById("message-chart");
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
    controller: null,
    tokenStore: null,
    webexapisBaseUrl: "",
    workspaceById: Object.create(null),
    deviceById: Object.create(null),
    latestByWorkspace: Object.create(null),
    feed: [],
    messageCount: 0,
    messageTimes: [],
    orgName: "",
    lastPollAt: null,
    payloadOpen: previewMode === "activate",
    deviceSearchSubmitted: false,
  };

  let searchTimer = 0;
  let chartTimer = 0;

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
    togglePayload.textContent = state.payloadOpen ? "Hide payload" : "Show payload";
    togglePayload.setAttribute("aria-expanded", String(state.payloadOpen));
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
      decodedBody.textContent = error.message || "Unable to decode activation code.";
      decodedBox.hidden = false;
      syncPayloadToggle();
    }
  };

  const setPanelInstallVisible = (visible) => {
    if (panelInstall) {
      panelInstall.hidden = !visible;
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
    for (let minute = 0; minute < CHART_WINDOW_MINUTES; minute += CHART_TICK_MINUTES) {
      tickMinutes.push(minute);
    }
    if (tickMinutes[tickMinutes.length - 1] !== CHART_WINDOW_MINUTES - 1) {
      tickMinutes.push(CHART_WINDOW_MINUTES - 1);
    }
    for (const minute of tickMinutes) {
      const x = xAt(minute);
      const anchor =
        minute === 0 ? "start" : minute === CHART_WINDOW_MINUTES - 1 ? "end" : "middle";
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

  const renderStats = () => {
    if (!statsRow) return;
    statsRow.replaceChildren();
    if (!state.running && state.messageCount === 0) {
      statsRow.hidden = true;
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
      ["Monitor", state.running ? "Polling" : "Stopped"],
    ];
    for (const [label, value] of items) {
      const chip = createElement("div", "stat-chip");
      chip.append(
        createElement("span", "stat-chip__label", label),
        createElement("span", "stat-chip__value", value),
      );
      statsRow.append(chip);
    }
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
        copy.append(
          createElement(
            "h3",
            "workspace-card__title",
            lookupName(state.workspaceById, workspaceId, "Workspace"),
          ),
          createElement(
            "p",
            "workspace-card__product",
            latest.deviceId
              ? deviceProduct(latest.deviceId) || "RoomOS device"
              : "Device pending",
          ),
        );
        card.append(copy);

        const pills = createElement("div", "status-pills");
        const statuses = latest.statuses || Object.create(null);
        let shown = 0;
        for (const key of HIGHLIGHT_STATUS_KEYS) {
          if (statuses[key] === undefined) continue;
          const pill = createElement("span", "status-pill");
          pill.append(
            createElement("span", "status-pill__key", key.split(".").slice(-2).join(".")),
            createElement("span", "status-pill__value", String(statuses[key])),
          );
          pills.append(pill);
          shown += 1;
        }
        const extra = Object.keys(statuses).length - shown;
        if (extra > 0) {
          pills.append(
            createElement("span", "status-pill status-pill--muted", `+${extra} more`),
          );
        }
        if (pills.childNodes.length) {
          card.append(pills);
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
      copy.append(
        createElement("strong", "feed-item__workspace", item.workspaceName),
        createElement(
          "p",
          "feed-item__product",
          item.deviceProduct || "RoomOS device",
        ),
      );
      const toggle = createElement(
        "button",
        "icon-button secondary-button feed-item__raw-toggle",
      );
      toggle.type = "button";
      toggle.setAttribute(
        "aria-label",
        item.rawOpen ? "Show formatted notification" : "Show raw notification",
      );
      toggle.setAttribute("title", item.rawOpen ? "Show formatted" : "Show raw");
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
        ? createElement("pre", "feed-item__body", formatJson(omitFalseFullSync(item.raw)))
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

  const createKvList = (record, extraRowClass = "") => {
    const list = createElement("div", "feed-kv");
    for (const [key, value] of Object.entries(record)) {
      const row = createElement(
        "div",
        extraRowClass ? `feed-kv__row ${extraRowClass}` : "feed-kv__row",
      );
      row.append(createElement("span", "feed-kv__key", key));
      if (value !== undefined) {
        row.append(
          createElement("span", "feed-kv__value", formatFeedValue(value)),
        );
      }
      list.append(row);
    }
    return list;
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
      const entries = Object.entries(value).filter(([key]) => key !== "timestamp");
      if (entries.length) {
        block.append(createKvList(Object.fromEntries(entries)));
      }
    } else if (value !== undefined && value !== null && value !== "") {
      block.append(createKvList({ Value: value }));
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
        createFeedSection("Updated", createKvList(item.updated), "feed-section--updated"),
      );
    }
    if (Array.isArray(item.removed) && item.removed.length) {
      content.append(
        createFeedSection(
          "Removed",
          createKvList(
            Object.fromEntries(item.removed.map((key) => [String(key), undefined])),
            "feed-kv__row--removed",
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
      content.append(createFeedSection("Details", createKvList(item.details)));
    }
    if (!content.childNodes.length) {
      content.append(
        createElement(
          "pre",
          "feed-item__body",
          formatJson(omitFalseFullSync(item.raw)),
        ),
      );
    }
    return content;
  };

  const eventValue = (event) =>
    event?.value && typeof event.value === "object" ? event.value : {};

  const isDemoPanelClick = (event) =>
    event?.key === "UserInterface.Extensions.Panel.Clicked" &&
    String(eventValue(event).PanelId || "") === DEMO_PANEL_ID;

  const sendPanelAlert = (deviceId, value) => {
    if (previewMode || !state.tokenStore || !state.webexapisBaseUrl || !deviceId) {
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
        await executeXapiCommand({
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
    workspaceName: lookupName(state.workspaceById, message.workspaceId, "Workspace"),
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
    const workspaceName = lookupName(state.workspaceById, device.workspaceId, "Workspace");
    try {
      const accessToken = await state.tokenStore.getAccessToken(
        state.controller?.signal,
      );
      await executeXapiCommand({
        baseUrl: state.webexapisBaseUrl,
        accessToken,
        command: "UserInterface.Extensions.Panel.Save",
        deviceId: device.id,
        arguments: { PanelId: DEMO_PANEL_ID },
        body: DEMO_PANEL_XML,
        signal: state.controller?.signal,
      });
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
    }
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
      const saveButton = createElement(
        "button",
        "secondary-button",
        "Save demo panel",
      );
      saveButton.type = "button";
      saveButton.addEventListener("click", () => {
        void saveDemoPanel(device);
      });
      row.append(copy, saveButton);
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
    stopChartTimer();
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
    startChartTimer();
    syncPayloadToggle();
    syncButtons();
    renderDecoded();
    renderWorkspaces();
    renderFeed();
    renderStats();
    renderMessageChart();
    renderDeviceSearch();
  };

  const runMonitor = async () => {
    const { clientId, clientSecret, activationCode } = readCredentials();
    if (!clientId || !clientSecret || !activationCode) {
      setStatusEl(monitorStatus, "Enter the Client ID, Client Secret, and Activation Code.", "error");
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

    state.controller = new AbortController();
    const { signal } = state.controller;
    state.running = true;
    state.tokenStore = null;
    state.webexapisBaseUrl = "";
    state.workspaceById = Object.create(null);
    state.deviceById = Object.create(null);
    state.latestByWorkspace = Object.create(null);
    state.feed = [];
    state.messageCount = 0;
    state.messageTimes = [];
    state.lastPollAt = null;
    beginMonitoringUi();

    try {
      setStatusEl(monitorStatus, "Decoding activation code…");
      const payload = decodeActivationJwt(activationCode);
      state.orgName = payload.orgName || "";
      state.webexapisBaseUrl = payload.webexapisBaseUrl;
      renderDecoded();
      renderStats();

      setStatusEl(monitorStatus, "Requesting an access token…");
      const tokens = await createAccessToken({
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

      setStatusEl(monitorStatus, "Loading workspaces…");
      try {
        const accessToken = await tokenStore.getAccessToken(signal);
        const [workspaces, devices] = await Promise.all([
          listWorkspaces(payload.webexapisBaseUrl, accessToken, signal),
          listDevices(payload.webexapisBaseUrl, accessToken, signal).catch(() => []),
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

      setStatusEl(monitorStatus, "Activating the integration and enabling long polling…");
      const accessToken = await tokenStore.getAccessToken(signal);
      const activated = await activateQueue(payload.appUrl, accessToken, signal);
      let pollUrl = activated.pollUrl;

      setStatusEl(
        monitorStatus,
        "Integration activated. Listening for device status and events…",
        "success",
      );

      while (state.running && !signal.aborted) {
        try {
          const pollToken = await tokenStore.getAccessToken(signal);
          const result = await pollQueue(pollUrl, pollToken, signal);
          pollUrl = result.pollUrl;
          state.lastPollAt = new Date();
          for (const message of result.messages) {
            applyMessage(message);
          }
          if (result.messages.length) {
            renderWorkspaces();
            renderFeed();
          }
          renderStats();
          renderMessageChart();
        } catch (error) {
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
    document.querySelector("#monitor .step-actions")?.setAttribute("hidden", "");
    document.querySelector("#monitor > p")?.setAttribute("hidden", "");

    indexRecords(PREVIEW_WORKSPACES, state.workspaceById);
    indexRecords(PREVIEW_DEVICES, state.deviceById);
    state.orgName = PREVIEW_ORG_NAME;
    state.running = true;
    state.lastPollAt = new Date(PREVIEW_NOW);
    setCredentialsVisible(false);
    setPanelInstallVisible(true);
    setMessageChartVisible(true);
    state.payloadOpen = false;
    if (decodedBox) {
      decodedBox.hidden = true;
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
  }

  syncPayloadToggle();
  syncButtons();
  renderWorkspaces();
  renderFeed();
  renderStats();
  renderDeviceSearch();
})();
