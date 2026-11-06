const path = require("path");
const axios = require("axios");
const { logEvent } = require("./timingLogger.js");

// ScrapeOps' proxy API, for a site that refuses our own fetch paths (Gambol).
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
async function request(url, attempt) {
  const params = new URLSearchParams({ api_key: API_KEY, url, render_js: "false" });
  // A failed plain request gets ScrapeOps' stronger proxy pool on the retry.
  if (attempt > 1) params.set("premium", "level_1");

  let response;
  try {
    response = await axios.get(`${API_URL}?${params}`, {
      timeout: REQUEST_TIMEOUT_MS,
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
async function fetchViaScrapeOps(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request(url, attempt);
    } catch (err) {
      if (err.final || attempt === MAX_ATTEMPTS) throw err;
      logEvent(`  ScrapeOps attempt ${attempt}/${MAX_ATTEMPTS} failed — ${err.message}`);
    }
  }
}

module.exports = { fetchViaScrapeOps, hasApiKey };
