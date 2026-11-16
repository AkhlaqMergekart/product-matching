const { fetchViaScrapeOps } = require("./scrapeOpsClient.js");
const { step, logEvent } = require("./timingLogger.js");
const { mapWithConcurrency } = require("./concurrency.js");

// adidas.co.in, used by the "adidas" destination (config/targetSites.js).
// A Next.js site: every page carries its data in __NEXT_DATA__ (verified
// 2026-11-16):
//
//   /search?q=<article code>  -> that product's page (IM8583 opens
//                                /adizero-essentials-running-split-shorts/IM8583.html)
//   /search?q=<words>         -> a results page: up to 48 products with title,
//                                price and two images, but no sizes
//   /<slug>/<code>.html       -> one product: sizes, price, MRP, every image,
//                                description, colour, gender
//
// Only ScrapeOps' premium level_2 pool with render_js gets through (see
// SCRAPEOPS_OPTIONS); a page is then ~20s. Its JSON APIs
// (/api/products/<code>, availability) refuse every pool, so per-size stock
// is not known.

const BASE_URL = "https://www.adidas.co.in";
// Since 2026-11-16 a plain level_2 request fails every time (HTTP 500 after
// ~77s); with render_js it comes back in ~20s. A failing one takes ScrapeOps
// ~80s to give up on, so wait 60s at most and retry once: a dead page costs
// ~2 minutes instead of ~4 (3 attempts x 80s).
const SCRAPEOPS_OPTIONS = { premium: "level_2", renderJs: true, timeoutMs: 60000, attempts: 2 };
// Product pages after a results page are fetched this many at a time.
const PAGE_CONCURRENCY = Number(process.env.ADIDAS_PAGE_CONCURRENCY) || 5;

// adidas article codes: two letters and four digits (IM8583), or one letter
// and five (H43064).
const ARTICLE_CODE = /^[A-Z]{2}\d{4}$|^[A-Z]\d{5}$/i;

function nextData(html, url) {
  const match = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`No page data in adidas page (${String(html).length} bytes) for ${url}`);
  return JSON.parse(match[1]);
}

// The product object of a product page, or null for any other page.
function productFromPage(data) {
  const props = data?.props?.pageProps;
  if (props?.pageType !== "ProductDetailPage") return null;
  const stored = Object.values(props.initialState?.productStore?.products || {})[0]?.data;
  if (stored) return stored;
  const query = (props.dehydratedState?.queries || []).find((q) => String(q.queryKey?.[0] || "").startsWith("/api/products/"));
  return query?.state?.data || null;
}

// adidas lets ScrapeOps through only part of the time: the same URL can come
// back as the real page (~790 KB) or, still HTTP 200, as a ~15 KB block page
// without __NEXT_DATA__. A block page is retried like a failed request.
const BLOCK_PAGE_ATTEMPTS = 3;

async function fetchPage(url) {
  for (let attempt = 1; ; attempt++) {
    const html = await fetchViaScrapeOps(url, SCRAPEOPS_OPTIONS);
    try {
      return nextData(html, url);
    } catch (err) {
      if (attempt >= BLOCK_PAGE_ATTEMPTS) throw err;
      logEvent(`  adidas block page (${String(html).length} bytes), attempt ${attempt}/${BLOCK_PAGE_ATTEMPTS} — ${url}`);
    }
  }
}

async function fetchProduct(url) {
  const product = productFromPage(await fetchPage(url));
  if (!product) throw new Error(`Not a product page: ${url}`);
  return product;
}

const searchPageUrl = (query) => `${BASE_URL}/search?q=${encodeURIComponent(query)}`;

// One search: a product page means the site resolved the query to a single
// product; a results page gives the first `maxResults` products, each then
// read from its own page for sizes and description.
async function runSearch(query, maxResults) {
  const data = await fetchPage(searchPageUrl(query));
  const direct = productFromPage(data);
  if (direct) {
    logEvent(`adidas search "${query}": opened product ${direct.id} directly`);
    return [{ listing: null, product: direct }];
  }

  const listings = (data?.props?.pageProps?.products || []).slice(0, maxResults);
  logEvent(`adidas search "${query}": ${data?.props?.pageProps?.info?.count ?? 0} result(s), first ${listings.length} kept`);

  return mapWithConcurrency(listings, PAGE_CONCURRENCY, async (listing, i) => {
    let product = null;
    try {
      product = await step(`adidas product ${i + 1}/${listings.length} fetch`, () => fetchProduct(listing.url), { detail: listing.id });
    } catch (err) {
      console.error(`Error fetching adidas product ${listing.id}:`, err.message);
    }
    return { listing, product };
  });
}

// Searches by the source row's article code first (project 360's adidas SKUs
// are article codes). Only a code that opens its product page is used; when
// it doesn't (not sold here), the search is by `query` (the title) instead.
async function searchAdidas(query, sourceProduct, maxResults = 10) {
  const code = String(sourceProduct?.sku || "").trim();
  if (ARTICLE_CODE.test(code)) {
    try {
      const data = await step("adidas search by article code", () => fetchPage(searchPageUrl(code)), { detail: code });
      const direct = productFromPage(data);
      if (direct) {
        logEvent(`adidas search "${code}": opened product ${direct.id} directly`);
        return [{ listing: null, product: direct }];
      }
      logEvent(`adidas search "${code}": no product page, searching by title`);
    } catch (err) {
      console.error(`adidas search by article code ${code} failed:`, err.message);
    }
  }
  return runSearch(query, maxResults);
}

module.exports = { searchAdidas, productFromPage, nextData };
