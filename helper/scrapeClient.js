const { fetchViaBrowser, closeBrowser } = require("./browserClient.js");
const { fetchPage, closeSession } = require("./httpClient.js");
const { logEvent } = require("./timingLogger.js");
const { tryScrapeOpsFallback, fetchViaScrapeOps, isConfigured: scrapeOpsConfigured } = require("./scrapeOpsClient.js");
const { scrapeOpsIsFallback } = require("../config/scrapingVendors.js");

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
//   mustContain -> HTML marker that must be present; a missing marker is
//                  treated like a block page and costs the current attempt
//   retryStatuses -> HTTP statuses that this target wants retried even if the
//                    generic client would normally treat them as permanent
async function fetchHtml(scraperType, url, options = {}) {
  const type = scraperType || "axios";

  // Per-target override: ScrapeOps as the PRIMARY vendor (used by Myntra),
  // tried directly up to 3 times before anything else. Premium routing only
  // (no render_js, no cloudflare bypass) — i.e. the vendor-id-15 {"premium":
  // true} variant, not the id-12 cloudflare_level_1 one. Only after all three
  // attempts fail does it fall through to the normal Webshare path below.
  if (options.scrapeOpsFirst && scrapeOpsConfigured()) {
    const sops = { ...options, premium: true, renderJs: false };
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fetchViaScrapeOps(url, sops);
      } catch (err) {
        lastError = err;
        logEvent(`  ScrapeOps (primary) attempt ${attempt}/3 failed for ${url} — ${err.message}`);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    logEvent(`  ScrapeOps primary exhausted for ${url} — falling back to Webshare`);
    // Drop the flag so the fallback path doesn't loop back into ScrapeOps-first.
    options = { ...options, scrapeOpsFirst: false };
  }

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
      logEvent(`  browser fetch attempt ${attempt}/3 failed — ${err.message}`);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // Same vendor hand-off as the HTTP path: ScrapeOps renders JS itself, so a
  // target that needed a browser is still served correctly through it.
  if (scrapeOpsIsFallback()) {
    return tryScrapeOpsFallback(url, { ...options, renderJs: options.renderJs !== false }, lastError);
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
