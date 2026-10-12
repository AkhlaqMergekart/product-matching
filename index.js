const axios = require("axios");
const fs = require("fs");
const cheerio = require("cheerio");
const dom = require("xmldom").DOMParser;
const express = require("express");
const app = express();
const sendUpdateReportEmail = require("./helper/sendUpdateReport.js");
const { fetchHtml, closeFetchClients } = require("./helper/scrapeClient.js");
const { fetchPage, fetchJson } = require("./helper/httpClient.js");
const { exportResultsToExcel } = require("./helper/exportResults.js");
const timing = require("./helper/timingLogger.js");
const targetSites = require("./config/targetSites.js");
const brandTargets = require("./config/brandTargets.js");

require("./database/config.js");

const ScratchProducts = require("./models/scratchProducts.js");

const MATCH_THRESHOLD = 0.85;
const MATCH_FIELD_KEYS = ["title", "brand", "color", "image_similarity"];
const MATCHING_SERVICE_URL = "http://localhost:8000/api/match";

function appendToFile(filename, data) {
    // Read the file
    return new Promise((resolve, reject) => {

        // Check if the file exists
        if (!fs.existsSync(filename)) {
            // If not, create it with an empty array
            fs.writeFileSync(filename, JSON.stringify([], null, 2), 'utf8');
        }

        fs.readFile(filename, 'utf8', (err, fileData) => {
            if (err) throw err;
            // Parse the JSON data
            let arr = JSON.parse(fileData);

            // Append the data
            if (Array.isArray(data)) {
                console.log(data.length);
                arr = arr.concat(data);
            } else {
                const found = arr.find(itm => itm === data);
                if (!found) {
                    arr.push(data);
                }
            }

            // Write the updated array back to the file
            fs.writeFile(filename, JSON.stringify(arr, null, 2), 'utf8', (err) => {
                if (err) reject(err);
                resolve();
            });
        });
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Ended-line summary for a fetched page in the timing log.
function describeHtml(html) {
    return typeof html === "string" ? `${Math.round(html.length / 1024)} KB` : "";
}

// Second pass for targets whose listing grid is *mostly* complete but drops a
// field on some cards. Fetches the product page for only those candidates,
// rather than making every candidate pay for the few that are short.
// Driven entirely by targetConfig.brandFallback — targets without it (Nahdi,
// Firstcry UAE) are untouched.
async function enrichMissingBrands(targetConfig, candidates) {
    const cfg = targetConfig.brandFallback;
    if (!cfg) return candidates;

    const gaps = candidates.filter((c) => cfg.needed(c));
    if (gaps.length === 0) return candidates;

    const limit = cfg.maxFetches ?? gaps.length;
    const toFetch = gaps.slice(0, limit);

    console.log(
        `  ${targetConfig.label}: ${gaps.length}/${candidates.length} candidates missing brand` +
        `, fetching ${toFetch.length} product page(s) to fill them in` +
        (gaps.length > toFetch.length ? ` (capped at ${limit})` : "")
    );

    // Cache by URL so repeated ASINs in one result set cost one fetch.
    const seen = new Map();

    for (let i = 0; i < toFetch.length; i++) {
        const candidate = toFetch[i];
        const url = cfg.buildUrl(candidate);
        if (!url) continue;

        if (seen.has(url)) {
            candidate.brand = seen.get(url);
            continue;
        }

        await delay(1000);

        try {
            const html = await timing.step(
                `${targetConfig.label} brand fallback page ${i + 1}/${toFetch.length} fetch`,
                () => fetchHtml(targetConfig.scraper, url, cfg.scraperOptions || targetConfig.scraperOptions),
                { detail: url }
            );
            const $ = cheerio.load(html);
            const brand = cfg.extract(new dom().parseFromString($.xml(), "text/xml")) || "";
            seen.set(url, brand);
            candidate.brand = brand;
        } catch (err) {
            // A failed top-up is not fatal — the candidate just keeps its blank
            // brand and will score 0 on that gate, exactly as it would have
            // without this pass at all.
            console.error(`  brand fallback failed for ${url}:`, err.message);
        }
    }

    return candidates;
}

// Turns a search-results page into candidates via the target's own JSON
// endpoint (targetConfig.detailApi), rather than one product-page fetch per
// candidate. Driven entirely by config, so a second site with a usable
// endpoint needs no changes here.
async function buildCandidatesFromApi(targetConfig, doc, query) {
    const cfg = targetConfig.detailApi;

    const skus = cfg.extractListingSkus(doc);
    if (skus.length === 0) {
        console.log(`No products found on ${targetConfig.label} for:`, query);
        return [];
    }

    // De-dupe before asking: a search page can link the same SKU more than
    // once, and the endpoint would just return it twice.
    const uniqueSkus = [...new Set(skus)];
    const batchSize = cfg.batchSize || uniqueSkus.length;
    const batchCount = Math.ceil(uniqueSkus.length / batchSize);
    const candidates = [];

    timing.logEvent(`${targetConfig.label} search page: ${uniqueSkus.length} product SKU(s) extracted`);

    for (let i = 0; i < uniqueSkus.length; i += batchSize) {
        const batch = uniqueSkus.slice(i, i + batchSize);

        if (i > 0) {
            await delay(1000);
        }

        let items;
        try {
            items = await timing.step(
                `${targetConfig.label} product API batch ${i / batchSize + 1}/${batchCount} fetch`,
                () => fetchJson(cfg.buildUrl(batch)),
                {
                    detail: `${batch.length} SKU(s)`,
                    summarize: (res) => (Array.isArray(res) ? `${res.length} item(s)` : ""),
                }
            );
        } catch (err) {
            // Lose this batch, keep the rest — same posture as a failed detail
            // page in the per-candidate path below.
            console.error(`Error fetching ${targetConfig.label} product API for ${batch.length} SKU(s):`, err.message);
            continue;
        }

        if (!Array.isArray(items)) {
            console.error(`Unexpected ${targetConfig.label} product API response (expected an array):`, typeof items);
            continue;
        }

        for (const item of items) {
            try {
                candidates.push(cfg.mapItem(item));
            } catch (err) {
                console.error(`Error mapping ${targetConfig.label} API item:`, err.message);
            }
        }
    }

    console.log(`  ${targetConfig.label}: ${uniqueSkus.length} SKU(s) on the search page -> ${candidates.length} candidate(s) from the product API`);

    return candidates;
}

// Searches `targetConfig`'s site for `query` and returns a full list of
// candidate product objects, ready to hand to the matching service. This is
// the piece that used to be hardcoded to Nahdi — every site-specific fact
// (search URL, listing/detail selectors, which fetch strategy to use) comes
// from targetConfig (config/targetSites.js) instead.
async function buildCandidatesFromSearch(targetConfig, query) {
    const searchUrl = targetConfig.buildSearchUrl(query);

    let searchHtml;
    try {
        searchHtml = await timing.step(
            `${targetConfig.label} search page fetch`,
            () => fetchHtml(targetConfig.scraper, searchUrl, targetConfig.scraperOptions),
            { detail: searchUrl, summarize: describeHtml }
        );
    } catch (err) {
        console.error(`Error searching ${targetConfig.label} for "${query}":`, err.message);
        return [];
    }

    const $ = cheerio.load(searchHtml);
    const doc = new dom().parseFromString($.xml(), "text/xml");

    return buildCandidatesFromDoc(targetConfig, doc, query);
}

// Turns an already-fetched search-results document into candidates, picking one
// of three modes from the target's config. Split out from
// buildCandidatesFromSearch so the legacy flow — which fetches its own search
// page — goes through exactly the same logic instead of its own copy.
async function buildCandidatesFromDoc(targetConfig, doc, query) {
    // Mode A: a page per candidate (Nahdi, Firstcry UAE). The richest data —
    // full image gallery, description, real price — and affordable again now
    // that a page is a ~1-2s GET on a held-open proxy tunnel rather than a
    // ~13s browser navigation.
    if (targetConfig.needsDetailFetch) {
        const candidates = await buildCandidatesFromDetailPages(targetConfig, doc, query);

        // If every page failed, fall back to the site's bulk endpoint where one
        // is configured. Degraded (Nahdi's carries only the main image) but far
        // better than returning nothing for this source product.
        if (candidates.length === 0 && targetConfig.detailApi) {
            console.log(`  ${targetConfig.label}: no candidates from product pages, falling back to the bulk product API`);
            timing.logEvent(`${targetConfig.label}: no candidates from product pages, falling back to the bulk product API`);
            return buildCandidatesFromApi(targetConfig, doc, query);
        }

        return candidates;
    }

    // Mode B: the site has its own JSON endpoint and no detail-page pass. Read
    // the SKUs off the search page and fetch every candidate in one request.
    if (targetConfig.detailApi) {
        return buildCandidatesFromApi(targetConfig, doc, query);
    }

    // Mode C: some targets (Amazon UAE) carry enough data on the search-results
    // page itself, so there's no second request at all.
    const candidates = targetConfig.extractListingProducts(doc);
    timing.logEvent(`${targetConfig.label} search page: ${candidates.length} candidate(s) extracted`);
    return enrichMissingBrands(targetConfig, candidates);
}

// Mode A: one product page per candidate. A failed or unparseable page costs
// only its own candidate.
async function buildCandidatesFromDetailPages(targetConfig, doc, query) {
    const productLinks = targetConfig.extractListingLinks(doc);
    if (productLinks.length === 0) {
        console.log(`No products found on ${targetConfig.label} for:`, query);
        return [];
    }

    timing.logEvent(`${targetConfig.label} search page: ${productLinks.length} product link(s) extracted`);

    const candidates = [];
    for (let i = 0; i < productLinks.length; i++) {
        const link = productLinks[i];

        // Throttle between product detail requests. Kept even on the cheap
        // fetch path — the point is to look like a person reading a catalogue,
        // and the sticky exit IP is only worth holding if we don't hammer it.
        await delay(1000);

        let detailHtml = null;
        try {
            detailHtml = await timing.step(
                `${targetConfig.label} single product scrape ${i + 1}/${productLinks.length}`,
                () => fetchHtml(targetConfig.scraper, link, targetConfig.scraperOptions),
                { detail: link, summarize: describeHtml }
            );
        } catch (err) {
            console.error(`Error fetching ${targetConfig.label} product page:`, link, err.message);
            continue; // Skip this link, keep processing the rest of the batch
        }

        const $$ = cheerio.load(detailHtml);
        const detailDoc = new dom().parseFromString($$.xml(), "text/xml");

        try {
            candidates.push(targetConfig.extractDetail(detailDoc, link));
        } catch (err) {
            console.error(`Error parsing ${targetConfig.label} product page:`, link, err.message);
        }
    }

    console.log(`  ${targetConfig.label}: ${productLinks.length} product page(s) -> ${candidates.length} candidate(s)`);

    return candidates;
}

// Sends originalProduct + candidates to the matching microservice in
// batches of 5 (unchanged from the original Nahdi flow) and returns the
// flattened field-score results. Image similarity is the expensive part of a
// call, so it's opt-in — see matchWithImagePrefilter().
async function callMatchingService(originalProduct, comparableProducts, { includeImageSimilarity = true } = {}) {
    originalProduct.price = originalProduct.price ? parseFloat(originalProduct.price) : 0;
    originalProduct.mrp = originalProduct.mrp ? parseFloat(originalProduct.mrp) : 0;

    let matchData = [];
    const batchSize = 5;
    const batchCount = Math.ceil(comparableProducts.length / batchSize);
    const passLabel = includeImageSimilarity ? "Image matching" : "Text matching";

    for (let i = 0; i < comparableProducts.length; i += batchSize) {
        const batch = comparableProducts.slice(i, i + batchSize);

        const config = {
            method: 'post',
            maxBodyLength: Infinity,
            url: MATCHING_SERVICE_URL,
            headers: {
                'accept': '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'content-type': 'application/json',
                'origin': 'https://www.mumzworld.com',
                'referer': 'https://www.mumzworld.com/',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
                'X-API-Key': "test123#"
            },
            data: {
                "original_product": originalProduct,
                "comparable_products": batch,
                "include_image_similarity": includeImageSimilarity
            },
            timeout: 120000
        };

        const matchResponse = await timing.step(
            `${passLabel} batch ${i / batchSize + 1}/${batchCount}`,
            () => axios.request(config),
            { detail: `${batch.length} candidate(s)` }
        );
        matchData = matchData.concat(matchResponse.data);
    }

    return matchData;
}

// Text scores a candidate must beat (strictly) to be worth an image check.
// Deliberately looser than MATCH_THRESHOLD: this only decides who gets the
// expensive image pass, and the final 0.85 gate still applies afterwards.
const PREFILTER_MIN_TITLE = 0.5;
const PREFILTER_MIN_BRAND = 0.75;

function passesTextPrefilter(scored) {
    const s = scored.field_scores;
    return Boolean(s) && s.title > PREFILTER_MIN_TITLE && s.brand > PREFILTER_MIN_BRAND;
}

// Pass 1 of two-pass matching: every candidate is scored WITHOUT image
// similarity (cheap), and only those with title > 0.5 and brand > 0.75 make
// the `shortlist` for pass 2 — callMatchingService() WITH image similarity,
// whose results are what the result files hold. `textScores` (every
// candidate, each tagged with shortlistedForImageCheck) goes to a file of its
// own and never into the result files.
async function scoreAndShortlist(originalProduct, candidates) {
    const textScores = await callMatchingService(originalProduct, candidates, { includeImageSimilarity: false });

    // The service sorts each batch by composite score, so its results can't be
    // mapped back to `candidates` by index. Match on URL (then SKU) to resend
    // the candidate exactly as it was first sent, falling back to the
    // service's own echo of it.
    const shortlist = [];
    for (const scored of textScores) {
        scored.shortlistedForImageCheck = passesTextPrefilter(scored);
        if (!scored.shortlistedForImageCheck) continue;

        const echoed = scored.product || {};
        const original =
            candidates.find((c) => echoed.url && c.url === echoed.url) ||
            candidates.find((c) => echoed.sku && c.sku === echoed.sku) ||
            echoed;
        shortlist.push(original);
    }

    timing.logEvent(
        `Text pre-filter: ${shortlist.length}/${candidates.length} candidate(s) shortlisted for image check ` +
        `(title > ${PREFILTER_MIN_TITLE}, brand > ${PREFILTER_MIN_BRAND})`
    );

    return { textScores, shortlist };
}

const NO_SHORTLIST_ERROR = `No candidate passed the text pre-filter (title > ${PREFILTER_MIN_TITLE}, brand > ${PREFILTER_MIN_BRAND})`;

// Applies the "all four scores >= 0.85" rule (unchanged threshold) and
// returns the first candidate that clears it, or null.
function pickBestMatch(matchData) {
    for (let i = 0; i < matchData.length; i++) {
        const fieldScores = matchData[i].field_scores;
        const clearsThreshold = fieldScores && MATCH_FIELD_KEYS.every((key) => fieldScores[key] >= MATCH_THRESHOLD);

        if (clearsThreshold) {
            // Unwrap to the product itself. The matching service returns each
            // candidate inside a score envelope —
            //   { product: {...}, composite_score, field_scores, ... }
            // — and this used to hand back that whole envelope as
            // `matchedProduct`. helper/exportResults.js then read .title/.url/
            // .price straight off it, one level too shallow, so a candidate
            // that PASSED all four gates produced a spreadsheet row reading
            // "Matched: Yes" with blank title, URL and price. Invisible so far
            // only because nothing has ever passed.
            //
            // Nothing is lost by unwrapping here: the full envelope for every
            // candidate is already written to the raw JSON further down.
            const matchedProduct = matchData[i].product || matchData[i];
            return { matchedProduct, fieldScores };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Legacy Mumzworld -> Nahdi flow (original, unrefactored implementation).
// Pulls source rows by SKU list + projectId, loads the Nahdi search page in a
// headless browser via the Webshare proxy, reads every candidate from Nahdi's
// own product API in one batched call, and matches against the matching
// microservice. Existing callers of POST /product-matching keep working
// exactly as before.
// ---------------------------------------------------------------------------
async function productMatching(brands, projectId, category) {
    try {

        console.log("Starting product matching for brand:", brands.join(", "), "and projectId:", projectId, "and category:", category || "All");

        if (!brands || brands.length == 0 || !projectId) {
            console.error("Brand and projectId are required parameters.");
            throw new Error("Brand and projectId are required parameters.");
        }

        // The browser is launched (and the Webshare proxy authenticated)
        // lazily by helper/browserClient.js on the first fetch below. This
        // used to launch its own instance here with the same proxy but no
        // page.authenticate() call, so every request through it would have
        // been met with an unanswered proxy auth challenge.

        // for (var z = 0; z < brands.length; z++) {

        // const brand = brands[z];

        const sourceProducts = await ScratchProducts.findAll({
            where: {
                sku: { [Op.in]: brands.map(itm => itm.toString()) },
                projectId: projectId
            },
            // limit: 1,
            raw: true,
            attributes: ['title', 'url', 'brand', 'sku', 'category', 'images', 'attributes', 'price', 'mrp']
        });

        const brand = sourceProducts[0].brand;

        console.log("Brand: ", sourceProducts[0].brand, "Source products count:", sourceProducts.length);

        let retryCount = 0;
        let lastProcessedIndex = -1;

        const outputFilePath = `products_matched_final_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const errorFilePath = `products_matching_errors_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const matchedFilePath = `products_matched_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const textScoresFilePath = `products_text_scores_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const emptyFilePath = `emptyFile.json`
        const timingFilePath = timing.startRun(
            timing.timingLogPath(`${sourceProducts[0].brand}_${projectId}_${Date.now()}`),
            `Nahdi matching for brand ${brand}, project ${projectId}, ${sourceProducts.length} SKU(s)`
        );

        for (var x = 0; x < sourceProducts.length; x++) {

            const sourceProduct = sourceProducts[x];

            // Reset the retry counter only when we advance to a genuinely new
            // product. Retries keep the same index (via x = x - 1), so this keeps
            // the counter per-product instead of leaking across products.
            if (x !== lastProcessedIndex) {
                retryCount = 0;
                lastProcessedIndex = x;
            }

            timing.beginSku(
                sourceProduct.sku,
                `${x + 1}/${sourceProducts.length}${retryCount > 0 ? `, retry ${retryCount}` : ""}`
            );

            // Throttle between products to stay under proxy / site rate limits.
            await delay(1500);

            const url = `https://www.nahdionline.com/en-sa/search?query=${encodeURIComponent(sourceProduct.title)}`;

            console.log(x, sourceProduct.title, url);

            let htmlResponse = null;
            try {
                // One attempt per pass — the retryCount loop below is what
                // retries, exactly as it did when this escalated ScrapeOps'
                // premium tier on retryCount >= 2. There's no tier to
                // escalate now; a retry gets a fresh browser context and
                // therefore a fresh rotating exit IP instead.
                htmlResponse = await timing.step(
                    "Nahdi search page fetch",
                    () => fetchPage(url),
                    { detail: url, summarize: describeHtml }
                );
            } catch (err) {
                console.error("Error navigating to URL:", err);
                retryCount++;
                if (retryCount >= 3) {
                    console.error("Max retries reached for source product:", sourceProduct.title);
                    await appendToFile(errorFilePath, {
                        sourceProduct: sourceProduct,
                        error: "Max retries reached"
                    });
                    continue; // Skip to the next source product
                } else {
                    x = x - 1; // Decrement x to retry the current source product
                    continue; // Skip to the next source product
                }

            }

            const $ = cheerio.load(htmlResponse);

            const doc = new dom().parseFromString($.xml(), 'text/xml');

            // Shares the brand flow's dispatch (config/targetSites.js decides
            // the mode), so the two flows can't drift apart on how a Nahdi
            // product is read and the listing selector exists in exactly one
            // place. It does its own link extraction and its own empty check,
            // which is why the extraction that used to sit here is gone — the
            // productBatches.length check below covers the empty case.
            //
            // This is where the win is for a blocked run: the ~20 full Chrome
            // navigations per source product are now ~20 plain GETs sharing one
            // held-open proxy tunnel.
            let productBatches = [];
            try {
                productBatches = await timing.step(
                    "Nahdi candidate collection",
                    () => buildCandidatesFromDoc(targetSites.nahdi, doc, sourceProduct.title),
                    { summarize: (c) => `${c.length} candidate(s)` }
                );
            } catch (error) {
                console.error("Error building Nahdi candidates:", error);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: error.message
                });

                continue; // Skip to the next source product if there's an error
            }

            if (productBatches.length === 0) {
                console.log("No products found for:", sourceProduct.title);
                timing.logEvent("Result: no products found on Nahdi");
                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No products found"
                });
                continue; // Skip to the next source product if no products found
            }

            console.log("Found products in batch:", productBatches.length);

            let matchData = [];
            let shortlist = [];
            try {
                // Pass 1: text-only scores for every candidate, recorded in
                // their own file before pass 2 so they survive a pass-2 failure.
                const scored = await scoreAndShortlist(sourceProduct, productBatches);
                shortlist = scored.shortlist;

                await appendToFile(textScoresFilePath, {
                    sourceProduct: sourceProduct,
                    matchedProducts: scored.textScores,
                });

                console.log("Shortlisted for image check:", shortlist.length, "of", productBatches.length);

                // Pass 2: image similarity for the shortlist only. This is
                // what the result files below are built from.
                if (shortlist.length > 0) {
                    matchData = await callMatchingService(sourceProduct, shortlist, { includeImageSimilarity: true });
                }
            } catch (error) {
                console.log(error);
                console.error("Error matching products:", error);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: error.message
                });

                continue; // Skip to the next source product if there's an error
            }

            // Nothing was close enough on text to be worth an image check —
            // recorded the same way as "no candidate cleared the threshold".
            if (shortlist.length === 0) {
                console.log("No candidates passed the text pre-filter for:", sourceProduct.title);
                timing.logEvent("Result: no candidate passed the text pre-filter");

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: NO_SHORTLIST_ERROR
                });

                await appendToFile(outputFilePath, {
                    sourceProduct: sourceProduct,
                    matchedProducts: {}
                });

                continue;
            }

            if (matchData.length === 0) {
                console.log("No match data found for:", sourceProduct.title);
                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No match data found"
                });
                continue; // Skip to the next source product if no match data found
            }

            console.log("Match data found:", matchData.length);

            await appendToFile(matchedFilePath, {
                sourceProduct: sourceProduct,
                matchedProducts: matchData,
            });

            let foundProductCount = 0;
            try {

                for (var i = 0; i < matchData.length; i++) {

                    const fieldScores = matchData[i].field_scores;

                    if (fieldScores && fieldScores.title >= 0.85 && fieldScores.brand >= 0.85 && fieldScores.color >= 0.85 && fieldScores.image_similarity >= 0.85) {
                        const finalObj = {
                            sourceProduct: sourceProduct,
                            matchedProducts: matchData[i],
                        };

                        await appendToFile(outputFilePath, finalObj);
                        foundProductCount++;
                        break; // Break after finding the first match
                    }

                }


            } catch (error) {
                console.error("Error processing match data:", error);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: error.message
                });

                continue; // Skip to the next source product if there's an error
            }

            timing.logEvent(foundProductCount === 0 ? "Result: no candidate cleared the match threshold" : "Result: match found");

            if (foundProductCount === 0) {
                console.log("No matching products found for:", sourceProduct.title);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No matching products found"
                });

                await appendToFile(outputFilePath, {
                    sourceProduct: sourceProduct,
                    matchedProducts: {}
                });

            } else {
                console.log(`Found ${foundProductCount} matching products for:`, sourceProduct.title);
            }

        }
        const allProducts = fs.existsSync(outputFilePath) ? JSON.parse(fs.readFileSync(outputFilePath, "utf8")) : [];
        console.log("Total matched products:", allProducts.length);

        console.log("Product matching completed successfully.");

        timing.endRun(`${sourceProducts.length} SKU(s), ${allProducts.length} row(s) in the final output`);

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: "akhlaq@mergekart.com",
            subject: `Product Matching Report for ${brand} - ${projectId}`,
            text: `Product matching completed successfully for brand: ${brand} and projectId: ${projectId}. Total matched products: ${allProducts.length}`,
            attachments: [
                {
                    filename: 'products_matched_final.json',
                    path: fs.existsSync(outputFilePath) ? outputFilePath : emptyFilePath,
                },
                {
                    filename: 'products_matching_errors.json',
                    path: fs.existsSync(errorFilePath) ? errorFilePath : emptyFilePath,
                },
                {
                    filename: 'products_matched.json',
                    path: fs.existsSync(matchedFilePath) ? matchedFilePath : emptyFilePath,
                },
                {
                    filename: 'products_text_scores.json',
                    path: fs.existsSync(textScoresFilePath) ? textScoresFilePath : emptyFilePath,
                },
                {
                    filename: 'product_matching_timing.log',
                    path: timingFilePath,
                }
            ]
        };

        await sendUpdateReportEmail(mailOptions);

        // if (fs.existsSync(outputFilePath)) {
        //     fs.unlinkSync(outputFilePath);
        // }

        // if (fs.existsSync(errorFilePath)) {
        //     fs.unlinkSync(errorFilePath);
        // }

        // if (fs.existsSync(matchedFilePath)) {
        //     fs.unlinkSync(matchedFilePath);
        // }
        // }

        await closeFetchClients();


    } catch (err) {
        console.error("Error:", err);
        timing.endRun(`aborted: ${err.message}`);
        const mailOptions = {
            from: config.FROM_EMAIL,
            to: "akhlaq@mergekart.com",
            subject: `Product Matching Error for ${brands.join(", ")} - ${projectId}`,
            text: `An error occurred during product matching for brand: ${brands.join(", ")} and projectId: ${projectId}. Error: ${err.message}`,
        };

        await sendUpdateReportEmail(mailOptions);
    }
}

// ---------------------------------------------------------------------------
// New brand-driven flow: looks up every {target, direction} pair configured
// for `brandName` in config/brandTargets.js and runs all of them, combining
// results into one spreadsheet. This is what powers the Teknum x Amazon
// UAE / Firstcry UAE (forward + reverse) checks.
// ---------------------------------------------------------------------------
async function runBrandMatching(brandName, projectId, skus = null) {
    const targets = brandTargets[brandName];
    if (!targets || targets.length === 0) {
        throw new Error(`No target sites configured for brand "${brandName}" in config/brandTargets.js`);
    }

    // The brand's own catalog rows — used as the source list for "forward"
    // checks, and as the comparison pool for "reverse" checks. An optional
    // `skus` list narrows this to specific products (e.g. a 10-product test
    // run). It only selects WHICH of our own rows to process — the target
    // sites are still searched by product title, not by SKU (a Mumzworld SKU
    // means nothing on Amazon UAE / Firstcry UAE).
    const where = { brand: { [Op.iLike]: brandName }, projectId };
    if (Array.isArray(skus) && skus.length > 0) {
        where.sku = { [Op.in]: skus.map((s) => String(s)) };
    }

    const localCatalog = await ScratchProducts.findAll({
        where,
        raw: true,
        attributes: ['title', 'url', 'brand', 'sku', 'category', 'images', 'attributes', 'price', 'mrp']
    });

    if (localCatalog.length === 0) {
        const skuNote = Array.isArray(skus) && skus.length > 0 ? ` and skus [${skus.join(", ")}]` : "";
        throw new Error(`No catalog rows found for brand "${brandName}" and projectId ${projectId}${skuNote}`);
    }

    const runId = Date.now();
    const errorFilePath = `brand_matching_errors_${brandName}_${projectId}_${runId}.json`;
    const matchedFilePath = `brand_matching_raw_${brandName}_${projectId}_${runId}.json`;
    const textScoresFilePath = `brand_matching_text_scores_${brandName}_${projectId}_${runId}.json`;
    const excelFilePath = `brand_matching_${brandName}_${projectId}_${runId}.xlsx`;
    const timingFilePath = timing.startRun(
        timing.timingLogPath(`brand_${brandName}_${projectId}_${runId}`),
        `brand matching for ${brandName}, project ${projectId}, ${localCatalog.length} SKU(s), ` +
        `targets: ${targets.map((t) => `${t.target}/${t.direction}`).join(", ")}`
    );
    const allResults = [];

    for (const { target: targetId, direction } of targets) {
        const targetConfig = targetSites[targetId];
        if (!targetConfig) {
            console.error(`Unknown target site "${targetId}" in brandTargets config, skipping.`);
            continue;
        }

        console.log(`Running ${direction} check for ${brandName} against ${targetConfig.label}`);

        if (direction === "forward") {
            // Same shape as the legacy flow: iterate our own catalog rows,
            // search the target for each one.
            for (let p = 0; p < localCatalog.length; p++) {
                const sourceProduct = localCatalog[p];
                timing.beginSku(sourceProduct.sku, `${targetConfig.label} ${direction}, ${p + 1}/${localCatalog.length}`);

                await delay(1500);

                const candidates = await timing.step(
                    `${targetConfig.label} candidate collection`,
                    () => buildCandidatesFromSearch(targetConfig, sourceProduct.title),
                    { summarize: (c) => `${c.length} candidate(s)` }
                );
                if (candidates.length === 0) {
                    timing.logEvent(`Result: no products found on ${targetConfig.label}`);
                    await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct, error: "No products found" });
                    continue;
                }

                // Pass 1 (text only, every candidate) goes to its own file;
                // pass 2 (image, shortlist only) feeds the raw file and Excel.
                let matchData = [];
                let shortlist = [];
                try {
                    const scored = await scoreAndShortlist(sourceProduct, candidates);
                    shortlist = scored.shortlist;
                    await appendToFile(textScoresFilePath, { direction, target: targetConfig.label, sourceProduct, matchedProducts: scored.textScores });

                    if (shortlist.length > 0) {
                        matchData = await callMatchingService(sourceProduct, shortlist, { includeImageSimilarity: true });
                    }
                } catch (err) {
                    await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct, error: err.message });
                    continue;
                }

                if (shortlist.length === 0) {
                    timing.logEvent("Result: no candidate passed the text pre-filter");
                    await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct, error: NO_SHORTLIST_ERROR });
                    allResults.push({
                        targetLabel: targetConfig.label,
                        direction,
                        sourceProduct,
                        matched: false,
                        matchedProduct: null,
                        fieldScores: null,
                    });
                    continue;
                }

                await appendToFile(matchedFilePath, { direction, target: targetConfig.label, sourceProduct, matchedProducts: matchData });

                const best = pickBestMatch(matchData);
                timing.logEvent(best ? "Result: match found" : "Result: no candidate cleared the match threshold");
                allResults.push({
                    targetLabel: targetConfig.label,
                    direction,
                    sourceProduct,
                    matched: !!best,
                    matchedProduct: best ? best.matchedProduct : null,
                    fieldScores: best ? best.fieldScores : null,
                });
            }
        }
        // Reverse direction disabled for now (out of scope per current HLD —
        // forward-only). Left in place, commented, rather than deleted:
        // else if (direction === "reverse") {
        //     // Search the target site for the brand itself, then check each
        //     // result found there against our own catalog. NOTE: this only
        //     // covers the first page of results the target returns for the
        //     // brand-name query — no pagination yet. Good enough to surface
        //     // "things listed under this brand that we don't have tracked,"
        //     // but not an exhaustive crawl of the target site.
        //     const targetSideProducts = await buildCandidatesFromSearch(targetConfig, brandName);
        //
        //     for (const targetSideProduct of targetSideProducts) {
        //         await delay(1500);
        //
        //         let matchData = [];
        //         try {
        //             matchData = await callMatchingService(targetSideProduct, localCatalog);
        //         } catch (err) {
        //             await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct: targetSideProduct, error: err.message });
        //             continue;
        //         }
        //
        //         await appendToFile(matchedFilePath, { direction, target: targetConfig.label, sourceProduct: targetSideProduct, matchedProducts: matchData });
        //
        //         const best = pickBestMatch(matchData);
        //         allResults.push({
        //             targetLabel: targetConfig.label,
        //             direction,
        //             sourceProduct: targetSideProduct,
        //             matched: !!best,
        //             matchedProduct: best ? best.matchedProduct : null,
        //             fieldScores: best ? best.fieldScores : null,
        //         });
        //     }
        // }
    }

    exportResultsToExcel(allResults, excelFilePath);

    const matchedCount = allResults.filter((r) => r.matched).length;

    timing.endRun(`${matchedCount}/${allResults.length} row(s) matched`);

    const mailOptions = {
        from: config.FROM_EMAIL,
        to: "akhlaq@mergekart.com",
        subject: `Product Matching Report for ${brandName} - ${projectId}`,
        text: `Multi-marketplace product matching completed for brand: ${brandName}, project: ${projectId}. ${matchedCount}/${allResults.length} rows matched. See attached spreadsheet.`,
        attachments: [
            { filename: 'product_matching_results.xlsx', path: excelFilePath },
            { filename: 'product_matching_raw.json', path: fs.existsSync(matchedFilePath) ? matchedFilePath : `emptyFile.json` },
            { filename: 'product_matching_errors.json', path: fs.existsSync(errorFilePath) ? errorFilePath : `emptyFile.json` },
            { filename: 'product_matching_text_scores.json', path: fs.existsSync(textScoresFilePath) ? textScoresFilePath : `emptyFile.json` },
            { filename: 'product_matching_timing.log', path: timingFilePath },
        ]
    };

    await sendUpdateReportEmail(mailOptions);

    return { excelFilePath, totalRows: allResults.length, matchedCount };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const config = require("./config.json");
const { Op } = require('sequelize');

app.post('/product-matching', async (req, res) => {
    const { brand, projectId, category } = req.body;
    console.log(brand)
    if (!brand || brand.length == 0 || !projectId) {
        return res.status(400).json({ error: "Brand and projectId are required parameters." });
    }

    try {

        res.status(200).json({ message: "Product matching started successfully." });

        await timing.withTimingContext(() => productMatching(brand, projectId, category));

        console.log("Product matching completed successfully.");
    } catch (error) {
        console.error("Error in product matching:", error);

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: "akhlaq@mergekart.com",
            subject: `Product Matching Error for ${brand} - ${projectId}`,
            text: `An error occurred during product matching for brand: ${brand} and projectId: ${projectId}. Error: ${error.message}`,
        };

        await sendUpdateReportEmail(mailOptions);

        res.status(500).json({ error: "An error occurred during product matching." });
    }
});

// New: config-driven, multi-target (+ reverse-check) matching for a whole
// brand, e.g. { "brandName": "Teknum", "projectId": 342 }. Which target
// sites and directions run is controlled entirely by config/brandTargets.js.
// Optionally pass "skus": ["...", "..."] to limit the run to specific products
// (e.g. a 10-product test); omit it to process the brand's whole catalog.
app.post('/product-matching/brand', async (req, res) => {
    const { brandName, projectId, skus } = req.body;

    if (!brandName || !projectId) {
        return res.status(400).json({ error: "brandName and projectId are required parameters." });
    }

    if (skus !== undefined && !Array.isArray(skus)) {
        return res.status(400).json({ error: "skus, if provided, must be an array of SKU strings." });
    }

    try {
        res.status(200).json({ message: "Brand product matching started successfully." });

        const result = await timing.withTimingContext(() => runBrandMatching(brandName, projectId, skus));

        console.log("Brand product matching completed successfully.", result);
    } catch (error) {
        console.error("Error in brand product matching:", error);

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: "anushidh@mergekart.com",
            subject: `Product Matching Error for ${brandName} - ${projectId}`,
            text: `An error occurred during brand product matching for brand: ${brandName} and projectId: ${projectId}. Error: ${error.message}`,
        };

        await sendUpdateReportEmail(mailOptions);
    }
});

app.get("/test", async (req, res) => {
    return res.status(200).json({ message: "API is working fine." });
});

const server = app.listen(8010, () => {
    console.log("Server is running on port 8010");
});

// Both fetch clients hold something open for the life of the process — the
// browser (helper/browserClient.js) and the keep-alive proxy tunnel
// (helper/httpClient.js) — so a Ctrl-C or a container stop would otherwise
// leave an orphaned Chrome and a dangling socket behind.
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        console.log(`Received ${signal}, shutting down...`);
        server.close();
        await closeFetchClients();
        process.exit(0);
    });
}
