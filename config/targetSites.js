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
    extractListingLinks: (doc) => {
      const links = xpath.select("//div[contains(@class,'lblock')]//a[@href][1]", doc);
      return links
        .map((a) => a.getAttribute("href"))
        .filter((href) => Boolean(href) && !/^\s*(javascript:|#)/i.test(href))
        .map((href) => {
          if (href.startsWith("//")) return `https:${href}`;
          if (href.startsWith("http")) return href;
          return `https://www.firstcry.ae${href}`;
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
    scraper: "scrapeops",
    needsDetailFetch: false,

    buildSearchUrl: (query) =>
      `https://www.amazon.ae/s?k=${encodeURIComponent(query)}&ref=nb_sb_noss`,

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
        const title = xpath.select(".//h2", item)?.[0]?.textContent?.trim();
        const priceWhole = xpath.select(".//span[@class='a-price-whole']", item)?.[0]?.textContent;
        const priceFraction = xpath.select(".//span[@class='a-price-fraction']", item)?.[0]?.textContent;
        const image = xpath.select(".//img[@class='s-image']", item)?.[0]?.getAttribute("src");

        const price = priceWhole
          ? parseFloat(`${priceWhole.replace(/[^0-9]/g, "")}.${priceFraction || "0"}`)
          : 0;

        return {
          url: asin ? `https://www.amazon.ae/dp/${asin}` : "",
          category: "",
          // Not available from the search-results grid without visiting the
          // product page (out of scope for this target, see needsDetailFetch
          // above) — left blank. This is a known gap: the matching engine's
          // brand-similarity score will be unreliable for Amazon UAE
          // candidates until/unless detail-page fetching is added for it.
          brand: "",
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
