const xpath = require("xpath");

// Each entry describes everything that is specific to one target website:
// how to search it, how to read a search-results page, and (if needed) how
// to read an individual product page. Adding a new marketplace means adding
// an entry here, not touching the matching engine in index.js.
//
// `scraper` names the fetch strategy fetchHtml() (helper/scrapeClient.js)
// uses to retrieve the page. Every target now uses "puppeteer" — a real
// headless browser driven through the Webshare rotating proxy
// (helper/browserClient.js) — having previously gone through the ScrapeOps
// and ScrapingAnt HTTP proxy APIs. The field is kept because the fetch method
// is genuinely part of a site's config, so a future target can opt into a
// different one without touching the matching engine.
//
// There are three ways a target can turn one search into full candidate
// objects. buildCandidatesFromSearch() in index.js checks them in this order:
//
// 1. `detailApi` -> read the SKUs off the search page, then fetch every
//    candidate's data from the site's own JSON endpoint in one batched request.
//    One request for the whole candidate set. Used for Nahdi.
// 2. `needsDetailFetch: false` -> build the full candidate object directly
//    from the search-results page, no second request at all. Used for Amazon
//    UAE, whose grid carries enough data to compare against and whose product
//    pages carry a much higher block risk than reading the grid once.
// 3. `needsDetailFetch: true` -> visit each candidate's own product page for
//    full field data. One request per candidate, so it's the most expensive
//    and most block-prone of the three; only Firstcry UAE still needs it,
//    having no known JSON endpoint.

// Pulls the schema.org Product node out of a page's <script
// type="application/ld+json"> blocks. Sites publish these for Google, which
// means they are maintained, server-rendered, and far more stable than the
// utility-class selectors a Tailwind/Next.js storefront ships — Nahdi's
// product page carries five such blocks (Organization, BreadcrumbList,
// WebSite, ImageObject, Product).
//
// Returns null when the page has no Product node, so callers fall back to
// their own selectors rather than throwing.
function extractJsonLdProduct(doc) {
  const scripts = xpath.select("//script[@type='application/ld+json']", doc);

  for (const script of scripts) {
    let parsed;
    try {
      parsed = JSON.parse(script.textContent);
    } catch (err) {
      continue; // A malformed block is not a reason to abandon the others.
    }

    // A block can be a single node, an array of them, or a @graph wrapper.
    const nodes = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.["@graph"])
        ? parsed["@graph"]
        : [parsed];

    const product = nodes.find((node) => {
      const type = node?.["@type"];
      return Array.isArray(type) ? type.includes("Product") : type === "Product";
    });

    if (product) return product;
  }

  return null;
}

const targetSites = {
  nahdi: {
    id: "nahdi",
    label: "Nahdi",
    // Plain GETs through the sticky proxy — no browser. Verified live
    // 2026-10-06: both the search page and the product pages answer HTTP 200
    // with a real browser's headers and no cookies at all (no Cloudflare
    // clearance needed), in ~1-5s against ~13-30s for a Chrome navigation, and
    // the extractors below find the same data in the result.
    scraper: "axios",
    // Back to a page per candidate, which is affordable now that a page is a
    // ~1-2s GET on a held-open proxy tunnel rather than a ~13s browser
    // navigation on a fresh IP. The page carries what the JSON endpoint cannot
    // (all 11 gallery images, the real description), and `detailApi` below
    // stays on as a bulk fallback.
    needsDetailFetch: true,

    buildSearchUrl: (query) =>
      `https://www.nahdionline.com/en-sa/search?query=${encodeURIComponent(query)}`,

    extractListingLinks: (doc) =>
      xpath
        .select("//a[@class='flex h-full flex-col']", doc)
        .map((itm) => "https://www.nahdionline.com" + itm.getAttribute("href")),

    extractDetail: (doc, link) => {
      // Everything structured comes from the page's schema.org Product block
      // rather than from CSS classes. That is deliberate: the class-based
      // selectors this replaced were both fragile and, in two cases, wrong.
      //
      //   price: the old selector read the right <div>, but Nahdi renders the
      //     SAR symbol as an inline <svg> whose <style> text lands inside it,
      //     so textContent was ".sar_symbol_svg__cls-1{fill:#231f20}254.00" and
      //     parseFloat() returned NaN — which then fell through to the MRP.
      //     That is how SKU 103804790 was recorded at 878.60 for a product that
      //     sells for 254.00.
      //   images: the old gallery selector matches nothing on the served HTML
      //     (0 hits); the carousel is built client-side. The JSON-LD carries
      //     all 11 image URLs.
      //
      // offers is an AggregateOffer: lowPrice is what the shopper pays,
      // highPrice is the pre-discount list price. Verified against the
      // storefront API for 103804790 — 254 / 878.6, matching exactly.
      const product = extractJsonLdProduct(doc);
      const offers = product?.offers || {};

      // The description is NOT in the JSON-LD (it repeats the product name
      // there), so this one field still comes from the page body.
      const description = xpath.select("//div[@class='pdp-about-section']", doc)?.[0]?.textContent;

      // Breadcrumb fallback for category. Nahdi emits an empty <li> between
      // "Home" and the first real level, and ends with the product name, so
      // trim both ends rather than passing "Home >  > ... > <product>" to the
      // matching service.
      const crumbs = xpath
        .select("//ul[@class='flex items-center text-custom-xs font-semibold text-gray ']/li", doc)
        .map((itm) => itm.textContent.trim())
        .filter(Boolean)
        .filter((part) => part.toLowerCase() !== "home")
        .slice(0, -1);

      const sku = String(product?.sku || link.split("/").pop().split("?")[0] || "");

      const price = parseFloat(offers.lowPrice ?? offers.price) || 0;
      const mrp = parseFloat(offers.highPrice ?? offers.lowPrice ?? offers.price) || 0;

      return {
        url: link,
        category: product?.category || crumbs.join(" > ") || "",
        brand: product?.brand?.name || product?.brand || "",
        title: product?.name || xpath.select("//h1", doc)?.[0]?.textContent?.trim() || "",
        sku,
        price,
        mrp: mrp || price,
        totalRating: product?.aggregateRating?.ratingValue ? String(product.aggregateRating.ratingValue) : "",
        totalReview: product?.aggregateRating?.reviewCount ? String(product.aggregateRating.reviewCount) : "",
        express: false,
        description: description?.trim() || "",
        images: Array.isArray(product?.image) ? product.image : product?.image ? [product.image] : [],
      };
    },

    // Bulk fallback, used by buildCandidatesFromSearch() only when the
    // per-candidate pages above yield nothing at all. One request for the whole
    // candidate set — measured 2026-10-03: 20 SKUs in 16 KB, 0.33s direct /
    // ~3.0s proxied. It carries the right price and category but only the main
    // catalogue image, so it is the degraded path, not the preferred one.
    detailApi: {
      // SKU is the last path segment of a product link
      // (/en-sa/<slug>/pdp/<sku>), which is exactly what the endpoint keys on.
      extractListingSkus: (doc) =>
        xpath
          .select("//a[@class='flex h-full flex-col']", doc)
          .map((itm) => (itm.getAttribute("href") || "").split("?")[0].split("/").filter(Boolean).pop())
          .filter(Boolean),

      // 20 (one full search page) is verified; the cap is here so an unusually
      // long result set is split rather than sent as one enormous query string.
      batchSize: 50,

      buildUrl: (skus) =>
        `https://www.nahdionline.com/api/analytics/product?skus=${skus.join(",")}&language=en&region=SA`,

      mapItem: (item) => {
        // item_category/2/3/... is the shopper-facing taxonomy but comes back
        // empty for plenty of SKUs (every Anivagene/Balmy/Avene item in the
        // 2026-10-03 sample). The imf_* fields carry the internal taxonomy and
        // were populated on all of them, so fall back to those rather than
        // handing the matching service a blank category.
        const retailCategory = [
          item.item_category,
          item.item_category2,
          item.item_category3,
          item.item_category4,
          item.item_category5,
        ]
          .filter((part) => part && String(part).trim())
          .join(" > ");

        const internalCategory = [
          item.imf_division,
          item.imf_department,
          item.imf_category,
          item.imf_sub_category,
          item.imf_class,
        ]
          .filter((part) => part && String(part).trim())
          .join(" > ");

        // item_link has no locale prefix ("/teknum-flylite-stroller-black/pdp/
        // 103804790"), so prepend the one the rest of this file uses — those
        // are the URLs that land in the exported sheet.
        const link = item.item_link
          ? `https://www.nahdionline.com/en-sa${item.item_link}`
          : item.item_id
            ? `https://www.nahdionline.com/en-sa/pdp/${item.item_id}`
            : "";

        return {
          url: link,
          category: retailCategory || internalCategory || "",
          brand: item.item_brand || "",
          title: item.item_name || "",
          sku: String(item.item_id || ""),
          // price is what the shopper pays, shelf_price is the pre-discount
          // list price. The old detail-page scrape read the struck-through
          // figure into `price` and left `mrp` at 0 — for SKU 103804790 that
          // meant price 878.6 when the product actually sells for 254.
          price: parseFloat(item.price) || parseFloat(item.shelf_price) || 0,
          mrp: parseFloat(item.shelf_price) || parseFloat(item.price) || 0,
          // Not carried by this endpoint. They were never match gates — the
          // four gates are title, brand, color and image_similarity — so
          // nothing in the scoring regresses by leaving them empty.
          totalRating: "",
          totalReview: "",
          express: false,
          description: "",
          // One image (the main catalogue shot) where the product page offered
          // ~11. This is the real trade-off of the API route: image_similarity
          // IS one of the four gates. The main shot is the one that carries the
          // comparison, and a blocked run returns no images at all.
          images: item.item_image_link ? [item.item_image_link] : [],
        };
      },
    },
  },

  firstcryAE: {
    id: "firstcryAE",
    label: "Firstcry UAE",
    scraper: "puppeteer",
    needsDetailFetch: true,

    // Verified live 2026-07-21: a plain multi-word query returns a real
    // search-results page. Single strong keywords (e.g. a category name)
    // can 302 straight to a category listing instead — still a valid page
    // of products, just not literally a "/search" URL.
    buildSearchUrl: (query) =>
      `https://www.firstcry.ae/search?q=${encodeURIComponent(query)}`,

    // Card container verified live: div.lblock. Using contains() instead of
    // an exact class match since firstcry.ae's class strings carry extra
    // layout modifiers (e.g. "lblock" alone vs longer variants).
    //
    // That looseness is why the de-dupe below is needed. Each product card
    // holds several links to the same product page (photo, title, price),
    // and the card is built as nested divs whose class strings all contain
    // "lblock", so `//a[@href][1]` — which takes the first anchor under
    // EVERY matching node, not the first per card — collects each product
    // many times over. Measured on the 2026-07-25 run: 308 links for 44
    // distinct products on a single search, i.e. ~7x the detail fetches
    // needed (~7 hours instead of ~1 for a 10-SKU run), plus a candidate
    // list whose first entries were all repeats of one product.
    //
    // De-duping the output is deliberate over tightening the XPath: it
    // can't silently break if Firstcry restyles their grid, whereas a more
    // specific container selector would.
    extractListingLinks: (doc) => {
      const links = xpath.select("//div[contains(@class,'lblock')]//a[@href][1]", doc);
      const seen = new Set();

      return links
        .map((a) => a.getAttribute("href"))
        .filter((href) => Boolean(href) && !/^\s*(javascript:|#)/i.test(href))
        .map((href) => {
          if (href.startsWith("//")) return `https:${href}`;
          if (href.startsWith("http")) return href;
          return `https://www.firstcry.ae${href}`;
        })
        .filter((url) => {
          // De-dupe on Firstcry's product id (the path segment before
          // "product-detail"), not the URL. Comparing URLs isn't enough:
          // the same id is linked under one slug per colour swatch on the
          // card — id dfd27aed83f43 alone appears as ...-newton-black,
          // -red, -gold, -khaki, -picasso, -dark-grey and more.
          //
          // Those are NOT separate products. Verified live 2026-07-26 by
          // fetching the -newton-black and -red URLs: identical title,
          // price (567.03), brand and all 20 image URLs. Firstcry routes on
          // the id and treats the slug as decoration, so fetching each
          // colour slug just re-downloads the same page.
          //
          // Measured on this search: 303 raw links -> 131 unique URLs ->
          // 40 actual products.
          const parts = url.split("?")[0].split("/").filter(Boolean);
          const idx = parts.indexOf("product-detail");
          // Fall back to the whole path if the URL isn't shaped as expected,
          // so an unrecognised link is kept rather than silently dropped.
          const key = idx > 0 ? parts[idx - 1] : url.split("?")[0];

          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },

    extractDetail: (doc, link) => {
      // /text() (not the element) so the trailing promo badge text
      // (e.g. "Freeoffer") that Firstcry renders as a nested <span> inside
      // the same <h1> doesn't get concatenated into the title.
      const title = xpath.select("//h1[contains(@class,'prod-name')]/text()", doc)?.[0]?.nodeValue?.trim();
      const price = xpath.select("//span[contains(@class,'pdprice')]//span[contains(@class,'main_prc')]", doc)?.[0]?.textContent;
      const brandLinkText = xpath.select("//a[contains(@class,'R12_link')]", doc)?.[0]?.textContent;
      const brand = brandLinkText ? brandLinkText.replace(/^View All\s+/i, "").replace(/\s+Products$/i, "").trim() : "";
      const images = xpath.select("//img[contains(@class,'thumb-img')]", doc).map((itm) => itm.getAttribute("src")).filter(Boolean);
      const ratingText = xpath.select("//div[contains(@class,'p_rating_c')]", doc)?.[0]?.textContent;

      return {
        url: link,
        category: "",
        brand: brand || "",
        title: title || "",
        sku: link.split("/").filter(Boolean).slice(-2, -1)[0] || "",
        price: parseFloat(price) || 0,
        // No confirmed sample with a strikethrough MRP yet — falls back to
        // price like Nahdi does, rather than guessing an unverified selector.
        mrp: parseFloat(price) || 0,
        totalRating: ratingText || "",
        totalReview: "",
        express: false,
        description: "",
        images: images || [],
      };
    },
  },

  amazonAE: {
    id: "amazonAE",
    label: "Amazon UAE",
    // Was ScrapeOps (itself a stand-in for the ScrapingAnt key HLD section 5
    // specified, which that API rejected as "API token is wrong"). Both are
    // retired — this target is fetched in-browser like every other one.
    scraper: "puppeteer",
    scraperOptions: { country: "ae" },
    needsDetailFetch: false,

    // Amazon prints a brand byline (h2.a-size-mini) on most search cards but
    // not all — typically ~5 of 48 on a Teknum search, and occasionally a
    // whole results page renders without any. Those cards aren't brandless
    // products: the brand IS in Amazon's catalogue, just not on the card
    // (verified 2026-07-26 on B0GH7PYQPR, whose product page shows
    // "Brand: TEKNUM" while its search card shows no byline at all).
    //
    // Since brand is one of the four match gates, leaving those blank scores
    // them 0 and rejects them outright — including, for the SLD stroller,
    // the single closest title match on the page. So top up just the gaps
    // with a targeted product-page fetch, rather than either (a) leaving
    // them blank or (b) detail-fetching all 48 candidates, which at ~15s a
    // page would be ~12 minutes per source product.
    brandFallback: {
      needed: (candidate) => !candidate.brand || !String(candidate.brand).trim(),
      buildUrl: (candidate) => `https://www.amazon.ae/-/en/dp/${candidate.sku}`,
      // These fields are server-rendered, so waiting for the page's JS to
      // settle is wasted here — renderJs: false returns as soon as the DOM is
      // parsed. (Under ScrapeOps the equivalent render_js=false was measured
      // 2026-07-26 at ~16s vs ~33s for the same brand value.)
      scraperOptions: { country: "ae", renderJs: false },
      // Safety valve. If a whole page came back without bylines this would
      // otherwise fetch all 48; better to enrich the first N and leave the
      // rest blank than to stall the run.
      maxFetches: 15,
      extract: (doc) => {
        // Preferred: the "Brand" row of the product-overview table — it's a
        // bare value ("TEKNUM") with no prefix to strip.
        const fromTable = xpath
          .select("//tr[contains(@class,'po-brand')]//span[contains(@class,'po-break-word')]", doc)?.[0]
          ?.textContent?.trim();
        if (fromTable) return fromTable;

        // Fallback: the byline under the title. Renders as either
        // "Brand: TEKNUM" or "Visit the TEKNUM Store" depending on whether
        // the seller has a storefront, so strip both shapes.
        const byline = xpath.select("//a[@id='bylineInfo']", doc)?.[0]?.textContent?.trim();
        if (!byline) return "";
        return byline
          .replace(/^Brand:\s*/i, "")
          .replace(/^Visit the\s+/i, "")
          .replace(/\s+Store$/i, "")
          .trim();
      },
    },

    // The "/-/en/" path prefix is the fix for the 2026-07-25 run coming back
    // with 468/479 candidate titles in Arabic (which scored ~0.04 against our
    // English source titles). Verified live 2026-07-26 — of the approaches
    // tried against this exact query, ONLY this one works:
    //   plain /s?k=              -> 48/48 Arabic
    //   + ScrapeOps country=ae   -> 48/48 Arabic
    //   + Accept-Language en-AE  -> 48/48 Arabic
    //   + &language=en_AE        -> 48/48 Arabic
    //   /-/en/s?k=               -> 0/48 Arabic  <-- this one
    // i.e. amazon.ae picks its storefront language from the URL path, not
    // from the exit IP's geo or from request headers.
    buildSearchUrl: (query) =>
      `https://www.amazon.ae/-/en/s?k=${encodeURIComponent(query)}`,

    // Verified live 2026-07-21. Deliberately NOT reusing the utility-class
    // selector from cluster-service/bulkUpload.js
    // ("div.a-section.a-spacing-small.puis-padding-left-small...") — a live
    // check today showed Amazon's own h2 class has already drifted from
    // what that file expects (missing "a-spacing-none"), i.e. that selector
    // is stale. `data-component-type='s-search-result'` + `data-asin` are
    // Amazon's own stable hooks and matched all 60 results in the same
    // live check, so used here instead.
    extractListingProducts: (doc) => {
      const items = xpath.select("//div[@data-component-type='s-search-result']", doc);

      return items.map((item) => {
        const asin = item.getAttribute("data-asin");

        // Each card carries TWO h2s, and which is which matters:
        //   h2.a-size-mini       -> brand   ("TEKNUM")
        //   h2.a-size-base-plus  -> title   ("Travel Lite Shock Proof Stroller Sld|...")
        // The old selector was a bare ".//h2" taking [0], so on the English
        // storefront it would have returned the BRAND as the title. Verified
        // live 2026-07-26: 44 of 48 cards carry both.
        const brand = xpath.select(".//h2[contains(@class,'a-size-mini')]", item)?.[0]?.textContent?.trim() || "";
        const rawTitle =
          xpath.select(".//h2[contains(@class,'a-size-base-plus')]", item)?.[0]?.textContent?.trim() ||
          // The ~4 cards per page with only one h2 put the full name there.
          xpath.select(".//h2", item)?.[0]?.textContent?.trim() ||
          "";

        // Amazon splits the brand out of the displayed title, so the raw
        // title reads "Travel Lite Shock Proof Stroller Sld|..." while our
        // source title is "Teknum SLD Travel Lite Stroller - Black". Compose
        // them back into the full product name the shopper actually sees, or
        // the brand token is missing from one side of every title comparison.
        const title =
          brand && !new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(rawTitle)
            ? `${brand} ${rawTitle}`.trim()
            : rawTitle;

        const priceWhole = xpath.select(".//span[contains(@class,'a-price-whole')]", item)?.[0]?.textContent;
        const priceFraction = xpath.select(".//span[contains(@class,'a-price-fraction')]", item)?.[0]?.textContent;
        // contains() rather than an exact class match: Amazon ships this img
        // as both class="s-image" and class="s-image s-image-optimized-..."
        // depending on the layout bucket the request lands in, and an exact
        // match silently yields no images on the latter.
        const image = xpath.select(".//img[contains(@class,'s-image')]", item)?.[0]?.getAttribute("src");

        const price = priceWhole
          ? parseFloat(`${priceWhole.replace(/[^0-9]/g, "")}.${priceFraction || "0"}`)
          : 0;

        return {
          // "/-/en/" for the same reason as buildSearchUrl above: without it
          // a click-through from the exported sheet lands on the Arabic page.
          url: asin ? `https://www.amazon.ae/-/en/dp/${asin}` : "",
          category: "",
          // Previously hardcoded "" on the assumption brand wasn't on the
          // search grid, which zeroed the brand gate for all 479 candidates
          // in the 2026-07-25 run. It IS on the grid (h2.a-size-mini above),
          // so no detail-page fetch is needed for this target after all.
          brand: brand,
          title: title || "",
          sku: asin || "",
          price: price || 0,
          mrp: price || 0,
          totalRating: "",
          totalReview: "",
          express: false,
          description: "",
          images: image ? [image] : [],
        };
      }).filter((p) => p.url);
    },
  },
};

module.exports = targetSites;
