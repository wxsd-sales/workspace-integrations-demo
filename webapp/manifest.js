/*
 * Workspace Integration manifest builder. Kept free of DOM access so the
 * same helpers can be imported by the UI and by lightweight checks.
 */

const SUPPORTED_STATUSES = [
  { path: "RoomAnalytics.*", access: "required" },
  {
    path: "Peripherals.ConnectedDevice[*].RoomAnalytics.*",
    access: "required",
  },
  { path: "Standby.State", access: "required" },
  { path: "SystemUnit.State.NumberOfActiveCalls", access: "required" },
  { path: "SystemUnit.State.System", access: "required" },
  {
    path: "Conference.Presentation.LocalInstance[*].SendingMode",
    access: "required",
  },
  { path: "Bookings.Availability.Status", access: "required" },
  { path: "MicrosoftTeams.Calling.InCall", access: "required" },
  { path: "MicrosoftTeams.Pairing.Active", access: "required" },
  { path: "MicrosoftTeams.User.SignedIn", access: "required" },
];

const SUPPORTED_EVENTS = [
  { path: "Bookings.Start", access: "required" },
  { path: "Bookings.End", access: "required" },
  { path: "Bookings.ExtensionRequested", access: "required" },
  { path: "Bookings.Deleted", access: "required" },
  { path: "BootEvent", access: "required" },
  { path: "CallDisconnect", access: "required" },
  { path: "CallSuccessful", access: "required" },
  { path: "OutgoingCallIndication", access: "required" },
  { path: "UserInterface.Message.Prompt.Response", access: "required" },
  { path: "UserInterface.Message.Prompt.Cleared", access: "required" },
  { path: "UserInterface.Message.Rating.Response", access: "required" },
  { path: "UserInterface.Message.Rating.Cleared", access: "required" },
  { path: "UserInterface.Message.TextInput.Response", access: "required" },
  { path: "UserInterface.Message.TextInput.Clear", access: "required" },
  { path: "UserInterface.Extensions.Panel.Clicked", access: "required" },
  { path: "UserInterface.Extensions.Panel.Close", access: "required" },
  { path: "UserInterface.Extensions.Widget.Action", access: "required" },
  { path: "UserInterface.Assistant.Notification", access: "required" },
  { path: "UserInterface.WebView.Display", access: "required" },
  { path: "UserInterface.WebView.Cleared", access: "required" },
];

const SUPPORTED_COMMANDS = [
  { path: "UserInterface.Extensions.Icon.List", access: "required" },
  { path: "UserInterface.Extensions.List", access: "required" },
  { path: "UserInterface.Extensions.Panel.Clicked", access: "required" },
  { path: "UserInterface.Extensions.Panel.Remove", access: "required" },
  { path: "UserInterface.Extensions.Panel.Save", access: "required" },
  { path: "UserInterface.Message.Alert.Display", access: "required" },
  { path: "UserInterface.Message.Prompt.Display", access: "required" },
  { path: "UserInterface.Message.Rating.Display", access: "required" },
  { path: "UserInterface.Message.TextInput.Display", access: "required" },
];

function trimOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createManifestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/**
 * Build a new org-private Workspace Integration manifest.
 * A fresh UUID is generated on every call so each download is a new integration.
 */
export function buildManifest(values = {}) {
  const displayName =
    trimOrEmpty(values.displayName) || "Workspace Integrations Demo";
  const vendor = trimOrEmpty(values.vendor) || "WXSD";
  const email = trimOrEmpty(values.email) || "wxsd@external.cisco.com";
  const description =
    trimOrEmpty(values.description) ||
    "Monitors Webex workspace devices and displays live xStatus and xEvent notifications.";
  const descriptionUrl = trimOrEmpty(values.descriptionUrl);
  const activationUrl = trimOrEmpty(values.activationUrl);

  const manifest = {
    id: trimOrEmpty(values.id) || createManifestId(),
    manifestVersion: 1,
    displayName,
    vendor,
    email,
    description,
    availability: "org_private",
    apiAccess: [
      {
        scope: "spark-admin:devices_read",
        access: "required",
        role: "id_readonly_admin",
      },
      {
        scope: "spark-admin:workspaces_read",
        access: "required",
        role: "id_readonly_admin",
      },
      {
        scope: "spark:xapi_statuses",
        access: "required",
      },
      {
        scope: "spark:xapi_commands",
        access: "required",
      },
    ],
    xapiAccess: {
      status: SUPPORTED_STATUSES,
      commands: SUPPORTED_COMMANDS,
      events: SUPPORTED_EVENTS,
    },
    provisioning: {
      type: "manual",
    },
  };

  if (descriptionUrl) {
    manifest.descriptionUrl = descriptionUrl;
  }
  if (activationUrl) {
    manifest.provisioning.url = activationUrl;
  }

  return manifest;
}

export function stringifyManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function manifestFileName(manifest) {
  const base = String(manifest?.displayName || "workspace-integration")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "workspace-integration"}-manifest.json`;
}
