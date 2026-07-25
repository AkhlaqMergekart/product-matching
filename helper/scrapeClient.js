const axios = require("axios");
const ScrapingAntClient = require("@scrapingant/scrapingant-client");

const SCRAPEOPS_API_KEY = "6aa09d27-c12a-49b1-9332-b0fe571795c2";
// Same key already used in production for amazon.ae in
// sellerpundit-backend/cluster-service/bulkUpload.js.
const SCRAPINGANT_API_KEY = "3b03950ccb7e41ff9f66b98c8eb1e190";

const scrapingAntClient = new ScrapingAntClient({ apiKey: SCRAPINGANT_API_KEY });

async function fetchViaScrapeOps(url, attempt) {
  const premium_level = attempt >= 2 ? "level_2" : "level_1";

  const response = await axios.request({
    method: "get",
    maxBodyLength: Infinity,
    url: `https://proxy.scrapeops.io/v1/?api_key=${SCRAPEOPS_API_KEY}&url=${url}&render_js=true&premium=${premium_level}`,
    headers: {},
  });

  return response.data;
}

async function fetchViaScrapingAnt(url) {
  const response = await scrapingAntClient.scrape(url, {
    browser: false,
    proxy_country: "AE",
  });

  return response.content;
}

// Fetches `url` using whichever proxy client `scraperType` names, retrying
// up to 3 times (ScrapeOps escalates to its "premium" rendering tier after
// the first failed attempt, matching the retry behavior already in the
// original Nahdi flow).
async function fetchHtml(scraperType, url) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (scraperType === "scrapingant") {
        return await fetchViaScrapingAnt(url);
      }
      if (scraperType === "scrapeops") {
        return await fetchViaScrapeOps(url, attempt);
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
