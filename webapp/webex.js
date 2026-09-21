/*
 * Webex Workspace Integration helpers: JWT decode, token exchange,
 * activation, workspace lookup, and long-poll queue reads.
 */

const MAX_LIST_PAGES = 20;
const LIST_PAGE_SIZE = 100;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_ERROR_BODY = 280;

const WEBEX_API_HOSTS = new Set([
  "webexapis.com",
  "api.ciscospark.com",
  "webexapis-usgov.webex.com",
]);

const WEBEX_XAPI_HOSTS = new Set(["xapi.gov.ciscospark.com"]);

function isAllowedHost(hostname, { allowXapi } = {}) {
  const host = String(hostname || "").toLowerCase();
  if (WEBEX_API_HOSTS.has(host)) {
    return true;
  }
  if (allowXapi && WEBEX_XAPI_HOSTS.has(host)) {
    return true;
  }
  if (allowXapi && (host === "wbx2.com" || host.endsWith(".wbx2.com"))) {
    return (
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.wbx2\.com$/.test(host) ||
      host === "wbx2.com"
    );
  }
  return false;
}

function isLocalDevHost() {
  const host = globalThis.location?.hostname;
  return host === "localhost" || host === "127.0.0.1";
}

function proxiedRequestUrl(targetUrl) {
  if (!isLocalDevHost()) {
    return targetUrl;
  }
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function assertAllowedWebexUrl(raw, { allowXapi = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The activation payload contained an invalid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS Webex URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new Error("Webex URLs must not include credentials.");
  }
  if (!isAllowedHost(url.hostname, { allowXapi })) {
    throw new Error("The activation payload pointed at an unexpected host.");
  }
  return url.toString();
}

function padBase64(value) {
  const remainder = value.length % 4;
  return remainder === 0 ? value : value + "=".repeat(4 - remainder);
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padBase64(normalized));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function isJwtShape(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
    String(value || "").trim(),
  );
}

export function decodeActivationJwt(token) {
  const raw = String(token || "").trim();
  if (!isJwtShape(raw)) {
    throw new Error(
      "Activation code must be a JWT with three dot-separated parts.",
    );
  }
  const [, payloadPart] = raw.split(".");
  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(payloadPart));
  } catch {
    throw new Error("The activation code payload could not be decoded.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("The activation code payload is empty.");
  }

  const oauthUrl = assertAllowedWebexUrl(payload.oauthUrl);
  const appUrl = assertAllowedWebexUrl(payload.appUrl, { allowXapi: true });
  const webexapisBaseUrl = assertAllowedWebexUrl(
    payload.webexapisBaseUrl || "https://webexapis.com/v1",
  );
  const refreshToken = String(payload.refreshToken || "").trim();
  if (!refreshToken) {
    throw new Error("The activation code does not include a refresh token.");
  }

  let xapiAccess = payload.xapiAccess;
  if (typeof xapiAccess === "string") {
    try {
      xapiAccess = JSON.parse(xapiAccess);
    } catch {
      xapiAccess = null;
    }
  }

  return {
    ...payload,
    oauthUrl,
    appUrl,
    webexapisBaseUrl,
    refreshToken,
    xapiAccess,
  };
}

export function redactActivationPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const redacted = { ...payload };
  if (redacted.refreshToken) {
    redacted.refreshToken = "[redacted]";
  }
  return redacted;
}

function describeHttpError(status, bodyText) {
  if (status === 401 || status === 403) {
    return "Webex rejected the credentials. Check the client ID, client secret, and activation code.";
  }
  if (status === 404 || status === 410) {
    return "The integration was not found. Confirm it is still present in Control Hub.";
  }
  if (status >= 500) {
    return "Webex returned a server error. Try again in a moment.";
  }
  const snippet = String(bodyText || "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_ERROR_BODY);
  return snippet || `Request failed with HTTP ${status}.`;
}

export function describeNetworkError(error) {
  if (error && error.name === "AbortError") {
    return "The request was cancelled.";
  }
  if (error && error.name === "TypeError") {
    if (isLocalDevHost()) {
      return "The browser blocked this Webex request. Start the app with npm run devProxy so API calls are proxied.";
    }
    return "The browser blocked this Webex request. Workspace Integration APIs often reject cross-origin calls from GitHub Pages.";
  }
  return error?.message || "The request failed.";
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Redacted request/response snapshots for the "How this works" panels, keyed
// by a caller-supplied logKey. Demo-only: not used for retries or auth.
const requestLog = new Map();

export function getRequestLog(logKey) {
  return requestLog.get(logKey) || null;
}

export function clearRequestLog() {
  requestLog.clear();
}

// Lets the README screenshot fixture (preview.js data, no network access)
// populate the "Show requests" panels with a realistic example exchange.
export function primeRequestLogForPreview(logKey, entry) {
  requestLog.set(logKey, entry);
}

function redactHeaders(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key] = /^authorization$/i.test(key) ? "Bearer ***" : value;
  });
  return out;
}

function redactRequestBody(logKey, body) {
  if (body instanceof URLSearchParams) {
    const clone = new URLSearchParams(body);
    if (logKey === "token") {
      if (clone.has("client_secret")) clone.set("client_secret", "***");
      if (clone.has("refresh_token")) clone.set("refresh_token", "***");
    }
    return Object.fromEntries(clone.entries());
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body ?? null;
}

function redactResponseBody(logKey, body) {
  if (logKey === "token" && body && typeof body === "object") {
    const clone = { ...body };
    if (clone.access_token) clone.access_token = "[redacted]";
    if (clone.refresh_token) clone.refresh_token = "[redacted]";
    return clone;
  }
  return body;
}

async function requestJson(url, options = {}) {
  const { allowXapi = false, logKey = null, ...fetchOptions } = options;
  const safeUrl = assertAllowedWebexUrl(url, { allowXapi });
  const headers = new Headers(fetchOptions.headers || {});
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  headers.set("Cache-Control", "no-store");

  const snapshot = logKey
    ? {
        method: fetchOptions.method || "GET",
        url: safeUrl,
        headers: redactHeaders(headers),
        body: redactRequestBody(logKey, fetchOptions.body),
      }
    : null;

  let response;
  try {
    response = await fetch(proxiedRequestUrl(safeUrl), {
      ...fetchOptions,
      headers,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (snapshot) {
      requestLog.set(logKey, {
        ...snapshot,
        error: describeNetworkError(error),
      });
    }
    throw new Error(describeNetworkError(error), { cause: error });
  }

  const body = await readJson(response);
  if (snapshot) {
    requestLog.set(logKey, {
      ...snapshot,
      status: response.status,
      responseBody: redactResponseBody(logKey, body),
      receivedAt: Date.now(),
    });
  }
  if (!response.ok) {
    throw new Error(
      describeHttpError(response.status, body.message || body.raw),
    );
  }
  return { body, response };
}

export async function createAccessToken({
  oauthUrl,
  clientId,
  clientSecret,
  refreshToken,
  signal,
}) {
  const safeOauthUrl = assertAllowedWebexUrl(oauthUrl);
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const { body } = await requestJson(safeOauthUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
    signal,
    logKey: "token",
  });

  const accessToken = String(body.access_token || "").trim();
  if (!accessToken) {
    throw new Error("Webex did not return an access token.");
  }

  const expiresIn = Number(body.expires_in);
  return {
    accessToken,
    refreshToken: String(body.refresh_token || refreshToken).trim(),
    expiresAt:
      Date.now() +
      (Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1000
        : 50 * 60 * 1000),
  };
}

export function createTokenStore(initialTokens, credentials) {
  let tokens = { ...initialTokens };

  return {
    peek() {
      return tokens;
    },
    async getAccessToken(signal) {
      if (Date.now() < tokens.expiresAt - TOKEN_REFRESH_SKEW_MS) {
        return tokens.accessToken;
      }
      tokens = await createAccessToken({
        oauthUrl: credentials.oauthUrl,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        refreshToken: tokens.refreshToken,
        signal,
      });
      return tokens.accessToken;
    },
  };
}

function parseNextLink(linkHeader) {
  if (!linkHeader) {
    return "";
  }
  const parts = String(linkHeader).split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

async function listCollection(
  baseUrl,
  path,
  accessToken,
  signal,
  extraParams = {},
  logKey = null,
) {
  const items = [];
  const query = new URLSearchParams({ max: String(LIST_PAGE_SIZE) });
  for (const [key, value] of Object.entries(extraParams)) {
    const text = String(value ?? "").trim();
    if (text) {
      query.set(key, text);
    }
  }
  let nextUrl = `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}?${query}`;

  for (let page = 0; page < MAX_LIST_PAGES && nextUrl; page += 1) {
    const { body, response } = await requestJson(nextUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
      logKey: page === 0 ? logKey : null,
    });
    if (Array.isArray(body.items)) {
      items.push(...body.items);
    }
    const next = parseNextLink(response.headers.get("Link"));
    nextUrl = next ? assertAllowedWebexUrl(next) : "";
  }

  return items;
}

export async function listWorkspaces(baseUrl, accessToken, signal) {
  return listCollection(
    baseUrl,
    "workspaces",
    accessToken,
    signal,
    {},
    "workspaces",
  );
}

export async function listDevices(baseUrl, accessToken, signal) {
  return listCollection(
    baseUrl,
    "devices",
    accessToken,
    signal,
    { type: "roomdesk", capability: "xapi" },
    "devices",
  );
}

export async function activateQueue(appUrl, accessToken, signal) {
  const { body } = await requestJson(appUrl, {
    method: "PATCH",
    allowXapi: true,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provisioningState: "completed",
      queue: {
        state: "enabled",
      },
    }),
    signal,
    logKey: "activate",
  });

  const pollUrl = body?.queue?.pollUrl;
  if (!pollUrl) {
    throw new Error(
      "Activation succeeded, but Webex did not return a queue poll URL.",
    );
  }
  return {
    pollUrl: assertAllowedWebexUrl(pollUrl, { allowXapi: true }),
    details: body,
  };
}

const ALLOWED_XAPI_COMMANDS = new Set([
  "UserInterface.Extensions.List",
  "UserInterface.Extensions.Panel.Save",
  "UserInterface.Extensions.Panel.Clicked",
  "UserInterface.Extensions.Panel.Remove",
  "UserInterface.Message.Alert.Display",
]);

const XAPI_COMMAND_LOG_KEYS = {
  "UserInterface.Extensions.Panel.Save": "panelSave",
  "UserInterface.Extensions.Panel.Clicked": "panelClicked",
  "UserInterface.Extensions.Panel.Remove": "panelRemove",
};

export async function executeXapiCommand({
  baseUrl,
  accessToken,
  command,
  deviceId,
  arguments: args,
  body,
  signal,
}) {
  if (!ALLOWED_XAPI_COMMANDS.has(command)) {
    throw new Error("Unsupported xAPI command.");
  }
  const device = String(deviceId || "").trim();
  if (!device) {
    throw new Error("A device ID is required.");
  }
  const url = `${String(baseUrl).replace(/\/$/, "")}/xapi/command/${command}`;
  const payload = {
    deviceId: device,
    arguments: args && typeof args === "object" ? args : {},
  };
  if (body !== undefined && body !== "") {
    payload.body = body;
  }
  return requestJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
    logKey: XAPI_COMMAND_LOG_KEYS[command] || null,
  });
}

export async function pollQueue(pollUrl, accessToken, signal) {
  const { body } = await requestJson(pollUrl, {
    method: "GET",
    allowXapi: true,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
    logKey: "poll",
  });

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const nextPollUrl = body?.queue?.pollUrl || body.pollUrl;
  return {
    messages,
    pollUrl: nextPollUrl
      ? assertAllowedWebexUrl(nextPollUrl, { allowXapi: true })
      : pollUrl,
  };
}

function shortId(value) {
  const text = String(value || "");
  return text.length <= 12 ? text || "unknown" : text.slice(-12);
}

export function lookupName(map, id, fallbackPrefix) {
  if (id && map[id]?.displayName) {
    return map[id].displayName;
  }
  return id ? `${fallbackPrefix} ${shortId(id)}` : fallbackPrefix;
}
