const xpath = require("xpath");

// Each entry describes everything that is specific to one target website:
// how to search it, how to read a search-results page, and (if needed) how
// to read an individual product page. Adding a new marketplace means adding
// an entry here, not touching the matching engine in index.js.
//
// `scraper` selects which proxy client fetchHtml() (helper/scrapeClient.js)
// uses to actually retrieve the page — sites differ in how aggressively they
// block scrapers, so the fetch method is part of the site's config too.
//
// `needsDetailFetch: true`  -> visit each candidate's own product page for
//   full field data (title/price/brand/images). Used for sites whose search
//   results don't carry enough data to compare against (Nahdi, Firstcry UAE).
// `needsDetailFetch: false` -> build the full candidate object directly from
//   the search-results page, no second request per candidate. Used for
//   Amazon UAE, mirroring the approach already proven in
//   sellerpundit-backend/cluster-service/bulkUpload.js — visiting individual
//   Amazon product pages at scale carries a much higher block risk than
//   reading the search-results grid once.

const targetSites = {
  nahdi: {
    id: "nahdi",
    label: "Nahdi",
    scraper: "scrapeops",
    needsDetailFetch: true,

    buildSearchUrl: (query) =>
      `https://www.nahdionline.com/en-sa/search?query=${encodeURIComponent(query)}`,

    extractListingLinks: (doc) =>
      xpath
        .select("//a[@class='flex h-full flex-col']", doc)
        .map((itm) => "https://www.nahdionline.com" + itm.getAttribute("href")),

    extractDetail: (doc, link) => {
      const category = xpath
        .select("//ul[@class='flex items-center text-custom-xs font-semibold text-gray ']/li", doc)
        ?.map((itm) => itm.textContent)
        .join(" > ");
      const brand = xpath.select("//div[@class='flex items-center space-x-2 empty:hidden rtl:space-x-reverse']", doc)?.[0]?.textContent;
      const title = xpath.select("//h1", doc)?.[0]?.textContent;
      const price = xpath.select("//div[@class='flex items-center text-primary-red']", doc)?.[0]?.textContent;
      const mrp = xpath.select("//div[@class='items-center mx-2 flex text-lg text-gray-500 line-through']", doc)?.[0]?.textContent;
      const express = xpath.select("//div[@class='ms-1 flex min-w-fit flex-row']/img", doc).length > 0;
      const description = xpath.select("//div[@class='pdp-about-section']", doc);
      const totalRating = xpath.select("//span[@class='flex items-center gap-2 text-2xl font-semibold']", doc)?.[0]?.textContent;
      const totalReview = xpath.select("//span[@class='hidden text-xl lg:block']", doc)?.[0]?.textContent;
      const images = xpath
        .select("//img[@class='relative h-full w-full object-contain transition duration-300 ease-in-out group-hover:scale-105']", doc)
        .map((itm) => itm.getAttribute("src"));

      return {
        url: link,
        category: category || "",
        brand: brand || "",
        title: title || "",
        sku: link.split("/").pop().split("?")[0] || "",
        price: parseFloat(price) || parseFloat(mrp) || 0,
        mrp: parseFloat(mrp) || 0,
        totalRating: totalRating || "",
        totalReview: totalReview || "",
        express: express || false,
        description: description[0]?.textContent || "",
        images: images || [],
      };
    },
  },

  firstcryAE: {
    id: "firstcryAE",
    label: "Firstcry UAE",
    scraper: "scrapeops",
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
    // HLD section 5 specifies ScrapingAnt for this target, but that key
    // (helper/scrapeClient.js) is currently rejected by the API with
    // "API token is wrong", so ScrapeOps it is until someone re-issues it.
    scraper: "scrapeops",
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
      // These fields are server-rendered, so JS rendering is wasted here —
      // verified 2026-07-26: render_js=false returns the same brand in
      // ~16s vs ~33s.
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
