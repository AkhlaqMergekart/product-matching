const path = require("path");

// Webshare rotating proxy, shared by every outbound request this service
// makes — both the headless-browser page fetches (helper/browserClient.js) and
// the plain GETs and JSON API calls (helper/httpClient.js).
//
// The endpoint hands out a different exit IP per new *connection*, not per
// request — which is the fact both clients are built around. Holding a
// connection open keeps one IP (and skips the ~1.2s handshake); dropping it
// takes a new one. helper/httpClient.js uses that to stay on a working IP and
// change only on failure.
//
// ---------------------------------------------------------------------------
// Credentials are NOT in this file on purpose. They're read from, in order:
//   1. env vars        — PROXY_HOST / PROXY_PORT / PROXY_USERNAME / PROXY_PASSWORD
//   2. config.json     — PROXY_Host / PROXY_Port / PROXY_Username / PROXY_Password
//                        (gitignored, same place SMTP_* lives)
//
// So a deployment needs either the env vars set or these keys in its
// config.json:
//
//   "PROXY_Host":     "p.webshare.io",
//   "PROXY_Port":     "80",
//   "PROXY_Username": "...",
//   "PROXY_Password": "..."
//
// Nothing here falls back to a baked-in password: a proxy password in git
// history is not something you can take back, and config.json is already this
// repo's home for secrets.
// ---------------------------------------------------------------------------
function loadFileConfig() {
  try {
    // Resolved rather than plain require("../config.json") so a missing file is
    // a warning we control, not a module-load crash.
    return require(path.join(__dirname, "..", "config.json"));
  } catch (err) {
    return {};
  }
}

const fileConfig = loadFileConfig();

const PROXY_HOST = process.env.PROXY_HOST || fileConfig.PROXY_Host || "p.webshare.io";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || fileConfig.PROXY_Port || "80", 10);
const PROXY_USERNAME = process.env.PROXY_USERNAME || fileConfig.PROXY_Username || "";
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || fileConfig.PROXY_Password || "";

// Fail loudly at startup rather than letting every fetch die with an opaque
// ERR_INVALID_AUTH_CREDENTIALS / HTTP 407 further down.
if (!PROXY_USERNAME || !PROXY_PASSWORD) {
  console.error(
    "[config/proxy.js] No proxy credentials found. Set PROXY_USERNAME and PROXY_PASSWORD " +
      "in the environment, or PROXY_Username and PROXY_Password in config.json. " +
      "Every fetch will fail with a proxy auth error until this is set."
  );
}

module.exports = {
  PROXY_HOST,
  PROXY_PORT,
  PROXY_USERNAME,
  PROXY_PASSWORD,

  // Chrome's --proxy-server form.
  PROXY_SERVER: `http://${PROXY_HOST}:${PROXY_PORT}`,
};
