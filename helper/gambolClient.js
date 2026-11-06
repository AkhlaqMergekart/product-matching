const cheerio = require("cheerio");
const { isBlockPage } = require("./blockDetect.js");
const { fetchViaScrapeOps } = require("./scrapeOpsClient.js");
const { step } = require("./timingLogger.js");

// gambol.in is a Shopify store, used by the "gambol" destination
// (config/targetSites.js):
//
//   /search?q=...&type=product  -> the results page: up to 28 product cards
//   /products/<handle>.js       -> one product as JSON: title, vendor, tags,
//                                  description and every image
//
// Everything goes through ScrapeOps: from a direct connection Gambol answers
// product URLs with HTTP 429 "local_rate_limited", even after 6 idle minutes
// (2026-11-06). A ScrapeOps request takes ~10-15s, so a full page of 28
// products is ~5 minutes and 29 requests.

const BASE_URL = "https://gambol.in";

// What a results card carries by itself: enough to match on text, with the
// main image only.
function parseCards(html) {
  const $ = cheerio.load(html);

  return $(".grid-product")
    .map((_, element) => {
      const card = $(element);
      const image = card.find("img.grid-product__image").first().attr("data-src") || "";
      return {
        handle: card.attr("data-product-handle") || "",
        id: card.attr("data-product-id") || "",
        title: card.attr("data-product-name") || "",
        vendor: card.attr("data-product-vendor") || "",
        price: card.attr("data-product-price") || "",
        // data-src is a lazy-load template; 1024px is well above what the
        // matching service compares at.
        image: image.replace("{width}", "1024"),
      };
    })
    .get()
    .filter((card) => card.handle);
}

// Searches Gambol for `query` and returns the first page of results as
// { card, product }. `product` is the /products/<handle>.js JSON, or null when
// it couldn't be fetched; the candidate then carries the card's data.
async function searchGambol(query) {
  const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}&type=product`;
  const html = await fetchViaScrapeOps(searchUrl);
  if (isBlockPage(html)) throw new Error(`Blocked page (${html.length} bytes) for ${searchUrl}`);

  const cards = parseCards(html);
  const results = [];

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const url = `${BASE_URL}/products/${encodeURIComponent(card.handle)}.js`;
    let product = null;

    try {
      product = await step(
        `Gambol product ${i + 1}/${cards.length} fetch`,
        async () => JSON.parse(await fetchViaScrapeOps(url)),
        { detail: card.handle }
      );
    } catch (err) {
      console.error(`Error fetching Gambol product ${card.handle}:`, err.message);
    }

    results.push({ card, product });
  }

  return results;
}

module.exports = { searchGambol, parseCards };
