const path = require("path");
const axios = require("axios");
const { logEvent } = require("./timingLogger.js");

// Amazon Selling Partner API — just the catalog search the "amazon"
// destination needs (config/targetSites.js). Called directly, not through the
// Webshare proxy: it's Amazon's authenticated API for our own developer
// account, not a site we're scraping, and rotating residential IPs on an
// account token buys nothing.
//
// ---------------------------------------------------------------------------
// Credentials, read in order from env vars, then config.json (gitignored —
// the same home as PROXY_* and SMTP_*):
//
//   AMAZON_SPAPI_CLIENT_ID      / "AMAZON_SPAPI_Client_Id"
//   AMAZON_SPAPI_CLIENT_SECRET  / "AMAZON_SPAPI_Client_Secret"
//   AMAZON_SPAPI_REFRESH_TOKEN  / "AMAZON_SPAPI_Refresh_Token"
//
// From those, an access token is fetched from Login with Amazon and renewed
// before it expires (LWA access tokens last one hour). For a quick test
// without them, a ready-made access token ("Atza|...") can be set as
// AMAZON_SPAPI_ACCESS_TOKEN / "AMAZON_SPAPI_Access_Token" — it stops working
// an hour after it was issued, so it is no substitute for the three above.
// ---------------------------------------------------------------------------
function loadFileConfig() {
  try {
    return require(path.join(__dirname, "..", "config.json"));
  } catch (err) {
    return {};
  }
}

const fileConfig = loadFileConfig();
const setting = (envName, fileName) => process.env[envName] || fileConfig[fileName] || "";

const CREDENTIALS = {
  clientId: setting("AMAZON_SPAPI_CLIENT_ID", "AMAZON_SPAPI_Client_Id"),
  clientSecret: setting("AMAZON_SPAPI_CLIENT_SECRET", "AMAZON_SPAPI_Client_Secret"),
  refreshToken: setting("AMAZON_SPAPI_REFRESH_TOKEN", "AMAZON_SPAPI_Refresh_Token"),
};
const STATIC_ACCESS_TOKEN = setting("AMAZON_SPAPI_ACCESS_TOKEN", "AMAZON_SPAPI_Access_Token");

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
// Renew this long before the stated expiry, so a token never lapses mid-call.
const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 4;

function canRefresh() {
  return Boolean(CREDENTIALS.clientId && CREDENTIALS.clientSecret && CREDENTIALS.refreshToken);
}

function hasCredentials() {
  return canRefresh() || Boolean(STATIC_ACCESS_TOKEN);
}

const tokenState = { value: null, expiresAt: 0, pending: null };

async function fetchAccessToken() {
  const response = await axios.post(
    LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: CREDENTIALS.refreshToken,
      client_id: CREDENTIALS.clientId,
      client_secret: CREDENTIALS.clientSecret,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    }
  );

  if (response.status !== 200 || !response.data?.access_token) {
    const reason = response.data?.error_description || response.data?.error || `HTTP ${response.status}`;
    throw new Error(`Amazon LWA token request failed: ${reason}`);
  }

  tokenState.value = response.data.access_token;
  tokenState.expiresAt = Date.now() + (Number(response.data.expires_in) || 3600) * 1000;
  return tokenState.value;
}

// Concurrent callers share one in-flight renewal.
async function getAccessToken({ forceRefresh = false } = {}) {
  if (!canRefresh()) {
    if (STATIC_ACCESS_TOKEN) return STATIC_ACCESS_TOKEN;
    throw new Error(
      "No Amazon SP-API credentials: set AMAZON_SPAPI_CLIENT_ID, AMAZON_SPAPI_CLIENT_SECRET and " +
        "AMAZON_SPAPI_REFRESH_TOKEN (env), or the AMAZON_SPAPI_* keys in config.json."
    );
  }

  const fresh = tokenState.value && Date.now() < tokenState.expiresAt - TOKEN_RENEW_MARGIN_MS;
  if (fresh && !forceRefresh) return tokenState.value;

  if (!tokenState.pending) {
    tokenState.pending = fetchAccessToken().finally(() => {
      tokenState.pending = null;
    });
  }
  return tokenState.pending;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeFailure(response) {
  const error = response.data?.errors?.[0];
  return error ? `${error.code}: ${error.message}${error.details ? ` (${error.details})` : ""}` : `HTTP ${response.status}`;
}

// GET with the SP-API retry posture: 429 and 5xx back off and retry; a 403
// renews the token once (when we can) and retries; any other 4xx fails at once.
async function spApiGet(host, apiPath, params) {
  let renewedAfter403 = false;

  for (let attempt = 1; ; attempt++) {
    const token = await getAccessToken();
    let response;
    try {
      response = await axios.get(`${host}${apiPath}`, {
        params,
        headers: { Accept: "application/json", "x-amz-access-token": token },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      logEvent(`  SP-API attempt ${attempt}/${MAX_ATTEMPTS} failed — ${err.code || err.message}`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    if (response.status === 200) return response.data;

    const reason = describeFailure(response);

    if (response.status === 403 && canRefresh() && !renewedAfter403) {
      renewedAfter403 = true;
      logEvent(`  SP-API 403 (${reason}) — renewing the access token`);
      await getAccessToken({ forceRefresh: true });
      continue;
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
      logEvent(`  SP-API attempt ${attempt}/${MAX_ATTEMPTS} failed — ${reason}`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    const hint =
      response.status === 403 && !canRefresh()
        ? " — the access token has probably expired; set the AMAZON_SPAPI_* refresh credentials"
        : "";
    throw new Error(`SP-API ${apiPath} returned ${reason}${hint}`);
  }
}

// searchCatalogItems (2022-04-01). `keywords` is a comma-delimited list in
// this API, so commas in a product title are turned into spaces rather than
// splitting it into separate keywords.
async function searchCatalogItems({ host, marketplaceId, keywords, includedData, pageSize }) {
  const data = await spApiGet(host, "/catalog/2022-04-01/items", {
    marketplaceIds: marketplaceId,
    includedData: includedData.join(","),
    pageSize,
    keywords: String(keywords).replace(/,/g, " ").replace(/\s+/g, " ").trim(),
  });
  return Array.isArray(data?.items) ? data.items : [];
}

module.exports = { searchCatalogItems, hasCredentials };
