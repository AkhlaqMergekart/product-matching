const path = require("path");
const xpath = require("xpath");

// config.json is the repo's home for deploy-time overrides (see
// config/proxy.js); a missing file just means "use the defaults".
const fileConfig = (() => {
  try {
    return require(path.join(__dirname, "..", "config.json"));
  } catch (err) {
    return {};
  }
})();

// Each entry describes everything that is specific to one target website:
// how to search it, how to read a search-results page, and (if needed) how
// to read an individual product page. Adding a new marketplace means adding
// an entry here, not touching the matching engine in index.js.
//
// `scraper` names the fetch strategy fetchHtml() (helper/scrapeClient.js)
// uses to retrieve the page, both of them routed through the Webshare
// rotating proxy:
//   "axios"     -> a plain GET with a real browser's headers on a sticky
//                  proxy tunnel (helper/httpClient.js). ~1-5s a page, an
//                  order of magnitude cheaper than a browser, and the
//                  preferred option — Nahdi, Myntra and Nykaa Fashion all
//                  serve everything the extractors need to it.
//   "puppeteer" -> real headless Chrome (helper/browserClient.js). Needed
//                  only where a page's data is injected by its own
//                  JavaScript, or where the site won't serve a non-browser
//                  client at all: Amazon UAE and Firstcry UAE.
// The legacy names "scrapeops" / "scrapingant" are still accepted and map to
// the browser, so an old config keeps working. ScrapeOps itself is no longer
// a `scraper` value — it is now a vendor-level FALLBACK behind both
// strategies (config/scrapingVendors.js, helper/scrapeOpsClient.js), so a
// target does not opt into it.
//
// A target with `searchApi` skips everything below: its own search API
// returns full candidates in one request, with no search page involved. Used
// for Mumzworld (its Algolia index).
//
// Otherwise there are three ways a target can turn one search page into full
// candidate objects. buildCandidatesFromSearch() in index.js checks them in
// this order:
//
// 1. `detailApi` -> read the SKUs off the search page, then fetch every
//    candidate's data from the site's own JSON endpoint in one batched request.
//    One request for the whole candidate set. Used for Nahdi.
// 2. `needsDetailFetch: false` -> build the full candidate object directly
//    from the search-results page, no second request at all. Used for Amazon
//    UAE, whose grid carries enough data to compare against and whose product
//    pages carry a much higher block risk than reading the grid once; and for
//    Myntra and Nykaa Fashion, whose grids are rendered client-side but which
//    ship the JSON their own app hydrates from in a <script> on that page —
//    richer than the grid, and still one request.
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

// Pulls a JSON object out of a `<script>` that assigns one to a global, e.g.
// Myntra's `window.__myx = {...}`. Same reasoning as extractJsonLdProduct
// above: the blob is what the site's own app hydrates from, so it is
// server-rendered and maintained, where the grid it renders into is not in the
// HTML at all.
//
// `prefix` must match the assignment including its `=`. Several scripts on a
// page can share a global's name as a prefix (window.__myx vs
// window.__myx_seo__), and matching loosely picks up the wrong one.
//
// Returns null rather than throwing when nothing matches or the blob is
// malformed, so an extractor reports "no candidates" instead of aborting the
// source product.
function extractAssignedJson(doc, prefix) {
  for (const script of xpath.select("//script", doc)) {
    const text = script.textContent || "";
    const match = text.match(prefix);
    if (!match) continue;

    // From the assignment's `{` to the end of the script, minus a trailing
    // semicolon. These blobs are the whole body of their script tag.
    const start = text.indexOf("{", match.index + match[0].length - 1);
    if (start === -1) continue;

    try {
      return JSON.parse(text.slice(start).trim().replace(/;\s*$/, ""));
    } catch (err) {
      // Keep looking: on Myntra the first `window.__myx`-prefixed script is
      // `window.__myx_deviceType__ = 'desktop'`, which is not an object at
      // all. A strict `prefix` makes that rare, not impossible.
      continue;
    }
  }

  return null;
}

// Query text for a target that searches better on brand + title than on title
// alone (see `buildQuery` in the Myntra / Nykaa Fashion entries). Prepends the
// source product's brand unless its title already carries it, so a title like
// "Nike Air Max SC SE" isn't searched as "Nike Nike Air Max SC SE".
function composeBrandTitleQuery(product) {
  const title = typeof product?.title === "string" ? product.title.trim() : "";
  const brand = typeof product?.brand === "string" ? product.brand.trim() : "";
  return prefixBrand(brand, title) || title || brand;
}

// Strips HTML to readable text. The storefronts ship these descriptions as
// markup fragments ("<p>…<br>…</p>"), which is noise in a spreadsheet cell.
function htmlToText(value) {
  return String(value || "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Pulls a labelled figure out of Nykaa Fashion's brand_book "horizontal
// widget", whose items are {title: "3k+", subtitle: "Orders \nFulfilled"}.
// Matched on the subtitle because the order of the four is not guaranteed, and
// with whitespace collapsed because the subtitles carry embedded newlines.
function brandBookFigure(items, pattern) {
  const match = (items || []).find((item) => pattern.test(String(item?.subtitle || "").replace(/\s+/g, " ").trim()));
  return match ? String(match.title || "").trim() : "";
}

// Query text as a URL path segment, for a site that puts the search terms in
// the path (Myntra). Anything that isn't alphanumeric collapses to a single
// hyphen, which is the form Myntra itself canonicalises to — and the reason
// losing an apostrophe here is harmless is that the real query travels
// alongside it in `rawQuery`.
function slugify(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Casefold, strip accents, drop everything that isn't a letter or digit. Used
// only to decide whether two strings name the same brand — never to build text
// that is sent anywhere.
function normalizeBrandText(value) {
  return String(value || "")
    .normalize("NFD")
    // Combining marks, so "L'Oréal" and "Loreal" compare equal.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Shared by the query builder and the two extractors: `brand` followed by
// `text`, unless `text` already names that brand.
//
// "Already names it" is deliberately not a literal match. Catalogue rows
// routinely write the brand one way in the `brand` column and another way in
// the title, and an exact comparison treats those as different brands:
//
//   brand "Levis"         + title "Levi's 511 Slim Fit Jeans"
//   brand "Levi's"        + title "Levis Men 511 Slim Fit Jeans"
//   brand "L'Oréal Paris" + title "Loreal Paris Total Repair Shampoo"
//   brand "M&S"           + title "M & S Cotton Shirt"
//
// Each of those would otherwise be searched as "Levis Levi's 511 Slim Fit
// Jeans" — the brand token duplicated in a mangled form, which is worse for
// relevance ranking than either spelling alone. So the comparison is made on
// both strings stripped of case, accents and punctuation.
function prefixBrand(brand, text) {
  const name = (text || "").trim();
  const brandName = (brand || "").trim();
  if (!brandName) return name;
  if (!name) return brandName;

  const normBrand = normalizeBrandText(brandName);
  const normName = normalizeBrandText(name);

  if (!normBrand) return name;

  // Stripping punctuation also strips word boundaries, so containment can
  // over-match: brand "Gap" is found inside "Gapless Seamless Tee" and the
  // prefix is skipped. That is the harmless direction to be wrong in — the
  // query loses a brand token it would have gained, rather than gaining a
  // mangled duplicate of one.
  //
  // Below 3 normalized characters the over-match stops being harmless (a
  // 2-letter brand is a substring of a great many words), so those fall back
  // to a strict word-boundary test on the original text. The cost is that a
  // short punctuated brand still duplicates: brand "M&S" normalizes to "ms",
  // so "M&S" + "M & S Cotton Shirt" is searched as "M&S M & S Cotton Shirt".
  // No brand in the current projects is affected.
  if (normBrand.length >= 3) {
    return normName.includes(normBrand) ? name : `${brandName} ${name}`;
  }

  const escaped = brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}($|\\W)`, "i").test(name) ? name : `${brandName} ${name}`;
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
        // JSON-LD brand is either a bare string or a Brand object. A Brand
        // with name: null must become "", not fall through to the object —
        // the matching service 422s the whole batch on a non-string brand.
        brand: (typeof product?.brand === "string" ? product.brand : product?.brand?.name) || "",
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

  // -------------------------------------------------------------------------
  // Myntra and Nykaa Fashion are both Mode C (needsDetailFetch: false), but
  // not in the way Amazon UAE is: their search grids are rendered client-side,
  // so there is nothing for an xpath selector to read. What they DO ship,
  // server-rendered in a <script> on the search page, is the exact JSON their
  // own React app hydrates from — which carries more per product than a card
  // ever shows (full gallery, brand, MRP vs selling price, category path).
  //
  // So the extractors below read that blob rather than the DOM. Both verified
  // live 2026-10-31 through the Webshare proxy on a plain GET (no browser, no
  // ScrapeOps needed): Myntra 706 KB / 50 products, Nykaa Fashion 860 KB / 36
  // products, for a `brand + title` query.
  //
  // First page only, per the brief — and that is what these blobs contain. No
  // pagination: Myntra exposes `searchData.nextPaginationContext` and Nykaa
  // `listingV2.currentPage`, both deliberately unused.
  // -------------------------------------------------------------------------
  myntra: {
    id: "myntra",
    label: "Myntra",
    scraper: "axios",
    needsDetailFetch: false,

    // Searched by brand + title rather than title alone. Myntra's relevance
    // ranking leans heavily on the brand token, and our source titles don't
    // always carry it.
    buildQuery: composeBrandTitleQuery,

    // Myntra's search URL puts the query in the PATH as a slug and repeats it
    // in `rawQuery`. The slug is what the site canonicalises to; rawQuery is
    // what it actually searches on, which is why an apostrophe or a stray
    // symbol lost to slugification costs nothing.
    buildSearchUrl: (query) =>
      `https://www.myntra.com/${slugify(query) || "search"}?rawQuery=${encodeURIComponent(query)}`,

    extractListingProducts: (doc) => {
      // Three scripts on the page start with `window.__myx` — the state blob
      // plus `window.__myx_deviceType__` and `window.__myx_seo__`. The `=`
      // with nothing between it and the name is what distinguishes the one we
      // want; matching on the prefix alone picks up `'desktop'` and fails.
      const state = extractAssignedJson(doc, /window\.__myx\s*=\s*/);
      const products = state?.searchData?.results?.products;
      if (!Array.isArray(products)) return [];

      return products
        .map((item) => {
          // landingPageUrl is relative with no leading slash
          // ("sports-shoes/nike/nike-air-max-sc-se-womens-shoes/46384606/buy").
          const url = item.landingPageUrl
            ? `https://www.myntra.com/${String(item.landingPageUrl).replace(/^\//, "")}`
            : item.productId
              ? `https://www.myntra.com/${item.productId}`
              : "";

          // masterCategory > subCategory > articleType, e.g.
          // "Footwear > Shoes > Sports Shoes". `category` on its own is just
          // the leaf, so build the path the other targets supply.
          const category = [item.masterCategory?.typeName, item.subCategory?.typeName, item.articleType?.typeName]
            .filter((part) => part && String(part).trim())
            .join(" > ") || item.category || "";

          // The gallery carries a "size_representation" view whose src is ""
          // (a size chart, not the product), so filter on the value rather
          // than trusting every entry.
          const images = (Array.isArray(item.images) ? item.images : [])
            .map((img) => img?.src)
            .filter((src) => typeof src === "string" && src.trim());

          const brand = typeof item.brand === "string" ? item.brand.trim() : "";
          // Myntra's productName already leads with the brand ("Nike Air Max
          // SC SE Women's Shoes"), unlike Amazon's split cards — so prefix
          // only when it genuinely isn't there.
          const title = prefixBrand(brand, item.productName || item.product || "");

          const price = round2(item.price);
          const mrp = round2(item.mrp) || price;

          return {
            url,
            category,
            brand,
            title,
            sku: String(item.productId || ""),
            price,
            mrp,
            totalRating: item.rating ? String(item.rating) : "",
            totalReview: item.ratingCount ? String(item.ratingCount) : "",
            express: false,
            description: typeof item.additionalInfo === "string" ? item.additionalInfo.trim() : "",
            images,
          };
        })
        .filter((p) => p.url);
    },

    // Fetched for the MATCHED product only — one extra page per source
    // product, not per candidate. These fields are not on the search listing
    // at all (the blob there has no ratings, sizes, description or
    // attributes), so there is no way to get them without the product page,
    // and no reason to pay for it 50 times when 49 are discarded.
    //
    // Reads pdpData out of the product page's own `window.__myx`, the same
    // mechanism as the listing. Verified live 2026-10-31 against
    // /sports-shoes/nike/nike-air-max-sc-se-womens-shoes/46384606/buy.
    matchedDetail: {
      buildUrl: (candidate) => candidate.url,

      extract: (doc, url) => {
        const state = extractAssignedJson(doc, /window\.__myx\s*=\s*/);
        const pd = state?.pdpData;
        if (!pd) return { url, error: "no pdpData on the product page" };

        const ratings = pd.ratings || {};

        // Sizes carry an `available` flag, and an out-of-stock size is not a
        // size you can buy — so both lists are kept rather than collapsing
        // them, which would misreport availability either way.
        const allSizes = (Array.isArray(pd.sizes) ? pd.sizes : []).map((s) => String(s.label || "").trim()).filter(Boolean);
        const inStockSizes = (Array.isArray(pd.sizes) ? pd.sizes : [])
          .filter((s) => s.available)
          .map((s) => String(s.label || "").trim())
          .filter(Boolean);

        // productDetails is a list of titled sections, matching the page's own
        // headings: "Product Details" (the prose the shopper reads first),
        // "MATERIAL & CARE", "SIZE & FIT". The description is the first; the
        // others are kept under `sections` rather than thrown away, since they
        // cost nothing once the page is fetched.
        const sections = Array.isArray(pd.productDetails) ? pd.productDetails : [];
        const mainDetail = sections.find((s) => /^product details$/i.test(String(s.title || "").trim()));

        return {
          url,
          // Myntra's own product id, the same value the search listing yields
          // as `sku`. Carried here too so the enriched row stands alone.
          sku: String(pd.id || ""),
          title: pd.name || "",
          brand: (typeof pd.brand === "string" ? pd.brand : pd.brand?.name) || "",
          // Rounded: Myntra reports the raw mean (4.386759581881533), which is
          // noise in a spreadsheet cell.
          rating: ratings.averageRating != null ? String(round2(ratings.averageRating)) : "",
          ratingCount: ratings.totalCount != null ? String(ratings.totalCount) : "",
          reviewCount: ratings.reviewInfo?.reviewsCount != null ? String(ratings.reviewInfo.reviewsCount) : "",
          size: inStockSizes.join(", "),

          // Full gallery from the PDP, in album order. src/secureSrc carry
          // Myntra's ($height)/($width) placeholders, so imageURL — the plain,
          // directly fetchable form — is preferred, and any residual
          // placeholder URL is dropped rather than handed on unusable.
          images: (Array.isArray(pd.media && pd.media.albums) ? pd.media.albums : [])
            .flatMap((a) => (Array.isArray(a.images) ? a.images : []))
            .map((img) => img.imageURL || img.secureSrc || img.src)
            .filter((u) => typeof u === "string" && u.length > 0 && u.indexOf("($") === -1),
          sizesAll: allSizes.join(", "),

          // Per-size pricing. The headline mrp/price below is the parent's,
          // which need not be what the size we actually hold costs: each size
          // carries its own sizeSellerData, and a size can be listed by more
          // than one seller at different prices (size 6 of style 27953916 was
          // offered at both 2399 and 5999 on 2026-10-31). The lowest is taken,
          // which is the one the storefront shows.
          variants: (Array.isArray(pd.sizes) ? pd.sizes : []).map((s) => {
            const sellers = Array.isArray(s.sizeSellerData) ? s.sizeSellerData : [];
            const prices = sellers.map((d) => round2(d.discountedPrice)).filter((n) => n > 0);
            const mrps = sellers.map((d) => round2(d.mrp)).filter((n) => n > 0);
            return {
              size: String(s.label || "").trim(),
              available: Boolean(s.available),
              sku: s.skuId != null ? String(s.skuId) : "",
              price: prices.length ? Math.min(...prices) : round2(pd.price?.discounted),
              mrp: mrps.length ? Math.min(...mrps) : round2(pd.mrp),
            };
          }),

          // Myntra puts every COLOUR on its own styleId and its own URL, each
          // with its own price — which is what "the price changes when the
          // colour changes" means here. They are sibling products, not options
          // on this page, so reading a different colour's price means fetching
          // that colour's page.
          baseColour: pd.baseColour || "",
          colourOptions: (Array.isArray(pd.colours) ? pd.colours : []).map((c) => ({
            label: String(c.label || "").trim(),
            styleId: c.styleId != null ? String(c.styleId) : "",
            url: c.url ? `https://www.myntra.com/${String(c.url).replace(/^\//, "")}` : "",
          })),
          mrp: round2(pd.mrp ?? pd.price?.mrp),
          price: round2(pd.price?.discounted ?? pd.mrp),
          // The page's "PRODUCT DETAILS" prose. Both forms are kept: the
          // source markup exactly as the site ships it, and a readable
          // plain-text rendering. Which one is wanted depends on the consumer
          // — a spreadsheet cell needs the text, anything re-rendering the
          // copy needs the original markup — and the HTML cannot be
          // reconstructed from the text once it has been stripped.
          description: htmlToText(mainDetail?.description || ""),
          descriptionHtml: mainDetail?.description || "",
          // The "Specifications" table on the page, as JSON. A flat
          // label -> value map ("Sole Material": "PU", "Sport": "Running").
          specifications: pd.articleAttributes && typeof pd.articleAttributes === "object" ? pd.articleAttributes : {},
          sections: sections.map((s) => ({ title: s.title || "", html: s.description || "", text: htmlToText(s.description || "") })),
        };
      },
    },
  },

  nykaafashion: {
    id: "nykaafashion",
    label: "Nykaa Fashion",
    scraper: "axios",
    needsDetailFetch: false,

    buildQuery: composeBrandTitleQuery,

    buildSearchUrl: (query) =>
      `https://www.nykaafashion.com/catalogsearch/result/?q=${encodeURIComponent(query)}`,

    extractListingProducts: (doc) => {
      // A <script id="__PRELOADED_STATE__" type="application/json">, so the
      // whole element text is the JSON — no assignment prefix to strip.
      const script = xpath.select("//script[@id='__PRELOADED_STATE__']", doc)?.[0];
      if (!script) return [];

      let state;
      try {
        state = JSON.parse(script.textContent);
      } catch (err) {
        return [];
      }

      const listing = state?.listingV2;
      const products = listing?.products;
      if (!Array.isArray(products)) return [];

      // Nykaa Fashion NEVER returns an empty result set. Verified live
      // 2026-10-31: a deliberate nonsense query ("zzzzqqq nonexistent product
      // xyz") still answers with products, `isNotFound: false` and a non-zero
      // `count` — it just substitutes whatever it considers closest.
      //
      // The one honest signal it gives is `uiMessage`, which it sets to
      // "No results found for '<query>'. Showing most relevant results." in
      // exactly that case. Treating those as candidates would spend a full
      // matching-service request (~2.5s for the first call on a product) to
      // score items the site has already said are not results.
      //
      // This only catches the site's own admission. A query it thinks it
      // answered but didn't — "Loreal Paris Total Repair 5 Shampoo" returns
      // bath towels and soap dispensers on a fashion site, with an empty
      // uiMessage and count: 153 — is not detectable here, and is left to the
      // title/brand gates, which score such candidates near 0.
      if (typeof listing.uiMessage === "string" && /^no results found/i.test(listing.uiMessage.trim())) {
        return [];
      }

      return products
        .map((item) => {
          // Nykaa splits the name across two fields, and NOT the way the
          // names suggest: `title` is the brand ("Nike") and `subTitle` is the
          // product ("Men's Downshifter 14 Running Shoes"). Taking `title` as
          // the title — the obvious reading — would compare every candidate on
          // the brand name alone and score ~0 on the title gate.
          const brand = typeof item.title === "string" ? item.title.trim() : "";
          const name = typeof item.subTitle === "string" ? item.subTitle.trim() : "";
          const title = prefixBrand(brand, name) || brand;

          // `price` is the pre-discount list price and `discountedPrice` is
          // what the shopper pays (4895 / 2937 at a 40% discount on the
          // verified sample) — the reverse of the field names' first reading,
          // and the same trap Nahdi's shelf_price was.
          const price = round2(item.discountedPrice) || round2(item.price);
          const mrp = round2(item.price) || price;

          // Full gallery in display order, from the PDP bridge the card
          // carries; imageUrl is just its first entry.
          const gallery = (Array.isArray(item.plp_pdp_bridge?.images) ? item.plp_pdp_bridge.images : [])
            .slice()
            .sort((a, b) => (parseInt(a?.position, 10) || 0) - (parseInt(b?.position, 10) || 0))
            .map((img) => img?.url)
            .filter((url) => typeof url === "string" && url.trim());

          const images = gallery.length > 0 ? gallery : item.imageUrl ? [item.imageUrl] : [];

          return {
            url: item.actionUrl ? `https://www.nykaafashion.com${String(item.actionUrl).replace(/^\/?/, "/")}` : "",
            // `categoryId` is a bare list of numeric ids with no names
            // anywhere on the page, so there is no category path to give here.
            // It was never a match gate.
            category: "",
            brand,
            title,
            sku: String(item.sku || item.id || ""),
            price,
            mrp,
            totalRating: "",
            totalReview: "",
            express: false,
            description: "",
            images,
          };
        })
        .filter((p) => p.url);
    },

    // Matched product only, same rationale as Myntra's above.
    //
    // Two sources on one page, because neither alone is complete:
    //   - `details.skuData.product` in __PRELOADED_STATE__ carries sizes,
    //     prices, the Product details widget and the brand_book figures.
    //   - the schema.org Product block carries the ratings, which the state
    //     does not (`review_rating_json` is {} on every sample seen).
    //
    // Note `hybridPDP.product.details` looks like the obvious place and is
    // empty — Nykaa hydrates that client-side. The data is under `details`,
    // not `hybridPDP`. Verified live 2026-10-31 against
    // /nike-downshifter-14-men-s-road-running-shoe/p/26355138.
    //
    // Its REST API is not an option here: every /rest/appapi/ path probed
    // answered 403/404/400 through the proxy, so the page is the way in.
    matchedDetail: {
      buildUrl: (candidate) => candidate.url,

      extract: (doc, url) => {
        const script = xpath.select("//script[@id='__PRELOADED_STATE__']", doc)?.[0];
        let product = null;
        if (script) {
          try {
            product = JSON.parse(script.textContent)?.details?.skuData?.product || null;
          } catch (err) {
            product = null;
          }
        }

        const ld = extractJsonLdProduct(doc) || {};
        const rating = ld.aggregateRating || {};

        if (!product) {
          // The ratings block alone is still worth returning — better a row
          // with the fields we could read than an empty one.
          return {
            url,
            error: "no skuData on the product page",
            title: ld.name || "",
            brand: typeof ld.brand === "string" ? ld.brand : ld.brand?.name || "",
            rating: rating.ratingValue != null ? String(rating.ratingValue) : "",
            ratingCount: rating.ratingCount != null ? String(rating.ratingCount) : "",
            reviewCount: rating.reviewCount != null ? String(rating.reviewCount) : "",
          };
        }

        // Same brand/name split as the listing: `title` is the brand.
        const brand = typeof product.title === "string" ? product.title.trim() : "";
        const name = typeof product.subTitle === "string" ? product.subTitle.trim() : "";

        // `sizeName` is the display label the shopper picks, and it is the
        // only size field that works across categories: "XS, S, M, L" for a
        // shirt, "32, 34, 36" for a kurta, "UK 6 (EU 40)" for a shoe.
        //
        // `size_data` is NOT a substitute — it is category-specific
        // measurements (eu_size/us_size on footwear, but bust/waist/inseam on
        // apparel), so reading it was why every non-footwear product came back
        // with a blank size. It is kept only as a fallback for an option that
        // somehow has no sizeName.
        //
        // A single-size product (a watch) has isOneSize: true and NO options
        // at all, which is a real answer rather than a gap, so it is labelled
        // instead of left blank.
        const options = Array.isArray(product.sizeOptions?.options) ? product.sizeOptions.options : [];
        const sizeLabels = options
          .map((opt) => {
            const name = String(opt.sizeName || "").trim();
            if (name) return name;
            const eu = opt.size_data?.eu_size?.cm;
            const us = opt.size_data?.us_size?.cm;
            if (eu && us) return `EU ${eu} (US ${us})`;
            return eu ? `EU ${eu}` : us ? `US ${us}` : "";
          })
          .filter(Boolean);

        if (sizeLabels.length === 0 && product.isOneSize) {
          sizeLabels.push("One Size");
        }

        // The "Product details" widget holds a label/value attribute table
        // plus free-text children ("Care instructions", "Pack contains").
        //
        // pdp_sections normally hangs off each size option (identical across
        // sizes, so the first is taken), but a ONE-SIZE product — a watch, a
        // bag — has no options at all and carries them on the product
        // instead. Reading only options[0] left every such product with no
        // description and no specifications: 3 of 10 in the 2026-10-31 run.
        const sections = Array.isArray(options[0]?.pdp_sections)
          ? options[0].pdp_sections
          : Array.isArray(product.pdp_sections)
            ? product.pdp_sections
            : [];
        const detailWidget = sections.find((s) => /^product details$/i.test(String(s.title || "").trim()));
        const children = Array.isArray(detailWidget?.child_widgets) ? detailWidget.child_widgets : [];

        const attributes = {};
        for (const child of children) {
          for (const attr of Array.isArray(child.attributes) ? child.attributes : []) {
            if (attr?.label) attributes[String(attr.label)] = String(attr.value ?? "");
          }
          // plain_widget children are a titled single value.
          if (child?.widget_type === "plain_widget" && child.title) {
            attributes[String(child.title)] = htmlToText(child.value || "");
          }
        }

        // The prose description. On Nykaa this is NOT the "Product details"
        // widget — that one is the attribute grid (Material, Pattern,
        // Occasion…), i.e. the specifications. The description lives in the
        // separate "Know your product" collapsible, whose subtitle is
        // literally ["Description"].
        //
        // Its `value` is sometimes plain text ("PRODUCT STORY: Step up your
        // sneaker game…") and sometimes a full HTML fragment
        // ("<div>…<h3>Benefits</h3><ul>…"), varying by brand feed — so both
        // forms are kept, exactly as for Myntra.
        const kyp = sections.find((s) => /know your product/i.test(String(s.title || "").trim()));
        const descriptionHtml = kyp?.value || "";

        const bookItems = (Array.isArray(product.brand_book) ? product.brand_book : [])
          .find((w) => w?.widget_type === "horizontal_widget")?.items || [];

        // Ratings come from `review_rating_json` first, NOT the JSON-LD.
        // Nykaa omits aggregateRating from the JSON-LD whenever
        // `show_ratings` is false — which it sets for a product with only a
        // couple of ratings — so the JSON-LD alone left 7 of 10 products in
        // the 2026-10-31 run blank. The figures are present either way
        // (star_rating 2.5 / star_rating_count 2 on one such product), and the
        // site's own number is worth having even where the site chooses not
        // to show it. `ratingShown` records that choice so a hidden rating is
        // not mistaken for a displayed one.
        const rr = product.review_rating_json && typeof product.review_rating_json === "object" ? product.review_rating_json : {};
        const ratingValue = rr.star_rating ?? rating.ratingValue;
        const ratingCount = rr.star_rating_count ?? rating.ratingCount;
        const reviewCount = rr.review_count ?? rating.reviewCount;

        return {
          url,
          // Nykaa's own SKU ("NIKEX00086194"), matching the listing's.
          sku: String(product.sku || product.id || ""),
          title: prefixBrand(brand, name) || ld.name || brand,
          brand,
          rating: ratingValue != null ? String(round2(ratingValue)) : "",
          ratingCount: ratingCount != null ? String(ratingCount) : "",
          reviewCount: reviewCount != null ? String(reviewCount) : "",
          ratingShown: rr.show_ratings === undefined ? "" : String(Boolean(rr.show_ratings)),
          size: sizeLabels.join(", "),

          // Full gallery from the PDP. The matching service strips `images`
          // to [] in its response, so this is the only place the matched
          // product's pictures come back.
          images: (Array.isArray(product.productMedia) ? product.productMedia : [])
            .filter((m) => m && m.mediaType === "image" && m.url)
            .sort((a, b) => (parseInt(a.position, 10) || 0) - (parseInt(b.position, 10) || 0))
            .map((m) => m.url),

          // Per-size pricing, same reasoning as Myntra's. Nykaa carries it
          // directly on each size option, so no extra fetch is involved.
          variants: options.map((opt) => ({
            size: String(opt.sizeName || "").trim(),
            available: !opt.isOutOfStock,
            sku: String(opt.sku || opt.id || ""),
            price: round2(opt.discountedPrice) || round2(opt.price),
            mrp: round2(opt.price),
          })),

          // Colour siblings, each its own product with its own action_url.
          colourOptions: (Array.isArray(product.colorOptions) ? product.colorOptions : []).map((c) => ({
            label: String(c?.color?.name || c?.name || c?.title || "").trim(),
            sku: String(c?.sku || c?.id || ""),
            url: c?.actionUrl || c?.action_url ? `https://www.nykaafashion.com${String(c.actionUrl || c.action_url).replace(/^\/?/, "/")}` : "",
          })),
          // `price` is the list price and `discountedPrice` what is charged —
          // the same inversion as the listing.
          mrp: round2(product.price),
          price: round2(product.discountedPrice) || round2(product.price),
          description: htmlToText(descriptionHtml),
          descriptionHtml,
          // Same field name and shape as Myntra's, so one consumer reads both
          // destinations. This is the "Product details" attribute grid the
          // page renders — Material, Pattern, Occasion, Care instructions…
          specifications: attributes,
          // The four brand-trust figures shown on the PDP.
          brandYears: brandBookFigure(bookItems, /^years/i),
          brandOrdersFulfilled: brandBookFigure(bookItems, /orders fulfilled/i),
          brandAverageRating: brandBookFigure(bookItems, /average rating/i),
          brandCustomerRatings: brandBookFigure(bookItems, /customer ratings/i),
        };
      },
    },
  },

  mumzworld: {
    id: "mumzworld",
    label: "Mumzworld",
    // Mode S (searchApi): Mumzworld's search box queries its Algolia index
    // straight from the browser, and every hit already carries name, SKU, URL,
    // full image gallery, price and categories — so one request yields every
    // candidate, with no search page to parse and no product page per
    // candidate. Verified live 2026-10-12.
    //
    // Not the catalog GraphQL API (catalog.mumzworld.com/graphql): its
    // `products(search: ...)` argument is accepted but ignored — it returns the
    // same default listing for any query. It only filters by attribute
    // (brand id, SKU), which is fine for a brand crawl but not a title search.
    searchApi: {
      // The app id, index and search key are what the storefront itself uses;
      // it serves them to every visitor in storeConfig.algoliaSettings
      // (www.mumzworld.com/graphql). That endpoint answers non-browser clients
      // with a 403, so they can't be read at runtime — hence the defaults here.
      // The key is Algolia's public, search-only kind. If Mumzworld rotates it,
      // searches start failing with HTTP 403: read the new one from the
      // x-algolia-api-key parameter of the *.algolia.net request the search
      // page makes, and set MUMZWORLD_ALGOLIA_API_KEY (env) or
      // MUMZWORLD_Algolia_Api_Key (config.json) — no code change needed.
      appId: "0LZ0827VB4",
      apiKey: process.env.MUMZWORLD_ALGOLIA_API_KEY || fileConfig.MUMZWORLD_Algolia_Api_Key || "dc4a1be8e6ca1550969280e60a40a0d3",
      // Saudi English store, matching Nahdi's en-sa and the SAR prices on both.
      indexName: "magento2_aws_live_sa-en_products",
      // Same candidate count as a Nahdi search page.
      hitsPerPage: 20,

      // A GET with the credentials in headers (not the query string), so the
      // key never lands in a logged URL. fetchJson() supplies the proxy,
      // browser headers and retries.
      buildUrl(query) {
        return (
          `https://${this.appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(this.indexName)}` +
          `?query=${encodeURIComponent(query)}&hitsPerPage=${this.hitsPerPage}&distinct=true`
        );
      },
      headers() {
        return {
          "x-algolia-application-id": this.appId,
          "x-algolia-api-key": this.apiKey,
          origin: "https://www.mumzworld.com",
          referer: "https://www.mumzworld.com/",
        };
      },
      extractHits: (response) => (Array.isArray(response?.hits) ? response.hits : []),

      // Same candidate shape as Nahdi's extractDetail, so the matching
      // service sees no difference between destinations.
      mapHit(hit) {
        const sar = hit.price?.SAR || {};
        const price = round2(sar.default);
        const mrp = round2(sar.default_original) || price;

        return {
          url: hit.url || "",
          // Full path, the same "Default Category > ... > Leaf" form as the
          // Mumzworld rows in ScratchProducts.
          category: Array.isArray(hit.categories_without_path_base) ? hit.categories_without_path_base.join(" > ") : "",
          brand: mumzworldBrand(hit),
          title: hit.name || "",
          sku: String(hit.sku || ""),
          price,
          mrp,
          totalRating: "",
          totalReview: "",
          express: false,
          // Not carried by the index.
          description: "",
          images: mumzworldImages(hit),
        };
      },
    },
  },
};

// Prices in the index carry float noise (28.9996 for a 29.00 shelf price).
function round2(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// The index has a `brand` on most products but not all — verified 31 of 40
// hits across six searches, and the catalog GraphQL API has brand: null for
// the same products, so there's nowhere else to get it. Mumzworld's names
// lead with the brand ("Beesline - Whitening Facial Soap - 85 gm"); where both
// exist the prefix equals the brand on 29 of 31. So: the brand field when
// present, else the name's leading segment. A blank brand would score 0 on
// the brand gate and reject the candidate outright, so the fallback can only
// help.
function mumzworldBrand(hit) {
  if (typeof hit.brand === "string" && hit.brand.trim()) return hit.brand.trim();
  const name = typeof hit.name === "string" ? hit.name : "";
  return name.includes(" - ") ? name.split(" - ")[0].trim() : "";
}

// Full gallery in display order. Entry files are paths below the product
// media root ("/a/e/foo.jpg" or "FOO-1.jpg"); image_url carries the resized
// cache prefix the storefront serves them from, so reuse that prefix rather
// than hardcoding its hash. Every URL built this way was fetched 200
// image/jpeg on 2026-10-12, the first one equal to image_url.
function mumzworldImages(hit) {
  const cachePrefix = typeof hit.image_url === "string"
    ? (hit.image_url.match(/^(.*\/media\/catalog\/product\/cache\/[^/]+)\//) || [])[1]
    : null;

  const files = (Array.isArray(hit.media_gallery_entries) ? hit.media_gallery_entries : [])
    .filter((entry) => entry && !entry.disabled && entry.file)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((entry) => entry.file);

  if (cachePrefix && files.length > 0) {
    return files.map((file) => `${cachePrefix}/${String(file).replace(/^\//, "")}`);
  }
  return hit.image_url ? [hit.image_url] : [];
}

// True when two brand strings name the same brand, comparing with case,
// accents and punctuation stripped — so "Levis"/"Levi's" and "L'Oréal"/
// "Loreal" match. Same normalisation prefixBrand() uses.
//
// Exported because callers outside this file need the same test: a candidate
// whose brand is not the source product's brand cannot be the same product,
// and that is checkable without the matching service.
function brandsMatch(a, b) {
  const x = normalizeBrandText(a);
  const y = normalizeBrandText(b);
  if (!x || !y) return false;
  // Containment rather than equality, both ways: marketplaces append or drop
  // qualifiers ("Adidas" vs "Adidas Originals", "Stag" vs "Stag Iconic").
  return x === y || x.includes(y) || y.includes(x);
}

module.exports = targetSites;
module.exports.brandsMatch = brandsMatch;
