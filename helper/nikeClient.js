const { fetchViaScrapeOps } = require("./scrapeOpsClient.js");
const { step, logEvent } = require("./timingLogger.js");

// Nike's official Indian store, used by the "nike" destination
// (config/targetSites.js). nike.com/in now redirects to nike.in, which runs on
// Nykaa Fashion's platform and answers two JSON APIs (verified 2026-11-16):
//
//   /rest/appapi/V2/categories/products?searchTerm=...  -> search results with
//       title, price, MRP, images and every size (with stock)
//   /rest/appapi/V3/products/id/<id>                    -> one product: the
//       above plus description, colour and Nike's style code ("CN9675-401")
//
// Searching by style code finds nothing, so the search is by title.
// Everything goes through ScrapeOps (plain pool, ~5s a request).

const { mapWithConcurrency } = require("./concurrency.js");

const BASE_URL = "https://www.nike.in";
// Product API calls after a search are made this many at a time.
const PAGE_CONCURRENCY = Number(process.env.NIKE_PAGE_CONCURRENCY) || 5;

function searchUrl(query) {
  const params = new URLSearchParams({
    searchTerm: query,
    PageSize: "36",
    currentPage: "1",
    filter_format: "v2",
    sort: "relevance",
    device_os: "desktop",
  });
  return `${BASE_URL}/rest/appapi/V2/categories/products?${params}`;
}

async function fetchJsonViaScrapeOps(url) {
  const body = await fetchViaScrapeOps(url);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`nike.in answered something other than JSON (${body.length} bytes) for ${url}`);
  }
}

// Searches nike.in for `query` and returns the first `maxResults` products as
// { listing, detail }. `detail` is the product API's answer, or null when it
// couldn't be fetched; the candidate then carries the listing's data.
async function searchNike(query, maxResults = 10) {
  const response = await fetchJsonViaScrapeOps(searchUrl(query));
  const listings = (response?.response?.products || []).slice(0, maxResults);
  logEvent(`Nike search: ${response?.response?.count ?? 0} result(s), first ${listings.length} kept`);

  return mapWithConcurrency(listings, PAGE_CONCURRENCY, async (listing, i) => {
    let detail = null;
    try {
      detail = await step(
        `Nike product ${i + 1}/${listings.length} fetch`,
        async () => (await fetchJsonViaScrapeOps(`${BASE_URL}/rest/appapi/V3/products/id/${listing.id}`))?.response?.product || null,
        { detail: listing.id }
      );
    } catch (err) {
      console.error(`Error fetching Nike product ${listing.id}:`, err.message);
    }
    return { listing, detail };
  });
}

module.exports = { searchNike, searchUrl };
