/*
 * Simulated Webex integration for "Demo Integration" mode. Mirrors the
 * shape of the real functions in webex.js (same inputs/outputs) so app.js
 * can swap between the real client and this one without branching its own
 * activation/monitoring logic.
 */

import {
  PREVIEW_DEVICES,
  PREVIEW_WORKSPACES,
  PREVIEW_APP_URL,
} from "./preview.js";

const DEMO_TOKEN_LIFETIME_SECONDS = 18 * 60 * 60; // matches Webex's real machine account access token lifetime of 18 hours
const DEMO_POLL_MIN_MS = 3000;
const DEMO_POLL_MAX_MS = 6000;
const DEMO_MAX_MESSAGES_PER_POLL = 10;
const DEMO_POLL_URL = `${PREVIEW_APP_URL}/queue`;
const DEMO_WEBEXAPIS_BASE_URL = "https://webexapis.com/v1";

const DEMO_REQUEST_HEADERS = {
  Authorization: "Bearer ***",
  Accept: "application/json",
  "Cache-Control": "no-store",
};

const XAPI_COMMAND_LOG_KEYS = {
  "UserInterface.Extensions.Panel.Save": "panelSave",
  "UserInterface.Extensions.Panel.Clicked": "panelClicked",
  "UserInterface.Extensions.Panel.Remove": "panelRemove",
};

function trimTrailingSlash(url) {
  return String(url || DEMO_WEBEXAPIS_BASE_URL).replace(/\/$/, "");
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

const DEMO_STATUS_TEMPLATES = [
  () => ({ "RoomAnalytics.PeopleCount.Current": randomInt(-1, 8) }),
  () => ({
    "RoomAnalytics.PeoplePresence": Math.random() > 0.3 ? "Yes" : "No",
  }),
  () => ({ "Standby.State": Math.random() > 0.5 ? "Off" : "Halfwake" }),
  () => ({ "SystemUnit.State.NumberOfActiveCalls": randomInt(0, 1) }),
  () => ({
    "RoomAnalytics.AmbientTemperature": Number(
      (20 + Math.random() * 6).toFixed(1),
    ),
  }),
  () => ({ "RoomAnalytics.RelativeHumidity": randomInt(30, 55) }),
];

const DEMO_EVENT_TEMPLATES = [
  {
    key: "CallSuccessful",
    value: () => ({ CallId: randomInt(1, 999), Protocol: "Spark" }),
  },
  { key: "BootEvent", value: () => ({}) },
  {
    key: "UserInterface.Extensions.Widget.Action",
    value: () => ({ WidgetId: "join-meeting", Type: "clicked" }),
  },
];

function pickOne(list) {
  return list[randomInt(0, list.length - 1)];
}

function buildDemoMessage(device) {
  const timestamp = new Date().toISOString();
  if (Math.random() > 0.35) {
    return {
      workspaceId: device.workspaceId,
      deviceId: device.id,
      timestamp,
      type: "status",
      isFullSync: false,
      changes: { updated: pickOne(DEMO_STATUS_TEMPLATES)(), removed: [] },
    };
  }
  const template = pickOne(DEMO_EVENT_TEMPLATES);
  return {
    workspaceId: device.workspaceId,
    deviceId: device.id,
    timestamp,
    type: "events",
    events: [{ key: template.key, value: template.value(), timestamp }],
  };
}

// A "Trigger panel clicked" click doesn't wait for a real device to react,
// so it queues the resulting Panel.Clicked event here and the next
// pollQueue() cycle delivers it, the same way a real long poll would.
function buildDemoPanelClickMessage(device, panelId) {
  const timestamp = new Date().toISOString();
  return {
    workspaceId: device.workspaceId,
    deviceId: device.id,
    timestamp,
    type: "events",
    events: [
      {
        key: "UserInterface.Extensions.Panel.Clicked",
        value: { PanelId: panelId, Target: "OSD" },
        timestamp,
      },
    ],
  };
}

/**
 * Creates one simulated integration session: a fake access token, the
 * shared demo workspaces/devices, a long-poll loop that manufactures 0-10
 * messages per cycle, and enough of the Cloud xAPI panel commands to make
 * "UI Extensions Demo" work against the demo devices.
 */
export function createDemoIntegration() {
  const installedPanels = new Set();
  const pendingEvents = [];
  const requestLog = new Map();

  const record = (logKey, entry) => {
    requestLog.set(logKey, { ...entry, receivedAt: Date.now() });
  };

  return {
    getRequestLog(logKey) {
      return requestLog.get(logKey) || null;
    },

    async createAccessToken({ oauthUrl, clientId, refreshToken }) {
      const responseBody = {
        access_token: "[redacted]",
        refresh_token: "[redacted]",
        expires_in: DEMO_TOKEN_LIFETIME_SECONDS,
      };
      record("token", {
        method: "POST",
        url: oauthUrl || `${DEMO_WEBEXAPIS_BASE_URL}/access_token`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "Cache-Control": "no-store",
        },
        body: {
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: "***",
          refresh_token: "***",
        },
        status: 200,
        responseBody,
      });
      return {
        accessToken: "demo-access-token",
        refreshToken: refreshToken || "demo-refresh-token-example",
        expiresAt: Date.now() + DEMO_TOKEN_LIFETIME_SECONDS * 1000,
      };
    },

    async listWorkspaces(baseUrl) {
      record("workspaces", {
        method: "GET",
        url: `${trimTrailingSlash(baseUrl)}/workspaces?max=100`,
        headers: DEMO_REQUEST_HEADERS,
        status: 200,
        responseBody: { items: PREVIEW_WORKSPACES },
      });
      return PREVIEW_WORKSPACES;
    },

    async listDevices(baseUrl) {
      record("devices", {
        method: "GET",
        url: `${trimTrailingSlash(baseUrl)}/devices?max=100&type=roomdesk&capability=xapi`,
        headers: DEMO_REQUEST_HEADERS,
        status: 200,
        responseBody: { items: PREVIEW_DEVICES },
      });
      return PREVIEW_DEVICES;
    },

    async activateQueue(appUrl) {
      const responseBody = {
        provisioningState: "completed",
        queue: { state: "enabled", pollUrl: DEMO_POLL_URL },
      };
      record("activate", {
        method: "PATCH",
        url: appUrl || "demo://apps/demo-integration",
        headers: {
          Authorization: "Bearer ***",
          "Content-Type": "application/json",
          Accept: "application/json",
          "Cache-Control": "no-store",
        },
        body: { provisioningState: "completed", queue: { state: "enabled" } },
        status: 200,
        responseBody,
      });
      return { pollUrl: DEMO_POLL_URL, details: responseBody };
    },

    async pollQueue(pollUrl, _accessToken, signal) {
      await delay(randomInt(DEMO_POLL_MIN_MS, DEMO_POLL_MAX_MS), signal);
      const triggered = pendingEvents.splice(0, pendingEvents.length);
      const count = randomInt(0, DEMO_MAX_MESSAGES_PER_POLL);
      const randomMessages = Array.from({ length: count }, () =>
        buildDemoMessage(pickOne(PREVIEW_DEVICES)),
      );
      const messages = [...triggered, ...randomMessages];
      const nextPollUrl = pollUrl || DEMO_POLL_URL;
      record("poll", {
        method: "GET",
        url: nextPollUrl,
        headers: DEMO_REQUEST_HEADERS,
        status: 200,
        responseBody: { messages, queue: { pollUrl: nextPollUrl } },
      });
      return { messages, pollUrl: nextPollUrl };
    },

    async executeXapiCommand({
      baseUrl,
      command,
      deviceId,
      arguments: args,
      body,
    }) {
      if (command === "UserInterface.Extensions.List") {
        const installed = installedPanels.has(deviceId);
        return {
          body: {
            deviceId,
            result: {
              Extensions: installed
                ? {
                    Panel: [
                      {
                        ActivityType: "Custom",
                        Icon: "Lightbulb",
                        Location: "HomeScreen",
                        Name: "Workspace Integration Demo",
                        Order: 1,
                        Origin: "local",
                        PanelId: args?.PanelId || "workspace-integrations-demo",
                        Type: "Home",
                        Visibility: "Auto",
                        id: 9,
                      },
                    ],
                    Version: "1.11",
                  }
                : { Version: "1.11" },
            },
          },
        };
      }
      const panelActionLogKey = XAPI_COMMAND_LOG_KEYS[command];
      if (panelActionLogKey) {
        record(panelActionLogKey, {
          method: "POST",
          url: `${trimTrailingSlash(baseUrl)}/xapi/command/${command}`,
          headers: {
            Authorization: "Bearer ***",
            "Content-Type": "application/json",
            Accept: "application/json",
            "Cache-Control": "no-store",
          },
          body: {
            deviceId,
            arguments: args && typeof args === "object" ? args : {},
            ...(body !== undefined && body !== "" ? { body } : {}),
          },
          status: 200,
          responseBody: {},
        });
      }
      if (command === "UserInterface.Extensions.Panel.Save") {
        installedPanels.add(deviceId);
      } else if (command === "UserInterface.Extensions.Panel.Remove") {
        installedPanels.delete(deviceId);
      } else if (command === "UserInterface.Extensions.Panel.Clicked") {
        const device = PREVIEW_DEVICES.find(
          (candidate) => candidate.id === deviceId,
        );
        if (device) {
          pendingEvents.push(buildDemoPanelClickMessage(device, args?.PanelId));
        }
      }
      return { body: {} };
    },
  };
}
