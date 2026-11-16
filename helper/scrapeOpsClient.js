const path = require("path");
const axios = require("axios");
const { logEvent } = require("./timingLogger.js");

// ScrapeOps' proxy API, for sites that refuse our own fetch paths (Gambol,
// nike.in, adidas.co.in).
// Paid per request, so nothing else goes through it. The key comes from
// SCRAPEOPS_API_KEY (env) or SCRAPEOPS_Api_Key (config.json).
const fileConfig = (() => {
  try {
    return require(path.join(__dirname, "..", "config.json"));
  } catch (err) {
    return {};
  }
})();

const API_KEY = process.env.SCRAPEOPS_API_KEY || fileConfig.SCRAPEOPS_Api_Key;
const API_URL = "https://proxy.scrapeops.io/v1/";
const REQUEST_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
// A bad key, no credits left, or a page that isn't there: retrying costs time
// and can't help.
const FINAL_STATUSES = new Set([401, 403, 404]);

const hasApiKey = () => Boolean(API_KEY);

// One request. Errors are rebuilt here because the request URL holds the API
// key, and index.js logs whole error objects.
//
// options.premium: a ScrapeOps premium proxy level ("level_1", "level_2") used
// on every attempt. adidas.co.in answers only through level_2; Nike and
// Gambol pass nothing and get the plain pool first.
// options.timeoutMs / options.attempts: per-site overrides of the defaults
// above. ScrapeOps takes ~80s to give up on an adidas page (HTTP 500) while a
// good one takes ~12s, so adidas stops waiting sooner and retries once.
async function request(url, attempt, options = {}) {
  // options.renderJs: have ScrapeOps load the page in its own browser. Costs
  // more credits; adidas.co.in needs it (see helper/adidasClient.js).
  const params = new URLSearchParams({ api_key: API_KEY, url, render_js: options.renderJs ? "true" : "false" });
  // A failed plain request gets ScrapeOps' stronger proxy pool on the retry.
  if (options.premium) params.set("premium", options.premium);
  else if (attempt > 1) params.set("premium", "level_1");

  let response;
  try {
    response = await axios.get(`${API_URL}?${params}`, {
      timeout: options.timeoutMs || REQUEST_TIMEOUT_MS,
      responseType: "text",
      transformResponse: (body) => body,
      validateStatus: () => true,
    });
  } catch (err) {
    throw new Error(`ScrapeOps request failed for ${url}: ${err.code || "network error"}`);
  }

  if (response.status !== 200) {
    const error = new Error(`ScrapeOps answered HTTP ${response.status} for ${url}`);
    error.final = FINAL_STATUSES.has(response.status);
    throw error;
  }
  return response.data;
}

// Fetches `url` through ScrapeOps and returns the body as text.
async function fetchViaScrapeOps(url, options = {}) {
  const maxAttempts = options.attempts || MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await request(url, attempt, options);
    } catch (err) {
      if (err.final || attempt >= maxAttempts) throw err;
      logEvent(`  ScrapeOps attempt ${attempt}/${maxAttempts} failed — ${err.message}`);
    }
  }
}

module.exports = { fetchViaScrapeOps, hasApiKey };
