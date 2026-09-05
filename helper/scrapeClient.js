const { fetchViaBrowser, closeBrowser } = require("./browserClient.js");

// Fetches `url` with a real browser (helper/browserClient.js) through the
// Webshare rotating proxy, retrying up to 3 times.
//
// This used to dispatch to one of two HTTP proxy APIs (ScrapeOps /
// ScrapingAnt). Both are gone: every target is now scraped in-browser, which
// removes the per-request credit cost and the dependency on a third party's
// rendering tier. `scraperType` is kept in the signature — and the old names
// still accepted — so config/targetSites.js entries and any callers that
// still pass "scrapeops" keep working.
//
// A retry is meaningful here even though nothing escalates a "premium tier"
// any more: each attempt opens a fresh browser context, which takes a new
// connection through the rotating endpoint and so a new exit IP. Attempt 2 is
// genuinely not the same request from the same address.
//
// `options` comes from the target's `scraperOptions` in config/targetSites.js
// and carries per-site fetch concerns that aren't the caller's business:
//   renderJs -> false skips waiting for network idle on server-rendered pages
//   headers  -> forwarded to the target site (locale, etc.)
//   country  -> accepted but no longer enforced (see browserClient.js)
const SUPPORTED_SCRAPERS = new Set(["puppeteer", "browser", "scrapeops", "scrapingant"]);

async function fetchHtml(scraperType, url, options = {}) {
  if (scraperType && !SUPPORTED_SCRAPERS.has(scraperType)) {
    throw new Error(`Unknown scraper type: ${scraperType}`);
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchViaBrowser(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  throw lastError;
}

module.exports = { fetchHtml, closeBrowser };
