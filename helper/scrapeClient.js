const axios = require("axios");
const ScrapingAntClient = require("@scrapingant/scrapingant-client");

const SCRAPEOPS_API_KEY = "6aa09d27-c12a-49b1-9332-b0fe571795c2";
// Same key already used in production for amazon.ae in
// sellerpundit-backend/cluster-service/bulkUpload.js.
const SCRAPINGANT_API_KEY = "3b03950ccb7e41ff9f66b98c8eb1e190";

const scrapingAntClient = new ScrapingAntClient({ apiKey: SCRAPINGANT_API_KEY });

async function fetchViaScrapeOps(url, attempt, options = {}) {
  const premium_level = attempt >= 2 ? "level_2" : "level_1";

  // The target URL MUST be encoded. Interpolating it raw meant everything
  // after its first "&" was parsed as a ScrapeOps parameter instead of part
  // of the target URL (e.g. amazon.ae's "&ref=nb_sb_noss" was silently
  // dropped, and firstcry's "&spos=1&sstock=1" with it).
  const params = new URLSearchParams({
    api_key: SCRAPEOPS_API_KEY,
    url,
    // JS rendering roughly doubles both latency and credit cost, so callers
    // that only need server-rendered fields can opt out (renderJs: false).
    render_js: options.renderJs === false ? "false" : "true",
    premium: premium_level,
  });

  // Pins the exit IP to a country. Without it ScrapeOps routes through
  // whatever geo it likes, which is how amazon.ae ended up serving Arabic.
  if (options.country) {
    params.set("country", options.country);
  }

  const response = await axios.request({
    method: "get",
    maxBodyLength: Infinity,
    url: `https://proxy.scrapeops.io/v1/?${params.toString()}`,
    headers: options.headers || {},
  });

  return response.data;
}

async function fetchViaScrapingAnt(url, options = {}) {
  const response = await scrapingAntClient.scrape(url, {
    browser: false,
    proxy_country: options.country || "AE",
    // Forwarded to the target as "ant-"-prefixed headers by the client.
    // Accept-Language is what actually makes amazon.ae answer in English —
    // an AE exit IP alone still gets the Arabic storefront.
    ...(options.headers && { headers: options.headers }),
  });

  return response.content;
}

// Fetches `url` using whichever proxy client `scraperType` names, retrying
// up to 3 times (ScrapeOps escalates to its "premium" rendering tier after
// the first failed attempt, matching the retry behavior already in the
// original Nahdi flow).
//
// `options` comes from the target's `scraperOptions` in config/targetSites.js
// and carries per-site fetch concerns that aren't the caller's business:
//   country -> pin the proxy exit IP (both clients)
//   headers -> forwarded to the target site (locale, etc.)
async function fetchHtml(scraperType, url, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (scraperType === "scrapingant") {
        return await fetchViaScrapingAnt(url, options);
      }
      if (scraperType === "scrapeops") {
        return await fetchViaScrapeOps(url, attempt, options);
      }
      throw new Error(`Unknown scraper type: ${scraperType}`);
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  throw lastError;
}

module.exports = { fetchHtml };
