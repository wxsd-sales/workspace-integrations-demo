/*
 * Deterministic fixture data for README screenshots. Values are labelled
 * demo/example only and do not grant access to any Webex org.
 */

const PREVIEW_MODES = new Set(["create", "setup", "activate", "monitor"]);

export const PREVIEW_MANIFEST_ID = "00000000-0000-4000-8000-000000000001";
export const PREVIEW_ORG_NAME = "COE";

export const PREVIEW_CLIENT_ID = "C0demo00000000000000000000000000";
export const PREVIEW_CLIENT_SECRET = "demo-client-secret-example";

function encodeBase64Url(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function buildPreviewJwt() {
  const header = encodeBase64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      oauthUrl: "https://webexapis.com/v1/access_token",
      orgName: PREVIEW_ORG_NAME,
      appUrl:
        "https://xapi-r.wbx2.com/xapi/api/organizations/00000000-0000-4000-8000-000000000000/apps/00000000-0000-4000-8000-000000000001",
      webexapisBaseUrl: "https://webexapis.com/v1",
      refreshToken: "demo-refresh-token-example",
      expiryTime: "2099-01-01T00:00:00.000Z",
      action: "provision",
      scopes: "spark-admin:workspaces_read,spark:xapi_statuses,spark:xapi_commands",
      region: "us-west-2_r",
      appId: PREVIEW_MANIFEST_ID,
      xapiAccess: JSON.stringify({
        commands: [
          "UserInterface.Extensions.Panel.Save",
          "UserInterface.Message.Alert.Display",
        ],
        statuses: ["RoomAnalytics.*", "Standby.State"],
        events: ["BootEvent", "CallSuccessful", "UserInterface.Extensions.Panel.Clicked"],
      }),
    }),
  );
  return `${header}.${payload}.demo-signature`;
}

export const PREVIEW_WORKSPACES = [
  { id: "workspace-focus", displayName: "Focus Room" },
  { id: "workspace-board", displayName: "Board Room" },
  { id: "workspace-huddle", displayName: "Huddle Space" },
];

export const PREVIEW_DEVICES = [
  {
    id: "device-kit-pro",
    displayName: "Room Kit Pro",
    product: "Cisco Webex Room Kit Pro",
    workspaceId: "workspace-focus",
  },
  {
    id: "device-board-pro",
    displayName: "Board Pro 55",
    product: "Cisco Webex Board Pro 55",
    workspaceId: "workspace-board",
  },
  {
    id: "device-desk-pro",
    displayName: "Desk Pro",
    product: "Cisco Webex Desk Pro",
    workspaceId: "workspace-huddle",
  },
];

export const PREVIEW_NOW = "2026-09-07T14:06:00.000Z";

const PREVIEW_DEVICE_REFS = [
  ["workspace-focus", "device-kit-pro"],
  ["workspace-board", "device-board-pro"],
  ["workspace-huddle", "device-desk-pro"],
];

function previewTimestamp(minutesFromNow) {
  return new Date(Date.parse(PREVIEW_NOW) + minutesFromNow * 60_000).toISOString();
}

function previewStatusPing(minutesFromNow, index) {
  const [workspaceId, deviceId] = PREVIEW_DEVICE_REFS[index % PREVIEW_DEVICE_REFS.length];
  return {
    workspaceId,
    deviceId,
    timestamp: previewTimestamp(minutesFromNow),
    type: "status",
    isFullSync: false,
    changes: {
      updated: { "RoomAnalytics.PeopleCount.Current": 1 },
      removed: [],
    },
  };
}

const PREVIEW_CHART_CURVE = [
  [-54, 1],
  [-53, 2],
  [-52, 3],
  [-51, 5],
  [-50, 8],
  [-49, 9],
  [-48, 6],
  [-47, 3],
  [-46, 1],
  [-18, 1],
  [-16, 2],
  [-14, 3],
  [-12, 2],
  [-10, 1],
  [-8, 2],
];

const PREVIEW_CHART_TRAFFIC = PREVIEW_CHART_CURVE.flatMap(([offset, count], row) =>
  Array.from({ length: count }, (_, index) => previewStatusPing(offset, row + index)),
);

export const PREVIEW_CHART_TIMES = PREVIEW_CHART_TRAFFIC.map(
  (message) => message.timestamp,
);

export const PREVIEW_MESSAGES = [
  {
    workspaceId: "workspace-board",
    deviceId: "device-board-pro",
    timestamp: "2026-09-07T14:02:05.000Z",
    type: "events",
    events: [
      {
        key: "UserInterface.Extensions.Widget.Action",
        value: { WidgetId: "join-meeting", Type: "clicked" },
        timestamp: "2026-09-07T14:02:05.000Z",
      },
    ],
  },
  {
    workspaceId: "workspace-huddle",
    deviceId: "device-desk-pro",
    timestamp: "2026-09-07T14:03:21.000Z",
    type: "status",
    isFullSync: false,
    changes: {
      updated: {
        "RoomAnalytics.PeopleCount.Current": 0,
        "RoomAnalytics.PeoplePresence": "No",
        "Standby.State": "Halfwake",
        "SystemUnit.State.NumberOfActiveCalls": 0,
      },
      removed: [
        "Bookings.Current.Id",
        "Bookings.Current.Organizer.Name",
      ],
    },
  },
  {
    workspaceId: "workspace-board",
    deviceId: "device-board-pro",
    timestamp: "2026-09-07T14:04:48.000Z",
    type: "status",
    isFullSync: true,
    changes: {
      updated: {
        "RoomAnalytics.PeopleCount.Current": 8,
        "RoomAnalytics.PeoplePresence": "Yes",
        "Standby.State": "Off",
        "Bookings.Availability.Status": "Booked",
        "RoomAnalytics.RelativeHumidity": 41,
      },
      removed: [],
    },
  },
  {
    workspaceId: "workspace-focus",
    deviceId: "device-kit-pro",
    timestamp: "2026-09-07T14:05:18.000Z",
    type: "events",
    events: [
      {
        key: "CallSuccessful",
        value: { CallId: 14, Protocol: "Spark" },
        timestamp: "2026-09-07T14:05:18.000Z",
      },
    ],
  },
  {
    workspaceId: "workspace-focus",
    deviceId: "device-kit-pro",
    timestamp: "2026-09-07T14:05:50.000Z",
    type: "status",
    isFullSync: true,
    changes: {
      updated: {
        "RoomAnalytics.PeopleCount.Current": 3,
        "RoomAnalytics.PeoplePresence": "Yes",
        "Standby.State": "Off",
        "SystemUnit.State.NumberOfActiveCalls": 1,
        "RoomAnalytics.AmbientTemperature": 22.5,
      },
      removed: [
        "Bookings.Current.Id",
        "Bookings.Current.Organizer.Name",
      ],
    },
  },
  {
    workspaceId: "workspace-board",
    deviceId: "device-board-pro",
    timestamp: "2026-09-07T14:06:02.000Z",
    type: "events",
    events: [
      {
        key: "UserInterface.Extensions.Panel.Clicked",
        value: {
          PanelId: "workspace-integrations-demo",
          Target: "OSD",
        },
        timestamp: "2026-09-07T14:06:02.000Z",
      },
    ],
  },
];

export function readPreviewMode() {
  try {
    const preview = new URLSearchParams(window.location.search).get("preview");
    return PREVIEW_MODES.has(preview) ? preview : "";
  } catch {
    return "";
  }
}
