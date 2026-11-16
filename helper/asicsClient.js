const { fetchViaScrapeOps } = require("./scrapeOpsClient.js");
const { logEvent } = require("./timingLogger.js");

// asics.co.in, used by the "asics" destination (config/targetSites.js). A
// Magento PWA whose public GraphQL API (GET /graphql?query=...) answers a
// search with everything a candidate needs in one request: name, SKU, price,
// MRP, every image, description, colour and each size with its stock
// (verified 2026-11-17, ~4s through ScrapeOps' plain pool).
//
// ASICS SKUs are style.colour codes ("1011C127.004"), the same form as
// project 360's rows, so a row is looked up by its SKU first; only when that
// finds nothing is the site searched by title.

const BASE_URL = "https://www.asics.co.in";

const PRODUCT_FIELDS = `
  __typename sku name url_key url_suffix color_label stock_status meta_title
  categories { name }
  price_range { minimum_price { regular_price { value currency } final_price { value } } }
  small_image { url }
  media_gallery { url label position disabled }
  description { html }
  ... on ConfigurableProduct {
    configurable_options { attribute_code label values { value_index label } }
    variants { attributes { code label value_index } product { sku stock_status } }
  }`;

function graphqlUrl(query) {
  return `${BASE_URL}/graphql?query=${encodeURIComponent(query.replace(/\s+/g, " ").trim())}`;
}

async function runQuery(query) {
  const url = graphqlUrl(query);
  const body = await fetchViaScrapeOps(url);
  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error(`asics.co.in answered something other than JSON (${body.length} bytes)`);
  }
  if (json.errors?.length) throw new Error(`asics.co.in GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  return json.data?.products || { total_count: 0, items: [] };
}

// Looks a row up by its SKU, then by `query` (its title). Returns up to
// `maxResults` GraphQL product items.
async function searchAsics(query, sourceProduct, maxResults = 10) {
  const sku = String(sourceProduct?.sku || "").trim();
  if (/^\w+\.\w+$/.test(sku)) {
    try {
      const exact = await runQuery(`{ products(filter: { sku: { eq: ${JSON.stringify(sku)} } }) { total_count items { ${PRODUCT_FIELDS} } } }`);
      if (exact.items.length > 0) {
        logEvent(`ASICS lookup by SKU ${sku}: found`);
        return exact.items;
      }
      logEvent(`ASICS lookup by SKU ${sku}: not on the site, searching by title`);
    } catch (err) {
      console.error(`ASICS lookup by SKU ${sku} failed:`, err.message);
    }
  }

  const found = await runQuery(`{ products(search: ${JSON.stringify(query)}, pageSize: ${maxResults}) { total_count items { ${PRODUCT_FIELDS} } } }`);
  logEvent(`ASICS search "${query}": ${found.total_count} result(s), first ${found.items.length} kept`);
  return found.items.slice(0, maxResults);
}

module.exports = { searchAsics, BASE_URL };
