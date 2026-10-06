const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD } = require("../config/proxy.js");
const { isBlockPage } = require("./blockDetect.js");

// Plain HTTP fetching, every call masked behind the Webshare proxy, with a
// STICKY exit IP that is only given up when it stops working.
//
// Why sticky rather than per-request rotation:
//
//   The exit IP is a property of the TCP connection, not of the request. A
//   keep-alive agent holds one CONNECT tunnel open, so every request through
//   it leaves from the same address; destroying the agent forces a new tunnel
//   and a new address. Verified 2026-10-06 against api.ipify.org — five calls
//   on one agent all reported 82.23.215.193, then a fresh agent reported
//   174.140.200.107 and a third 82.21.244.77.
//
//   Holding the tunnel open is also what makes this fast: the first request
//   pays ~1.5s for the proxy handshake, every one after it ~350ms. Rotating
//   per request would pay that handshake every time (and it is what made the
//   earlier axios-with-axios-proxy path ~3.0s per call).
//
// So: keep one IP and make as many calls through it as it will take, and
// change IP only on evidence that it has stopped working — a network error, an
// HTTP error, or a block/captcha page. Nothing rotates on a success.
const PROXY_URL = `http://${encodeURIComponent(PROXY_USERNAME)}:${encodeURIComponent(PROXY_PASSWORD)}@${PROXY_HOST}:${PROXY_PORT}`;

// The header set from a real Edge session. Sending a browser's headers while
// the request leaves from a residential-looking exit IP is most of what keeps
// these fetches from being classified as automation.
const PAGE_HEADERS = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "max-age=0",
  priority: "u=0, i",
  "sec-ch-ua": '"Chromium";v="154", "Microsoft Edge";v="154", "Not A(Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0",
};

const JSON_HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": PAGE_HEADERS["user-agent"],
};

const REQUEST_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 3;

let agent = null;
let sessionNumber = 0;
let requestsThisSession = 0;

function getAgent() {
  if (!agent) {
    sessionNumber += 1;
    requestsThisSession = 0;
    agent = new HttpsProxyAgent(PROXY_URL, {
      keepAlive: true,
      keepAliveMsecs: 30000,
      // The flows here are sequential, but a handful of sockets lets a future
      // concurrent caller share the session instead of opening a second one.
      maxSockets: 10,
    });
  }

  return agent;
}

// Drops the current tunnel so the next request leaves from a new exit IP.
// Called on failure, never on success.
function rotateSession(reason) {
  if (agent) {
    console.log(
      `  proxy: rotating exit IP after ${requestsThisSession} request(s) on session #${sessionNumber} — ${reason}`
    );
    agent.destroy();
  }

  agent = null;
}

function closeSession() {
  if (agent) {
    agent.destroy();
    agent = null;
  }
}

function sessionInfo() {
  return { sessionNumber, requestsThisSession, active: Boolean(agent) };
}

// Statuses that say "this URL is gone", not "this IP is unwelcome". Rotating
// for these is pointless — it burns two extra requests and two exit IPs to be
// told the same thing — so they fail immediately instead.
const PERMANENT_STATUSES = new Set([404, 410]);

class PermanentHttpError extends Error {}

// One attempt. Throws on anything that should cost us this IP.
async function attempt(url, { headers, timeout, expectJson }) {
  const response = await axios.request({
    method: "get",
    url,
    httpsAgent: getAgent(),
    // Tell axios not to apply its own proxy handling on top of the agent —
    // with both set the request is tunnelled twice and fails.
    proxy: false,
    timeout: timeout || REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxRedirects: 5,
    headers,
    // Treat the status ourselves so a 403/503 challenge rotates rather than
    // surfacing as a bare axios error.
    validateStatus: () => true,
  });

  requestsThisSession += 1;

  if (PERMANENT_STATUSES.has(response.status)) {
    throw new PermanentHttpError(`HTTP ${response.status} for ${url}`);
  }

  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  if (expectJson) {
    return response.data;
  }

  const html = typeof response.data === "string" ? response.data : String(response.data);

  if (isBlockPage(html)) {
    throw new Error(`Blocked by anti-bot page (${html.length} bytes) for ${url}`);
  }

  return html;
}

// Shared retry loop. Each failure rotates the exit IP before the next try, so
// attempt 2 is genuinely a different client; successes leave the session alone.
async function fetchWithRotation(url, options, expectJson) {
  const headers = {
    ...(expectJson ? JSON_HEADERS : PAGE_HEADERS),
    ...(options.headers || {}),
  };

  let lastError = null;

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      return await attempt(url, { headers, timeout: options.timeout, expectJson });
    } catch (err) {
      lastError = err;

      // A dead URL is the caller's problem, not the IP's. Fail fast and keep
      // the working session for the next candidate.
      if (err instanceof PermanentHttpError) {
        throw err;
      }

      if (i < MAX_ATTEMPTS) {
        rotateSession(err.message);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // The last attempt failed too — don't leave the next caller on a session
  // that has just proved itself bad.
  rotateSession(`gave up after ${MAX_ATTEMPTS} attempts`);

  throw lastError;
}

// Fetches `url` as HTML. Drop-in for the browser fetch, minus the browser:
// verified 2026-10-06 that Nahdi's search and product pages both answer 200
// with these headers and no cookies, in ~1-5s against ~13-30s for a Chrome
// navigation, and that the page extractors find the same data in the result.
function fetchPage(url, options = {}) {
  return fetchWithRotation(url, options, false);
}

// Fetches `url` as JSON (a site's own storefront endpoint).
function fetchJson(url, options = {}) {
  return fetchWithRotation(url, options, true);
}

module.exports = { fetchPage, fetchJson, rotateSession, closeSession, sessionInfo };
