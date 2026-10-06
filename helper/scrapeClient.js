const { fetchViaBrowser, closeBrowser } = require("./browserClient.js");
const { fetchPage, closeSession } = require("./httpClient.js");

// Fetches `url` with whichever strategy `scraperType` names, retrying up to 3
// times. Both strategies route every request through the Webshare proxy, so
// nothing here ever leaves from the host's own IP.
//
//   "axios"     -> helper/httpClient.js. A plain GET with a real browser's
//                  headers over a sticky, keep-alive proxy tunnel. ~1-5s a
//                  page. Preferred: it is an order of magnitude cheaper than a
//                  browser, and it holds one exit IP for as long as that IP
//                  keeps working rather than burning a new one per request.
//   "puppeteer" -> helper/browserClient.js. Real headless Chrome. Needed only
//                  where a page's data is injected by its own JavaScript, or
//                  where the site will not serve a non-browser client.
//
// This used to dispatch to two paid HTTP proxy APIs (ScrapeOps / ScrapingAnt).
// Both are gone; their names are still accepted and map to the browser so an
// old config keeps working.
const BROWSER_SCRAPERS = new Set(["puppeteer", "browser", "scrapeops", "scrapingant"]);
const HTTP_SCRAPERS = new Set(["axios", "http"]);

// `options` comes from the target's `scraperOptions` in config/targetSites.js
// and carries per-site fetch concerns that aren't the caller's business:
//   headers  -> forwarded to the target site (locale, etc.)
//   renderJs -> browser only; false skips waiting for network idle
//   country  -> accepted but not enforced (see browserClient.js)
async function fetchHtml(scraperType, url, options = {}) {
  const type = scraperType || "axios";

  if (HTTP_SCRAPERS.has(type)) {
    // httpClient runs its own attempt loop, rotating the exit IP between
    // tries, so there is nothing to wrap here.
    return fetchPage(url, options);
  }

  if (!BROWSER_SCRAPERS.has(type)) {
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

// Releases both fetch paths' long-lived resources (the browser and the proxy
// tunnel).
async function closeFetchClients() {
  closeSession();
  await closeBrowser();
}

module.exports = { fetchHtml, closeFetchClients, closeBrowser };
