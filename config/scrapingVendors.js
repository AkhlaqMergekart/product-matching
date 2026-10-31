// Which scraping vendor is tried for a page, and in what order.
//
// The main backend keeps this in a `scraping_vendors` table
// (sellerpundit-backend/scraping/src/models/scrapingvendor.js — name,
// scraping_method "proxy" | "api", credentials, status). This service has no
// such table, so the same decision lives here as plain config.
//
// Current policy, per the 2026-10-31 request: Webshare first, ScrapeOps only
// if Webshare could not get the page.
//
//   webshare  — scraping_method "proxy". The rotating proxy in
//               config/proxy.js, used by BOTH fetch paths
//               (helper/httpClient.js for plain GETs, helper/browserClient.js
//               for headless Chrome). Primary for every target: it is far
//               cheaper per page, and verified live against Nahdi, Myntra and
//               Nykaa Fashion as answering 200 on a plain GET.
//   scrapeops — scraping_method "api". helper/scrapeOpsClient.js. Billed per
//               request and slower, so it is a fallback only, and it is
//               skipped entirely when no API key is configured (in which case
//               behaviour is exactly as it was before it existed).
//
// Reordering this list is the supported way to change the policy — e.g. a
// target site that starts refusing the Webshare pool outright. Nothing here
// enables a vendor that has no credentials.
const VENDOR_ORDER = ["webshare", "scrapeops"];

// True when ScrapeOps should be attempted after Webshare exhausts its tries.
function scrapeOpsIsFallback() {
  const webshare = VENDOR_ORDER.indexOf("webshare");
  const scrapeops = VENDOR_ORDER.indexOf("scrapeops");
  return scrapeops !== -1 && (webshare === -1 || scrapeops > webshare);
}

module.exports = { VENDOR_ORDER, scrapeOpsIsFallback };
