const axios = require("axios");
const path = require("path");
const { isBlockPage } = require("./blockDetect.js");
const { logEvent } = require("./timingLogger.js");

// ScrapeOps' proxy API, used ONLY as a fallback for when the Webshare proxy
// (config/proxy.js) has exhausted its own attempts on a URL. Webshare stays
// the primary vendor everywhere: it is an order of magnitude cheaper per page
// and, for every target currently configured, it answers 200 on a plain GET.
//
// The split mirrors the scraping_vendor rows the main backend keeps
// (sellerpundit-backend/scraping — `scraping_method` "proxy" for Webshare,
// "api" for ScrapeOps). There's no vendor table in this service, so the order
// lives in config/scrapingVendors.js instead.
//
// ---------------------------------------------------------------------------
// The key is NOT in this file, same posture as the proxy credentials. Read
// from, in order:
//   1. env var     — SCRAPEOPS_API_KEY
//   2. config.json — SCRAPEOPS_Api_Key (gitignored, where SMTP_*/PROXY_* live)
//
// With no key configured this module reports isConfigured() === false and
// every caller simply keeps Webshare's own error. That is deliberate: a
// missing key should degrade to today's behaviour, not turn a recoverable
// fetch failure into a confusing auth error.
// ---------------------------------------------------------------------------
const fileConfig = (() => {
  try {
    return require(path.join(__dirname, "..", "config.json"));
  } catch (err) {
    return {};
  }
})();

const API_KEY = process.env.SCRAPEOPS_API_KEY || fileConfig.SCRAPEOPS_Api_Key || "";
const API_URL = process.env.SCRAPEOPS_API_URL || fileConfig.SCRAPEOPS_Api_Url || "https://proxy.scrapeops.io/v1/";

// ScrapeOps renders and routes the request itself, so it needs a generous
// window — a render_js fetch of a storefront search page regularly takes
// 30-60s, well past the 60s a direct GET is given.
const REQUEST_TIMEOUT_MS = 120000;

function isConfigured() {
  return Boolean(API_KEY);
}

// `options` is the same shape the other fetch paths accept
// (config/targetSites.js `scraperOptions`), so a target needs no extra config
// to be reachable through this vendor:
//   renderJs -> render_js. Defaults to false: every target here is
//               server-rendered, and rendering is both slower and billed at a
//               higher rate.
//   country  -> country. Honoured here, unlike the browser path, since
//               ScrapeOps geo-targets per request.
//   headers  -> forwarded to the target site.
//   mustContain -> HTML marker that must be present in a successful response.
function buildUrl(url, options = {}) {
  const params = new URLSearchParams({ api_key: API_KEY, url });

  // Premium residential routing. This is a last-resort path — the plain pool
  // has already effectively been tried, since Webshare's own rotation failed
  // before we got here — so default it on rather than burning another attempt
  // on a datacentre IP.
  params.set("premium", String(options.premium !== false));

  if (options.renderJs) params.set("render_js", "true");
  if (options.country) params.set("country", options.country);

  return `${API_URL}?${params.toString()}`;
}

// One ScrapeOps fetch. Throws on a non-2xx, on an anti-bot interstitial, or
// when no key is configured, so callers can treat it exactly like a failed
// Webshare attempt.
async function fetchViaScrapeOps(url, options = {}) {
  if (!isConfigured()) {
    throw new Error(
      "ScrapeOps fallback is not configured. Set SCRAPEOPS_API_KEY in the environment, " +
      "or SCRAPEOPS_Api_Key in config.json."
    );
  }

  const expectJson = Boolean(options.expectJson);

  const response = await axios.request({
    method: "get",
    url: buildUrl(url, options),
    timeout: options.timeout || REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxRedirects: 5,
    headers: options.headers || {},
    // Handle the status ourselves, so a 403/503 relayed from the target
    // surfaces as a thrown error rather than an opaque axios rejection.
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    // ScrapeOps answers its own errors (bad key, out of credits) on this
    // channel too, and its body says which — worth carrying into the message,
    // since the alternative is debugging "HTTP 401" with no context.
    const body = typeof response.data === "string" ? response.data.slice(0, 300) : JSON.stringify(response.data).slice(0, 300);
    throw new Error(`ScrapeOps HTTP ${response.status} for ${url}: ${body}`);
  }

  if (expectJson) {
    // ScrapeOps relays the body verbatim; axios only parses it when the
    // relayed content-type says JSON, so parse a string body here rather than
    // handing the caller raw text where it expects an object.
    if (typeof response.data === "string") {
      try {
        return JSON.parse(response.data);
      } catch (err) {
        throw new Error(`ScrapeOps returned non-JSON for ${url}: ${response.data.slice(0, 200)}`);
      }
    }
    return response.data;
  }

  const html = typeof response.data === "string" ? response.data : String(response.data);

  if (isBlockPage(html)) {
    throw new Error(`ScrapeOps returned an anti-bot page (${html.length} bytes) for ${url}`);
  }

  if (options.mustContain && !html.includes(options.mustContain)) {
    throw new Error(`ScrapeOps returned a page without required marker "${options.mustContain}" (${html.length} bytes) for ${url}`);
  }

  return html;
}

// Wrapper used by the fetch clients at the point Webshare has given up.
// Returns the fetched body, or re-throws `primaryError` — the Webshare failure
// is the one worth reporting when the fallback is unavailable or also fails,
// because it is the vendor the run is actually built on.
async function tryScrapeOpsFallback(url, options, primaryError) {
  if (!isConfigured()) throw primaryError;

  logEvent(`  falling back to ScrapeOps for ${url} — Webshare failed: ${primaryError.message}`);

  try {
    const body = await fetchViaScrapeOps(url, options);
    logEvent(`  ScrapeOps fallback succeeded for ${url}`);
    return body;
  } catch (err) {
    logEvent(`  ScrapeOps fallback also failed for ${url} — ${err.message}`);
    // Surface both vendors' reasons in one message. Either one alone has sent
    // someone looking in the wrong place before.
    const combined = new Error(`${primaryError.message} (ScrapeOps fallback also failed: ${err.message})`);
    combined.primaryError = primaryError;
    combined.fallbackError = err;
    throw combined;
  }
}

module.exports = { isConfigured, fetchViaScrapeOps, tryScrapeOpsFallback };
